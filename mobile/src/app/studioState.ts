import type {
  RemoteStudioMessage,
  RemoteStudioOptions,
  RemoteStudioSessionSummary,
  RemoteStudioToolCall,
  StudioMode,
  StudioModelSelection
} from '../../../src/types/remote';

/**
 * Состояние AI Studio на телефоне (TASK-140.10, decision-83) и чистые функции над ним. Сессии — те же, что
 * во вкладках AI Studio на ПК: телефон их читает, продолжает и начинает новые, а хранит и ведёт их окно
 * ProjectHub.
 */

export type StudioMessage = RemoteStudioMessage;

export interface StudioState {
  /** Сессии проекта: открытые вкладки ПК и история, свежие сверху. */
  sessions: RemoteStudioSessionSummary[];
  sessionsLoaded: boolean;
  /** Открытая сессия; `null` — новая, ещё без промптов. */
  sessionId: string | null;
  title: string;
  messages: StudioMessage[];
  olderOmitted: number;
  /** В открытой сессии отвечает агент. */
  busy: boolean;
  loading: boolean;
  options: RemoteStudioOptions | null;
  /** Модель и режим следующего промпта. */
  selection: StudioModelSelection | null;
  mode: StudioMode;
}

export const emptyStudio = (prev?: Pick<StudioState, 'options' | 'selection' | 'mode' | 'sessions' | 'sessionsLoaded'>): StudioState => ({
  sessions: prev?.sessions ?? [],
  sessionsLoaded: prev?.sessionsLoaded ?? false,
  sessionId: null,
  title: '',
  messages: [],
  olderOmitted: 0,
  busy: false,
  loading: false,
  options: prev?.options ?? null,
  selection: prev?.options?.current ?? prev?.selection ?? null,
  mode: 'agent'
});

/** Ответ агента: текст дописывается в последнее сообщение ассистента, иначе начинается новое. */
export function appendAssistantText(messages: StudioMessage[], text: string, now = Date.now()): StudioMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  return [...messages, { id: `a${now}`, role: 'assistant', text }];
}

/** Строка инструмента: обновляется по `id` в последнем сообщении ассистента. */
export function upsertAssistantTool(messages: StudioMessage[], tool: RemoteStudioToolCall, now = Date.now()): StudioMessage[] {
  const last = messages[messages.length - 1];
  const base = last && last.role === 'assistant' ? last : { id: `a${now}`, role: 'assistant' as const, text: '' };
  const tools = [...(base.tools ?? [])];
  const idx = tools.findIndex((t) => t.id === tool.id);
  if (idx >= 0) tools[idx] = { ...tools[idx], ...tool };
  else tools.push(tool);
  const next = { ...base, tools };
  return last && last.role === 'assistant' ? [...messages.slice(0, -1), next] : [...messages, next];
}

/** Чанк потока: текст и/или строка инструмента. */
export function applyStudioChunk(messages: StudioMessage[], chunk: { text?: unknown; tool?: unknown }, now = Date.now()): StudioMessage[] {
  let out = messages;
  const tool = chunk.tool as RemoteStudioToolCall | undefined;
  if (tool && typeof tool.id === 'string' && typeof tool.name === 'string') out = upsertAssistantTool(out, tool, now);
  if (typeof chunk.text === 'string' && chunk.text) out = appendAssistantText(out, chunk.text, now);
  return out;
}

/** Отметить, идёт ли ответ в сессии списка, не дожидаясь перечитывания. */
export function markRunning(sessions: RemoteStudioSessionSummary[], sessionId: string, running: boolean): RemoteStudioSessionSummary[] {
  return sessions.map((s) => (s.id === sessionId ? { ...s, running, ...(running ? { updatedAt: Date.now() } : {}) } : s));
}

/** Список сессий в окне истории: открытые на ПК и закрытые, каждая группа — свежие сверху. */
export function groupStudioSessions(sessions: RemoteStudioSessionSummary[], query = ''): { open: RemoteStudioSessionSummary[]; history: RemoteStudioSessionSummary[] } {
  const q = query.trim().toLowerCase();
  const match = (s: RemoteStudioSessionSummary) => !q || s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q);
  const sorted = [...sessions].filter(match).sort((a, b) => b.updatedAt - a.updatedAt);
  return { open: sorted.filter((s) => !s.archived), history: sorted.filter((s) => s.archived) };
}

/** «сейчас», «5 мин», «3 ч», «вчера», «12 окт». */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  if (h < 48) return 'вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Подпись выбора модели на кнопке: из названий каталога, если они есть. */
export function selectionTitle(sel: StudioModelSelection | null, options: RemoteStudioOptions | null): string {
  if (!sel) return options?.currentLabel || 'Модель ПК';
  if (sel.provider === 'anthropic') {
    const m = options?.claudeModels.find((x) => x.id === sel.model);
    return `Claude · ${m?.name.replace(/\s*\(.*\)$/, '') || sel.model}`;
  }
  if (sel.provider === 'openai-compatible') {
    const p = options?.profiles.find((x) => x.id === sel.profileId);
    return `${p?.name || 'Профиль'} · ${sel.model}`;
  }
  return `${sel.provider} · ${sel.model}`;
}

export const MODE_LABEL: Record<StudioMode, string> = { agent: 'Агент', chat: 'Чат', architect: 'Архитектор' };
