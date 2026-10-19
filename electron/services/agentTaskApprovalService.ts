/**
 * Подтверждение задач, заведённых агентом (TASK-153 → TASK-155, decision-89 п. 3, 9, 11).
 *
 * Один путь для всех каналов: окно ProjectHub (IPC `backlog:approveAgentTask*`), кнопка Telegram
 * (`/api/agent-tasks/approve` по билету) и телефон (RPC `approve_agent_tasks`). Подтверждение снимает метку
 * `agent-created`, автор в `reporter` остаётся. Каждая задача — своя запись аудита `agent-task-approve`
 * с источником решения: окно, Telegram или устройство.
 *
 * Main сам выбирает файлы по метке, автору и id: ни один канал не может подтвердить произвольный список путей.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { normalizeFrontmatter, taskNumberFromName, withUpdatedDate } from './backlogTaskFormat.js';
import { isAwaitingApproval, withoutApprovalLabel } from './agentTaskPolicy.js';
import { reporterKey, sameReporter } from '../../src/utils/agentTask.js';
import { AgentTaskTickets, taskIdKey, type AgentTaskTicket } from './agentTaskTickets.js';
import type { HitlDecisionSource } from './hitlTypes.js';
import type { HitlAutoDecisionInfo } from './hitlService.js';

/** Канал, из которого пришло подтверждение: пишется в `detail` аудита. */
export type AgentTaskApprovalChannel = 'window' | 'telegram' | 'phone';

export interface AgentTaskApprovalDeps {
  recordHumanDecision(info: HitlAutoDecisionInfo, decision: 'allow', source: HitlDecisionSource, rule: string, detail?: string): string;
  listProjectRoots(): Promise<string[]>;
}

export interface PendingAgentTask {
  projectPath: string;
  id: string;
  title: string;
  reporter?: string;
  created?: string;
  filePath: string;
}

export interface AgentTaskApprovalResult {
  approved: string[];
  /** Задачи из запроса, которые уже не ждут подтверждения (подтверждены в другом канале) или не найдены. */
  notPending: string[];
}

export type TicketApprovalResult = ({ ok: true; projectPath: string } & AgentTaskApprovalResult) | { ok: false; reason: 'unknown_ticket' };

export const AGENT_TASK_APPROVE_RULE = 'agent-task-approve';

const fmString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return String(value);
};

const fmStringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(fmString).filter((v): v is string => v !== undefined) : []);

function parseTaskFile(raw: string) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const parsed = matter(raw.replace(/\r\n/g, '\n'));
  return { eol, data: { ...parsed.data } as Record<string, unknown>, content: parsed.content };
}

function serializeTaskFile(content: string, data: Record<string, unknown>, eol: string): string {
  const text = matter.stringify(content, normalizeFrontmatter(data));
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

function taskIdOf(data: Record<string, unknown>, filePath: string): string {
  const fromFrontmatter = fmString(data.id);
  if (fromFrontmatter) return fromFrontmatter;
  const base = path.basename(filePath, '.md');
  const n = taskNumberFromName(base);
  return n !== null ? `TASK-${n}` : base.split(' - ')[0].trim();
}

/** Корень проекта по файлу задачи `<root>/backlog/tasks/<file>.md`. */
export function projectRootOfTaskFile(filePath: string): string {
  return path.resolve(path.dirname(filePath), '..', '..');
}

export class AgentTaskApprovalService {
  public readonly tickets: AgentTaskTickets;
  private readonly listeners = new Set<(info: { projectPath: string; approved: string[]; resolvedTickets: AgentTaskTicket[]; channel: AgentTaskApprovalChannel }) => void>();

  constructor(
    private readonly deps: AgentTaskApprovalDeps,
    tickets: AgentTaskTickets = new AgentTaskTickets()
  ) {
    this.tickets = tickets;
  }

  /** Подписка на подтверждения из любого канала: снять кнопки Telegram, обновить экраны. */
  public onApproved(listener: (info: { projectPath: string; approved: string[]; resolvedTickets: AgentTaskTicket[]; channel: AgentTaskApprovalChannel }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Подтвердить один файл. `filter.reporter` — только задачу этого автора, `filter.ids` — только задачу из
   * списка. Возвращает id задачи или `null`, если она уже не ждёт подтверждения или не подходит под фильтр.
   */
  private async approveFile(
    filePath: string,
    filter: { reporter?: string; ids?: Set<string> },
    source: HitlDecisionSource,
    channel: AgentTaskApprovalChannel
  ): Promise<string | null> {
    const { eol, data, content } = parseTaskFile(await fs.readFile(filePath, 'utf-8'));
    const labels = fmStringList(data.labels);
    if (!isAwaitingApproval(labels)) return null;
    if (filter.reporter !== undefined && !sameReporter(fmString(data.reporter), filter.reporter)) return null;
    const taskId = taskIdOf(data, filePath);
    if (filter.ids && !filter.ids.has(taskIdKey(taskId))) return null;
    data.labels = withoutApprovalLabel(labels);
    await fs.writeFile(filePath, serializeTaskFile(content, withUpdatedDate(data), eol), 'utf-8');
    const projectPath = projectRootOfTaskFile(filePath);
    this.deps.recordHumanDecision(
      {
        sessionId: channel === 'window' ? 'ui' : channel,
        projectPath,
        type: 'file_write',
        title: `Подтверждена задача агента: ${taskId}`,
        tool: 'task_approve',
        filePath: path.relative(projectPath, filePath).split(path.sep).join('/'),
        ...(fmString(data.reporter) ? { agentName: fmString(data.reporter) } : {})
      },
      'allow',
      source,
      AGENT_TASK_APPROVE_RULE,
      channel
    );
    return taskId;
  }

  private async taskFiles(projectPath: string): Promise<string[]> {
    const dir = path.join(projectPath, 'backlog', 'tasks');
    if (!existsSync(dir)) return [];
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  }

  private emit(projectPath: string, approved: string[], channel: AgentTaskApprovalChannel): void {
    if (approved.length === 0) return;
    const resolvedTickets = this.tickets.markApproved(projectPath, approved);
    for (const listener of this.listeners) {
      try {
        listener({ projectPath, approved, resolvedTickets, channel });
      } catch (err) {
        console.warn('[AgentTasks] Approval listener failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Одна задача по пути файла (окно задачи). Путь уже проверен гардом проекта. */
  public async approveTaskFile(filePath: string, source: HitlDecisionSource, channel: AgentTaskApprovalChannel): Promise<string | null> {
    const taskId = await this.approveFile(filePath, {}, source, channel);
    if (taskId) this.emit(projectRootOfTaskFile(filePath), [taskId], channel);
    return taskId;
  }

  /**
   * Задачи проекта по фильтру. Без `ids` нужен автор: «подтвердить все» без автора не бывает (decision-89 п. 9).
   */
  public async approveInProject(
    projectPath: string,
    filter: { reporter?: string; ids?: readonly string[] },
    source: HitlDecisionSource,
    channel: AgentTaskApprovalChannel
  ): Promise<AgentTaskApprovalResult> {
    const ids = filter.ids ? new Set(filter.ids.map(taskIdKey).filter(Boolean)) : undefined;
    if (!ids && !reporterKey(filter.reporter)) return { approved: [], notPending: [] };
    if (ids && ids.size === 0) return { approved: [], notPending: [] };
    const approved: string[] = [];
    for (const filePath of await this.taskFiles(projectPath)) {
      try {
        const taskId = await this.approveFile(filePath, { reporter: filter.reporter, ids }, source, channel);
        if (taskId) approved.push(taskId);
      } catch (err) {
        console.error(`[AgentTasks] Failed to approve agent task ${path.basename(filePath)}:`, err instanceof Error ? err.message : err);
      }
    }
    const done = new Set(approved.map(taskIdKey));
    const notPending = ids ? [...ids].filter((id) => !done.has(id)) : [];
    this.emit(projectPath, approved, channel);
    return { approved, notPending };
  }

  /** Кнопка Telegram: ровно задачи пачки из уведомления и того же автора. */
  public async approveTicket(ticketId: unknown, source: HitlDecisionSource): Promise<TicketApprovalResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { ok: false, reason: 'unknown_ticket' };
    const result = await this.approveInProject(ticket.projectPath, { reporter: ticket.reporter, ids: ticket.taskIds }, source, 'telegram');
    return { ok: true, projectPath: ticket.projectPath, ...result };
  }

  /** Задачи, ждущие подтверждения, по всем зарегистрированным проектам или по одному. */
  public async listPending(projectPath?: string): Promise<PendingAgentTask[]> {
    const roots = projectPath ? [projectPath] : await this.deps.listProjectRoots();
    const out: PendingAgentTask[] = [];
    for (const root of roots) {
      for (const filePath of await this.taskFiles(root)) {
        try {
          const { data } = parseTaskFile(await fs.readFile(filePath, 'utf-8'));
          if (!isAwaitingApproval(fmStringList(data.labels))) continue;
          out.push({
            projectPath: root,
            id: taskIdOf(data, filePath),
            title: fmString(data.title) ?? path.basename(filePath, '.md'),
            ...(fmString(data.reporter) ? { reporter: fmString(data.reporter) } : {}),
            ...(fmString(data.created_date) ? { created: fmString(data.created_date) } : {}),
            filePath
          });
        } catch {
          // битый файл задачи не прячет остальные
        }
      }
    }
    return out;
  }
}
