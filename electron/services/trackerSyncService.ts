import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findTrackerAdapter, TRACKER_ADAPTERS } from './trackerAdapters.js';
import type { TrackerAdapter, TrackerHttp, TrackerLinkContext } from './trackerAdapter.js';
import { planSync, suggestStatusMap, type PlanAction } from './trackerSyncPlan.js';
import {
  createLocalTaskFromRemote,
  projectStatuses,
  readLocalTasks,
  sanitizeRemoteDescription,
  sanitizeRemoteTitle,
  updateLocalTaskFile
} from './trackerLocalTasks.js';
import type {
  FieldValues,
  RemoteStatus,
  RemoteTask,
  SyncBaseEntry,
  TrackerJournalEntry,
  TrackerJournalKind,
  TrackerRunSummary,
  TrackerSyncConfig,
  TrackerSyncLocalState,
  TrackerSyncStatusView,
  TrackerTargetGroup
} from './trackerTypes.js';
import type { ConnectionUsage } from './connectionTypes.js';
import { ConnectionAuthError } from './connectionTypes.js';
import { AppError, appErrorFields, type AppErrorKey } from '../../src/lib/appError.js';

/**
 * Синхронизация задач Backlog.md с внешним трекером (TASK-128, decision-103).
 *
 * Настройка проекта — `.projecthub/tracker-sync.json` (в git); подключение, база сверки, интервал и журнал —
 * `<userData>/tracker-sync/<хэш пути>.json`. Сеть идёт только через `authorizedFetch` выбранного подключения.
 */

export const PROJECT_CONFIG_PATH = path.join('.projecthub', 'tracker-sync.json');
export const STATE_DIR_NAME = 'tracker-sync';
const MAX_RUNS = 20;
const MAX_ENTRIES = 300;
/** Сколько пропавших из списка задач за запуск проверить запросом: не переехали ли они (переименование). */
const MAX_MOVED_LOOKUPS = 20;
const SCHEDULER_TICK_MS = 60_000;

export interface TrackerSyncDeps {
  userDataDir: () => string;
  authorizedFetch: (connectionId: string, target: string, init?: RequestInit) => Promise<Response>;
  /** Описание подключения для журнала, проверки сервиса и ссылок (decision-106 п. 2); `null` — подключения нет. */
  getConnection: (connectionId: string) => Promise<{ serviceId: string; label: string; baseUrl?: string } | null>;
  listProjectRoots?: () => Promise<string[]>;
  adapters?: readonly TrackerAdapter[];
  now?: () => number;
}

export function defaultTrackerConfig(): TrackerSyncConfig {
  return { version: 1, enabled: false, adapter: 'clickup', target: null, statusMap: {}, conflictPolicy: 'backlog', exportLabel: '', importClosed: false };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeTrackerConfig(raw: unknown): TrackerSyncConfig {
  const d = defaultTrackerConfig();
  if (!isObject(raw)) return d;
  const target = isObject(raw.target) && typeof raw.target.id === 'string' && raw.target.id
    ? { id: raw.target.id, name: typeof raw.target.name === 'string' ? raw.target.name : raw.target.id, ...(typeof raw.target.path === 'string' ? { path: raw.target.path } : {}) }
    : null;
  const statusMap: Record<string, string> = {};
  if (isObject(raw.statusMap)) for (const [k, v] of Object.entries(raw.statusMap)) if (typeof v === 'string' && v) statusMap[k] = v;
  return {
    version: 1,
    enabled: raw.enabled === true,
    adapter: typeof raw.adapter === 'string' && raw.adapter ? raw.adapter : d.adapter,
    target,
    statusMap,
    conflictPolicy: raw.conflictPolicy === 'remote' ? 'remote' : 'backlog',
    exportLabel: typeof raw.exportLabel === 'string' ? raw.exportLabel.trim() : '',
    importClosed: raw.importClosed === true
  };
}

function normalizeState(raw: unknown, projectPath: string): TrackerSyncLocalState {
  const o = isObject(raw) ? raw : {};
  const base: Record<string, SyncBaseEntry> = {};
  if (isObject(o.base)) {
    for (const [id, e] of Object.entries(o.base)) {
      if (!isObject(e) || typeof e.taskId !== 'string' || !isObject(e.local) || !isObject(e.remote)) continue;
      const fv = (x: Record<string, unknown>): FieldValues => ({ title: String(x.title ?? ''), description: String(x.description ?? ''), status: String(x.status ?? '') });
      base[id] = { taskId: e.taskId, local: fv(e.local), remote: fv(e.remote), at: Number(e.at) || 0 };
    }
  }
  const interval = Number(o.intervalMinutes);
  return {
    version: 1,
    projectPath,
    connectionId: typeof o.connectionId === 'string' && o.connectionId ? o.connectionId : null,
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? Math.min(Math.round(interval), 24 * 60) : 0,
    base,
    runs: Array.isArray(o.runs) ? (o.runs as TrackerRunSummary[]).slice(-MAX_RUNS) : []
  };
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, body, 'utf-8');
  try {
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    await fs.writeFile(file, body, 'utf-8');
  }
}

function projectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return createHash('sha1').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 16);
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Значения локальной стороны в том виде, в каком они лягут в файл (без маркеров Backlog.md в описании).
 * Иначе база помнила бы исходный текст трекера, и следующий запуск принял бы очистку за правку.
 */
function asWritten(values: FieldValues): FieldValues {
  return { title: sanitizeRemoteTitle(values.title), description: sanitizeRemoteDescription(values.description), status: values.status };
}

function errorText(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), 300);
}

/** Ошибка записи журнала или запуска: обрезанный английский текст и код (decision-165). */
function errorFields(err: unknown): { error: string; errorKey?: AppErrorKey } {
  const { errorKey } = appErrorFields(err);
  return errorKey ? { error: errorText(err), errorKey } : { error: errorText(err) };
}

function errorDetail(err: unknown): { detail: string; detailKey?: AppErrorKey } {
  const { error, errorKey } = errorFields(err);
  return errorKey ? { detail: error, detailKey: errorKey } : { detail: error };
}

export class TrackerSyncService {
  private readonly deps: TrackerSyncDeps;
  private readonly states = new Map<string, TrackerSyncLocalState>();
  private readonly configs = new Map<string, TrackerSyncConfig>();
  private readonly running = new Map<string, { dryRun: boolean; job: Promise<TrackerRunSummary> }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: TrackerSyncDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get adapters(): readonly TrackerAdapter[] {
    return this.deps.adapters ?? TRACKER_ADAPTERS;
  }

  private statePath(projectPath: string): string {
    return path.join(this.deps.userDataDir(), STATE_DIR_NAME, `${projectKey(projectPath)}.json`);
  }

  async readConfig(projectPath: string): Promise<TrackerSyncConfig> {
    try {
      const config = normalizeTrackerConfig(JSON.parse(await fs.readFile(path.join(projectPath, PROJECT_CONFIG_PATH), 'utf-8')));
      this.configs.set(path.resolve(projectPath), config);
      return config;
    } catch {
      return defaultTrackerConfig();
    }
  }

  private async readState(projectPath: string): Promise<TrackerSyncLocalState> {
    const key = path.resolve(projectPath);
    const cached = this.states.get(key);
    if (cached) return cached;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await fs.readFile(this.statePath(projectPath), 'utf-8'));
    } catch {
      // нет состояния — синк на этой машине ещё не настраивали
    }
    const state = normalizeState(raw, key);
    this.states.set(key, state);
    return state;
  }

  private async saveState(state: TrackerSyncLocalState): Promise<void> {
    this.states.set(state.projectPath, state);
    await writeJsonAtomic(this.statePath(state.projectPath), state);
  }

  adapterList() {
    return this.adapters.map((a) => ({ id: a.id, label: a.label, serviceId: a.serviceId }));
  }

  async getStatus(projectPath: string): Promise<TrackerSyncStatusView> {
    const config = await this.readConfig(projectPath);
    const state = await this.readState(projectPath);
    return {
      projectPath: state.projectPath,
      config,
      connectionId: state.connectionId,
      intervalMinutes: state.intervalMinutes,
      linkedTasks: Object.keys(state.base).length,
      running: this.running.has(state.projectPath),
      lastRun: state.runs[state.runs.length - 1] ?? null,
      adapters: this.adapterList()
    };
  }

  /** Сохранить настройку проекта и/или машинное состояние. Смена цели или трекера сбрасывает базу сверки. */
  async saveSettings(
    projectPath: string,
    patch: { config?: Partial<TrackerSyncConfig>; connectionId?: string | null; intervalMinutes?: number }
  ): Promise<TrackerSyncStatusView> {
    if (patch.config) {
      const current = await this.readConfig(projectPath);
      const next = normalizeTrackerConfig({ ...current, ...patch.config });
      if (!findTrackerAdapter(next.adapter, this.adapters)) throw new AppError('tracker.unknown', { tracker: next.adapter });
      await writeJsonAtomic(path.join(projectPath, PROJECT_CONFIG_PATH), next);
      this.configs.set(path.resolve(projectPath), next);
      // Другая цель или другой трекер — прежняя база сверки к ним не относится.
      if (current.target?.id !== next.target?.id || current.adapter !== next.adapter) {
        const state = await this.readState(projectPath);
        state.base = {};
        await this.saveState(state);
      }
    }
    if (patch.connectionId !== undefined || patch.intervalMinutes !== undefined) {
      const state = await this.readState(projectPath);
      if (patch.connectionId !== undefined) state.connectionId = patch.connectionId || null;
      if (patch.intervalMinutes !== undefined) state.intervalMinutes = normalizeState({ intervalMinutes: patch.intervalMinutes }, '').intervalMinutes;
      await this.saveState(state);
    }
    return this.getStatus(projectPath);
  }

  /** Адаптер, подключение, функция сети и контекст ссылок для проекта. */
  private async context(
    projectPath: string
  ): Promise<{ config: TrackerSyncConfig; state: TrackerSyncLocalState; adapter: TrackerAdapter; http: TrackerHttp; link: TrackerLinkContext }> {
    const config = await this.readConfig(projectPath);
    const state = await this.readState(projectPath);
    const adapter = findTrackerAdapter(config.adapter, this.adapters);
    if (!adapter) throw new AppError('tracker.unknown', { tracker: config.adapter });
    if (!state.connectionId) throw new AppError('tracker.chooseConnection');
    const connection = await this.deps.getConnection(state.connectionId);
    if (!connection) throw new AppError('tracker.connectionMissing');
    if (connection.serviceId !== adapter.serviceId) throw new AppError('tracker.connectionMismatch', { tracker: adapter.label });
    const connectionId = state.connectionId;
    return {
      config,
      state,
      adapter,
      http: (target, init) => this.deps.authorizedFetch(connectionId, target, init),
      link: { webBase: connection.baseUrl ?? '' }
    };
  }

  async listTargets(projectPath: string): Promise<TrackerTargetGroup[]> {
    const { adapter, http } = await this.context(projectPath);
    return adapter.listTargets(http);
  }

  /** Статусы цели и предложенная таблица соответствия. */
  async describeTarget(projectPath: string): Promise<{ localStatuses: string[]; remoteStatuses: RemoteStatus[]; suggested: Record<string, string> }> {
    const { config, adapter, http } = await this.context(projectPath);
    if (!config.target) throw new AppError('tracker.chooseTarget');
    const localStatuses = await projectStatuses(projectPath);
    const remoteStatuses = await adapter.getStatuses(http, config.target);
    return { localStatuses, remoteStatuses, suggested: suggestStatusMap(localStatuses, remoteStatuses, config.statusMap) };
  }

  /** Предпросмотр: план без записи (decision-103 п. 8). */
  preview(projectPath: string): Promise<TrackerRunSummary> {
    return this.execute(projectPath, true);
  }

  run(projectPath: string): Promise<TrackerRunSummary> {
    return this.execute(projectPath, false);
  }

  private execute(projectPath: string, dryRun: boolean): Promise<TrackerRunSummary> {
    const key = path.resolve(projectPath);
    const pending = this.running.get(key);
    // Тот же режим уже идёт — его итог. Другой (запуск во время предпросмотра) — после него, а не итог предпросмотра.
    if (pending) {
      if (pending.dryRun === dryRun) return pending.job;
      return pending.job.then(
        () => this.execute(projectPath, dryRun),
        () => this.execute(projectPath, dryRun)
      );
    }
    const job = this.runOnce(key, dryRun).finally(() => this.running.delete(key));
    this.running.set(key, { dryRun, job });
    return job;
  }

  private async runOnce(projectPath: string, dryRun: boolean): Promise<TrackerRunSummary> {
    const at = this.now();
    const entries: TrackerJournalEntry[] = [];
    const finish = async (ok: boolean, failure?: unknown, state?: TrackerSyncLocalState): Promise<TrackerRunSummary> => {
      const error = failure === undefined ? undefined : errorFields(failure);
      const counts: Partial<Record<TrackerJournalKind, number>> = {};
      for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      const summary: TrackerRunSummary = { at, finishedAt: this.now(), dryRun, ok, ...(error ?? {}), counts, entries: entries.slice(0, MAX_ENTRIES) };
      if (!dryRun && state) {
        state.runs = [...state.runs, summary].slice(-MAX_RUNS);
        await this.saveState(state);
      }
      // Счётчики без заголовков и описаний: в лог не попадает содержимое задач.
      console.log(
        `[TrackerSync] ${dryRun ? 'Preview' : 'Run'} ${ok ? 'ok' : `failed (${error?.error})`}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'no changes'}`
      );
      return summary;
    };

    let ctx: Awaited<ReturnType<TrackerSyncService['context']>>;
    try {
      ctx = await this.context(projectPath);
    } catch (err) {
      return finish(false, err);
    }
    const { config, state, adapter, http, link } = ctx;
    if (!config.target) return finish(false, new AppError('tracker.chooseTarget'), state);
    if (!dryRun && !config.enabled) return finish(false, new AppError('tracker.disabled'), state);

    let actions: PlanAction[];
    const localById = new Map<string, Awaited<ReturnType<typeof readLocalTasks>>[number]>();
    let localStatuses: string[];
    const remoteIds = new Set<string>();
    // Связь «внешний id → локальный id» для подзадач: уже связанные и созданные в этом запуске.
    const localOf = new Map<string, string>();
    try {
      const [remoteStatuses, remoteAll, all] = await Promise.all([
        adapter.getStatuses(http, config.target),
        adapter.listTasks(http, config.target),
        readLocalTasks(projectPath, (ref) => adapter.parseLink(ref, link))
      ]);
      localStatuses = await projectStatuses(projectPath);
      // Архивная задача не синхронизируется, но её внешняя задача занята — иначе её импортировали бы заново.
      const archivedLinks = new Set(all.filter((t) => t.archived).flatMap((t) => t.links));
      const local = all.filter((t) => !t.archived);
      const remote = remoteAll.filter((r) => !archivedLinks.has(r.id));
      for (const t of all) for (const id of t.links) localOf.set(id, t.id);
      for (const t of local) localById.set(t.id, t);
      for (const r of remote) remoteIds.add(r.id);
      actions = planSync({ local, remote, base: state.base, config, localStatuses, remoteStatuses });
    } catch (err) {
      return finish(false, err, state);
    }

    const lookups = { left: MAX_MOVED_LOOKUPS };
    for (const action of actions) {
      try {
        await this.apply(action, { projectPath, dryRun, state, adapter, http, link, config, localById, localOf, localStatuses, entries, remoteIds, lookups });
      } catch (err) {
        if (err instanceof ConnectionAuthError) {
          entries.push({ kind: 'error', ...errorDetail(err) });
          return finish(false, err, state);
        }
        const ref = 'externalId' in action ? action.externalId : action.kind === 'import' ? action.remote.id : undefined;
        const taskId = 'taskId' in action ? action.taskId : action.kind === 'export' ? action.local.id : undefined;
        entries.push({ kind: 'error', ...(taskId ? { taskId } : {}), ...(ref ? { externalId: ref } : {}), ...errorDetail(err) });
      }
    }
    return finish(!entries.some((e) => e.kind === 'error'), undefined, state);
  }

  private async apply(
    action: PlanAction,
    c: {
      projectPath: string;
      dryRun: boolean;
      state: TrackerSyncLocalState;
      adapter: TrackerAdapter;
      http: TrackerHttp;
      link: TrackerLinkContext;
      config: TrackerSyncConfig;
      localById: Map<string, { filePath: string; title: string }>;
      localOf: Map<string, string>;
      localStatuses: string[];
      entries: TrackerJournalEntry[];
      /** id задач трекера из списка этого запуска. */
      remoteIds: Set<string>;
      lookups: { left: number };
    }
  ): Promise<void> {
    const { state, adapter, http, entries, dryRun } = c;
    const setBase = (externalId: string, taskId: string, local: FieldValues, remote: FieldValues) => {
      if (!dryRun) state.base[externalId] = { taskId, local, remote, at: this.now() };
    };
    const remoteFields = (t: RemoteTask): FieldValues => ({ title: t.title, description: t.description, status: t.status });

    switch (action.kind) {
      case 'base':
        setBase(action.externalId, action.taskId, action.local, action.remote);
        return;
      case 'missingRemote': {
        // Переименование репозитория GitHub или ключа команды Linear меняет id: сервис находит задачу по старому id
        // (редирект, прежний идентификатор) и отдаёт новый — ссылка переписывается вместо повторного импорта.
        const moved = await this.movedTask(action.externalId, c);
        if (moved) {
          const file = c.localById.get(action.taskId);
          if (!file) throw new AppError('tracker.taskFileNotFound', { id: action.taskId });
          if (!dryRun) {
            await updateLocalTaskFile(file.filePath, {
              dropReference: (ref) => adapter.parseLink(ref, c.link) === action.externalId,
              addReference: adapter.linkFor(moved.id, { ...c.link, url: moved.url })
            });
            const base = state.base[action.externalId];
            if (base) state.base[moved.id] = base;
            delete state.base[action.externalId];
          }
          c.localOf.set(moved.id, action.taskId);
          entries.push({ kind: 'relinked', taskId: action.taskId, externalId: moved.id, title: clip(action.title), detail: action.externalId });
          return;
        }
        entries.push({ kind: 'missingRemote', taskId: action.taskId, externalId: action.externalId, title: clip(action.title) });
        return;
      }
      case 'missingLocal':
        entries.push({ kind: 'missingLocal', taskId: action.taskId, externalId: action.externalId });
        return;
      case 'relink': {
        const file = c.localById.get(action.taskId);
        if (!file) throw new AppError('tracker.taskFileNotFound', { id: action.taskId });
        if (!dryRun) await updateLocalTaskFile(file.filePath, { addReference: adapter.linkFor(action.externalId, { ...c.link, ...(action.url ? { url: action.url } : {}) }) });
        c.localOf.set(action.externalId, action.taskId);
        entries.push({ kind: 'relinked', taskId: action.taskId, externalId: action.externalId, title: clip(file.title) });
        return;
      }
      case 'duplicateLink':
        entries.push({
          kind: 'error',
          externalId: action.externalId,
          ...errorDetail(new AppError('tracker.duplicateLink', { id: action.externalId, tasks: action.taskIds.join(', ') }))
        });
        return;
      case 'unmappedStatus':
        entries.push({
          kind: 'unmappedStatus',
          ...(action.taskId ? { taskId: action.taskId } : {}),
          ...(action.externalId ? { externalId: action.externalId } : {}),
          detail: `${action.side === 'local' ? 'Backlog.md' : c.adapter.label}: «${action.status}»`
        });
        return;
      case 'update': {
        const file = c.localById.get(action.taskId);
        for (const conflict of action.conflicts) {
          entries.push({
            kind: 'conflict',
            taskId: action.taskId,
            externalId: action.externalId,
            title: clip(action.title),
            fields: [conflict.field],
            ...errorDetail(
              new AppError(action.noBase ? 'tracker.conflictNoBase' : 'tracker.conflict', {
                winner: conflict.winner === 'local' ? 'Backlog.md' : adapter.label,
                lost: conflict.lost
              })
            )
          });
        }
        const pullFields = Object.keys(action.pull) as (keyof FieldValues)[];
        const pushFields = Object.keys(action.push) as (keyof FieldValues)[];
        let remoteAfter = action.remote;
        if (pushFields.length > 0) {
          if (!dryRun) remoteAfter = remoteFields(await adapter.updateTask(http, action.externalId, action.push));
          entries.push({ kind: 'push', taskId: action.taskId, externalId: action.externalId, title: clip(action.title), fields: pushFields });
        }
        if (pullFields.length > 0) {
          if (!file) throw new AppError('tracker.taskFileNotFound', { id: action.taskId });
          if (!dryRun) await updateLocalTaskFile(file.filePath, { fields: action.pull });
          entries.push({ kind: 'pull', taskId: action.taskId, externalId: action.externalId, title: clip(action.title), fields: pullFields });
        }
        setBase(action.externalId, action.taskId, asWritten(action.local), remoteAfter);
        return;
      }
      case 'import': {
        const r = action.remote;
        const status = action.localStatus ?? c.localStatuses[0] ?? 'To Do';
        // Уже связана в этом запуске: задача переехала (переименование) и ссылка переписана выше.
        if (c.localOf.has(r.id)) return;
        const parentTaskId = r.parentId ? c.localOf.get(r.parentId) : undefined;
        // Номер новой задачи выдаётся при записи: в предпросмотре его нет, окно пишет «новая».
        let taskId: string | undefined;
        if (!dryRun) {
          const created = await createLocalTaskFromRemote(c.projectPath, {
            title: r.title,
            description: r.description,
            status,
            reference: adapter.linkFor(r.id, { ...c.link, url: r.url }),
            ...(parentTaskId ? { parentTaskId } : {})
          });
          taskId = created.id;
          c.localOf.set(r.id, created.id);
          setBase(r.id, created.id, asWritten({ title: r.title, description: r.description, status }), remoteFields(r));
        }
        entries.push({ kind: 'import', ...(taskId ? { taskId } : {}), externalId: r.id, title: clip(r.title) });
        return;
      }
      case 'export': {
        const l = action.local;
        const file = c.localById.get(l.id);
        let externalId: string | undefined;
        if (!dryRun) {
          if (!file || !c.config.target) throw new AppError('tracker.taskFileNotFound', { id: l.id });
          const parentExternal = l.parentTaskId
            ? [...c.localOf.entries()].find(([, local]) => local === l.parentTaskId)?.[0]
            : undefined;
          const created = await adapter.createTask(http, c.config.target, {
            title: l.title,
            description: l.description,
            ...(action.remoteStatus ? { status: action.remoteStatus } : {}),
            ...(parentExternal ? { parentId: parentExternal } : {})
          });
          externalId = created.id;
          // База — на диск сразу после создания во внешнем трекере: если запись ссылки в файл сорвётся, следующий
          // запуск вернёт ссылку по базе (`relink`), а не выгрузит задачу второй раз.
          setBase(created.id, l.id, { title: l.title, description: l.description, status: l.status }, remoteFields(created));
          await this.saveState(state);
          await updateLocalTaskFile(file.filePath, { addReference: adapter.linkFor(created.id, { ...c.link, url: created.url }) });
          c.localOf.set(created.id, l.id);
        }
        entries.push({ kind: 'export', taskId: l.id, ...(externalId ? { externalId } : {}), title: clip(l.title) });
        return;
      }
    }
  }

  /**
   * Новая версия пропавшей из списка задачи: сервис нашёл её по старому id и вернул другой id, который есть в списке
   * этого запуска и ещё ни с чем не связан. Ошибки поиска (кроме входа) — не переезд.
   */
  private async movedTask(
    oldId: string,
    c: { adapter: TrackerAdapter; http: TrackerHttp; remoteIds: Set<string>; localOf: Map<string, string>; lookups: { left: number } }
  ): Promise<RemoteTask | null> {
    if (c.lookups.left <= 0) return null;
    c.lookups.left -= 1;
    let found: RemoteTask | null;
    try {
      found = await c.adapter.getTask(c.http, oldId);
    } catch (err) {
      if (err instanceof ConnectionAuthError) throw err;
      return null;
    }
    if (!found || found.id === oldId || !c.remoteIds.has(found.id) || c.localOf.has(found.id)) return null;
    return found;
  }

  /** Какие проекты используют подключения — для окна «Подключения» (decision-102 п. 7). */
  usages(): ConnectionUsage[] {
    const out: ConnectionUsage[] = [];
    for (const state of this.states.values()) {
      if (!state.connectionId) continue;
      const config = this.configs.get(state.projectPath);
      const adapter = findTrackerAdapter(config?.adapter ?? 'clickup', this.adapters);
      out.push({ connectionId: state.connectionId, label: `${adapter?.label ?? 'Tracker'} → ${path.basename(state.projectPath)}` });
    }
    return out;
  }

  /** Загрузить состояния всех проектов этой машины (для окна подключений и интервала). */
  async loadAllStates(): Promise<void> {
    const dir = path.join(this.deps.userDataDir(), STATE_DIR_NAME);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
        if (!isObject(raw) || typeof raw.projectPath !== 'string') continue;
        const state = normalizeState(raw, raw.projectPath);
        this.states.set(state.projectPath, state);
        await this.readConfig(state.projectPath);
      } catch {
        // битое состояние одного проекта не мешает остальным
      }
    }
  }

  /** Проекты, которым пора синхронизироваться по интервалу этой машины (decision-103 п. 7). */
  async dueProjects(): Promise<string[]> {
    const roots = this.deps.listProjectRoots ? new Set((await this.deps.listProjectRoots()).map((p) => path.resolve(p))) : null;
    const due: string[] = [];
    for (const state of this.states.values()) {
      if (state.intervalMinutes <= 0 || !state.connectionId) continue;
      if (roots && !roots.has(state.projectPath)) continue;
      const config = await this.readConfig(state.projectPath);
      if (!config.enabled || !config.target) continue;
      const last = state.runs[state.runs.length - 1]?.at ?? 0;
      if (this.now() - last >= state.intervalMinutes * 60_000) due.push(state.projectPath);
    }
    return due;
  }

  startScheduler(): void {
    if (this.timer) return;
    void this.loadAllStates();
    this.timer = setInterval(() => {
      void this.dueProjects()
        .then((due) => Promise.all(due.map((p) => this.run(p).catch(() => undefined))))
        .catch((err) => console.warn('[TrackerSync] Scheduler tick failed:', errorText(err)));
    }, SCHEDULER_TICK_MS);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
