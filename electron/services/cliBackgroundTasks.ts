/**
 * Фоновые задачи Claude Code в ходе `claude -p` вкладки Studio (TASK-290, decision-211).
 *
 * CLI сообщает о них системными событиями stream-json: `background_tasks_changed` — полный набор живых задач
 * (уровень, REPLACE), `task_started` / `task_updated` / `task_notification` — переходы. Пока набор не пуст, CLI
 * в `-p` не выходит: ждёт задачи и по их концу сам начинает ещё один ход модели. Модуль без Electron — копит
 * задачи хода для панели вкладки и отвечает, держат ли они ход.
 */

export type CliBackgroundTaskKind = 'shell' | 'agent' | 'mcp' | 'workflow' | 'other';
export type CliBackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface CliBackgroundTask {
  taskId: string;
  kind: CliBackgroundTaskKind;
  description: string;
  status: CliBackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** Итог CLI из `task_notification` («Background command … completed (exit code 0)»). */
  summary?: string;
}

/** Снимок для вкладки: задачи хода и ждёт ли ход их после ответа модели. */
export interface CliBackgroundSnapshot {
  tasks: CliBackgroundTask[];
  waiting: boolean;
}

/** Id задачи CLI (`bdz12mprr`, `a1b2…`): в `stop_task`/`get_task_output` уходит только такая строка. */
export function isCliTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function cliTaskKind(taskType: unknown): CliBackgroundTaskKind {
  switch (taskType) {
    case 'local_bash':
      return 'shell';
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'mcp_task':
      return 'mcp';
    case 'local_workflow':
      return 'workflow';
    default:
      return 'other';
  }
}

function endedStatus(value: unknown): CliBackgroundTaskStatus | null {
  switch (value) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

const DESCRIPTION_MAX = 300;
const SUMMARY_MAX = 500;

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type SystemEvent = {
  type?: unknown;
  subtype?: unknown;
  task_id?: unknown;
  task_type?: unknown;
  description?: unknown;
  is_backgrounded?: unknown;
  ambient?: unknown;
  status?: unknown;
  summary?: unknown;
  patch?: { status?: unknown; description?: unknown; is_backgrounded?: unknown };
  tasks?: unknown;
};

export class CliBackgroundTasks {
  private readonly tasks = new Map<string, CliBackgroundTask>();
  /** Живые задачи последнего `background_tasks_changed` без служебных (`ambient`). */
  private live = new Set<string>();

  /** Применяет событие stream-json; `true` — список задач хода изменился. */
  apply(event: unknown, now = Date.now()): boolean {
    const e = event as SystemEvent | null;
    if (e?.type !== 'system') return false;
    switch (e.subtype) {
      case 'background_tasks_changed':
        return this.applyLevel(e.tasks, now);
      case 'task_started':
        // Задача на переднем плане (подагент, обычная команда) ход и так держит — в панель она не идёт.
        if (e.is_backgrounded !== true || e.ambient === true || !isCliTaskId(e.task_id)) return false;
        return this.upsert(e.task_id, { kind: cliTaskKind(e.task_type), description: clip(e.description, DESCRIPTION_MAX) }, now);
      case 'task_updated': {
        if (!isCliTaskId(e.task_id)) return false;
        const task = this.tasks.get(e.task_id);
        if (!task) return false;
        const status = endedStatus(e.patch?.status);
        const description = clip(e.patch?.description, DESCRIPTION_MAX);
        if (!status && !description) return false;
        this.tasks.set(task.taskId, {
          ...task,
          ...(description ? { description } : {}),
          ...(status && task.status === 'running' ? { status, endedAt: now } : {})
        });
        return true;
      }
      case 'task_notification': {
        if (!isCliTaskId(e.task_id)) return false;
        const task = this.tasks.get(e.task_id);
        if (!task) return false;
        const status = endedStatus(e.status) ?? 'completed';
        const summary = clip(e.summary, SUMMARY_MAX);
        this.tasks.set(task.taskId, {
          ...task,
          ...(task.status === 'running' ? { status, endedAt: now } : {}),
          ...(summary ? { summary } : {})
        });
        return true;
      }
      default:
        return false;
    }
  }

  private applyLevel(list: unknown, now: number): boolean {
    if (!Array.isArray(list)) return false;
    const next = new Set<string>();
    let changed = false;
    for (const raw of list) {
      const t = raw as { task_id?: unknown; task_type?: unknown; description?: unknown; ambient?: unknown } | null;
      if (!t || t.ambient === true || !isCliTaskId(t.task_id)) continue;
      next.add(t.task_id);
      if (this.upsert(t.task_id, { kind: cliTaskKind(t.task_type), description: clip(t.description, DESCRIPTION_MAX) }, now)) changed = true;
    }
    // Ушедшая из уровня задача без итога (пропущенное событие-переход) — закончилась.
    for (const id of this.live) {
      const task = this.tasks.get(id);
      if (!next.has(id) && task?.status === 'running') {
        this.tasks.set(id, { ...task, status: 'completed', endedAt: now });
        changed = true;
      }
    }
    if (next.size !== this.live.size || [...next].some((id) => !this.live.has(id))) changed = true;
    this.live = next;
    return changed;
  }

  private upsert(taskId: string, info: { kind: CliBackgroundTaskKind; description: string }, now: number): boolean {
    const prev = this.tasks.get(taskId);
    if (!prev) {
      this.tasks.set(taskId, { taskId, kind: info.kind, description: info.description || taskId, status: 'running', startedAt: now });
      return true;
    }
    if (info.description && !prev.description) {
      this.tasks.set(taskId, { ...prev, description: info.description });
      return true;
    }
    return false;
  }

  /** Есть ли живые фоновые задачи: пока есть, CLI не выйдет, а stdin хода держится открытым для `stop_task`. */
  hasLive(): boolean {
    return this.live.size > 0;
  }

  /** Живые задачи: прерывание хода останавливает их (TASK-298). */
  liveIds(): string[] {
    return [...this.live];
  }

  /** Задача хода, которую ещё можно остановить. */
  isRunning(taskId: string): boolean {
    return this.tasks.get(taskId)?.status === 'running';
  }

  /** Знакома ли задача ходу: вывод читается и у закончившейся. */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  list(): CliBackgroundTask[] {
    return [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  snapshot(resultSeen: boolean): CliBackgroundSnapshot {
    return { tasks: this.list(), waiting: resultSeen && this.hasLive() };
  }
}

/** Ответ `control_response` по id запроса: успех с данными или текст ошибки CLI. */
export function parseControlResponse(event: unknown): { requestId: string; ok: true; response: Record<string, unknown> } | { requestId: string; ok: false; error: string } | null {
  const e = event as { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } } | null;
  if (e?.type !== 'control_response' || typeof e.response?.request_id !== 'string') return null;
  const requestId = e.response.request_id;
  if (e.response.subtype === 'success') {
    const response = e.response.response && typeof e.response.response === 'object' ? (e.response.response as Record<string, unknown>) : {};
    return { requestId, ok: true, response };
  }
  return { requestId, ok: false, error: typeof e.response.error === 'string' ? e.response.error : 'error' };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** CSI (цвета, курсор) и OSC (заголовок окна) — вкладка показывает вывод простым текстом. */
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g');

/** Текст вывода команды для показа: без escape-последовательностей, переводы строк — `\n`. */
export function plainTaskOutput(raw: string): string {
  return raw.replace(ANSI_SEQUENCE, '').replace(/\r\n?/g, '\n');
}

/** Хвост вывода задачи из ответа `get_task_output`. */
export function parseTaskOutput(response: Record<string, unknown>): { output: string; truncated: boolean; totalBytes: number } {
  return {
    output: typeof response.output === 'string' ? plainTaskOutput(response.output) : '',
    truncated: response.truncated === true,
    totalBytes: typeof response.total_bytes === 'number' ? response.total_bytes : 0
  };
}
