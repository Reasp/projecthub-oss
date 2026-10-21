import type { RemoteTaskSummary } from '../../../src/types/remote';
import { KANBAN_STATUSES } from './models';
import type { PhoneFleetHost } from './fleet';
import type { RpcMethod } from './remoteClient';

/**
 * Область главного экрана телефона (TASK-181, [[decision-139]]): узел дерева «Все → компьютеры → проекты», в котором
 * работает нижнее меню. Без React: выбор, фильтр записей и сборка общей доски задач проверяются unit-тестами.
 */

export type Scope =
  | { kind: 'all' }
  | { kind: 'host'; profileId: string }
  | { kind: 'project'; profileId: string; projectPath: string };

export const ALL_SCOPE: Scope = { kind: 'all' };

/** Ключ настроек телефона: область переживает перезапуск и переключение ПК. */
export const SCOPE_PREF = 'scope';

export function parseScope(raw: string | null | undefined): Scope {
  if (!raw) return ALL_SCOPE;
  try {
    const v = JSON.parse(raw) as Partial<{ kind: string; profileId: string; projectPath: string }>;
    if (v.kind === 'host' && typeof v.profileId === 'string' && v.profileId) return { kind: 'host', profileId: v.profileId };
    if (v.kind === 'project' && typeof v.profileId === 'string' && v.profileId && typeof v.projectPath === 'string' && v.projectPath) {
      return { kind: 'project', profileId: v.profileId, projectPath: v.projectPath };
    }
  } catch {
    // испорченная запись — «Все»
  }
  return ALL_SCOPE;
}

export function serializeScope(scope: Scope): string {
  return JSON.stringify(scope);
}

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'all') return true;
  if (a.profileId !== (b as { profileId: string }).profileId) return false;
  return a.kind === 'host' || a.projectPath === (b as { projectPath: string }).projectPath;
}

/** Компьютер области; у «Все» — нет. */
export function scopeProfileId(scope: Scope): string | null {
  return scope.kind === 'all' ? null : scope.profileId;
}

/** Забытый компьютер: область возвращается к «Все», а не показывает пустые вкладки. */
export function validScope(scope: Scope, profileIds: readonly string[]): Scope {
  return scope.kind === 'all' || profileIds.includes(scope.profileId) ? scope : ALL_SCOPE;
}

/**
 * Попадает ли запись компьютера `profileId` из проекта `projectPath` в область. Запись без проекта (событие хоста)
 * видна в области компьютера и «Все», но не проекта.
 */
export function inScope(scope: Scope, profileId: string, projectPath?: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.profileId !== profileId) return false;
  return scope.kind === 'host' || (Boolean(projectPath) && samePath(scope.projectPath, projectPath!));
}

/** Компьютер входит в область: «Все» или область этого компьютера либо его проекта. */
export function hostInScope(scope: Scope, profileId: string): boolean {
  return scope.kind === 'all' || scope.profileId === profileId;
}

/** Пути с хоста Windows приходят то с `\`, то с `/`, регистр букв диска разный. */
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/**
 * Путь — сам проект или внутри него: агент роя и участника общего хоста работает в `.worktrees/…` проекта, и его
 * запросы HITL несут путь worktree (decision-46 п. 2), а относятся к проекту (TASK-142.6).
 */
export function withinPath(child: string, root: string): boolean {
  const c = normPath(child);
  const r = normPath(root);
  return c === r || c.startsWith(`${r}/`);
}

export interface ScopeProjectRef {
  profileId: string;
  machineName: string;
  /** Компьютер открыт сейчас: его RPC идут соединением стора. */
  active: boolean;
  projectPath: string;
  projectName: string;
}

/** Проекты области на компьютерах в сети — в порядке дерева «Обзора». */
export function scopeProjects(fleet: readonly PhoneFleetHost[], scope: Scope): ScopeProjectRef[] {
  const out: ScopeProjectRef[] = [];
  for (const host of fleet) {
    if (!host.online || !hostInScope(scope, host.profileId)) continue;
    for (const p of host.overview?.projects ?? []) {
      if (!inScope(scope, host.profileId, p.path)) continue;
      out.push({ profileId: host.profileId, machineName: host.machineName, active: host.active, projectPath: p.path, projectName: p.name });
    }
  }
  return out;
}

export interface ScopedTask {
  ref: ScopeProjectRef;
  task: RemoteTaskSummary;
}

export interface ScopedColumn {
  status: string;
  tasks: ScopedTask[];
}

export type ScopeRpc = <T>(method: RpcMethod, params: Record<string, unknown>) => Promise<T>;

/**
 * Задачи всех проектов области: `get_tasks` по проекту, не больше `limit` запросов сразу. Проект, который не
 * ответил (нет связи, нет прав), попадает в `failed`, остальные показываются.
 */
export async function loadScopedTasks(
  refs: readonly ScopeProjectRef[],
  rpcFor: (ref: ScopeProjectRef) => ScopeRpc | null,
  limit = 4
): Promise<{ tasks: ScopedTask[]; failed: ScopeProjectRef[] }> {
  const results: Array<ScopedTask[] | null> = new Array(refs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const i = next++;
      const ref = refs[i];
      const rpc = rpcFor(ref);
      if (!rpc) continue;
      try {
        const list = await rpc<RemoteTaskSummary[]>('get_tasks', { projectPath: ref.projectPath });
        results[i] = Array.isArray(list) ? list.map((task) => ({ ref, task })) : [];
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, refs.length)) }, worker));
  return {
    tasks: results.flatMap((r) => r ?? []),
    failed: refs.filter((_, i) => results[i] === null)
  };
}

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Общая доска: колонки канбана по статусу, внутри — сначала важные, затем по проекту и номеру. */
export function groupScopedTasks(tasks: readonly ScopedTask[]): ScopedColumn[] {
  const columns = new Map<string, ScopedTask[]>();
  for (const s of KANBAN_STATUSES) columns.set(s, []);
  for (const t of tasks) {
    const status = t.task.status || 'To Do';
    if (!columns.has(status)) columns.set(status, []);
    columns.get(status)!.push(t);
  }
  const rank = (t: ScopedTask) => PRIORITY[String(t.task.priority ?? '').toLowerCase()] ?? 1;
  return [...columns.entries()].map(([status, list]) => ({
    status,
    tasks: [...list].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.ref.machineName.localeCompare(b.ref.machineName) ||
        a.ref.projectName.localeCompare(b.ref.projectName) ||
        a.task.id.localeCompare(b.task.id, undefined, { numeric: true })
    )
  }));
}
