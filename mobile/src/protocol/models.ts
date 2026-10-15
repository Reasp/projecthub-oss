import type { DeviceRights, RemotePendingApproval, RemoteTaskSummary } from '../../../src/types/remote';

/**
 * Чистые модели экранов мобильного клиента (TASK-140.1): без React, покрыты unit-тестами.
 */

// ── Права ──

/**
 * Что устройство может делать по правам токена (decision-11 п. 1). Хост проверяет то же самое
 * в `dispatchRpc` — здесь только чтобы не показывать кнопки, которые хост всё равно отклонит.
 */
export interface Capabilities {
  /** Решения HITL. */
  decide: boolean;
  /** Остальные изменения: процессы, задачи, промпт, агенты. */
  write: boolean;
}

export function capabilitiesFor(rights: DeviceRights | null | undefined, hostReadOnly: boolean): Capabilities {
  if (hostReadOnly) return { decide: false, write: false };
  // Хост без прав в токене трактует устройство как `full` (`device.rights ?? 'full'`).
  const r = rights ?? 'full';
  return { decide: r === 'hitl' || r === 'full', write: r === 'full' };
}

export function rightsLabel(rights: DeviceRights | null | undefined, hostReadOnly: boolean): string {
  if (hostReadOnly) return 'Только чтение (хост)';
  if (rights === 'readOnly') return 'Только чтение';
  if (rights === 'hitl') return 'Только решения';
  return 'Полный доступ';
}

// ── Kanban ──

/** Колонки Backlog.md в порядке процесса (правило 5 infra-dev). */
export const KANBAN_STATUSES = ['To Do', 'In Progress', 'Review', 'Done'] as const;

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
  return [...columns.entries()].map(([status, list]) => ({ status, tasks: [...list].sort(compareTasks) }));
}

export function criteriaProgress(task: RemoteTaskSummary): { done: number; total: number } {
  const criteria = task.criteria ?? [];
  return { done: criteria.filter((c) => c.completed).length, total: criteria.length };
}

// ── Очередь HITL ──

/** Событие `ai:hitl` и ответ `get_pending_approvals` приводятся к одному виду. */
export interface HitlItem {
  requestId: string;
  sessionId: string;
  projectPath: string;
  agentName?: string;
  role?: string;
  tool?: string;
  title: string;
  details?: string;
  command?: string;
  filePath?: string;
  expiresAt?: number;
}

export function hitlFromEvent(data: unknown): HitlItem | null {
  const d = (data || {}) as Record<string, unknown>;
  if (typeof d.requestId !== 'string' || !d.requestId) return null;
  const str = (k: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : undefined);
  return {
    requestId: d.requestId,
    sessionId: str('sessionId') ?? '',
    projectPath: str('projectPath') ?? '',
    agentName: str('agentName'),
    role: str('role'),
    tool: str('tool'),
    title: str('description') ?? str('title') ?? 'Агенту нужно решение',
    details: str('details'),
    command: str('command'),
    filePath: str('filePath'),
    expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : undefined
  };
}

export function hitlFromPending(p: RemotePendingApproval): HitlItem {
  return hitlFromEvent({ ...p, description: p.title })!;
}

/** Добавление без дублей по `requestId` (событие и догон могут прийти оба). */
export function addHitl(queue: HitlItem[], item: HitlItem): HitlItem[] {
  if (queue.some((q) => q.requestId === item.requestId)) return queue;
  return [...queue, item];
}

export function dropHitl(queue: HitlItem[], requestId: string): HitlItem[] {
  return queue.filter((q) => q.requestId !== requestId);
}

/** Список с хоста — источник истины: решённые на ПК исчезают, новые добавляются. */
export function replaceHitl(items: HitlItem[]): HitlItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.requestId) ? false : (seen.add(i.requestId), true)));
}

/** Причина отказа `hitl_decision` по-русски. */
export function hitlRejectReason(reason: string | undefined): string {
  if (reason === 'already_decided') return 'Запрос уже решён';
  if (reason === 'not_found') return 'Запрос не найден — возможно, истёк';
  return reason ? `Хост отклонил решение: ${reason}` : 'Хост отклонил решение';
}

// ── Логи ──

/** Кольцевой буфер текста логов: хвост не больше `maxChars`, обрезка по началу строки. */
export function appendLog(buffer: string, chunk: string, maxChars = 60_000): string {
  const next = buffer + chunk;
  if (next.length <= maxChars) return next;
  const cut = next.slice(next.length - maxChars);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 2000 ? cut.slice(nl + 1) : cut;
}

/** Убирает ANSI-последовательности (цвет, курсор) — на телефоне они не отрисовываются. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ESC-последовательности и есть то, что вырезаем
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

// ── Агенты ──

/** Статусы роя и слота агента — `SwarmStatus`/`AgentSlotStatus` из `src/types/electron.d.ts`. */
const ACTIVE_STATUSES = new Set(['running', 'pending', 'preparing']);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: 'Ожидает',
    pending: 'В очереди',
    preparing: 'Подготовка',
    running: 'Работает',
    completed: 'Готово',
    failed: 'Ошибка',
    stopped: 'Остановлен',
    interrupted: 'Прерван',
    budget_exceeded: 'Превышен бюджет'
  };
  return labels[status] ?? status;
}
