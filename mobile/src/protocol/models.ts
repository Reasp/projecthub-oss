import type { DeviceRights, RemotePendingAgentTask, RemoteHitlRisk, RemotePendingApproval, RemoteTaskSummary } from '../../../src/types/remote';
import { t } from '../i18n';

/**
 * Чистые модели экранов мобильного клиента (TASK-140.1): без React, покрыты unit-тестами.
 */

// ── Задачи агентов, ждущие подтверждения (TASK-155) ──

export interface AgentTaskGroup {
  projectPath: string;
  /** Автор `agent:<роль>`; пустой — задачи без автора, их подтверждают по одной. */
  reporter: string;
  tasks: RemotePendingAgentTask[];
}

/** Группы «проект × автор»: больше задач — выше; внутри группы задачи по номеру. */
export function groupAgentTasks(list: readonly RemotePendingAgentTask[]): AgentTaskGroup[] {
  const groups = new Map<string, AgentTaskGroup>();
  for (const task of list) {
    const reporter = (task.reporter ?? '').trim();
    const key = `${task.projectPath}\n${reporter.toLowerCase()}`;
    const group = groups.get(key) ?? { projectPath: task.projectPath, reporter, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const num = (id: string) => (id.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const byNumber = (a: RemotePendingAgentTask, b: RemotePendingAgentTask) => {
    const [x, y] = [num(a.id), num(b.id)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
    return 0;
  };
  return [...groups.values()]
    .map((g) => ({ ...g, tasks: [...g.tasks].sort(byNumber) }))
    .sort((a, b) => b.tasks.length - a.tasks.length || a.projectPath.localeCompare(b.projectPath) || a.reporter.localeCompare(b.reporter));
}

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
  const labels = t().models.rights;
  if (hostReadOnly) return labels.hostReadOnly;
  if (rights === 'readOnly') return labels.readOnly;
  if (rights === 'hitl') return labels.hitl;
  return labels.full;
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
  /** Класс риска от хоста (TASK-140.4, decision-112); у хостов до него нет. */
  risk?: RemoteHitlRisk;
  riskReason?: string;
}

/**
 * Можно ли одобрить запрос кнопкой в приложении (decision-112 п. 3): `high` — только с биометрией (ключ подтверждения
 * сопряжения, [[decision-114]]). Окончательно решает хост; клиент лишь не предлагает заведомо отклоняемое.
 */
export function canApproveInApp(item: HitlItem, biometric = false): boolean {
  return item.risk !== 'high' || biometric;
}

/**
 * Строка, которую подписывает ключ подтверждения (decision-112 п. 4). Та же, что `confirmProofPayload` хоста
 * (`electron/services/hitlConfirmProof.ts`): хост, запрос, решение и класс — подпись не переносится на другой запрос.
 */
export function hitlConfirmPayload(hostId: string, requestId: string, decision: 'allow' | 'deny', risk: RemoteHitlRisk): string {
  return ['projecthub-hitl-confirm-v1', hostId, requestId, decision, risk].join('\n');
}

/** Вид строки унифицированного диффа для подсветки. */
export function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** Почему push не включился (TASK-140.3). */
export function pushErrorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const text = t().models.push;
  if (code === 'no_distributor') return text.noDistributor;
  if (code === 'timeout') return text.timeout;
  return text.failed;
}

/** Текст ошибки биометрии; отмена человеком — `null`, без сообщения. */
export function confirmErrorText(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'cancelled') return null;
  const text = t().models.biometric;
  if (code === 'lockout') return text.lockout;
  if (code === 'invalidated' || code === 'no_key') return text.invalidated;
  if (code === 'unavailable') return text.unavailable;
  return text.failed;
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
    title: str('description') ?? str('title') ?? t().models.hitlDefaultTitle,
    details: str('details'),
    command: str('command'),
    filePath: str('filePath'),
    expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : undefined,
    risk: d.risk === 'low' || d.risk === 'moderate' || d.risk === 'high' ? d.risk : undefined,
    riskReason: str('riskReason')
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

/** Причина отказа `hitl_decision` на языке интерфейса. */
export function hitlRejectReason(reason: string | undefined): string {
  const text = t().models.reject;
  if (reason === 'already_decided') return text.alreadyDecided;
  if (reason === 'not_found') return text.notFound;
  if (reason === 'confirmation_required') return text.confirmationRequired;
  return reason ? text.hostRejectedWith(reason) : text.hostRejected;
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
  // Неизвестный статус (новый на хосте) показываем как есть; `hasOwn` — чтобы `toString` и т. п. не стали подписью.
  const labels: Record<string, string> = t().models.agentStatus;
  return Object.prototype.hasOwnProperty.call(labels, status) ? labels[status] : status;
}
