/**
 * Сводка хоста для дерева флота (TASK-174, decision-129 п. 5–6): все проекты реестра одним снимком — сессии Studio,
 * запуски агентов и роев, терминалы с CLI-агентом, ожидающие решения HITL, процессы и задачи.
 *
 * Сборка снимка — чистый `buildOverview` (`src/utils/fleetOverview.ts`); здесь — чтение источников с кэшем по времени
 * изменения файла, single-flight для одновременных клиентов и событие изменения с дебаунсом.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildOverview,
  lastOutputLine,
  OVERVIEW_LIMITS,
  type OverviewActions,
  type OverviewPendingInput,
  type OverviewProjectInput,
  type OverviewStudioInput,
  type OverviewSwarmInput,
  type OverviewTerminalInput,
  type RemoteOverview
} from '../../src/utils/fleetOverview.js';
import { summarizeStudioSession } from '../../src/utils/studioRemote.js';
import type { AISession } from '../../src/types/electron';
import type { HitlRequest } from './hitlTypes.js';
import type { SwarmSession } from './swarmTypes.js';

/** Дебаунс события `overview:changed` и предел ожидания от первого изменения. */
export const OVERVIEW_DEBOUNCE_MS = 800;
export const OVERVIEW_MAX_WAIT_MS = 3000;
/** Снимок, собранный не раньше этого, отдаётся следующему клиенту без пересборки, если ничего не менялось. */
const SNAPSHOT_TTL_MS = 30_000;

export interface FleetOverviewDeps {
  now(): number;
  hostId(): string;
  machineName(): string;
  platform: string;
  projects(): Promise<string[]>;
  /** Каталог сессий Studio проекта (`aiSessionStore.projectDir`). */
  studioDir(projectPath: string): string;
  studioRunning(sessionId: string): boolean;
  profileNames(): Promise<ReadonlyMap<string, string>>;
  swarms(projectPath: string): SwarmSession[];
  terminals(projectPath: string): OverviewTerminalInput[];
  pending(): HitlRequest[];
  processes(projectPath: string): Promise<Array<{ name: string; status: string }>>;
  log?(message: string): void;
}

interface FileCache<T> {
  mtimeMs: number;
  value: T;
}

/** `status:` из frontmatter задачи без разбора YAML целиком: снимок читает задачи всех проектов. */
export function taskStatusFromFrontmatter(raw: string): string | undefined {
  if (!raw.startsWith('---')) return undefined;
  const end = raw.indexOf('\n---', 3);
  const head = end > 0 ? raw.slice(0, end) : raw.slice(0, 2000);
  const m = head.match(/^status:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m);
  return m ? m[1].trim() : undefined;
}

/** Сессия Studio для снимка: последний ответ — ошибка или последняя строка ответа агента. */
export function studioInputFromSession(s: AISession, running: boolean, profileNames: ReadonlyMap<string, string>): OverviewStudioInput {
  const summary = summarizeStudioSession(s, { running, profileNames });
  const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant');
  const error = lastAssistant && !lastAssistant.content && lastAssistant.error ? lastAssistant.providerError?.message || lastAssistant.error : undefined;
  const lastLine = lastAssistant && typeof lastAssistant.content === 'string' ? lastOutputLine(lastAssistant.content) : undefined;
  const owner = (s as AISession & { memberId?: unknown }).memberId;
  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    running,
    archived: summary.archived,
    ...(error ? { error: String(error) } : {}),
    ...(summary.preview ? { preview: summary.preview } : {}),
    ...(lastLine ? { lastLine } : {}),
    ...(summary.modelLabel ? { modelLabel: summary.modelLabel } : {}),
    ...(typeof owner === 'string' && owner ? { ownerMemberId: owner } : {})
  };
}

export function swarmInput(s: SwarmSession): OverviewSwarmInput {
  const owner = (s as SwarmSession & { memberId?: unknown }).memberId;
  return {
    id: s.id,
    mode: s.mode,
    status: s.status,
    ...(s.taskId ? { taskId: s.taskId } : {}),
    ...(s.taskTitle ? { taskTitle: s.taskTitle } : {}),
    ...(s.origin ? { origin: s.origin } : {}),
    createdAt: s.createdAt,
    ...(s.completedAt ? { completedAt: s.completedAt } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.error && s.errorKey ? { errorKey: s.errorKey } : {}),
    agents: s.agents.map((a) => {
      const line = lastOutputLine(a.liveOutput || a.finalOutput || '');
      return {
        id: a.id,
        name: a.config.name,
        ...(a.config.roleSlug ? { roleSlug: a.config.roleSlug } : {}),
        ...(a.config.engine ? { engine: a.config.engine } : {}),
        status: a.status,
        ...(a.error ? { error: a.error } : {}),
        ...(a.error && a.errorKey ? { errorKey: a.errorKey } : {}),
        ...(line ? { lastLine: line } : {})
      };
    }),
    ...(typeof owner === 'string' && owner ? { ownerMemberId: owner } : {})
  };
}

export function pendingInput(r: HitlRequest): OverviewPendingInput {
  return {
    requestId: r.id,
    sessionId: r.sessionId,
    projectPath: r.projectPath,
    title: r.title,
    ...(r.textKey ? { textKey: r.textKey } : {}),
    ...(r.risk ? { risk: r.risk } : {}),
    ...(r.tool ? { tool: r.tool } : {}),
    ...(r.origin ? { origin: r.origin } : {}),
    ...(r.agentName ? { agentName: r.agentName } : {}),
    ...(r.role ? { role: r.role } : {}),
    createdAt: r.createdAt
  };
}

export class FleetOverviewService {
  private studioCache = new Map<string, FileCache<AISession | null>>();
  private taskCache = new Map<string, FileCache<string | undefined>>();
  private inflight: Promise<RemoteOverview> | null = null;
  private snapshot: { at: number; overview: RemoteOverview } | null = null;
  private listeners = new Set<() => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt = 0;

  constructor(private readonly deps: FleetOverviewDeps) {}

  /**
   * Снимок с правами устройства: данные одни на всех, `actions` — свои. Одновременные запросы ждут одну сборку.
   */
  public async getOverview(actions: OverviewActions): Promise<RemoteOverview> {
    const now = this.deps.now();
    if (this.snapshot && now - this.snapshot.at < SNAPSHOT_TTL_MS) return { ...this.snapshot.overview, actions };
    if (!this.inflight) {
      this.inflight = this.build()
        .then((overview) => {
          this.snapshot = { at: this.deps.now(), overview };
          return overview;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return { ...(await this.inflight), actions };
  }

  /** Что-то изменилось: кэш снимка сбрасывается, подписчики узнают об этом с дебаунсом. */
  public markChanged(): void {
    this.snapshot = null;
    const now = this.deps.now();
    if (!this.debounceTimer) this.firstChangeAt = now;
    else clearTimeout(this.debounceTimer);
    const wait = Math.max(0, Math.min(OVERVIEW_DEBOUNCE_MS, this.firstChangeAt + OVERVIEW_MAX_WAIT_MS - now));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          // подписчик не роняет источник изменения
        }
      }
    }, wait);
  }

  public onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.listeners.clear();
  }

  private async build(): Promise<RemoteOverview> {
    const [paths, profileNames] = await Promise.all([this.deps.projects(), this.deps.profileNames().catch(() => new Map<string, string>())]);
    const projects = await Promise.all(paths.map((p) => this.projectInput(p, profileNames)));
    return buildOverview({
      now: this.deps.now(),
      hostId: this.deps.hostId(),
      machineName: this.deps.machineName(),
      platform: this.deps.platform,
      actions: 'none',
      projects,
      pending: this.deps.pending().map(pendingInput)
    });
  }

  private async projectInput(projectPath: string, profileNames: ReadonlyMap<string, string>): Promise<OverviewProjectInput> {
    const [studio, processes, tasks] = await Promise.all([
      this.studioSessions(projectPath, profileNames),
      this.deps.processes(projectPath).catch(() => []),
      this.taskStatuses(projectPath)
    ]);
    return {
      path: projectPath,
      name: path.basename(projectPath),
      studio,
      swarms: this.deps.swarms(projectPath).map(swarmInput),
      terminals: this.deps.terminals(projectPath),
      processes,
      tasks: tasks.map((status) => ({ status }))
    };
  }

  /** Сессии Studio, изменённые за окно снимка; файл перечитывается, только если изменился. */
  private async studioSessions(projectPath: string, profileNames: ReadonlyMap<string, string>): Promise<OverviewStudioInput[]> {
    const dir = this.deps.studioDir(projectPath);
    const since = this.deps.now() - OVERVIEW_LIMITS.quietWindowMs;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: OverviewStudioInput[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'project.json') continue;
      const file = path.join(dir, name);
      const id = name.slice(0, -'.json'.length);
      const running = this.deps.studioRunning(id);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < since && !running) continue;
      const session = await this.cached(this.studioCache, file, mtimeMs, async () => {
        // Поля сессии лежат в корне файла рядом с `version` (decision-104), как их читает `aiSessionStore`.
        const s = JSON.parse(await fs.readFile(file, 'utf8')) as AISession | null;
        return s && typeof s === 'object' && s.id === id && Array.isArray(s.messages) ? s : null;
      });
      if (session) out.push(studioInputFromSession(session, running, profileNames));
    }
    return out;
  }

  private async taskStatuses(projectPath: string): Promise<string[]> {
    const dir = path.join(projectPath, 'backlog', 'tasks');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      const status = await this.cached(this.taskCache, file, mtimeMs, async () => {
        const handle = await fs.open(file, 'r');
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
          return taskStatusFromFrontmatter(buf.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await handle.close();
        }
      });
      if (status) out.push(status);
    }
    return out;
  }

  private async cached<T>(cache: Map<string, FileCache<T>>, file: string, mtimeMs: number, read: () => Promise<T>): Promise<T | undefined> {
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    try {
      const value = await read();
      cache.set(file, { mtimeMs, value });
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
      return value;
    } catch (err) {
      this.deps.log?.(`[FleetOverview] Could not read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
