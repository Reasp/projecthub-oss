/**
 * Голосовое управление агентом вкладки Agents Studio (TASK-276, [[decision-203]]): кому адресовано голосовое «да»,
 * когда голое «да» принимается, чьи ответы и вопросы читаются вслух и как звучит статус агента.
 *
 * Раньше голое «да» одобряло первый запрос проекта, а не запрос вкладки, на которую смотрит человек, и срабатывало
 * на фоновый разговор: ключевое слово по умолчанию выключено. Теперь адресат — запрос активной вкладки активного
 * проекта (или действие на компьютере, которое голос сам и поручил), а голое «да»/«нет» без обращения принимается
 * только в окне ответа после заданного вслух вопроса. Вне окна вопрос задаётся заново.
 *
 * Чистый модуль без React и Electron — покрыт unit-тестами.
 */
import type { AIMessage, AIToolCall, ApprovalRequest } from '../types/electron';
import { toolLabel, toolSubject } from '../lib/agentToolView';
import { summarizeForSpeech } from './ttsSummary';

/** Активная вкладка: проект и сессия Agents Studio, к которым относятся голосовые команды агенту. */
export interface VoiceAgentScope {
  projectPath?: string;
  sessionId?: string;
}

/** Пути проекта с разных сторон приходят с разным регистром диска и разделителями. */
function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Голые ответы: короткие слова обычной речи, которые без обращения легко услышать в чужом разговоре. */
const BARE_ANSWER = /^(?:да|нет|не надо|согласен|yes|yeah|yep|no|nope)$/iu;

export function isBareVoiceAnswer(text: string): boolean {
  const normalized = (text ?? '')
    .toLowerCase()
    .replace(/[.,!?;:…]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return BARE_ANSWER.test(normalized);
}

export interface VoiceApprovalTarget {
  request: ApprovalRequest;
  /** Карточка вкладки Agents Studio или общая очередь HITL: ответ уходит туда, где запрос ждёт. */
  via: 'studio' | 'hitl';
}

/**
 * Запрос, на который отвечает голос: запрос активной вкладки, иначе действие на компьютере (его поручают голосом,
 * [[decision-27]]). Запросы других вкладок, проектов, терминалов и роя голосу недоступны — их решают в Центре решений.
 */
export function pickVoiceApprovalTarget(
  scope: VoiceAgentScope,
  studioPending: readonly ApprovalRequest[],
  hitlPending: readonly ApprovalRequest[]
): VoiceApprovalTarget | null {
  const { projectPath, sessionId } = scope;
  if (projectPath && sessionId) {
    const studio = studioPending.find((r) => r.sessionId === sessionId);
    if (studio) return { request: studio, via: 'studio' };
    const hitl = hitlPending.find((r) => r.sessionId === sessionId && samePath(r.projectPath, projectPath));
    if (hitl) return { request: hitl, via: 'hitl' };
  }
  const computer = hitlPending.find((r) => r.type === 'computer_action');
  return computer ? { request: computer, via: 'hitl' } : null;
}

/** Окно ответа: после заданного вслух вопроса голое «да»/«нет» относится к нему. */
export interface VoiceAnswerWindow {
  requestId: string | null;
  until: number;
}

/** С конца вопроса: хватает подумать, но фоновая реплика через минуту уже ничего не одобрит. */
export const VOICE_ANSWER_WINDOW_MS = 20_000;

export function createAnswerWindow(): VoiceAnswerWindow {
  return { requestId: null, until: 0 };
}

export function openAnswerWindow(state: VoiceAnswerWindow, requestId: string, now: number, windowMs = VOICE_ANSWER_WINDOW_MS): void {
  state.requestId = requestId;
  state.until = now + windowMs;
}

export function closeAnswerWindow(state: VoiceAnswerWindow): void {
  state.requestId = null;
  state.until = 0;
}

export function isAnswerWindowOpen(state: VoiceAnswerWindow, requestId: string, now: number): boolean {
  return state.requestId === requestId && now <= state.until;
}

/**
 * Что сделать с голосовым «да»/«нет»:
 * - `decide` — ответить на запрос;
 * - `reask` — голое слово вне окна ответа: задать вопрос заново и открыть окно;
 * - `nothing` — явная команда, а отвечать не на что (показать почему);
 * - `ignore` — голое слово, а запроса нет: обычная речь, молчим.
 */
export type VoiceApprovalVerdict = 'decide' | 'reask' | 'nothing' | 'ignore';

export function resolveVoiceApproval(input: {
  target: ApprovalRequest | null | undefined;
  /** Голое «да»/«нет» или ответ, который угадала модель по свободной речи. */
  bare: boolean;
  /** Фраза обращена к приложению: ключевое слово или запись по клавише. */
  addressed: boolean;
  now: number;
  answerWindow: VoiceAnswerWindow;
}): VoiceApprovalVerdict {
  const { target, bare, addressed, now, answerWindow } = input;
  if (!target) return bare && !addressed ? 'ignore' : 'nothing';
  if (!bare || addressed) return 'decide';
  return isAnswerWindowOpen(answerWindow, target.id, now) ? 'decide' : 'reask';
}

/** Ответ или вопрос агента звучит, только если он из активной вкладки активного проекта. */
export function isActiveAgentScope(event: VoiceAgentScope, active: VoiceAgentScope): boolean {
  return Boolean(event.sessionId) && event.sessionId === active.sessionId && samePath(event.projectPath, active.projectPath);
}

/** Последний законченный ответ агента; во время хода незаконченный ответ пропускается. */
export function lastAgentAnswer(messages: readonly AIMessage[], streaming: boolean): string | null {
  let end = messages.length;
  if (streaming && end > 0 && messages[end - 1].role === 'assistant') end -= 1;
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.error && m.content?.trim()) return m.content;
  }
  return null;
}

const STEP_SUBJECT_MAX = 80;

/** Шаг агента для озвучки: имя инструмента и цель; у пути — только имя файла, длинный путь вслух не нужен. */
export function describeToolStepForSpeech(call: Pick<AIToolCall, 'name' | 'args'>): string {
  const label = toolLabel(call.name);
  let subject = toolSubject(call.name, call.args)?.trim();
  if (subject && !/\s/.test(subject) && /[\\/]/.test(subject)) {
    subject = subject.split(/[\\/]/).filter(Boolean).pop() ?? subject;
  }
  if (subject && subject.length > STEP_SUBJECT_MAX) subject = `${subject.slice(0, STEP_SUBJECT_MAX - 1)}…`;
  return subject ? `${label} ${subject}` : label;
}

/** Последний шаг текущего хода: последний вызов инструмента в последнем ответе агента. */
export function lastAgentStep(messages: readonly AIMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const call = last.toolCalls?.[last.toolCalls.length - 1];
  return call ? describeToolStepForSpeech(call) : null;
}

export interface VoiceAgentStatusLabels {
  noSession: string;
  /** {title} — вопрос агента. */
  waiting: string;
  /** {step} — последний шаг. */
  working: string;
  workingNoStep: string;
  /** {answer} — начало последнего ответа. */
  idle: string;
  idleEmpty: string;
  /** {count} — сообщения в очереди вкладки. */
  queued: string;
}

/** Длина ответа в статусе: статус — коротко, весь ответ читает команда «повтори ответ». */
const STATUS_ANSWER_MAX = 160;

/** Статус агента вкладки одной фразой для озвучки: ждёт решения, работает (последний шаг) или свободен. */
export function describeVoiceAgentStatus(
  input: { hasSession: boolean; streaming: boolean; pendingTitle?: string; messages: readonly AIMessage[]; queued: number },
  labels: VoiceAgentStatusLabels
): string {
  if (!input.hasSession) return labels.noSession;
  let text: string;
  if (input.pendingTitle) {
    text = labels.waiting.replace('{title}', input.pendingTitle);
  } else if (input.streaming) {
    const step = lastAgentStep(input.messages);
    text = step ? labels.working.replace('{step}', step) : labels.workingNoStep;
  } else {
    const answer = lastAgentAnswer(input.messages, false);
    const short = answer ? summarizeForSpeech(answer, { maxChars: STATUS_ANSWER_MAX }) : '';
    text = short ? labels.idle.replace('{answer}', short) : labels.idleEmpty;
  }
  return input.queued > 0 ? `${text} ${labels.queued.replace('{count}', String(input.queued))}` : text;
}
