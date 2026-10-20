import type {
  ConflictPolicy,
  FieldValues,
  RemoteStatus,
  RemoteTask,
  SyncBaseEntry,
  TrackerField,
  TrackerSyncConfig
} from './trackerTypes.js';
import { TRACKER_FIELDS } from './trackerTypes.js';

/**
 * План синхронизации задач с трекером (TASK-128, decision-103 п. 4–6): соответствие статусов и
 * трёхсторонний merge по полям. Чистый модуль: без файлов и сети — на входе снимки обеих сторон и база,
 * на выходе список действий.
 */

/** Задача проекта в том виде, который нужен синку. */
export interface LocalTaskInfo {
  id: string;
  title: string;
  description: string;
  status: string;
  labels: string[];
  /** id внешних задач этого адаптера из `references`. */
  links: string[];
  parentTaskId?: string;
}

export interface FieldConflict {
  field: TrackerField;
  winner: 'local' | 'remote';
  /** Перезаписанное значение проигравшей стороны (обрезано для журнала). */
  lost: string;
}

export type PlanAction =
  | { kind: 'import'; remote: RemoteTask; localStatus: string | null }
  | { kind: 'export'; local: LocalTaskInfo; remoteStatus: string | null }
  | {
      kind: 'update';
      externalId: string;
      taskId: string;
      title: string;
      /** Значения для записи в трекер. */
      push: Partial<FieldValues>;
      /** Значения для записи в файл задачи. */
      pull: Partial<FieldValues>;
      conflicts: FieldConflict[];
      /** Пары без базы: первая сверка на этой машине. */
      noBase: boolean;
      /** Состояние обеих сторон после применения (база до ответа трекера). */
      local: FieldValues;
      remote: FieldValues;
    }
  | { kind: 'base'; externalId: string; taskId: string; local: FieldValues; remote: FieldValues }
  | { kind: 'missingRemote'; externalId: string; taskId: string; title: string }
  | { kind: 'missingLocal'; externalId: string; taskId: string }
  | { kind: 'unmappedStatus'; externalId?: string; taskId?: string; status: string; side: 'local' | 'remote' };

export interface PlanInput {
  local: LocalTaskInfo[];
  remote: RemoteTask[];
  base: Record<string, SyncBaseEntry>;
  config: Pick<TrackerSyncConfig, 'statusMap' | 'conflictPolicy' | 'exportLabel' | 'importClosed'>;
  localStatuses: string[];
  remoteStatuses: RemoteStatus[];
}

const lc = (s: string) => s.trim().toLowerCase();

export function isClosedType(type: string): boolean {
  const t = lc(type);
  return t === 'closed' || t === 'done';
}

/**
 * Таблица по умолчанию (decision-103 п. 6): совпадение имени без регистра, `closed`/`done` — последний
 * статус Backlog.md, `open` — первый. Явные значения из `explicit` сохраняются, если такой статус есть у трекера.
 */
export function suggestStatusMap(
  localStatuses: readonly string[],
  remoteStatuses: readonly RemoteStatus[],
  explicit: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  const byName = new Map(remoteStatuses.map((s) => [lc(s.name), s.name]));
  const first = localStatuses[0];
  const last = localStatuses[localStatuses.length - 1];
  const open = remoteStatuses.find((s) => lc(s.type) === 'open');
  const closed = remoteStatuses.find((s) => isClosedType(s.type));
  for (const local of localStatuses) {
    const chosen = explicit[local] ? byName.get(lc(explicit[local])) : undefined;
    const named = byName.get(lc(local));
    const fallback = local === last && closed ? closed.name : local === first && open ? open.name : undefined;
    const value = chosen ?? named ?? fallback;
    if (value) out[local] = value;
  }
  return out;
}

export interface StatusMapping {
  toRemote(local: string): string | null;
  toLocal(remote: string, type?: string): string | null;
}

export function buildStatusMapping(
  localStatuses: readonly string[],
  remoteStatuses: readonly RemoteStatus[],
  statusMap: Record<string, string>
): StatusMapping {
  const remoteByName = new Map(remoteStatuses.map((s) => [lc(s.name), s]));
  const localByName = new Map(localStatuses.map((s) => [lc(s), s]));
  const forward = new Map<string, string>();
  for (const [local, remote] of Object.entries(statusMap)) {
    const l = localByName.get(lc(local));
    const r = remoteByName.get(lc(remote));
    if (l && r) forward.set(l, r.name);
  }
  return {
    toRemote: (local) => forward.get(localByName.get(lc(local)) ?? local) ?? null,
    toLocal: (remote, type) => {
      for (const [l, r] of forward) if (lc(r) === lc(remote)) return l;
      const named = localByName.get(lc(remote));
      if (named) return named;
      const t = type ?? remoteByName.get(lc(remote))?.type ?? '';
      if (isClosedType(t)) return localStatuses[localStatuses.length - 1] ?? null;
      if (lc(t) === 'open') return localStatuses[0] ?? null;
      return null;
    }
  };
}

/** Нормализация для сравнения: переводы строк, пробелы в концах строк, лишние пустые строки. */
export function normalizeField(field: TrackerField, value: string | undefined | null): string {
  const v = (value ?? '').replace(/\r\n?/g, '\n');
  if (field === 'description') {
    return v
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (field === 'status') return lc(v);
  return v.trim();
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function localValues(t: LocalTaskInfo): FieldValues {
  return { title: t.title, description: t.description, status: t.status };
}

function remoteValues(t: RemoteTask): FieldValues {
  return { title: t.title, description: t.description, status: t.status };
}

/** Трёхсторонний merge одной пары (decision-103 п. 4). */
export function planPair(
  externalId: string,
  local: LocalTaskInfo,
  remote: RemoteTask,
  base: SyncBaseEntry | undefined,
  mapping: StatusMapping,
  policy: ConflictPolicy
): PlanAction[] {
  const L = localValues(local);
  const R = remoteValues(remote);
  const nextL: FieldValues = { ...L };
  const nextR: FieldValues = { ...R };
  const push: Partial<FieldValues> = {};
  const pull: Partial<FieldValues> = {};
  const conflicts: FieldConflict[] = [];
  const extra: PlanAction[] = [];

  /** Значение для другой стороны; `null` — статус без соответствия. */
  const toRemote = (f: TrackerField): string | null => (f === 'status' ? mapping.toRemote(L.status) : L[f]);
  const toLocal = (f: TrackerField): string | null => (f === 'status' ? mapping.toLocal(R.status, remote.statusType) : R[f]);
  const equivalent = (f: TrackerField): boolean => {
    if (f !== 'status') return normalizeField(f, L[f]) === normalizeField(f, R[f]);
    const asRemote = mapping.toRemote(L.status);
    return (asRemote !== null && lc(asRemote) === lc(R.status)) || lc(mapping.toLocal(R.status, remote.statusType) ?? '') === lc(L.status);
  };
  // Непереносимое значение не попадает в базу: когда таблицу дополнят, изменение ещё будет видно.
  const doPush = (f: TrackerField): boolean => {
    const value = toRemote(f);
    if (value === null) {
      extra.push({ kind: 'unmappedStatus', externalId, taskId: local.id, status: L.status, side: 'local' });
      if (base) nextL[f] = base.local[f];
      return false;
    }
    push[f] = value;
    nextR[f] = value;
    return true;
  };
  const doPull = (f: TrackerField): boolean => {
    const value = toLocal(f);
    if (value === null) {
      extra.push({ kind: 'unmappedStatus', externalId, taskId: local.id, status: R.status, side: 'remote' });
      if (base) nextR[f] = base.remote[f];
      return false;
    }
    pull[f] = value;
    nextL[f] = value;
    return true;
  };

  for (const f of TRACKER_FIELDS) {
    if (equivalent(f)) continue;
    const localChanged = !base || normalizeField(f, L[f]) !== normalizeField(f, base.local[f]);
    const remoteChanged = !base || normalizeField(f, R[f]) !== normalizeField(f, base.remote[f]);
    if (localChanged && !remoteChanged) doPush(f);
    else if (remoteChanged && !localChanged) doPull(f);
    else if (localChanged && remoteChanged) {
      const winner = policy === 'remote' ? 'remote' : 'local';
      const applied = winner === 'local' ? doPush(f) : doPull(f);
      if (applied) conflicts.push({ field: f, winner, lost: clip(winner === 'local' ? R[f] : L[f]) });
    }
  }

  if (Object.keys(push).length > 0 || Object.keys(pull).length > 0) {
    extra.unshift({
      kind: 'update',
      externalId,
      taskId: local.id,
      title: local.title,
      push,
      pull,
      conflicts,
      noBase: !base,
      local: nextL,
      remote: nextR
    });
    return extra;
  }
  const baseStale = !base || TRACKER_FIELDS.some((f) => base.local[f] !== nextL[f] || base.remote[f] !== nextR[f]);
  if (baseStale) extra.unshift({ kind: 'base', externalId, taskId: local.id, local: nextL, remote: nextR });
  return extra;
}

/** План целиком: импорт, выгрузка, сверка пар, пропавшие с одной из сторон. */
export function planSync(input: PlanInput): PlanAction[] {
  const mapping = buildStatusMapping(input.localStatuses, input.remoteStatuses, input.config.statusMap);
  const remoteById = new Map(input.remote.map((t) => [t.id, t]));
  const linked = new Map<string, LocalTaskInfo>();
  for (const task of input.local) for (const id of task.links) if (!linked.has(id)) linked.set(id, task);

  const actions: PlanAction[] = [];

  for (const [externalId, local] of linked) {
    const remote = remoteById.get(externalId);
    if (!remote) {
      actions.push({ kind: 'missingRemote', externalId, taskId: local.id, title: local.title });
      continue;
    }
    actions.push(...planPair(externalId, local, remote, input.base[externalId], mapping, input.config.conflictPolicy));
  }

  // Импорт: внешняя задача без ссылки в проекте. Пара из базы без локальной задачи — удалена здесь, не импортируем снова.
  // Родители раньше подзадач: подзадача ищет локальный id родителя среди уже созданных.
  const depth = (task: RemoteTask): number => {
    let d = 0;
    for (let p = task.parentId; p && d < 10; p = remoteById.get(p)?.parentId) d += 1;
    return d;
  };
  const imports: Array<{ action: PlanAction; depth: number }> = [];
  for (const remote of input.remote) {
    if (linked.has(remote.id)) continue;
    const known = input.base[remote.id];
    if (known) {
      actions.push({ kind: 'missingLocal', externalId: remote.id, taskId: known.taskId });
      continue;
    }
    if (!input.config.importClosed && isClosedType(remote.statusType)) continue;
    const localStatus = mapping.toLocal(remote.status, remote.statusType);
    if (localStatus === null) actions.push({ kind: 'unmappedStatus', externalId: remote.id, status: remote.status, side: 'remote' });
    imports.push({ action: { kind: 'import', remote, localStatus }, depth: depth(remote) });
  }
  actions.push(...imports.sort((a, b) => a.depth - b.depth).map((i) => i.action));

  const label = lc(input.config.exportLabel ?? '');
  if (label) {
    for (const local of input.local) {
      if (local.links.length > 0 || !local.labels.some((l) => lc(l) === label)) continue;
      actions.push({ kind: 'export', local, remoteStatus: mapping.toRemote(local.status) });
    }
  }
  return actions;
}
