import type { AIProviderConfig, StudioSessionAgent } from '../types/electron';
import { claudeEngineOf } from './connections';

/**
 * Агент вкладки Agents Studio (TASK-170): у каждой вкладки свои провайдер, модель и аккаунт Claude Code.
 * Остальные настройки (авто-подтверждение, температура, рассуждения) общие — из конфига Studio.
 */

const PROVIDERS: ReadonlyArray<AIProviderConfig['provider']> = ['anthropic', 'openrouter', 'deepseek', 'ollama', 'custom', 'openai-compatible'];

/**
 * Конфиг запроса вкладки: общий конфиг, поверх него провайдер и модель вкладки. Движок Claude — общий, если общий
 * провайдер тоже Claude; иначе подписка: ключ Anthropic в общем поле не должен молча увести вкладку на API.
 */
export function sessionRequestConfig(global: AIProviderConfig, agent: StudioSessionAgent | undefined): AIProviderConfig {
  if (!agent) return global;
  const { profileId: _profileId, engine: _engine, ...rest } = global;
  return {
    ...rest,
    provider: agent.provider,
    model: agent.model,
    ...(agent.provider === 'anthropic' ? { engine: claudeEngineOf(global) } : {}),
    ...(agent.provider === 'openai-compatible' && agent.profileId ? { profileId: agent.profileId } : {})
  };
}

/** Текущий агент вкладки: свой, а у старой вкладки без поля — общий выбор Studio. */
export function effectiveSessionAgent(global: AIProviderConfig, agent: StudioSessionAgent | undefined): StudioSessionAgent {
  if (agent) return agent;
  return {
    provider: global.provider,
    model: global.model,
    ...(global.provider === 'openai-compatible' && global.profileId ? { profileId: global.profileId } : {})
  };
}

/**
 * Новый выбор модели во вкладке. Аккаунт Claude Code сохраняется, пока вкладка остаётся на Claude Code:
 * у другого провайдера аккаунта CLI нет.
 */
export function withSelection(
  current: StudioSessionAgent,
  selection: Pick<AIProviderConfig, 'provider' | 'profileId' | 'model'>
): StudioSessionAgent {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.provider === 'openai-compatible' && selection.profileId ? { profileId: selection.profileId } : {}),
    ...(selection.provider === 'anthropic' && current.provider === 'anthropic' && current.claudeAccountId
      ? { claudeAccountId: current.claudeAccountId }
      : {})
  };
}

/**
 * Выбор с телефона для уже открытой сессии (TASK-221): провайдер, профиль и аккаунт закреплены за сессией и
 * выбираются только при её открытии. Меняется лишь модель того же провайдера (и профиля); выбор другого провайдера
 * не трогает агента. Без изменений возвращается тот же объект.
 */
export function lockedSessionAgent(
  current: StudioSessionAgent,
  selection: { provider: string; profileId?: string; model: string } | undefined
): StudioSessionAgent {
  if (!selection || selection.provider !== current.provider || selection.model === current.model) return current;
  if (current.provider === 'openai-compatible' && selection.profileId !== current.profileId) return current;
  return { ...current, model: selection.model };
}

/** Аккаунт Claude Code вкладки; `null` — вернуть аккаунт проекта. */
export function withClaudeAccount(current: StudioSessionAgent, accountId: string | null): StudioSessionAgent {
  const { claudeAccountId: _old, ...rest } = current;
  return accountId ? { ...rest, claudeAccountId: accountId } : rest;
}

/** Агент запуска Claude CLI вкладки: аккаунт имеет смысл только у провайдера `anthropic`. */
export function sessionClaudeAccountId(agent: StudioSessionAgent | undefined): string | undefined {
  return agent?.provider === 'anthropic' ? agent.claudeAccountId : undefined;
}

/** Проверка поля с диска или от телефона: недопустимое значение отбрасывается целиком. */
export function sanitizeSessionAgent(value: unknown): StudioSessionAgent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== 'string' || !PROVIDERS.includes(v.provider as AIProviderConfig['provider'])) return undefined;
  if (typeof v.model !== 'string' || !v.model.trim()) return undefined;
  const provider = v.provider as AIProviderConfig['provider'];
  return {
    provider,
    model: v.model.slice(0, 200),
    ...(provider === 'openai-compatible' && typeof v.profileId === 'string' && v.profileId ? { profileId: v.profileId.slice(0, 120) } : {}),
    ...(provider === 'anthropic' && typeof v.claudeAccountId === 'string' && v.claudeAccountId.trim()
      ? { claudeAccountId: v.claudeAccountId.trim().slice(0, 120) }
      : {})
  };
}
