/**
 * Agents Studio с телефона (TASK-140.10, decision-83). Чистые функции без Electron и React: хост превращает
 * сессии и поток Agents Studio в формы для телефона, окно ProjectHub применяет выбор модели с телефона.
 *
 * На телефон уходит только то, что нужно читать с экрана: текст сообщений (с ограничением длины), имя и
 * статус вызова инструмента и короткая подпись (команда, путь). Диффы, содержимое файлов и результаты
 * инструментов не уходят — они остаются на ПК.
 */

import type { AIMessage, AIProviderConfig, AISession, AIToolCall, ClaudeUsageData } from '../types/electron';
import type {
  RemoteStudioMessage,
  RemoteStudioSession,
  RemoteStudioSessionSummary,
  RemoteStudioSessionUsage,
  RemoteStudioToolCall,
  RemoteStudioUsage,
  StudioMode,
  StudioModelSelection
} from '../types/remote';

export const STUDIO_PHONE_LIMITS = {
  /** Сколько последних сообщений сессии уходит на телефон. */
  messages: 60,
  messageText: 12_000,
  toolSummary: 160,
  preview: 90,
  sessions: 300
} as const;

export const STUDIO_MODES: StudioMode[] = ['agent', 'chat', 'architect'];

export function parseStudioMode(value: unknown): StudioMode | undefined {
  return STUDIO_MODES.includes(value as StudioMode) ? (value as StudioMode) : undefined;
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit)}…`, truncated: true } : { text, truncated: false };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Подпись вызова: команда, путь, шаблон или адрес — то, что видно в строке инструмента на ПК. */
export function toolCallSummary(tc: Pick<AIToolCall, 'args'>): string | undefined {
  const args = (tc.args || {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'filePath', 'pattern', 'url', 'query', 'description']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return clip(oneLine(value), STUDIO_PHONE_LIMITS.toolSummary).text;
  }
  return undefined;
}

export function toolCallForPhone(tc: AIToolCall): RemoteStudioToolCall {
  const summary = toolCallSummary(tc);
  return { id: String(tc.id), name: String(tc.name), ...(tc.status ? { status: tc.status } : {}), ...(summary ? { summary } : {}) };
}

/** Сообщение для телефона; системные и служебные сообщения инструментов не показываются. */
export function messageForPhone(m: AIMessage): RemoteStudioMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const tools = m.role === 'assistant' && m.toolCalls?.length ? m.toolCalls.map(toolCallForPhone) : undefined;
  const content = typeof m.content === 'string' ? m.content : '';
  if (m.role === 'assistant' && !content && m.error) {
    return { id: m.id, role: 'error', text: clip(m.providerError?.message || m.error, STUDIO_PHONE_LIMITS.messageText).text, ...(tools ? { tools } : {}) };
  }
  const { text, truncated } = clip(content, STUDIO_PHONE_LIMITS.messageText);
  if (!text && !tools) return null;
  return { id: m.id, role: m.role, text, ...(tools ? { tools } : {}), ...(truncated ? { truncated } : {}) };
}

export function sessionUpdatedAt(s: AISession): number {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const t = Date.parse(s.messages[i].timestamp);
    if (Number.isFinite(t)) return t;
  }
  return s.createdAt;
}

/** «Claude · sonnet», «LM Studio · qwen3», «deepseek · deepseek-chat». */
export function selectionLabel(sel: StudioModelSelection | undefined, profileNames: ReadonlyMap<string, string> = new Map()): string | undefined {
  if (!sel?.model) return undefined;
  if (sel.provider === 'anthropic') return `Claude · ${sel.model}`;
  if (sel.provider === 'openai-compatible') return `${(sel.profileId && profileNames.get(sel.profileId)) || 'Профиль'} · ${sel.model}`;
  return `${sel.provider} · ${sel.model}`;
}

export interface SummaryContext {
  running: boolean;
  profileNames?: ReadonlyMap<string, string>;
}

/** Отказ при записи в чужую сессию участника общего хоста (TASK-142.3). */
export const STUDIO_READ_ONLY_ERROR = 'Это сессия другого участника: её можно читать, но писать в неё может только он';

/**
 * Можно ли писать в сессию Agents Studio (decision-84 п. 5): только её владелец. Сессия владельца хоста (без
 * `memberId`) — для окна хоста и устройств владельца; сессия участника — только для его устройств.
 */
export function canWriteStudioSession(session: Pick<AISession, 'memberId'>, writerMemberId: string | undefined): boolean {
  return (session.memberId || undefined) === (writerMemberId || undefined);
}

export function summarizeStudioSession(s: AISession, ctx: SummaryContext): RemoteStudioSessionSummary {
  const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
  const modelLabel = selectionLabel(s.lastSelection, ctx.profileNames);
  return {
    id: s.id,
    title: s.title || 'Без названия',
    createdAt: s.createdAt,
    updatedAt: sessionUpdatedAt(s),
    messageCount: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    archived: typeof s.archivedAt === 'number',
    ...(s.origin ? { origin: s.origin } : {}),
    ...(s.originDevice ? { originDevice: s.originDevice } : {}),
    ...(s.memberId ? { memberId: s.memberId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    running: ctx.running,
    preview: lastUser ? clip(oneLine(lastUser.content || ''), STUDIO_PHONE_LIMITS.preview).text : ''
  };
}

/** Список для телефона: свежие сверху, пустые сессии (без сообщений) — только открытые вкладки. */
export function studioSessionList(sessions: AISession[], isRunning: (id: string) => boolean, profileNames?: ReadonlyMap<string, string>): RemoteStudioSessionSummary[] {
  return sessions
    .filter((s) => s.messages.length > 0 || typeof s.archivedAt !== 'number')
    .map((s) => summarizeStudioSession(s, { running: isRunning(s.id), profileNames }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, STUDIO_PHONE_LIMITS.sessions);
}

export function studioSessionForPhone(s: AISession, ctx: SummaryContext): RemoteStudioSession {
  const all = s.messages.map(messageForPhone).filter((m): m is RemoteStudioMessage => m !== null);
  const messages = all.slice(-STUDIO_PHONE_LIMITS.messages);
  const usage = sessionUsage(s);
  return {
    ...summarizeStudioSession(s, ctx),
    messages,
    olderOmitted: all.length - messages.length,
    ...(s.lastSelection ? { lastSelection: s.lastSelection } : {}),
    ...(s.lastMode ? { lastMode: s.lastMode } : {}),
    ...(usage ? { usage } : {})
  };
}

/** Расход сессии: сумма `usage` ответов; `undefined`, если движок расход не сообщал. */
export function sessionUsage(s: Pick<AISession, 'messages'>): RemoteStudioSessionUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let hasCost = false;
  let estimated = false;
  let any = false;
  for (const m of s.messages) {
    const u = m.usage;
    if (!u) continue;
    any = true;
    inputTokens += (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
    outputTokens += u.outputTokens || 0;
    if (typeof u.costUsd === 'number') {
      cost += u.costUsd;
      hasCost = true;
    }
    if (u.estimated) estimated = true;
  }
  if (!any) return undefined;
  return { inputTokens, outputTokens, ...(hasCost ? { costUsd: Math.round(cost * 10_000) / 10_000 } : {}), ...(estimated ? { estimated } : {}) };
}

/** Окно Usage для телефона: лимиты, запросы и токены по моделям. Без сырого вывода CLI. */
export function usageForPhone(d: ClaudeUsageData): RemoteStudioUsage {
  const win = (w?: { percent: number; resetsAt?: string }) =>
    w && Number.isFinite(w.percent) ? { percent: Math.max(0, Math.min(100, Math.round(w.percent))), ...(w.resetsAt ? { resetsAt: String(w.resetsAt).slice(0, 80) } : {}) } : undefined;
  const breakdown = (b?: { requests?: number; sessions?: number }) =>
    b && (b.requests !== undefined || b.sessions !== undefined) ? { ...(b.requests !== undefined ? { requests: b.requests } : {}), ...(b.sessions !== undefined ? { sessions: b.sessions } : {}) } : undefined;
  const models = Object.entries(d.modelUsage ?? {})
    .map(([model, t]) => ({
      model,
      inputTokens: (t.inputTokens || 0) + (t.cacheReadInputTokens || 0) + (t.cacheCreationInputTokens || 0),
      outputTokens: t.outputTokens || 0,
      ...(typeof t.costUSD === 'number' ? { costUSD: t.costUSD } : {})
    }))
    .sort((a, b) => b.outputTokens + b.inputTokens - (a.outputTokens + a.inputTokens))
    .slice(0, 12);
  const out: RemoteStudioUsage = { planType: d.planType || '', models, updatedAt: d.updatedAt };
  const session = win(d.sessionLimit);
  const weekly = win(d.weeklyLimit);
  const fable = win(d.fableLimit);
  if (session) out.sessionLimit = session;
  if (weekly) out.weeklyLimit = weekly;
  if (fable) out.fableLimit = fable;
  const l24 = breakdown(d.last24h);
  const l7 = breakdown(d.last7d);
  if (l24) out.last24h = l24;
  if (l7) out.last7d = l7;
  if (d.totalSessions !== undefined) out.totalSessions = d.totalSessions;
  if (d.totalMessages !== undefined) out.totalMessages = d.totalMessages;
  if (d.isFallback) out.isFallback = true;
  if (d.cliError) out.error = { kind: d.cliError.kind, message: usageErrorText(d.cliError.kind) };
  return out;
}

/** Понятная причина, почему лимиты не прочитаны (как в окне Usage на ПК). */
export function usageErrorText(kind: string): string {
  switch (kind) {
    case 'auth':
      return 'Claude Code на ПК не вошёл в аккаунт — войдите в окне Usage на компьютере.';
    case 'timeout':
      return 'Claude Code не ответил вовремя — показана статистика из кэша.';
    case 'unrecognized':
      return 'Ответ Claude Code не распознан — показана статистика из кэша.';
    default:
      return 'Не удалось получить лимиты Claude Code — показана статистика из кэша.';
  }
}

/** Чанк потока Agents Studio для телефона: текст и строка инструмента. Мысли, диффы и вывод — нет. */
export function studioChunkForPhone(chunk: { text?: string; toolCall?: AIToolCall }): { text?: string; tool?: RemoteStudioToolCall } | null {
  const out: { text?: string; tool?: RemoteStudioToolCall } = {};
  if (typeof chunk.text === 'string' && chunk.text) out.text = chunk.text;
  if (chunk.toolCall?.id && chunk.toolCall.name) out.tool = toolCallForPhone(chunk.toolCall);
  return out.text || out.tool ? out : null;
}

const SELECTABLE_PROVIDERS = new Set(['anthropic', 'openai-compatible']);

/** Проверка выбора модели, пришедшего с телефона: только Claude и профили LLM, как в списке на телефоне. */
export function parseStudioSelection(value: unknown): StudioModelSelection | undefined {
  const v = value as Partial<StudioModelSelection> | undefined;
  if (!v || typeof v.provider !== 'string' || typeof v.model !== 'string' || !v.model.trim()) return undefined;
  if (!SELECTABLE_PROVIDERS.has(v.provider)) return undefined;
  if (v.provider === 'openai-compatible' && (typeof v.profileId !== 'string' || !v.profileId)) return undefined;
  return {
    provider: v.provider,
    ...(v.provider === 'openai-compatible' ? { profileId: String(v.profileId).slice(0, 120) } : {}),
    model: v.model.trim().slice(0, 200)
  };
}

/**
 * Конфиг запроса с выбором модели — так же, как `ModelSelectorDropdown` на ПК меняет провайдера, профиль и
 * модель. Глобальный выбор Agents Studio при этом не меняется: модель с телефона действует на эту сессию.
 */
export function applyStudioSelection(config: AIProviderConfig, sel: StudioModelSelection | undefined): AIProviderConfig {
  if (!sel) return config;
  return {
    ...config,
    provider: sel.provider as AIProviderConfig['provider'],
    profileId: sel.provider === 'openai-compatible' ? sel.profileId : undefined,
    model: sel.model
  };
}

export function selectionOf(config: Pick<AIProviderConfig, 'provider' | 'profileId' | 'model'>): StudioModelSelection {
  return { provider: config.provider, ...(config.profileId ? { profileId: config.profileId } : {}), model: config.model };
}
