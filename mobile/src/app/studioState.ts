import type {
  RemoteStudioMessage,
  RemoteStudioOptions,
  RemoteStudioSessionSummary,
  RemoteStudioSessionUsage,
  RemoteStudioUsage,
  RemoteStudioToolCall,
  StudioMode,
  StudioModelSelection
} from '../../../src/types/remote';
import { t } from '../i18n';

/**
 * Состояние Agents Studio на телефоне (TASK-140.10, decision-83) и чистые функции над ним. Сессии — те же, что
 * во вкладках Agents Studio на ПК: телефон их читает, продолжает и начинает новые, а хранит и ведёт их окно
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
  /** Расход открытой сессии (токены и стоимость ответов). */
  sessionUsage: RemoteStudioSessionUsage | null;
  /** Лимиты Claude Code с ПК (окно Usage). */
  usage: RemoteStudioUsage | null;
  usageLoading: boolean;
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
  selection: prev?.options ? defaultStudioSelection(prev.options) : (prev?.selection ?? null),
  mode: 'agent',
  sessionUsage: null,
  usage: prev && 'usage' in prev ? (prev as StudioState).usage : null,
  usageLoading: false
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

/** «сейчас», «5 мин», «3 ч», «вчера», «12 окт.» — на языке интерфейса. */
export function relativeTime(ts: number, now = Date.now()): string {
  const tr = t().studio;
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return tr.justNow;
  if (min < 60) return tr.minutesAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return tr.hoursAgo(h);
  if (h < 48) return tr.yesterday;
  return new Date(ts).toLocaleDateString(tr.dateLocale, { day: 'numeric', month: 'short' });
}

/** Подпись выбора модели на кнопке: аккаунт и модель из названий каталога, если они есть. */
export function selectionTitle(sel: StudioModelSelection | null, options: RemoteStudioOptions | null): string {
  if (!sel) return options?.currentLabel || t().studio.pcModel;
  if (sel.provider === 'anthropic') {
    const m = options?.claudeModels.find((x) => x.id === sel.model);
    return `${accountLabel(sel, options)} · ${m?.name.replace(/\s*\(.*\)$/, '') || sel.model}`;
  }
  return `${accountLabel(sel, options)} · ${sel.model}`;
}

// ── Аккаунт LLM сессии (TASK-221): выбирается при открытии сессии и дальше не меняется ──

/** Аккаунт LLM: Claude Code с аккаунтом ПК (без id — аккаунт проекта) или профиль OpenAI-совместимого сервера. */
export type StudioAccountChoice = { kind: 'claude'; accountId?: string } | { kind: 'profile'; profileId: string };

/** Имя аккаунта Claude Code: профиль по умолчанию без переименования — текстом интерфейса. */
export function claudeAccountName(account: { name: string; isDefault: boolean }): string {
  return account.isDefault && account.name === 'Default' ? t().studio.defaultAccount : account.name;
}

/** Аккаунт Claude Code выбора: свой или аккаунт проекта. */
function effectiveClaudeAccountId(sel: StudioModelSelection, options: RemoteStudioOptions | null): string | undefined {
  return sel.claudeAccountId ?? options?.projectClaudeAccountId;
}

/**
 * Подпись аккаунта: «Claude» при одном аккаунте Claude Code на ПК, «Claude · Личный» при нескольких, имя профиля LLM —
 * для OpenAI-совместимого сервера.
 */
export function accountLabel(sel: StudioModelSelection, options: RemoteStudioOptions | null): string {
  if (sel.provider === 'anthropic') {
    const accounts = options?.claudeAccounts ?? [];
    if (accounts.length < 2) return 'Claude';
    const id = effectiveClaudeAccountId(sel, options);
    const account = accounts.find((a) => a.id === id);
    return `Claude · ${account ? claudeAccountName(account) : sel.claudeAccountId || t().studio.projectAccount}`;
  }
  if (sel.provider === 'openai-compatible') return options?.profiles.find((x) => x.id === sel.profileId)?.name || t().studio.profile;
  return sel.provider;
}

/** Выбор для новой сессии по умолчанию: текущий выбор ПК, у Claude — с аккаунтом проекта. */
export function defaultStudioSelection(options: RemoteStudioOptions): StudioModelSelection {
  const cur = options.current;
  if (cur.provider === 'anthropic' && !cur.claudeAccountId && options.projectClaudeAccountId) return { ...cur, claudeAccountId: options.projectClaudeAccountId };
  return cur;
}

/** Тот же ли аккаунт у выбора: провайдер, профиль и аккаунт Claude Code (без id — аккаунт проекта). */
export function isSameAccount(sel: StudioModelSelection | null, choice: StudioAccountChoice, options: RemoteStudioOptions | null): boolean {
  if (!sel) return false;
  if (choice.kind === 'profile') return sel.provider === 'openai-compatible' && sel.profileId === choice.profileId;
  if (sel.provider !== 'anthropic') return false;
  return effectiveClaudeAccountId(sel, options) === (choice.accountId ?? options?.projectClaudeAccountId);
}

/**
 * Выбор при открытии сессии с аккаунтом: модель — прежняя, если она есть у аккаунта, иначе выбор ПК или первая из
 * списка. `null` — у профиля нет моделей, выбрать его нельзя.
 */
export function selectionForAccount(
  options: RemoteStudioOptions,
  choice: StudioAccountChoice,
  prev: StudioModelSelection | null
): StudioModelSelection | null {
  if (choice.kind === 'claude') {
    const ids = options.claudeModels.map((m) => m.id);
    const candidates = [prev?.provider === 'anthropic' ? prev.model : undefined, options.current.provider === 'anthropic' ? options.current.model : undefined, ids[0]];
    const model = candidates.find((m) => m && (ids.length === 0 || ids.includes(m))) ?? candidates.find(Boolean);
    if (!model) return null;
    return { provider: 'anthropic', model, ...(choice.accountId ? { claudeAccountId: choice.accountId } : {}) };
  }
  const profile = options.profiles.find((p) => p.id === choice.profileId);
  if (!profile) return null;
  const sameProfile = (s: StudioModelSelection | null) => (s?.provider === 'openai-compatible' && s.profileId === profile.id ? s.model : undefined);
  const model = [sameProfile(prev), sameProfile(options.current), profile.models[0]].find((m) => m && profile.models.includes(m));
  return model ? { provider: 'openai-compatible', profileId: profile.id, model } : null;
}

/** Название режима на языке интерфейса; поля — геттеры, текст берётся в момент показа. */
export const MODE_LABEL: Readonly<Record<StudioMode, string>> = {
  get agent() {
    return t().studio.modes.agent;
  },
  get chat() {
    return t().studio.modes.chat;
  },
  get architect() {
    return t().studio.modes.architect;
  }
};

/** Быстрые команды Studio на телефоне (меню и ввод «/»): действия над сессией, не промпты агенту. */
export type StudioCommandId = 'clear' | 'new' | 'usage' | 'model' | 'sessions' | 'stop';

export interface StudioCommand {
  id: StudioCommandId;
  command: string;
  readonly title: string;
  readonly hint: string;
}

/** Команда с подписью и подсказкой на языке интерфейса: геттеры читают словарь при каждом показе. */
function studioCommand(id: StudioCommandId): StudioCommand {
  return {
    id,
    command: `/${id}`,
    get title() {
      return t().studio.commands[id].title;
    },
    get hint() {
      return t().studio.commands[id].hint;
    }
  };
}

export const STUDIO_COMMANDS: StudioCommand[] = (['clear', 'new', 'usage', 'model', 'sessions', 'stop'] as const).map(studioCommand);

/** Подсказки при вводе «/»: команды, начинающиеся с набранного; пробел после команды — уже промпт. */
export function matchStudioCommands(text: string): typeof STUDIO_COMMANDS {
  const value = text.trimStart();
  if (!value.startsWith('/') || /\s/.test(value)) return [];
  const q = value.toLowerCase();
  return STUDIO_COMMANDS.filter((c) => c.command.startsWith(q));
}

/** «12,3 тыс.», «1,2 млн» (по-английски «12.3k», «1.2M») — токены в окне Usage. */
export function formatTokens(n: number): string {
  const tr = t().studio;
  const fixed = (v: number) => v.toFixed(1).replace('.', tr.decimal);
  if (n >= 1_000_000) return tr.millions(fixed(n / 1_000_000));
  if (n >= 1000) return tr.thousands(fixed(n / 1000));
  return String(n);
}
