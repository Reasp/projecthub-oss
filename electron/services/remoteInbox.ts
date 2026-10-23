import type { AppBusEvent } from './hitlTypes.js';
import type { CheckRunResult } from './arenaTypes.js';
import type { SwarmSession } from './swarmTypes.js';
import type {
  RemoteInboxEvent,
  RemoteNoteLevel,
  RemoteReviewCheck,
  RemoteReviewCriterion,
  RemoteReviewReport,
  RemoteReviewScreenshot
} from '../../src/types/remote.js';

/**
 * «Входящие» телефона на стороне хоста (TASK-140.5, [[decision-117]]): чистые функции без Electron — какие события
 * шины попадают в журнал ленты, журнал с ограничением по числу и возрасту, отчёт цикла «до готовности» для проверки
 * задачи с телефона и лимит частоты `projecthub_notify`. Файлы, сеть и сервисы — в `remoteInboxService.ts`.
 */

export const INBOX_STATE_VERSION = 1;
export const INBOX_MAX_EVENTS = 200;
export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Агенты, чей итог нужен человеку: ответы Studio и терминальные сессии видны в чате и засорили бы ленту. */
const FEED_ORIGINS = new Set(['swarm', 'handoff', 'assigned', 'automation']);

const BODY_MAX = 1000;

function cut(text: string | undefined, max = BODY_MAX): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Запись журнала по событию шины; `null` — событие в ленту не идёт. `id` выдаёт журнал. */
export function inboxEventFromBus(event: AppBusEvent): Omit<RemoteInboxEvent, 'id'> | null {
  switch (event.type) {
    case 'agent:finished':
      // Остановку человек сделал сам — ему об этом сообщать не нужно.
      if (event.outcome !== 'done' || !FEED_ORIGINS.has(event.origin)) return null;
      return {
        kind: 'agent_done',
        at: event.at,
        title: `${event.agentName || event.role || 'Агент'} завершил работу`,
        projectPath: event.projectPath,
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {})
      };
    case 'agent:failed':
      if (!FEED_ORIGINS.has(event.origin)) return null;
      return {
        kind: 'agent_failed',
        at: event.at,
        title: `${event.agentName || event.role || 'Агент'} упал`,
        body: cut(event.error),
        projectPath: event.projectPath,
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {})
      };
    case 'automation:runFinished':
      if (event.outcome !== 'failed') return null;
      return {
        kind: 'automation_failed',
        at: event.at,
        title: `Automations: «${event.ruleName}» не выполнено`,
        body: cut(event.detail),
        ...(event.projectPath ? { projectPath: event.projectPath } : {}),
        ...(event.swarmId ? { swarmId: event.swarmId } : {})
      };
    case 'automation:suspended':
      return {
        kind: 'automation_suspended',
        at: event.at,
        title: `Automations: «${event.ruleName}» приостановлено до полуночи`,
        body: event.reason === 'budget' ? 'Исчерпан дневной бюджет' : 'Исчерпано дневное число запусков',
        ...(event.projectPath ? { projectPath: event.projectPath } : {})
      };
    default:
      return null;
  }
}

/** Журнал ленты: новые сверху, не больше `INBOX_MAX_EVENTS` и не старше `INBOX_MAX_AGE_MS`. */
export class InboxJournal {
  private events: RemoteInboxEvent[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => Math.random().toString(36).slice(2, 10)
  ) {}

  load(events: RemoteInboxEvent[]): void {
    this.events = events;
    this.prune();
  }

  add(event: Omit<RemoteInboxEvent, 'id'>): RemoteInboxEvent {
    const entry: RemoteInboxEvent = { ...event, id: `e${event.at.toString(36)}${(++this.seq).toString(36)}${this.randomId()}` };
    this.events = [entry, ...this.events].sort((a, b) => b.at - a.at);
    this.prune();
    return entry;
  }

  /** Убрать записи по id; возвращает, сколько убрано. */
  dismiss(ids: readonly string[]): number {
    const drop = new Set(ids);
    const before = this.events.length;
    this.events = this.events.filter((e) => !drop.has(e.id));
    return before - this.events.length;
  }

  list(): RemoteInboxEvent[] {
    this.prune();
    return this.events;
  }

  private prune(): void {
    const oldest = this.now() - INBOX_MAX_AGE_MS;
    this.events = this.events.filter((e) => e.at >= oldest).slice(0, INBOX_MAX_EVENTS);
  }
}

const EVENT_KINDS = new Set<RemoteInboxEvent['kind']>(['agent_done', 'agent_failed', 'automation_failed', 'automation_suspended', 'agent_note']);
const LEVELS = new Set<RemoteNoteLevel>(['info', 'success', 'warning', 'error']);

/** Записи из файла состояния: неизвестные виды и битые записи отбрасываются. */
export function normalizeInboxEvents(raw: unknown): RemoteInboxEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: RemoteInboxEvent[] = [];
  for (const item of raw) {
    const v = (item || {}) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : undefined);
    const id = str('id');
    const title = str('title');
    const kind = v.kind as RemoteInboxEvent['kind'];
    if (!id || !title || !EVENT_KINDS.has(kind) || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
    const level = v.level as RemoteNoteLevel;
    const entry: RemoteInboxEvent = { id, kind, at: v.at, title };
    for (const key of ['body', 'projectPath', 'agentName', 'role', 'taskId', 'swarmId', 'agentId'] as const) {
      const value = str(key);
      if (value) entry[key] = value;
    }
    if (LEVELS.has(level)) entry.level = level;
    out.push(entry);
  }
  return out;
}

// ── отчёт цикла «до готовности» для проверки с телефона ──

const DETAIL_MAX = 600;

function checkDetail(check: CheckRunResult): string | undefined {
  if (check.detail) return cut(check.detail, DETAIL_MAX);
  if (check.status !== 'failed' && check.status !== 'timeout' && check.status !== 'error') return undefined;
  // Хвост вывода упавшей проверки: последние строки, где обычно ошибка.
  const tail = (check.outputTail || '').trim().split(/\r?\n/).slice(-8).join('\n');
  return tail ? cut(tail.length > DETAIL_MAX ? tail.slice(tail.length - DETAIL_MAX) : tail, DETAIL_MAX) : undefined;
}

/**
 * Последний отчёт цикла по задаче: сессия с `doneLoop` и этой задачей, последняя по времени. Итерации, отменённые
 * откатом целиком, не считаются — их работы в проекте больше нет.
 */
export function latestDoneLoopSession(sessions: readonly SwarmSession[], taskId: string): SwarmSession | undefined {
  const key = taskId.toUpperCase();
  return [...sessions]
    .filter((s) => s.doneLoop && (s.taskId || '').toUpperCase() === key)
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0];
}

/** Отчёт без вывода агента и путей worktree: только то, что нужно для решения «принять или вернуть». */
export function reviewReportFromSession(session: SwarmSession): RemoteReviewReport | undefined {
  const loop = session.doneLoop;
  if (!loop) return undefined;
  const live = loop.iterations.filter((it) => it.rolledBack !== 'full');
  const last = live[live.length - 1];
  const agent = session.agents[0];
  const screenshots: RemoteReviewScreenshot[] = [];
  for (const check of last?.checks ?? []) {
    for (const a of check.artifacts ?? []) {
      if (a.kind === 'screenshot') screenshots.push({ relPath: a.relPath, name: a.name, checkName: check.name, bytes: a.bytes });
    }
  }
  const checks: RemoteReviewCheck[] = (last?.checks ?? []).map((c) => ({
    name: c.name,
    kind: c.kind,
    status: c.status,
    blocking: c.blocking,
    ...(typeof c.passedTests === 'number' ? { passedTests: c.passedTests } : {}),
    ...(typeof c.failedTests === 'number' ? { failedTests: c.failedTests } : {}),
    ...(typeof c.errorCount === 'number' ? { errorCount: c.errorCount } : {}),
    ...(checkDetail(c) ? { detail: checkDetail(c) } : {})
  }));
  return {
    swarmId: session.id,
    ...(loop.outcome ? { outcome: loop.outcome } : {}),
    ...(loop.reason ? { reason: cut(loop.reason, DETAIL_MAX) } : {}),
    ...(session.completedAt ? { finishedAt: session.completedAt } : {}),
    iterations: live.length,
    ...(last?.reportSummary ? { summary: cut(last.reportSummary, 2000) } : {}),
    ...(typeof loop.totalCostUsd === 'number' ? { costUsd: loop.totalCostUsd } : {}),
    checks,
    screenshots,
    ...(agent?.config.roleSlug ? { roleSlug: agent.config.roleSlug } : {}),
    ...(agent?.config.name ? { agentName: agent.config.name } : {})
  };
}

/**
 * Критерии задачи с вердиктом цикла: текст и отметка — из файла задачи (источник истины), вердикт и evidence — из
 * последней итерации, сопоставление по номеру и тексту (агент мог поменять порядок только правкой файла, а её
 * цикл откатывает).
 */
export function reviewCriteria(
  fileCriteria: ReadonlyArray<{ text: string; completed: boolean }>,
  session: SwarmSession | undefined
): RemoteReviewCriterion[] {
  const loop = session?.doneLoop;
  const live = loop?.iterations.filter((it) => it.rolledBack !== 'full') ?? [];
  const verdicts = live[live.length - 1]?.criteria ?? [];
  return fileCriteria.map((c, i) => {
    const index = i + 1;
    const v = verdicts.find((x) => x.index === index && x.text.trim() === c.text.trim()) ?? verdicts.find((x) => x.text.trim() === c.text.trim());
    const base: RemoteReviewCriterion = { index, text: c.text, completed: c.completed };
    if (!v) return base;
    return {
      ...base,
      accepted: v.accepted,
      ...(v.reported ? { reported: v.reported } : {}),
      ...(v.evidence ? { evidence: cut(v.evidence, DETAIL_MAX) } : {}),
      ...(v.reason ? { reason: cut(v.reason, 300) } : {}),
      ...(v.ui ? { ui: true } : {}),
      ...(v.screenshots?.length ? { screenshots: v.screenshots.map((s) => ({ relPath: s.relPath, name: s.name, checkName: s.checkId })) } : {})
    };
  });
}

/** Все скриншоты отчёта — только их отдаёт `get_review_screenshot`. */
export function reportScreenshotPaths(report: RemoteReviewReport | undefined, criteria: readonly RemoteReviewCriterion[]): Set<string> {
  const paths = new Set<string>();
  for (const s of report?.screenshots ?? []) paths.add(s.relPath);
  for (const c of criteria) for (const s of c.screenshots ?? []) paths.add(s.relPath);
  return paths;
}

// ── projecthub_notify ──

export const NOTIFY_TOOL_NAME = 'projecthub_notify';

/** Одно описание для встроенного MCP и tool-loop API-движка (decision-117 п. 8). */
export const NOTIFY_TOOL_DEFINITION = {
  name: NOTIFY_TOOL_NAME,
  description:
    'Позвать человека: короткое сообщение во «Входящие» его телефона и зашифрованный push. Для того, что человек '
    + 'просил сообщить («напиши, когда тесты пройдут»), итога долгой работы или проблемы, без которой не продолжить. '
    + 'Не для обычного хода работы и не вместо вопроса с выбором. Не чаще раза в 30 секунд и 10 раз в час на сессию.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Текст сообщения, до 500 символов: что случилось и что нужно от человека' },
      level: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Важность: info по умолчанию' }
    },
    required: ['text']
  } as Record<string, unknown>
};

export const NOTE_MAX_CHARS = 500;
/** Не чаще одного сообщения в 30 секунд и не больше 10 в час на сессию агента. */
export const NOTE_MIN_INTERVAL_MS = 30_000;
export const NOTE_PER_HOUR = 10;

export interface ParsedNote {
  text: string;
  level: RemoteNoteLevel;
}

/** Разбор аргументов инструмента; ошибка — текст для агента. */
export function parseNoteArgs(args: Record<string, unknown>): ParsedNote | { error: string } {
  const text = typeof args.text === 'string' ? args.text.replace(/\s+$/g, '').trim() : '';
  if (!text) return { error: 'The message text (text) is required.' };
  if (text.length > NOTE_MAX_CHARS) return { error: `The message is longer than ${NOTE_MAX_CHARS} characters — shorten it.` };
  const raw = typeof args.level === 'string' ? args.level.trim().toLowerCase() : '';
  if (raw && !LEVELS.has(raw as RemoteNoteLevel)) return { error: 'level must be info, success, warning or error.' };
  return { text, level: (raw as RemoteNoteLevel) || 'info' };
}

/** Лимит частоты сообщений по сессии агента. */
export class NoteRateLimiter {
  private sent = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Можно ли отправить сейчас; `retryAfterMs` — через сколько можно повторить. Успешная проверка считает отправку. */
  take(sessionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.sent.get(sessionId) ?? []).filter((t) => now - t < 3_600_000);
    const last = recent[recent.length - 1];
    if (last !== undefined && now - last < NOTE_MIN_INTERVAL_MS) {
      this.sent.set(sessionId, recent);
      return { ok: false, retryAfterMs: NOTE_MIN_INTERVAL_MS - (now - last) };
    }
    if (recent.length >= NOTE_PER_HOUR) {
      this.sent.set(sessionId, recent);
      return { ok: false, retryAfterMs: 3_600_000 - (now - recent[0]) };
    }
    recent.push(now);
    this.sent.set(sessionId, recent);
    // Карта не растёт бесконечно: сессии без отправок за час забываются.
    if (this.sent.size > 500) for (const [k, v] of this.sent) if (v.every((t) => now - t >= 3_600_000)) this.sent.delete(k);
    return { ok: true };
  }
}

export function noteTitle(level: RemoteNoteLevel, who: string | undefined): string {
  const name = who || 'Агент';
  if (level === 'error') return `${name}: ошибка`;
  if (level === 'warning') return `${name}: нужно внимание`;
  if (level === 'success') return `${name}: готово`;
  return `${name}: сообщение`;
}
