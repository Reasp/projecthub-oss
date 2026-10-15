/**
 * AI Studio с телефона (TASK-140.10, decision-83). Чистые функции без Electron и React: хост превращает
 * сессии и поток AI Studio в формы для телефона, окно ProjectHub применяет выбор модели с телефона.
 *
 * На телефон уходит только то, что нужно читать с экрана: текст сообщений (с ограничением длины), имя и
 * статус вызова инструмента и короткая подпись (команда, путь). Диффы, содержимое файлов и результаты
 * инструментов не уходят — они остаются на ПК.
 */

import type { AIMessage, AIProviderConfig, AISession, AIToolCall } from '../types/electron';
import type {
  RemoteStudioMessage,
  RemoteStudioSession,
  RemoteStudioSessionSummary,
  RemoteStudioToolCall,
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
  return {
    ...summarizeStudioSession(s, ctx),
    messages,
    olderOmitted: all.length - messages.length,
    ...(s.lastSelection ? { lastSelection: s.lastSelection } : {}),
    ...(s.lastMode ? { lastMode: s.lastMode } : {})
  };
}

/** Чанк потока AI Studio для телефона: текст и строка инструмента. Мысли, диффы и вывод — нет. */
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
 * модель. Глобальный выбор AI Studio при этом не меняется: модель с телефона действует на эту сессию.
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
