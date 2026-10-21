import type { AIProviderConfig, LlmProviderPreset } from '../types/electron';

/**
 * Подключения Agents Studio (TASK-172): аккаунты Claude Code, ключ Anthropic API, профили серверов моделей
 * и старое подключение из `ai-config.json` — одним списком. Здесь правила без React: значок, группы окна
 * «Добавить», распознавание старого подключения и выбор модели по умолчанию.
 */

/** Значок провайдера: логотип сервиса, локальный сервер или сервер вообще. */
export type ConnectionIcon = 'claude' | 'anthropic' | 'openrouter' | 'deepseek' | 'ollama' | 'local' | 'server';

const PRESET_BRANDS: Record<string, ConnectionIcon> = {
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  ollama: 'ollama'
};

export function presetIcon(presetId: string | undefined, local = false): ConnectionIcon {
  return (presetId && PRESET_BRANDS[presetId]) || (local ? 'local' : 'server');
}

/** Провайдеры до профилей (decision-40): один ключ и адрес в `ai-config.json`. */
export type LegacyProvider = 'openrouter' | 'deepseek' | 'ollama' | 'custom';
const LEGACY: readonly LegacyProvider[] = ['openrouter', 'deepseek', 'ollama', 'custom'];

export function legacyProviderOf(config: Pick<AIProviderConfig, 'provider'>): LegacyProvider | null {
  return (LEGACY as readonly string[]).includes(config.provider) ? (config.provider as LegacyProvider) : null;
}

export function legacyIcon(provider: LegacyProvider): ConnectionIcon {
  return provider === 'custom' ? 'server' : provider;
}

/**
 * Ключ Anthropic API сохранён. Поле `apiKey` одно: у старого провайдера оно принадлежит ему, у профиля сервера
 * ключ лежит в самом профиле, поэтому ключ в поле — это ключ Anthropic.
 */
export function hasAnthropicKey(config: Pick<AIProviderConfig, 'provider' | 'apiKey'>): boolean {
  return !legacyProviderOf(config) && !!config.apiKey?.trim();
}

/** Движок Claude по сохранённым настройкам: как `mainEngineOf`, без поля `engine` ключ означает API. */
export function claudeEngineOf(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): 'claude-cli' | 'api' {
  if (config.provider !== 'anthropic') return 'claude-cli';
  return config.apiKey?.trim() && config.engine !== 'claude-cli' ? 'api' : 'claude-cli';
}

/** Пункт окна «Добавить». */
export type AddOption =
  | { kind: 'claude-account'; icon: 'claude' }
  | { kind: 'claude-directory'; icon: 'claude' }
  | { kind: 'anthropic-key'; icon: 'anthropic' }
  | { kind: 'preset'; presetId: string; name: string; icon: ConnectionIcon };

export interface AddOptionGroups {
  /** Вход по подписке Claude: новый аккаунт или каталог, которым уже пользуется IDE. */
  subscription: AddOption[];
  /** Облачные сервисы по ключу. */
  apiKey: AddOption[];
  /** Свой сервер: локальные пресеты и Custom (vLLM, LiteLLM, Ollama в сети). */
  server: AddOption[];
}

export function addOptionGroups(presets: Pick<LlmProviderPreset, 'id' | 'name' | 'local' | 'requiresApiKey'>[]): AddOptionGroups {
  const preset = (p: Pick<LlmProviderPreset, 'id' | 'name' | 'local'>): AddOption => ({
    kind: 'preset',
    presetId: p.id,
    name: p.name,
    icon: presetIcon(p.id, p.local)
  });
  return {
    subscription: [
      { kind: 'claude-account', icon: 'claude' },
      { kind: 'claude-directory', icon: 'claude' }
    ],
    apiKey: [{ kind: 'anthropic-key', icon: 'anthropic' }, ...presets.filter((p) => p.requiresApiKey).map(preset)],
    server: presets.filter((p) => !p.requiresApiKey).map(preset)
  };
}

/**
 * Модель по умолчанию из общего списка моделей. У Claude движок (подписка или API-ключ) сохраняется: список
 * его не выбирает, это делает переключатель рядом. У профиля сервера движка нет.
 */
export function defaultModelPatch(
  form: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>,
  selection: Pick<AIProviderConfig, 'provider' | 'profileId' | 'model'>
): Pick<AIProviderConfig, 'provider' | 'profileId' | 'model' | 'engine'> {
  if (selection.provider === 'anthropic') {
    // С другого провайдера — подписка: ключ мог остаться в поле, но API-путь включается только явно.
    return { provider: 'anthropic', profileId: undefined, model: selection.model, engine: claudeEngineOf(form) };
  }
  return { provider: selection.provider, profileId: selection.profileId, model: selection.model, engine: undefined };
}
