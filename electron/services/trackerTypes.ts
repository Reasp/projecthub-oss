/**
 * Типы синхронизации задач с внешними трекерами (TASK-128, decision-103). Без Electron: модуль импортируют
 * main-процесс и тесты, рендерер видит зеркало в `src/types/electron.d.ts`.
 */

/** Синхронизируемые поля (decision-103 п. 6). */
import type { AppErrorKey } from '../../src/lib/appError.js';

export type TrackerField = 'title' | 'description' | 'status';
export const TRACKER_FIELDS: readonly TrackerField[] = ['title', 'description', 'status'];

export type ConflictPolicy = 'backlog' | 'remote';

/** Статус задачи во внешнем трекере. `type` — как у ClickUp: open, custom, done, closed. */
export interface RemoteStatus {
  name: string;
  type: string;
}

export interface RemoteTask {
  id: string;
  title: string;
  description: string;
  status: string;
  statusType: string;
  /** Время последнего изменения, мс. */
  updatedAt: number;
  url: string;
  /** id родительской задачи — у подзадач. */
  parentId?: string;
}

/** Цель синхронизации: список задач трекера. */
export interface TrackerTarget {
  id: string;
  name: string;
  /** Путь для показа: «Workspace / Space / Folder». */
  path?: string;
}

/** Дерево целей для выбора в окне. */
export interface TrackerTargetGroup {
  id: string;
  name: string;
  targets: TrackerTarget[];
}

/** Настройка синка в проекте — `.projecthub/tracker-sync.json` (в git, decision-103 п. 3). */
export interface TrackerSyncConfig {
  version: 1;
  enabled: boolean;
  adapter: string;
  target: TrackerTarget | null;
  /** Статус Backlog.md → статус трекера. */
  statusMap: Record<string, string>;
  conflictPolicy: ConflictPolicy;
  /** Новые задачи проекта с этой меткой создаются в трекере. Пусто — не выгружать. */
  exportLabel: string;
  /** Импортировать закрытые задачи трекера. */
  importClosed: boolean;
}

/** Значения полей одной стороны после последней сверки. */
export type FieldValues = Record<TrackerField, string>;

export interface SyncBaseEntry {
  taskId: string;
  local: FieldValues;
  remote: FieldValues;
  at: number;
}

export type TrackerJournalKind =
  | 'import'
  | 'export'
  | 'push'
  | 'pull'
  | 'conflict'
  | 'missingRemote'
  | 'missingLocal'
  /** Внешняя задача сменила id (переименован репозиторий, ключ команды) или ссылка восстановлена по базе — ссылка переписана. */
  | 'relinked'
  | 'unmappedStatus'
  | 'error';

export interface TrackerJournalEntry {
  kind: TrackerJournalKind;
  taskId?: string;
  externalId?: string;
  title?: string;
  fields?: TrackerField[];
  /** Для конфликта: какая сторона победила и что было перезаписано (обрезано). */
  detail?: string;
  /** Код ошибки записи для текста на языке окна (decision-165). */
  detailKey?: AppErrorKey;
}

export interface TrackerRunSummary {
  at: number;
  finishedAt: number;
  dryRun: boolean;
  ok: boolean;
  error?: string;
  /** Код ошибки запуска для текста на языке окна (decision-165). */
  errorKey?: AppErrorKey;
  counts: Partial<Record<TrackerJournalKind, number>>;
  entries: TrackerJournalEntry[];
}

/** Машинное состояние — `<userData>/tracker-sync/<хэш>.json` (decision-103 п. 3). */
export interface TrackerSyncLocalState {
  version: 1;
  projectPath: string;
  connectionId: string | null;
  /** Интервал автозапуска в минутах; 0 — только вручную. */
  intervalMinutes: number;
  /** База сверки по id внешней задачи. */
  base: Record<string, SyncBaseEntry>;
  runs: TrackerRunSummary[];
}

/** Состояние для окна и инструмента `tracker_sync_status`. */
export interface TrackerSyncStatusView {
  projectPath: string;
  config: TrackerSyncConfig;
  connectionId: string | null;
  intervalMinutes: number;
  linkedTasks: number;
  running: boolean;
  lastRun: TrackerRunSummary | null;
  adapters: Array<{ id: string; label: string; serviceId: string }>;
}
