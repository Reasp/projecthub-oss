import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit } from 'simple-git';
import matter from 'gray-matter';
import type { PullRequest, PRCreateOptions, PRProviderInfo, TaskPullRequestsResult } from '../../src/types/electron';
import { findTaskFile } from './taskFileLookup.js';
import { normalizeFrontmatter, withUpdatedDate } from './backlogTaskFormat.js';
import { appEventBus } from './eventBus.js';
import os from 'node:os';
import { parseGhPrList, type PrInfo, type PrStateInfo } from './prSnapshot.js';
import { ghCommentArgs } from './prReviewFormat.js';
import { findConnectionService } from './connectionCatalog.js';
import type { ConnectionInput, ConnectionStatus, ConnectionUsage } from './connectionTypes.js';
import {
  cloudHostingOf,
  connectionMatchesRemote,
  findPrAdapter,
  parseGitRemote,
  parsePrUrl,
  prInfoFrom,
  prUrlInRepo,
  repoPathFor,
  taskIdsInText,
  type GitRemote,
  type PrHostingAdapter,
  type PrHostingId,
  type PrHttp,
  type PrListState,
  type RepoRef
} from './prHosting.js';
import { stateFields, withVersion } from './stateFiles.js';

/** PR для ревью (TASK-81): голова, ветки и описание. */
export interface PrReviewTarget {
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  state: string;
}

/** Подключение слоя decision-102, как его видит PR-интеграция. */
export interface PrConnectionInfo {
  id: string;
  serviceId: string;
  label: string;
  baseUrl: string;
  status: ConnectionStatus;
}

/** Доступ к слою подключений (TASK-138.2, decision-105): сеть только через `authorizedFetch`. */
export interface PrConnectionsPort {
  list(): Promise<PrConnectionInfo[]>;
  authorizedFetch(connectionId: string, target: string, init?: RequestInit): Promise<Response>;
  addWithToken(input: ConnectionInput): Promise<{ id: string; label: string }>;
}

export interface PrServiceDeps {
  connections?: PrConnectionsPort;
  /** Файл выбора подключения по проектам (`<userData>/pr-hosting.json`). */
  statePath?: () => string;
  exec?: (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
  /** Адрес remote `origin` (или первого) проекта; по умолчанию — из git. */
  readRemote?: (projectPath: string) => Promise<string | null>;
}

export const PR_HOSTING_STATE_VERSION = 1;

/**
 * Настройки PR проекта в `pr-hosting.json`: подключение (TASK-138.2) и статус, в который слияние PR
 * переводит задачу из `Review` (TASK-138.5). `path` — исходный путь проекта для опроса PR.
 */
interface ProjectPrSettings {
  connectionId?: string;
  mergeStatus?: string;
  path?: string;
}
const MAX_TASK_PRS = 5;

type Backend =
  | { kind: 'connection'; adapter: PrHostingAdapter; connection: PrConnectionInfo; repo: RepoRef; remote: GitRemote; http: PrHttp; candidates: PrConnectionInfo[] }
  | { kind: 'cli'; remote: GitRemote; candidates: PrConnectionInfo[] }
  | { kind: 'none'; hosting: PrHostingId | null; remote: GitRemote | null; remoteUrl?: string; candidates: PrConnectionInfo[] };

/** Элемент `gh pr list/view --json …`. */
interface GhPrItem {
  number: number;
  title: string;
  state: string;
  url: string;
  author?: { login?: string };
  createdAt: string;
  updatedAt: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  body?: string;
  labels?: Array<{ name: string }>;
  statusCheckRollup?: Array<{ state?: string; conclusion?: string; status?: string }>;
  comments?: unknown[];
  isDraft?: boolean;
  reviewDecision?: string;
  isCrossRepository?: boolean;
}

const execFileAsync = promisify(execFile);
const STATUS_RANK: Record<ConnectionStatus, number> = { connected: 0, unchecked: 1, error: 2, needsReauth: 3 };

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
}

export class PRService {
  private readonly deps: PrServiceDeps;
  private settings: Record<string, ProjectPrSettings> | null = null;
  private readonly mergeSettingsListeners = new Set<() => void>();
  /** Какое подключение использовал проект в последний раз — для окна «Подключения». */
  private readonly usedConnections = new Map<string, { connectionId: string; label: string }>();

  constructor(deps: PrServiceDeps = {}) {
    this.deps = deps;
  }

  private exec(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string }> {
    return this.deps.exec ? this.deps.exec(file, args, options) : execFileAsync(file, args, options);
  }

  private async runGh(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await this.exec('gh', args, {
        cwd,
        env: { ...process.env, GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1' }
      });
      return stdout.trim();
    } catch (err: any) {
      throw new Error(err.stderr || err.message || 'Ошибка выполнения GitHub CLI', { cause: err });
    }
  }

  private async isGhAvailable(): Promise<boolean> {
    try {
      await this.exec('gh', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────── Выбор подключения проекта ───────────────

  private async loadSettings(): Promise<Record<string, ProjectPrSettings>> {
    if (this.settings) return this.settings;
    const file = this.deps.statePath?.();
    const projects: Record<string, ProjectPrSettings> = {};
    if (file) {
      try {
        const raw = stateFields(JSON.parse(await fs.readFile(file, 'utf-8')), PR_HOSTING_STATE_VERSION).projects;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (!v || typeof v !== 'object') continue;
            const r = v as Record<string, unknown>;
            const entry: ProjectPrSettings = {};
            if (typeof r.connectionId === 'string' && r.connectionId) entry.connectionId = r.connectionId;
            if (typeof r.mergeStatus === 'string' && r.mergeStatus.trim()) entry.mergeStatus = r.mergeStatus.trim();
            if (typeof r.path === 'string' && r.path) entry.path = r.path;
            if (entry.connectionId || entry.mergeStatus) projects[k] = entry;
          }
        }
      } catch {
        // нет файла или он битый — настроек нет
      }
    }
    this.settings = projects;
    return projects;
  }

  private async updateSettings(projectPath: string, patch: Partial<ProjectPrSettings>): Promise<void> {
    const settings = await this.loadSettings();
    const key = pathKey(projectPath);
    const entry: ProjectPrSettings = { ...settings[key], ...patch, path: projectPath };
    if (!entry.connectionId) delete entry.connectionId;
    if (!entry.mergeStatus) delete entry.mergeStatus;
    if (entry.connectionId || entry.mergeStatus) settings[key] = entry;
    else delete settings[key];
    const file = this.deps.statePath?.();
    if (!file) return;
    const text = `${JSON.stringify(withVersion(PR_HOSTING_STATE_VERSION, { projects: settings }), null, 2)}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, file).catch(async () => {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      await fs.writeFile(file, text, 'utf-8');
    });
  }

  /** Запомнить подключение проекта; `null` — выбирать автоматически. */
  async setProjectConnection(projectPath: string, connectionId: string | null): Promise<PRProviderInfo> {
    await this.updateSettings(projectPath, { connectionId: connectionId ?? undefined });
    return this.getProviderInfo(projectPath);
  }

  /** Статус, в который слияние PR переводит задачу из `Review` (TASK-138.5); `null` — не переводить. */
  async getMergeStatus(projectPath: string): Promise<string | null> {
    return (await this.loadSettings())[pathKey(projectPath)]?.mergeStatus ?? null;
  }

  async setMergeStatus(projectPath: string, status: string | null): Promise<PRProviderInfo> {
    const value = status?.trim() || undefined;
    if (value && value.toLowerCase() === 'review') throw new Error('Слияние PR не может переводить задачу в Review: она уже там');
    await this.updateSettings(projectPath, { mergeStatus: value });
    for (const listener of this.mergeSettingsListeners) listener();
    return this.getProviderInfo(projectPath);
  }

  /** Проекты с включённым переводом задач при слиянии — их PR опрашивает `prWatcher`. */
  async mergeStatusProjects(): Promise<string[]> {
    return Object.values(await this.loadSettings())
      .filter((e) => e.mergeStatus && e.path)
      .map((e) => e.path!);
  }

  onMergeSettingsChange(listener: () => void): () => void {
    this.mergeSettingsListeners.add(listener);
    return () => this.mergeSettingsListeners.delete(listener);
  }

  /** Использования подключений PR-интеграцией (decision-102 п. 7). */
  usages(): ConnectionUsage[] {
    const seen = new Set<string>();
    const out: ConnectionUsage[] = [];
    for (const u of this.usedConnections.values()) {
      const key = `${u.connectionId}\n${u.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    return out;
  }

  private async remoteUrl(projectPath: string): Promise<string | null> {
    if (this.deps.readRemote) return this.deps.readRemote(projectPath);
    if (!existsSync(path.join(projectPath, '.git'))) return null;
    const remotes = await simpleGit(projectPath).getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin') || remotes[0];
    return origin?.refs.fetch || null;
  }

  /**
   * Чем ходить за PR проекта: выбранное или подходящее подключение к хостингу remote, затем `gh` для
   * GitHub. Подключение, требующее входа заново, автоматически не выбирается.
   */
  private async resolveBackend(projectPath: string): Promise<Backend> {
    const remoteUrl = await this.remoteUrl(projectPath);
    const remote = parseGitRemote(remoteUrl);
    if (!remote) return { kind: 'none', hosting: null, remote: null, remoteUrl: remoteUrl ?? undefined, candidates: [] };
    const cloud = cloudHostingOf(remote.hostname);
    const all = this.deps.connections ? await this.deps.connections.list().catch(() => [] as PrConnectionInfo[]) : [];
    const candidates = all
      .filter((c) => findPrAdapter(c.serviceId) && connectionMatchesRemote(c.baseUrl, remote) && (!cloud || c.serviceId === cloud))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    const saved = (await this.loadSettings())[pathKey(projectPath)]?.connectionId;
    const chosen = candidates.find((c) => c.id === saved) ?? candidates.find((c) => c.status !== 'needsReauth');
    const key = pathKey(projectPath);
    if (chosen && this.deps.connections) {
      const adapter = findPrAdapter(chosen.serviceId)!;
      const service = findConnectionService(chosen.serviceId);
      const repoPath = repoPathFor(remote, chosen.baseUrl);
      const repo: RepoRef = { path: repoPath, webBase: chosen.baseUrl, apiBase: service ? service.apiBase(chosen.baseUrl) : chosen.baseUrl };
      const connections = this.deps.connections;
      this.usedConnections.set(key, { connectionId: chosen.id, label: `PR: ${repoPath}` });
      return {
        kind: 'connection',
        adapter,
        connection: chosen,
        repo,
        remote,
        candidates,
        http: (target, init) => connections.authorizedFetch(chosen.id, target, init)
      };
    }
    this.usedConnections.delete(key);
    const hosting = cloud ?? (candidates[0] ? findPrAdapter(candidates[0].serviceId)!.id : null);
    if (hosting === 'github' && (await this.isGhAvailable())) return { kind: 'cli', remote, candidates };
    return { kind: 'none', hosting, remote, remoteUrl: remoteUrl ?? undefined, candidates };
  }

  private noBackendError(backend: Backend): Error {
    const where = backend.kind === 'none' && backend.hosting ? findPrAdapter(backend.hosting)?.label : null;
    return new Error(
      where
        ? `Нет подключения к ${where}: добавьте его в окне «Подключения»`
        : 'Хостинг репозитория не распознан: добавьте подключение к нему в окне «Подключения»'
    );
  }

  async getProviderInfo(projectPath: string): Promise<PRProviderInfo> {
    try {
      const backend = await this.resolveBackend(projectPath);
      const hasCli = backend.kind === 'cli' || (await this.isGhAvailable());
      const connections = backend.candidates.map((c) => ({ id: c.id, label: c.label, status: c.status }));
      const settings = (await this.loadSettings())[pathKey(projectPath)];
      const saved = settings?.connectionId;
      const pinned = {
        ...(saved && connections.some((c) => c.id === saved) ? { pinnedConnectionId: saved } : {}),
        ...(settings?.mergeStatus ? { mergeStatus: settings.mergeStatus } : {})
      };
      if (backend.kind === 'connection') {
        return {
          provider: backend.adapter.id,
          repo: backend.repo.path,
          remoteUrl: backend.remote ? `${backend.remote.hostname}/${backend.remote.path}` : undefined,
          hasCli,
          authenticated: backend.connection.status !== 'needsReauth',
          via: 'connection',
          connectionId: backend.connection.id,
          connectionLabel: backend.connection.label,
          ...pinned,
          connections
        };
      }
      if (!backend.remote) {
        return { provider: 'none', remoteUrl: backend.kind === 'none' ? backend.remoteUrl : undefined, hasCli, authenticated: false, via: 'none', connections };
      }
      const hosting = backend.kind === 'cli' ? 'github' : backend.hosting;
      let ghAuthed = false;
      if (hosting === 'github' && hasCli) {
        try {
          await this.runGh(['auth', 'status', '--hostname', backend.remote.hostname], projectPath);
          ghAuthed = true;
        } catch {
          ghAuthed = false;
        }
      }
      let importableCli: PRProviderInfo['importableCli'];
      if (!connections.length) {
        importableCli = hosting === 'github' ? (ghAuthed ? 'gh' : undefined) : await this.cliLoginFor(hosting, backend.remote.hostname, projectPath, hasCli);
      }
      return {
        provider: hosting ?? 'none',
        repo: hosting ? backend.remote.path : undefined,
        remoteUrl: `${backend.remote.hostname}/${backend.remote.path}`,
        hasCli,
        authenticated: backend.kind === 'cli' && ghAuthed,
        via: backend.kind === 'cli' ? 'cli' : 'none',
        connections,
        ...(importableCli ? { importableCli } : {})
      };
    } catch (e) {
      console.error(`Failed to get PR provider info for ${projectPath}:`, e);
      return { provider: 'none', hasCli: false, authenticated: false, via: 'none', connections: [] };
    }
  }

  private async glabLoggedIn(hostname: string, cwd: string): Promise<boolean> {
    try {
      await this.exec('glab', ['auth', 'status', '--hostname', hostname], { cwd, env: { ...process.env, NO_PROMPT: '1' } });
      return true;
    } catch {
      return false;
    }
  }

  /** Вход CLI для хоста: `glab` у GitLab; у неизвестного self-hosted — `glab`, затем `gh` (GitHub Enterprise). */
  private async cliLoginFor(hosting: PrHostingId | null, hostname: string, cwd: string, hasGh: boolean): Promise<'gh' | 'glab' | undefined> {
    if (hosting === 'github') {
      return hasGh && (await this.runGh(['auth', 'status', '--hostname', hostname], cwd).then(() => true, () => false)) ? 'gh' : undefined;
    }
    if (hosting !== 'gitlab' && hosting !== null) return undefined;
    if (await this.glabLoggedIn(hostname, cwd)) return 'glab';
    if (hosting === null && hasGh && (await this.runGh(['auth', 'status', '--hostname', hostname], cwd).then(() => true, () => false))) return 'gh';
    return undefined;
  }

  /**
   * Перенести вход `gh` или `glab` в подключение (decision-105 п. 4): токен читается из CLI в main,
   * проверяется слоем подключений и в рендерер не попадает.
   */
  async importCliLogin(projectPath: string): Promise<{ id: string; label: string }> {
    if (!this.deps.connections) throw new Error('Слой подключений недоступен');
    const remote = parseGitRemote(await this.remoteUrl(projectPath));
    if (!remote) throw new Error('У проекта нет remote с адресом хостинга');
    const cli = await this.cliLoginFor(cloudHostingOf(remote.hostname), remote.hostname, projectPath, await this.isGhAvailable());
    if (!cli) throw new Error('Нет входа gh или glab для этого хоста');
    let token: string;
    const serviceId = cli === 'gh' ? 'github' : 'gitlab';
    try {
      if (cli === 'gh') {
        token = (await this.runGh(['auth', 'token', '--hostname', remote.hostname], projectPath)).trim();
      } else {
        const { stdout } = await this.exec('glab', ['config', 'get', 'token', '--host', remote.hostname], { cwd: projectPath, env: { ...process.env, NO_PROMPT: '1' } });
        token = stdout.trim();
      }
    } catch (err) {
      throw new Error(`CLI не отдал токен: ${errorText(err)}`, { cause: err });
    }
    if (!token || /\s/.test(token)) {
      throw new Error(serviceId === 'gitlab' ? 'glab хранит токен в системном хранилище: введите токен в окне «Подключения»' : 'gh не вернул токен');
    }
    const created = await this.deps.connections.addWithToken({ serviceId, method: 'token', baseUrl: `https://${remote.hostname}`, token });
    console.log(`[PR] Imported ${serviceId} CLI login into connection ${created.id}`);
    await this.setProjectConnection(projectPath, created.id);
    return created;
  }

  // ─────────────── Список, создание, дифф ───────────────

  private publishFailedChecks(projectPath: string, prs: PullRequest[]): void {
    // Упавшие проверки уходят в шину (TASK-63, decision-13 п.1). Список PR опрашивается
    // периодически, поэтому дубликаты снимает дедупликация `notificationRules` по
    // ключу `pr:checks:<project>:<number>`, а не какое-либо состояние здесь.
    for (const pr of prs) {
      if (pr.state === 'OPEN' && pr.checksStatus === 'FAILURE') {
        appEventBus.publish({
          type: 'pr:checksFailed',
          projectPath,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          at: Date.now()
        });
      }
    }
  }

  /**
   * Список PR. Через подключение ошибка (нет доступа, нужен вход) пробрасывается — окно PR её показывает;
   * через `gh` и без хостинга — пустой список, как раньше.
   */
  async listPullRequests(projectPath: string, state: PrListState = 'open'): Promise<PullRequest[]> {
    const backend = await this.resolveBackend(projectPath).catch((err) => {
      console.error(`Failed to resolve PR hosting for ${projectPath}:`, err);
      return null;
    });
    if (backend?.kind === 'connection') {
      const prs = await backend.adapter.list(backend.http, backend.repo, state);
      this.publishFailedChecks(projectPath, prs);
      return prs;
    }
    if (backend?.kind !== 'cli') return [];
    try {
      const prs = await this.listViaGh(projectPath, state);
      this.publishFailedChecks(projectPath, prs);
      return prs;
    } catch (err) {
      console.error(`Failed to list PRs for ${projectPath}:`, err);
      return [];
    }
  }

  private async listViaGh(projectPath: string, state: PrListState): Promise<PullRequest[]> {
    const jsonFields = [
      'number',
      'title',
      'state',
      'url',
      'author',
      'createdAt',
      'updatedAt',
      'headRefName',
      'headRefOid',
      'baseRefName',
      'body',
      'labels',
      'statusCheckRollup',
      'comments',
      'isDraft',
      'reviewDecision',
      'isCrossRepository'
    ].join(',');

    const raw = await this.runGh(['pr', 'list', '--state', state, '--json', jsonFields, '--limit', '30'], projectPath);
    if (!raw) return [];
    return (JSON.parse(raw) as GhPrItem[]).map((item) => this.fromGhItem(item));
  }

  private fromGhItem(item: GhPrItem): PullRequest {
    let checksStatus: PullRequest['checksStatus'] = 'NONE';
    if (item.statusCheckRollup && item.statusCheckRollup.length > 0) {
      const hasFailures = item.statusCheckRollup.some((c) => c.state === 'FAILURE' || c.conclusion === 'FAILURE');
      const hasPending = item.statusCheckRollup.some((c) => c.state === 'PENDING' || c.status === 'IN_PROGRESS');
      if (hasFailures) checksStatus = 'FAILURE';
      else if (hasPending) checksStatus = 'PENDING';
      else checksStatus = 'SUCCESS';
    }

    let prState: PullRequest['state'] = 'OPEN';
    if (item.state === 'MERGED') prState = 'MERGED';
    else if (item.state === 'CLOSED') prState = 'CLOSED';
    const review = item.reviewDecision;

    return {
      id: item.number,
      number: item.number,
      title: item.title,
      state: prState,
      url: item.url,
      author: item.author?.login || 'unknown',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      sourceBranch: item.headRefName || '',
      targetBranch: item.baseRefName || 'main',
      body: item.body || '',
      labels: (item.labels || []).map((l) => l.name),
      checksStatus,
      provider: 'github' as const,
      commentsCount: item.comments?.length || 0,
      draft: item.isDraft === true,
      headSha: item.headRefOid || undefined,
      ...(review === 'APPROVED' || review === 'CHANGES_REQUESTED' || review === 'REVIEW_REQUIRED' ? { reviewDecision: review } : {}),
      fromFork: item.isCrossRepository === true
    };
  }

  async createPullRequest(projectPath: string, options: PRCreateOptions): Promise<PullRequest | null> {
    try {
      const backend = await this.resolveBackend(projectPath);
      let created: PullRequest;
      if (backend.kind === 'connection') {
        created = await backend.adapter.create(backend.http, backend.repo, options);
        await this.syncBacklogOnPRCreated(projectPath, options.sourceBranch, options.title, created.url);
      } else if (backend.kind === 'cli') {
        created = await this.createViaGh(projectPath, options);
      } else {
        throw this.noBackendError(backend);
      }

      appEventBus.publish({
        type: 'pr:created',
        projectPath,
        number: created.number,
        title: created.title,
        url: created.url,
        at: Date.now()
      });

      return created;
    } catch (err: any) {
      console.error(`Failed to create PR in ${projectPath}:`, err);
      throw err;
    }
  }

  private async createViaGh(projectPath: string, options: PRCreateOptions): Promise<PullRequest> {
    const args = ['pr', 'create', '--title', options.title, '--body', options.body, '--head', options.sourceBranch];
    if (options.targetBranch) args.push('--base', options.targetBranch);
    if (options.draft) args.push('--draft');

    const prUrl = (await this.runGh(args, projectPath)).trim();

    // Задача Backlog переходит в Review и получает ссылку на PR (TASK-64)
    await this.syncBacklogOnPRCreated(projectPath, options.sourceBranch, options.title, prUrl);

    const raw = await this.runGh(
      ['pr', 'view', '--json', 'number,title,state,url,author,createdAt,updatedAt,headRefName,baseRefName,body,labels'],
      projectPath
    );
    const item = JSON.parse(raw);
    return {
      id: item.number,
      number: item.number,
      title: item.title,
      state: 'OPEN',
      url: item.url || prUrl,
      author: item.author?.login || 'you',
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString(),
      sourceBranch: item.headRefName || options.sourceBranch,
      targetBranch: item.baseRefName || options.targetBranch || 'main',
      body: item.body || options.body,
      labels: (item.labels || []).map((l: any) => l.name),
      checksStatus: 'NONE',
      provider: 'github',
      draft: options.draft === true
    };
  }

  // ─────────────── PR задачи (TASK-138.2) ───────────────

  /**
   * PR, связанные с задачей: ссылки на PR в `references` (и прежнее поле `pr`) и PR, в ветке или
   * заголовке которых есть номер задачи. Статус берётся у хостинга; без подключения и `gh` сети нет.
   */
  async getTaskPullRequests(projectPath: string, taskId: string): Promise<TaskPullRequestsResult> {
    const task = await findTaskFile(projectPath, taskId);
    if (!task) return { ok: false, prs: [], unresolved: [], error: 'Задача не найдена' };
    const refs = [
      ...(Array.isArray(task.data.references) ? task.data.references : []),
      ...(typeof task.data.pr === 'string' ? [task.data.pr] : [])
    ]
      .map((r) => String(r).trim())
      .filter((r) => parsePrUrl(r));
    const urls = [...new Set(refs)];
    const id = (typeof task.data.id === 'string' ? task.data.id : taskId).toUpperCase();

    let backend: Backend;
    try {
      backend = await this.resolveBackend(projectPath);
    } catch (err) {
      return { ok: false, prs: [], unresolved: urls, error: errorText(err) };
    }
    if (backend.kind === 'none' || !backend.remote) {
      return { ok: !urls.length, prs: [], unresolved: urls, ...(urls.length ? { error: this.noBackendError(backend).message } : {}) };
    }

    const repoPath = backend.kind === 'connection' ? backend.repo.path : backend.remote.path;
    const unresolved: string[] = [];
    const wanted = new Set<number>();
    for (const url of urls) {
      const ref = parsePrUrl(url)!;
      if (prUrlInRepo(ref, backend.remote, repoPath)) wanted.add(ref.number);
      else unresolved.push(url);
    }

    try {
      const recent = backend.kind === 'connection' ? await backend.adapter.list(backend.http, backend.repo, 'all') : await this.listViaGh(projectPath, 'all');
      const byNumber = new Map(recent.map((p) => [p.number, p]));
      for (const pr of recent) {
        if (taskIdsInText(`${pr.sourceBranch} ${pr.title}`).includes(id)) wanted.add(pr.number);
      }
      const prs: PullRequest[] = [];
      for (const number of [...wanted].sort((a, b) => b - a).slice(0, MAX_TASK_PRS)) {
        // Полный вид PR: в списке GitLab, Gitea и Bitbucket нет статусов сборок.
        const pr =
          backend.kind === 'connection'
            ? await backend.adapter.get(backend.http, backend.repo, number)
            : (byNumber.get(number) ?? (await this.viewViaGh(projectPath, number)));
        prs.push(pr);
      }
      return { ok: true, prs, unresolved };
    } catch (err) {
      return { ok: false, prs: [], unresolved: [...urls], error: errorText(err) };
    }
  }

  private async viewViaGh(projectPath: string, prNumber: number): Promise<PullRequest> {
    const raw = await this.runGh(
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,title,state,url,author,createdAt,updatedAt,headRefName,headRefOid,baseRefName,body,labels,statusCheckRollup,comments,isDraft,reviewDecision,isCrossRepository'
      ],
      projectPath
    );
    return this.fromGhItem(JSON.parse(raw));
  }

  // ─────────────── Ревью PR (TASK-81, decision-53): эти методы бросают ошибку, а не глотают её ───────────────

  private async strictBackend(projectPath: string): Promise<Exclude<Backend, { kind: 'none' }>> {
    const backend = await this.resolveBackend(projectPath);
    if (backend.kind === 'none') throw this.noBackendError(backend);
    return backend;
  }

  /** Открытые PR с головой для опроса `prWatcher`. Нет хостинга, авторизации или сети — исключение. */
  async listOpenPrsForWatch(projectPath: string): Promise<PrInfo[]> {
    const backend = await this.strictBackend(projectPath);
    if (backend.kind === 'connection') {
      return (await backend.adapter.list(backend.http, backend.repo, 'open')).map(prInfoFrom).filter((p): p is PrInfo => Boolean(p));
    }
    const raw = await this.runGh(
      ['pr', 'list', '--state', 'open', '--json', 'number,title,url,headRefOid,headRefName,baseRefName,isDraft,author', '--limit', '50'],
      projectPath
    );
    return parseGhPrList(raw);
  }

  /** Состояние PR, пропавшего из открытых (TASK-138.5): слит ли он. Сеть — только подключение или `gh`. */
  async getPrStateForWatch(projectPath: string, prNumber: number): Promise<PrStateInfo> {
    const backend = await this.strictBackend(projectPath);
    const pr = backend.kind === 'connection' ? await backend.adapter.get(backend.http, backend.repo, prNumber) : await this.viewViaGh(projectPath, prNumber);
    return {
      number: prNumber,
      state: pr.state,
      title: pr.title,
      url: pr.url,
      headRef: pr.sourceBranch,
      baseRef: pr.targetBranch,
      ...(pr.author && pr.author !== 'unknown' ? { author: pr.author } : {})
    };
  }

  async getPrForReview(projectPath: string, prNumber: number): Promise<PrReviewTarget> {
    const backend = await this.strictBackend(projectPath);
    if (backend.kind === 'connection') {
      const pr = await backend.adapter.get(backend.http, backend.repo, prNumber);
      if (!pr.headSha) throw new Error(`${backend.adapter.label} не вернул голову PR #${prNumber}`);
      return {
        number: prNumber,
        title: pr.title,
        body: pr.body,
        url: pr.url,
        headSha: pr.headSha,
        headRef: pr.sourceBranch,
        baseRef: pr.targetBranch,
        draft: pr.draft === true,
        state: pr.state
      };
    }
    const raw = await this.runGh(
      ['pr', 'view', String(prNumber), '--json', 'number,title,body,url,headRefOid,headRefName,baseRefName,isDraft,state'],
      projectPath
    );
    const r = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    if (!str(r.headRefOid)) throw new Error(`gh не вернул голову PR #${prNumber}`);
    return {
      number: prNumber,
      title: str(r.title) || `#${prNumber}`,
      body: str(r.body),
      url: str(r.url),
      headSha: str(r.headRefOid),
      headRef: str(r.headRefName),
      baseRef: str(r.baseRefName),
      draft: r.isDraft === true,
      state: str(r.state)
    };
  }

  async getPrDiffStrict(projectPath: string, prNumber: number): Promise<string> {
    const backend = await this.strictBackend(projectPath);
    if (backend.kind === 'connection') return backend.adapter.diff(backend.http, backend.repo, prNumber);
    return this.runGh(['pr', 'diff', String(prNumber)], projectPath);
  }

  /**
   * Голова PR в локальную ссылку `refs/projecthub/pr/<N>` — от неё строятся worktree ревьюеров.
   * Ссылка на голову у хостингов своя: `refs/pull/N/head`, `refs/merge-requests/N/head`, ветка у Bitbucket.
   */
  async fetchPrHead(projectPath: string, prNumber: number): Promise<{ ref: string; sha: string }> {
    const ref = `refs/projecthub/pr/${prNumber}`;
    const backend = await this.resolveBackend(projectPath);
    let refspec = `+refs/pull/${prNumber}/head:${ref}`;
    if (backend.kind === 'connection') {
      const pr = await backend.adapter.get(backend.http, backend.repo, prNumber);
      const spec = backend.adapter.headRefspec(pr, ref);
      if (!spec) throw new Error(`${backend.adapter.label}: голову PR #${prNumber} из форка получить нельзя`);
      refspec = spec;
    }
    const git = simpleGit(projectPath);
    await git.fetch('origin', refspec);
    const sha = (await git.revparse([ref])).trim();
    return { ref, sha };
  }

  /** Что увидит человек в запросе HITL на публикацию ревью (decision-53 п. 8). */
  async describeCommentTarget(projectPath: string, prNumber: number): Promise<{ command: string; tool: string }> {
    const backend = await this.resolveBackend(projectPath).catch(() => null);
    if (backend?.kind === 'connection') {
      return {
        command: `Комментарий в PR #${prNumber} (${backend.adapter.label}, ${backend.repo.path}) от подключения «${backend.connection.label}»`,
        tool: `${backend.adapter.id} pr comment`
      };
    }
    return { command: `gh pr comment ${prNumber} --body-file <текст ниже>`, tool: 'gh pr comment' };
  }

  /**
   * Сводный комментарий ревью. Единственный путь записи в PR из ревью — комментарий: через подключение
   * или `gh pr comment` (`ghCommentArgs`); approve и request changes невозможны (decision-53 п. 8).
   */
  async commentOnPr(projectPath: string, prNumber: number, body: string): Promise<string> {
    const backend = await this.strictBackend(projectPath);
    if (backend.kind === 'connection') return backend.adapter.comment(backend.http, backend.repo, prNumber, body);
    const file = path.join(os.tmpdir(), `projecthub-pr-${prNumber}-${Date.now()}.md`);
    await fs.writeFile(file, body, 'utf-8');
    try {
      return await this.runGh(ghCommentArgs(prNumber, file), projectPath);
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  async getPRDiff(projectPath: string, prNumber: number): Promise<string> {
    try {
      return await this.getPrDiffStrict(projectPath, prNumber);
    } catch (err) {
      console.error(`Failed to get diff for PR #${prNumber}:`, err);
      return '';
    }
  }

  /**
   * Задача из ветки или заголовка PR (`feat/task-8`, `TASK-8.2`) переходит в `Review`, ветка пишется в
   * `branch` (TASK-64), ссылка на PR — в нативное поле `references`: CLI Backlog.md выбрасывает
   * незнакомые поля frontmatter, а `references` сохраняет.
   */
  private async syncBacklogOnPRCreated(projectPath: string, branchName: string, prTitle: string, prUrl: string) {
    try {
      const [taskId] = taskIdsInText(`${branchName} ${prTitle}`);
      if (!taskId) return;

      const task = await findTaskFile(projectPath, taskId);
      if (!task) return;

      const data = { ...task.data };
      if (data.status !== 'Review' && data.status !== 'Done') data.status = 'Review';
      data.branch = branchName;
      if (prUrl) {
        const refs = Array.isArray(data.references) ? data.references.map(String) : [];
        if (!refs.includes(prUrl)) data.references = [...refs, prUrl];
      }

      const updated = matter.stringify(task.content, normalizeFrontmatter(withUpdatedDate(data)));
      await fs.writeFile(task.filePath, updated, 'utf-8');
    } catch (err) {
      console.error('Failed to sync Backlog task status on PR creation:', err);
    }
  }
}
