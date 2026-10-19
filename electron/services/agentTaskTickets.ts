/**
 * Билеты подтверждения задач агента для кнопок вне окна (TASK-155, decision-89 п. 11).
 *
 * У кнопки Telegram в `callback_data` не больше 64 байт: пути файлов и список из десяти id туда не входят.
 * Поэтому уведомление о пачке получает короткий случайный билет, а main помнит, какие задачи какого автора
 * в каком проекте он подтверждает. Билет подтверждает ровно задачи из уведомления: задачи, которые агент
 * завёл позже, человек в нём не видел. Билеты живут в памяти: после перезапуска кнопка отвечает «устарела»,
 * а задачи подтверждаются в окне или с телефона.
 *
 * Чистый модуль без Electron: проверяется unit-тестами.
 */
import { randomBytes } from 'node:crypto';

export const AGENT_TASK_TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_TASK_TICKET_LIMIT = 500;

export interface AgentTaskTicket {
  id: string;
  projectPath: string;
  reporter: string;
  taskIds: string[];
  createdAt: number;
}

/** Id задачи для сравнения: `task-5` и `TASK-5` — одна задача. */
export function taskIdKey(id: unknown): string {
  return String(id ?? '').trim().toUpperCase();
}

export function isTicketId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(value);
}

export class AgentTaskTickets {
  private readonly tickets = new Map<string, AgentTaskTicket & { remaining: Set<string>; resolved: boolean }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomBytes(9).toString('base64url')
  ) {}

  public issue(input: { projectPath: string; reporter: string; taskIds: readonly string[] }): AgentTaskTicket {
    this.prune();
    const ticket = {
      id: this.newId(),
      projectPath: input.projectPath,
      reporter: input.reporter,
      taskIds: [...input.taskIds],
      createdAt: this.now(),
      remaining: new Set(input.taskIds.map(taskIdKey)),
      resolved: false
    };
    this.tickets.set(ticket.id, ticket);
    while (this.tickets.size > AGENT_TASK_TICKET_LIMIT) {
      const oldest = this.tickets.keys().next();
      if (oldest.done) break;
      this.tickets.delete(oldest.value);
    }
    return this.view(ticket);
  }

  /** Живой билет или `null`, если его нет или он устарел. */
  public get(id: unknown): AgentTaskTicket | null {
    if (!isTicketId(id)) return null;
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    if (this.now() - ticket.createdAt > AGENT_TASK_TICKET_TTL_MS) {
      this.tickets.delete(id);
      return null;
    }
    return this.view(ticket);
  }

  /**
   * Задачи проекта подтверждены (любым каналом). Возвращает билеты, у которых только что не осталось
   * неподтверждённых задач: их кнопки пора снять. Закрытый билет помнится до конца срока, чтобы повторное
   * нажатие получило «уже подтверждены», а не «кнопка устарела».
   */
  public markApproved(projectPath: string, taskIds: readonly string[]): AgentTaskTicket[] {
    const done: AgentTaskTicket[] = [];
    const keys = taskIds.map(taskIdKey);
    for (const ticket of this.tickets.values()) {
      if (ticket.projectPath !== projectPath || ticket.resolved) continue;
      for (const key of keys) ticket.remaining.delete(key);
      if (ticket.remaining.size === 0) {
        ticket.resolved = true;
        done.push(this.view(ticket));
      }
    }
    return done;
  }

  public get size(): number {
    return this.tickets.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (now - ticket.createdAt > AGENT_TASK_TICKET_TTL_MS) this.tickets.delete(id);
  }

  private view(ticket: AgentTaskTicket): AgentTaskTicket {
    return { id: ticket.id, projectPath: ticket.projectPath, reporter: ticket.reporter, taskIds: [...ticket.taskIds], createdAt: ticket.createdAt };
  }
}
