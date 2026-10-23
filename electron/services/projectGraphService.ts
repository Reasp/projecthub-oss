/**
 * Источник данных вкладок «Граф кода» и «Граф документации» (TASK-167, decision-118).
 *
 * Граф кода отдаёт `gitnexus serve` — тот же HTTP-сервер, к которому подключается web UI GitNexus: он
 * открывает LadybugDB только на чтение и собирает граф сам, так что нативная база в ProjectHub не нужна.
 * Сервер поднимается по требованию на loopback и случайном порту, гасится после простоя и при выходе.
 * Граф документации читается из GraphML LightRAG напрямую — без Python и без Ollama.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AppError, appErrorKeyOf, type AppErrorKey } from '../../src/lib/appError.js';
import { findGitNexusRepo, fromGitNexusGraph, parseLightRagGraphml, type ProjectGraph } from './projectGraph';

export type ProjectGraphUnavailable = 'no-index' | 'no-cli' | 'not-registered' | 'disabled' | 'error';

export type ProjectGraphResult =
  | { ok: true; graph: ProjectGraph; indexedAt?: string; repo?: string }
  | { ok: false; reason: ProjectGraphUnavailable; error?: string; errorKey?: AppErrorKey };

/** Ошибка загрузки графа: английский текст и код для окна (decision-165). */
export function graphErrorResult(err: unknown): ProjectGraphResult {
  const errorKey = appErrorKeyOf(err);
  return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err), ...(errorKey ? { errorKey } : {}) };
}

const READY_TIMEOUT_MS = 30_000;
const GRAPH_TIMEOUT_MS = 120_000;
/** Сервер нужен на время загрузки графа; держать его дольше — лишний открытый порт с API анализа. */
const IDLE_STOP_MS = 3 * 60_000;
/** GraphML больше этого не разбирается: такой граф всё равно не нарисовать в окне. */
const MAX_GRAPHML_BYTES = 64 * 1024 * 1024;
const LIGHTRAG_GRAPHML = path.join('.lightrag-index', 'graph_chunk_entity_relation.graphml');

class CliMissingError extends Error {}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new AppError('graph.portPickFailed'))));
    });
  });
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new AppError('graph.httpError', { status: res.status, path: new URL(url).pathname });
  return res.json();
}

async function readInfraFeatures(root: string): Promise<Record<string, unknown> | null> {
  for (const rel of ['infra.config.json', path.join('.projecthub', 'infra', 'infra.config.json')]) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')) as { features?: unknown };
      if (parsed.features && typeof parsed.features === 'object') return parsed.features as Record<string, unknown>;
    } catch {
      // нет файла или он битый — пробуем следующее расположение
    }
  }
  return null;
}

class GitNexusServer {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  /** Адрес работающего сервера; запускает его, если нужно. */
  async ensure(): Promise<string> {
    this.touch();
    if (this.baseUrl && this.child && this.child.exitCode === null) return this.baseUrl;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<string> {
    const port = await freePort();
    const args = ['serve', '--port', String(port), '--host', '127.0.0.1'];
    // gitnexus на Windows — npm-обёртка gitnexus.cmd, её запускает только оболочка; аргументы — константы и число.
    const child = spawn('gitnexus', args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const state: { exited: { code: number | null; spawnError?: NodeJS.ErrnoException } | null } = { exited: null };
    child.once('error', (err: NodeJS.ErrnoException) => {
      state.exited = { code: null, spawnError: err };
    });
    child.once('exit', (code) => {
      state.exited ??= { code };
      if (this.child === child) {
        this.child = null;
        this.baseUrl = null;
      }
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ex = state.exited;
      if (ex) {
        // cmd сообщает о ненайденной команде кодом 1 и текстом «is not recognized», shell Unix — кодом 127.
        if (ex.spawnError?.code === 'ENOENT' || ex.code === 127 || /not recognized|не является|not found/i.test(output)) {
          throw new CliMissingError('gitnexus not found in PATH');
        }
        throw new AppError('graph.serveExited', { code: ex.code ?? '?', output: output.trim().slice(-500) });
      }
      try {
        await fetchJson(`${url}/api/health`, 1500);
        this.baseUrl = url;
        console.log(`[ProjectGraph] gitnexus serve запущен на ${url} (pid ${child.pid})`);
        return url;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.stop();
    throw new AppError('graph.serveTimeout');
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      // Между нами и node стоит cmd.exe (shell:true), поэтому гасится всё дерево. Синхронно: при выходе
      // асинхронный tree-kill не успевал до app.exit(), и node с открытым портом оставался сиротой.
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        return;
      } catch {
        // taskkill не нашёл процесс или упал — добиваем хотя бы корень
      }
    }
    // На Unix shell не используется: child — сам node gitnexus.
    try { child.kill('SIGTERM'); } catch { /* уже завершён */ }
  }
}

type CacheEntry = { stamp: string; result: Extract<ProjectGraphResult, { ok: true }> };

class ProjectGraphService {
  private readonly server = new GitNexusServer();
  private readonly codeCache = new Map<string, CacheEntry>();
  private readonly docsCache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ProjectGraphResult>>();

  /** Граф кода проекта из индекса GitNexus. `force` — мимо кэша (после переиндексации). */
  getCodeGraph(root: string, force = false): Promise<ProjectGraphResult> {
    const key = `code:${root}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.loadCodeGraph(root, force).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async loadCodeGraph(root: string, force: boolean): Promise<ProjectGraphResult> {
    const metaPath = path.join(root, '.gitnexus', 'meta.json');
    if (!existsSync(metaPath)) return { ok: false, reason: 'no-index' };

    let stamp = '';
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as { indexedAt?: unknown; lastCommit?: unknown };
      stamp = `${String(meta.indexedAt ?? '')}|${String(meta.lastCommit ?? '')}`;
    } catch {
      // без отметки кэш просто не используется
    }
    const cached = this.codeCache.get(root);
    if (!force && stamp && cached?.stamp === stamp) return cached.result;

    try {
      const base = await this.server.ensure();
      const repo = findGitNexusRepo(await fetchJson(`${base}/api/repos`, 15_000), root);
      if (!repo) return { ok: false, reason: 'not-registered' };
      const raw = await fetchJson(`${base}/api/graph?repo=${encodeURIComponent(repo.name)}`, GRAPH_TIMEOUT_MS);
      const result = { ok: true as const, graph: fromGitNexusGraph(raw), repo: repo.name, ...(repo.indexedAt ? { indexedAt: repo.indexedAt } : {}) };
      this.remember(this.codeCache, root, stamp, result);
      return result;
    } catch (err) {
      if (err instanceof CliMissingError) return { ok: false, reason: 'no-cli' };
      return graphErrorResult(err);
    }
  }

  /** Граф сущностей документации из `.lightrag-index` проекта. */
  async getDocsGraph(root: string): Promise<ProjectGraphResult> {
    const file = path.join(root, LIGHTRAG_GRAPHML);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(file);
    } catch {
      const features = await readInfraFeatures(root);
      return { ok: false, reason: features && features.lightrag !== true ? 'disabled' : 'no-index' };
    }
    if (stat.size > MAX_GRAPHML_BYTES) {
      return graphErrorResult(new AppError('graph.lightragTooLarge', { size: Math.round(stat.size / 1048576) }));
    }
    const stamp = `${stat.mtimeMs}|${stat.size}`;
    const cached = this.docsCache.get(root);
    if (cached?.stamp === stamp) return cached.result;
    try {
      const result = { ok: true as const, graph: parseLightRagGraphml(await fs.readFile(file, 'utf8')), indexedAt: stat.mtime.toISOString() };
      this.remember(this.docsCache, root, stamp, result);
      return result;
    } catch (err) {
      return graphErrorResult(err);
    }
  }

  /** Держим графы трёх последних проектов: граф кода крупного репозитория — десятки мегабайт. */
  private remember(cache: Map<string, CacheEntry>, root: string, stamp: string, result: CacheEntry['result']) {
    if (!stamp) return;
    cache.delete(root);
    cache.set(root, { stamp, result });
    while (cache.size > 3) cache.delete(cache.keys().next().value as string);
  }

  shutdown() {
    this.server.stop();
  }
}

export const projectGraphService = new ProjectGraphService();
