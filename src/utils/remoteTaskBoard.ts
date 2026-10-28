import type { RemoteTaskSummary } from '../types/remote';

/**
 * Доска задач удалённого проекта — общая для телефона и ПК (TASK-229): колонки по статусам Backlog.md из ответа
 * `get_tasks`. Без React и Electron.
 */

/** Колонки Backlog.md в порядке процесса (правило 5 infra-dev). */
export const KANBAN_STATUSES = ['To Do', 'In Progress', 'Review', 'Done'] as const;

/** Порядок колонок: Human-статусы (decision-162) встают за своей стадией, а не в конец. */
const COLUMN_ORDER = ['To Do', 'In Progress', 'InProgress(Human)', 'Review', 'Review(Human)', 'Done'];

/** Колонки по порядку движения задачи; свои статусы — после стандартных, в порядке появления. */
export function orderColumns<T extends { status: string }>(columns: T[]): T[] {
  const rank = (s: string) => {
    const i = COLUMN_ORDER.indexOf(s);
    return i < 0 ? COLUMN_ORDER.length : i;
  };
  return columns.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.status) - rank(b.c.status) || a.i - b.i).map((x) => x.c);
}

export interface KanbanColumn {
  status: string;
  tasks: RemoteTaskSummary[];
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Номер задачи для сортировки: TASK-140.2 → [140, 2]. */
function taskOrdinal(id: string): number[] {
  const m = id.match(/(\d+(?:\.\d+)*)\s*$/);
  return m ? m[1].split('.').map(Number) : [Number.MAX_SAFE_INTEGER];
}

function compareTasks(a: RemoteTaskSummary, b: RemoteTaskSummary): number {
  const pa = PRIORITY_ORDER[String(a.priority).toLowerCase()] ?? 1;
  const pb = PRIORITY_ORDER[String(b.priority).toLowerCase()] ?? 1;
  if (pa !== pb) return pa - pb;
  const oa = taskOrdinal(a.id);
  const ob = taskOrdinal(b.id);
  for (let i = 0; i < Math.max(oa.length, ob.length); i++) {
    const d = (ob[i] ?? -1) - (oa[i] ?? -1);
    if (d !== 0) return d; // новые задачи выше
  }
  return 0;
}

/**
 * Колонки Kanban: четыре стандартных статуса всегда, нестандартные (Draft и свои) — после них,
 * чтобы задача не пропала с доски из-за непривычного статуса.
 */
export function groupTasksByStatus(tasks: RemoteTaskSummary[]): KanbanColumn[] {
  const columns = new Map<string, RemoteTaskSummary[]>();
  for (const s of KANBAN_STATUSES) columns.set(s, []);
  for (const task of tasks) {
    const status = task.status || 'To Do';
    if (!columns.has(status)) columns.set(status, []);
    columns.get(status)!.push(task);
  }
  return orderColumns([...columns.entries()].map(([status, list]) => ({ status, tasks: [...list].sort(compareTasks) })));
}

export function criteriaProgress(task: RemoteTaskSummary): { done: number; total: number } {
  const criteria = task.criteria ?? [];
  return { done: criteria.filter((c) => c.completed).length, total: criteria.length };
}
