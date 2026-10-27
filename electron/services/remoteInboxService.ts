import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';
import type { AppBusEvent } from './hitlTypes.js';
import type { SwarmSession } from './swarmTypes.js';
import { stateFields, withVersion } from './stateFiles.js';
import {
  INBOX_STATE_VERSION,
  InboxJournal,
  NoteRateLimiter,
  inboxEventFromBus,
  latestDoneLoopSession,
  normalizeInboxEvents,
  noteTitle,
  parseNoteArgs,
  reportScreenshotPaths,
  reviewCriteria,
  reviewReportFromSession
} from './remoteInbox.js';
import type {
  DeviceRights,
  RemoteInbox,
  RemoteInboxEvent,
  RemoteNoteLevel,
  RemotePendingAgentTask,
  RemotePendingApproval,
  RemoteReviewItem,
  RemoteReviewResult,
  RemoteScreenshotChunk,
  RemoteTaskCriterion
} from '../../src/types/remote.js';

/**
 * «Входящие» телефона на хосте (TASK-140.5, [[decision-117]]): журнал ленты в userData, снимок `get_inbox` по всем
 * проектам, проверка задачи из Review, скриншоты отчёта и сообщения агента `projecthub_notify`. Сервисы ProjectHub
 * приходят зависимостями — `remoteControlService` собирает их, тесты подменяют.
 */

export interface InboxTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  updated?: string;
  criteria: RemoteTaskCriterion[];
}

export interface RemoteInboxDeps {
  now(): number;
  statePath(): string;
  projects(): Promise<string[]>;
  /** Проект зарегистрирован — иначе ошибка; возвращает его путь в виде реестра. */
  assertProject(projectPath: string): Promise<string>;
  tasks(projectPath: string): Promise<InboxTask[]>;
  pendingApprovals(): RemotePendingApproval[];
  agentTasks(): Promise<RemotePendingAgentTask[]>;
  swarms(projectPath?: string): SwarmSession[];
  /** Новая сессия роли по задаче (тот же путь, что `start_assigned_agent`). */
  startAgent(options: { projectPath: string; taskId: string; taskTitle: string; roleSlug: string; prompt: string; doneLoop: boolean; memberId?: string }): Promise<{ swarmId: string } | { error: string }>;
  updateTask(projectPath: string, taskId: string, mutate: (data: Record<string, unknown>, content: string) => { data: Record<string, unknown>; content: string }): Promise<boolean>;
  applyNote(content: string, note: string): string;
  timestamp(): string;
  /** Абсолютный путь файла внутри `<userData>/visual` или `null`. */
  resolveVisual(relPath: string): Promise<string | null>;
  pushNote(note: { id: string; text: string; level: RemoteNoteLevel; projectPath?: string; agent?: string }): Promise<number>;
  /** Лента изменилась — разослать `inbox:changed`. */
  changed(reason: string): void;
  log(message: string): void;
}

/** Часть скриншота в RPC: 384 КБ — base64 укладывается в 512 КБ, как части вложений (decision-114). */
export const SCREENSHOT_CHUNK = 384 * 1024;
/** Больше — не отдаём: скриншот `ui-smoke` такого размера — уже не скриншот. */
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface NoteContext {
  sessionId: string;
  projectPath?: string;
  agentName?: string;
  role?: string;
}

function isReview(status: string): boolean {
  return status.trim().toLowerCase() === 'review';
}

/** Последняя сессия по задаче с ролью — кого перезапускать при возврате. */
function lastRoleSession(sessions: readonly SwarmSession[], taskId: string): SwarmSession | undefined {
  const key = taskId.toUpperCase();
  return [...sessions]
    .filter((s) => (s.taskId || '').toUpperCase() === key && s.agents.some((a) => a.config.roleSlug))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export class RemoteInboxService {
  private readonly journal: InboxJournal;
  private readonly limiter: NoteRateLimiter;
  private loaded = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RemoteInboxDeps) {
    this.journal = new InboxJournal(deps.now);
    this.limiter = new NoteRateLimiter(deps.now);
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.deps.statePath(), 'utf8'));
      this.journal.load(normalizeInboxEvents(stateFields(raw, INBOX_STATE_VERSION).events));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.deps.log(`[Inbox] Failed to read journal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persist(): Promise<void> {
    const data = JSON.stringify(withVersion(INBOX_STATE_VERSION, { events: this.journal.list() }), null, 2);
    const target = this.deps.statePath();
    this.saveQueue = this.saveQueue
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data, 'utf8');
      })
      .catch((err) => this.deps.log(`[Inbox] Failed to save journal: ${err instanceof Error ? err.message : String(err)}`));
    return this.saveQueue;
  }

  private add(event: Omit<RemoteInboxEvent, 'id'>, reason: string): RemoteInboxEvent {
    const entry = this.journal.add(event);
    void this.persist();
    this.deps.changed(reason);
    return entry;
  }

  /** Событие шины: итоги агентов и сбои Automations — в журнал, с задачей и сессией роя, если их знает флот. */
  handleBus(event: AppBusEvent): void {
    const base = inboxEventFromBus(event);
    if (!base) return;
    if (base.agentId) {
      const swarm = this.deps.swarms().find((s) => s.agents.some((a) => a.id === base.agentId));
      if (swarm) {
        base.swarmId = swarm.id;
        if (swarm.taskId) base.taskId = swarm.taskId;
      }
    } else if (base.swarmId) {
      const swarm = this.deps.swarms().find((s) => s.id === base.swarmId);
      if (swarm?.taskId) base.taskId = swarm.taskId;
    }
    this.add(base, base.kind);
  }

  /** `projecthub_notify`: проверка, лимит частоты, запись в ленту и push. Ответ — текст для агента. */
  async notify(ctx: NoteContext, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const parsed = parseNoteArgs(args);
    if ('error' in parsed) return { isError: true, text: parsed.error };
    const slot = this.limiter.take(ctx.sessionId || 'unknown');
    if (!slot.ok) {
      const sec = Math.ceil(slot.retryAfterMs / 1000);
      return { isError: true, text: `The message limit of this session is used up: the next one is possible in ${sec} s. Do not repeat the message earlier.` };
    }
    const who = ctx.agentName || ctx.role;
    const entry = this.add(
      {
        kind: 'agent_note',
        at: this.deps.now(),
        ...noteTitle(parsed.level, who),
        body: parsed.text,
        level: parsed.level,
        ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}),
        ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
        ...(ctx.role ? { role: ctx.role } : {})
      },
      'agent_note'
    );
    let pushed = 0;
    try {
      pushed = await this.deps.pushNote({ id: entry.id, text: parsed.text, level: parsed.level, ...(ctx.projectPath ? { projectPath: ctx.projectPath } : {}), ...(who ? { agent: who } : {}) });
    } catch (err) {
      this.deps.log(`[Inbox] Note push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      isError: false,
      text: pushed > 0
        ? `The message is in the phone Inbox, push sent to devices: ${pushed}.`
        : 'The message is in the phone Inbox. Push was not sent: it is off, the app is open or the person is at the PC.'
    };
  }

  dismiss(ids: unknown): { removed: number } {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 500) : [];
    const removed = this.journal.dismiss(list);
    if (removed > 0) {
      void this.persist();
      this.deps.changed('dismiss');
    }
    return { removed };
  }

  private async reviewItems(): Promise<RemoteReviewItem[]> {
    const items: RemoteReviewItem[] = [];
    for (const projectPath of await this.deps.projects()) {
      let tasks: InboxTask[];
      try {
        tasks = (await this.deps.tasks(projectPath)).filter((t) => isReview(t.status));
      } catch {
        continue;
      }
      if (tasks.length === 0) continue;
      const sessions = this.deps.swarms(projectPath);
      for (const task of tasks) {
        const loop = latestDoneLoopSession(sessions, task.id);
        const report = loop ? reviewReportFromSession(loop) : undefined;
        const roleSession = lastRoleSession(sessions, task.id);
        const roleSlug = report?.roleSlug ?? roleSession?.agents.find((a) => a.config.roleSlug)?.config.roleSlug;
        items.push({
          projectPath,
          id: task.id,
          title: task.title,
          ...(task.priority ? { priority: task.priority } : {}),
          ...(task.updated ? { updated: task.updated } : {}),
          criteria: reviewCriteria(task.criteria, loop),
          ...(report ? { report } : {}),
          ...(roleSlug ? { roleSlug } : {})
        });
      }
    }
    return items;
  }

  async getInbox(host: { hostId: string; machineName: string }): Promise<RemoteInbox> {
    const [agentTasks, review] = await Promise.all([this.deps.agentTasks().catch(() => []), this.reviewItems()]);
    return {
      hostId: host.hostId,
      machineName: host.machineName,
      generatedAt: this.deps.now(),
      hitl: this.deps.pendingApprovals(),
      agentTasks,
      review,
      events: this.journal.list()
    };
  }

  private async reviewTaskOf(projectPathRaw: unknown, taskIdRaw: unknown): Promise<{ projectPath: string; task: InboxTask }> {
    const projectPath = await this.deps.assertProject(String(projectPathRaw || ''));
    const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
    if (!/^[A-Za-z]+-\d+(?:\.\d+)*$/.test(taskId)) throw new Error('taskId is required');
    const task = (await this.deps.tasks(projectPath)).find((t) => t.id.toUpperCase() === taskId.toUpperCase());
    if (!task) throw new AppError('inbox.taskNotFound', { id: taskId });
    return { projectPath, task };
  }

  /**
   * Решение по задаче из Review (decision-117 п. 4): `done` — в Done, `return` — в In Progress с комментарием в
   * Implementation Notes и, по флагу `restart`, новым запуском роли. Задача должна быть в Review: двойное нажатие на
   * двух телефонах не переведёт задачу, которую уже приняли или вернули.
   */
  async reviewTask(params: Record<string, unknown>, device: { name: string; rights: DeviceRights; memberId?: string }): Promise<RemoteReviewResult> {
    const action = params.action;
    if (action !== 'done' && action !== 'return') throw new Error('action must be done or return');
    const { projectPath, task } = await this.reviewTaskOf(params.projectPath, params.taskId);
    if (!isReview(task.status)) throw new AppError('inbox.notInReview', { id: task.id, status: task.status });
    const comment = typeof params.comment === 'string' ? params.comment.trim().slice(0, 4000) : '';
    const restart = action === 'return' && params.restart === true;
    if (action === 'return' && !comment) throw new AppError('inbox.commentRequired');
    if (restart && device.rights !== 'full') throw new AppError('inbox.restartFullOnly');

    const status = action === 'done' ? 'Done' : 'In Progress';
    const who = device.name || 'телефон';
    const note = action === 'done'
      ? `Принято с проверки (${who}, ${this.deps.timestamp()})${comment ? `: ${comment}` : ''}`
      : `Возвращено с проверки (${who}, ${this.deps.timestamp()}): ${comment}`;
    const written = await this.deps.updateTask(projectPath, task.id, (data, content) => ({
      data: { ...data, status },
      content: this.deps.applyNote(content, note)
    }));
    if (!written) throw new AppError('inbox.taskFileNotFound', { id: task.id });
    this.deps.changed('review');

    if (!restart) return { ok: true, status };
    const sessions = this.deps.swarms(projectPath);
    const prior = lastRoleSession(sessions, task.id);
    const roleSlug = prior?.agents.find((a) => a.config.roleSlug)?.config.roleSlug;
    if (!roleSlug) throw new AppError('inbox.noRoleToRestart');
    const prompt = [
      `Task ${task.id} was returned from review by a human.`,
      `Reviewer comment:\n${comment}`,
      'Fix the remarks and bring the task to its acceptance criteria.'
    ].join('\n\n');
    const res = await this.deps.startAgent({
      projectPath,
      taskId: task.id,
      taskTitle: task.title,
      roleSlug,
      prompt,
      doneLoop: Boolean(prior?.doneLoop),
      // Доработку по замечаниям запускает участник — агент в его worktree (TASK-142.3).
      ...(device.memberId ? { memberId: device.memberId } : {})
    });
    if ('error' in res) throw new AppError('inbox.agentNotStarted', { detail: res.error });
    return { ok: true, status, swarmId: res.swarmId };
  }

  /** Часть скриншота из последнего отчёта задачи: другие файлы хранилища `visual` не отдаются. */
  async screenshotChunk(params: Record<string, unknown>): Promise<RemoteScreenshotChunk> {
    const { projectPath, task } = await this.reviewTaskOf(params.projectPath, params.taskId);
    const relPath = typeof params.relPath === 'string' ? params.relPath : '';
    const loop = latestDoneLoopSession(this.deps.swarms(projectPath), task.id);
    const report = loop ? reviewReportFromSession(loop) : undefined;
    if (!relPath || !reportScreenshotPaths(report, reviewCriteria(task.criteria, loop)).has(relPath)) {
      throw new AppError('inbox.screenshotNotInReport');
    }
    const mime = MIME[path.extname(relPath).toLowerCase()];
    if (!mime) throw new AppError('inbox.notAnImage');
    const abs = await this.deps.resolveVisual(relPath);
    if (!abs) throw new AppError('inbox.screenshotRemoved');
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > SCREENSHOT_MAX_BYTES) throw new AppError('inbox.screenshotTooLarge');
    const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
    if (offset > st.size) throw new Error('offset is outside the file');
    const handle = await fs.open(abs, 'r');
    try {
      const length = Math.min(SCREENSHOT_CHUNK, st.size - offset);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      return { mime, total: st.size, offset, data: buf.toString('base64') };
    } finally {
      await handle.close();
    }
  }
}
