/**
 * Уведомление о задачах, которые завёл агент (TASK-153, decision-89).
 *
 * `task_create` в режиме `propose` создаёт задачу с меткой `agent-created`; человек должен узнать о ней вне окна
 * ProjectHub, иначе работа встанет. Менеджер заводит задачи пачкой, поэтому задачи одной сессии в одном проекте
 * за окно склейки уходят одним событием `task:agentCreated`: одно уведомление в Telegram вместо десяти.
 *
 * Чистый модуль без Electron: таймеры и публикация передаются снаружи, логика проверяется unit-тестами.
 */
import type { AppBusEvent } from './hitlTypes.js';

/** Окно склейки: от первой задачи пачки до уведомления. */
export const AGENT_TASK_NOTIFY_WINDOW_MS = 5_000;

export interface AgentTaskCreatedInfo {
  projectPath: string;
  sessionId: string;
  reporter: string;
  id: string;
  title: string;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Незавершённая пачка не держит процесс при выходе.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

interface Batch {
  projectPath: string;
  reporter: string;
  tasks: Array<{ id: string; title: string }>;
  timer: unknown;
}

export class AgentTaskNotifyBatcher {
  private readonly batches = new Map<string, Batch>();

  constructor(
    private readonly publish: (event: AppBusEvent) => void,
    private readonly windowMs: number = AGENT_TASK_NOTIFY_WINDOW_MS,
    private readonly timers: Timers = defaultTimers,
    private readonly now: () => number = Date.now
  ) {}

  public add(info: AgentTaskCreatedInfo): void {
    const key = `${info.projectPath}\n${info.sessionId}\n${info.reporter}`;
    const existing = this.batches.get(key);
    if (existing) {
      existing.tasks.push({ id: info.id, title: info.title });
      return;
    }
    const batch: Batch = {
      projectPath: info.projectPath,
      reporter: info.reporter,
      tasks: [{ id: info.id, title: info.title }],
      timer: null
    };
    batch.timer = this.timers.set(() => this.flush(key), this.windowMs);
    this.batches.set(key, batch);
  }

  /** Отправить все незавершённые пачки сразу (выход из приложения, тесты). */
  public flushAll(): void {
    for (const key of [...this.batches.keys()]) this.flush(key);
  }

  public get pendingBatches(): number {
    return this.batches.size;
  }

  private flush(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    this.timers.clear(batch.timer);
    this.publish({
      type: 'task:agentCreated',
      projectPath: batch.projectPath,
      reporter: batch.reporter,
      tasks: batch.tasks,
      at: this.now()
    });
  }
}
