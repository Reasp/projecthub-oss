/**
 * Провайдер LLM для слота Swarm, роли и ревьюера Arena (TASK-70.5, decision-40).
 *
 * Слот, роль и ревьюер задают провайдера одним из трёх способов:
 * - профилем OpenAI-совместимого провайдера ([[decision-39]]) — адрес, ключ и флаги берутся из профиля;
 * - прежним провайдером (`anthropic`, `openrouter`, `deepseek`, `ollama`, `custom`) — ключ у такого
 *   провайдера один, он хранится в настройках Agents Studio, поэтому работает только тот, что там выбран;
 * - ничем — тогда используются настройки Agents Studio пользователя.
 * Модели по умолчанию здесь нет ([[decision-26]] п. 0): пустая модель уходит дальше, и запрос
 * падает с понятной ошибкой «Модель не выбрана».
 *
 * Чистый модуль без Electron — импортируется unit-тестами напрямую.
 */
import type { AIProviderConfig } from './aiAgentService.js';
import { normalizeReasoningEffort } from './reasoningEffort.js';
import { providerConfigError } from './providerErrors.js';
import { AppError } from '../../src/lib/appError.js';
import { usesClaudeCli } from './modelTarget.js';

export type ProviderId = AIProviderConfig['provider'];

export const PROFILE_PROVIDER: ProviderId = 'openai-compatible';

/** Провайдеры до профилей: ключ и адрес — из настроек Agents Studio. */
export const LEGACY_PROVIDERS: readonly ProviderId[] = ['openrouter', 'deepseek', 'ollama', 'custom'];

const KNOWN_PROVIDERS: readonly ProviderId[] = ['anthropic', ...LEGACY_PROVIDERS, PROFILE_PROVIDER];

/** Провайдеры, которым ключ не нужен: можно использовать в слоте, даже если в Agents Studio выбран другой. */
const KEYLESS_PROVIDERS: readonly ProviderId[] = ['ollama'];

/** Минимум сведений о профиле для разрешения ссылки. */
export interface ProfileRefEntry {
  id: string;
  name: string;
  local?: boolean;
}

/** Провайдер слота, роли или ревьюера, как его задал пользователь. */
export interface ProviderSpec {
  provider?: string;
  /** Профиль: id или имя (роли хранят имя — id профиля свой на каждой машине). */
  profile?: string;
  model?: string;
  temperature?: number;
}

/** Снимок провайдера, с которым агент реально работал, — для экспорта и UI (TASK-70.5). */
export interface ResolvedProviderInfo {
  provider: ProviderId;
  model?: string;
  profileId?: string;
  profileName?: string;
  local?: boolean;
}

export function isKnownProvider(value: string | undefined | null): value is ProviderId {
  return typeof value === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

function clean(value: string | undefined | null): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? v : undefined;
}

/**
 * Профиль по ссылке: сначала точное совпадение id, затем имя без учёта регистра.
 *
 * @throws если профиль не найден или имя неоднозначно.
 */
export function resolveProfileRef(ref: string, profiles: readonly ProfileRefEntry[]): ProfileRefEntry {
  const needle = ref.trim();
  if (!needle) throw providerConfigError(new AppError('slots.profileNotSet'), 'no_profile');
  const byId = profiles.find((p) => p.id === needle);
  if (byId) return byId;
  const lower = needle.toLocaleLowerCase();
  const byName = profiles.filter((p) => p.name.trim().toLocaleLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw providerConfigError(new AppError('slots.profileAmbiguous', { name: needle, count: byName.length }), 'no_profile');
  }
  throw providerConfigError(new AppError('slots.profileNotFound', { name: needle }), 'no_profile');
}

/**
 * Конфиг провайдера из полей роли или ревьюера: `profile` важнее `provider`. Без полей — `undefined`
 * (настройки Agents Studio). Роль с одной моделью наследует провайдера Agents Studio, а не `anthropic`.
 */
export function providerConfigFromSpec(spec: ProviderSpec | undefined): Partial<AIProviderConfig> | undefined {
  if (!spec) return undefined;
  const profile = clean(spec.profile);
  const provider = clean(spec.provider);
  const model = clean(spec.model);
  const temperature = typeof spec.temperature === 'number' && Number.isFinite(spec.temperature) ? spec.temperature : undefined;
  if (!profile && !provider && !model) return undefined;
  const out: Partial<AIProviderConfig> = {};
  if (profile) {
    out.provider = PROFILE_PROVIDER;
    out.profileId = profile;
  } else if (provider) {
    if (!isKnownProvider(provider)) {
      throw providerConfigError(new AppError('slots.unknownProvider', { provider, known: KNOWN_PROVIDERS.join(', ') }), 'provider');
    }
    out.provider = provider;
  }
  if (model) out.model = model;
  if (temperature !== undefined) out.temperature = temperature;
  return out;
}

function sameLegacyTarget(slot: Partial<AIProviderConfig>, global: AIProviderConfig): boolean {
  return slot.provider === global.provider;
}

/**
 * Итоговый конфиг запроса для слота/ревьюера.
 *
 * - нет настроек слота — настройки Agents Studio;
 * - профиль — ссылка разрешается в id профиля, ключ возьмёт `llmProfileService`;
 * - провайдер не задан (только модель) — провайдер и ключ Agents Studio, модель слота;
 * - прежний провайдер = провайдер Agents Studio — ключ и адрес Agents Studio, модель слота;
 * - прежний провайдер без ключа (Ollama) — адрес слота или Agents Studio;
 * - иной прежний провайдер — ошибка: его ключа нет, молча подменять провайдера нельзя.
 *
 * Пустая модель слота (или `default`) заменяется моделью Agents Studio только для того же провайдера или
 * профиля: модель другого провайдера была бы чужой.
 *
 * Усилие рассуждений слота важнее унаследованного. Слот «как в Agents Studio» или только с моделью
 * наследует усилие Agents Studio, слот с профилем или Ollama — только своё ([[decision-41]] п. 7).
 */
export function resolveSlotProviderConfig(
  slot: Partial<AIProviderConfig> | undefined,
  global: AIProviderConfig,
  profiles: readonly ProfileRefEntry[]
): { config: AIProviderConfig; info: ResolvedProviderInfo } {
  const resolved = resolveSlotTarget(slot, global, profiles);
  const effort = normalizeReasoningEffort(slot?.reasoningEffort);
  return effort ? { ...resolved, config: { ...resolved.config, reasoningEffort: effort } } : resolved;
}

function resolveSlotTarget(
  slot: Partial<AIProviderConfig> | undefined,
  global: AIProviderConfig,
  profiles: readonly ProfileRefEntry[]
): { config: AIProviderConfig; info: ResolvedProviderInfo } {
  if (!slot || (!slot.provider && !slot.profileId && !clean(slot.model))) {
    return withInfo(global, profiles);
  }

  const slotModel = clean(slot.model);
  const temperature = slot.temperature ?? undefined;

  if (slot.provider === PROFILE_PROVIDER || slot.profileId) {
    if (!slot.profileId) {
      throw providerConfigError(new AppError('slots.compatNoProfile'), 'no_profile');
    }
    const profile = resolveProfileRef(slot.profileId, profiles);
    // Та же пара «профиль Agents Studio» — можно взять модель оттуда; иначе модель обязана быть у слота.
    const inheritModel = global.provider === PROFILE_PROVIDER && global.profileId === profile.id;
    const model = slotModel && !isDefaultAlias(slotModel) ? slotModel : inheritModel ? global.model : '';
    const config: AIProviderConfig = {
      provider: PROFILE_PROVIDER,
      profileId: profile.id,
      model,
      ...(temperature !== undefined ? { temperature } : {})
    };
    return { config, info: { provider: PROFILE_PROVIDER, model, profileId: profile.id, profileName: profile.name, ...(profile.local !== undefined ? { local: profile.local } : {}) } };
  }

  if (!slot.provider) {
    const config: AIProviderConfig = {
      ...global,
      model: slotModel ?? global.model,
      ...(temperature !== undefined ? { temperature } : {})
    };
    return withInfo(config, profiles);
  }

  if (sameLegacyTarget(slot, global)) {
    const config: AIProviderConfig = {
      ...global,
      model: slotModel && !isDefaultAlias(slotModel) ? slotModel : global.model,
      ...(temperature !== undefined ? { temperature } : {})
    };
    return withInfo(config, profiles);
  }

  if ((KEYLESS_PROVIDERS as readonly string[]).includes(slot.provider)) {
    const config: AIProviderConfig = {
      provider: slot.provider,
      model: slotModel && !isDefaultAlias(slotModel) ? slotModel : '',
      ...(clean(slot.baseUrl) ? { baseUrl: clean(slot.baseUrl) } : {}),
      ...(temperature !== undefined ? { temperature } : {})
    };
    return { config, info: { provider: config.provider, model: config.model, local: true } };
  }

  throw providerConfigError(new AppError('slots.providerMismatch', { slot: slot.provider, main: global.provider }), 'provider');
}

function isDefaultAlias(model: string): boolean {
  return model === 'default';
}

function withInfo(config: AIProviderConfig, profiles: readonly ProfileRefEntry[]): { config: AIProviderConfig; info: ResolvedProviderInfo } {
  if (config.provider === PROFILE_PROVIDER && config.profileId) {
    const profile = profiles.find((p) => p.id === config.profileId);
    return {
      config,
      info: {
        provider: PROFILE_PROVIDER,
        model: config.model,
        profileId: config.profileId,
        ...(profile ? { profileName: profile.name } : {}),
        ...(profile?.local !== undefined ? { local: profile.local } : {})
      }
    };
  }
  return { config, info: { provider: config.provider, model: config.model, ...(config.provider === 'ollama' ? { local: true } : {}) } };
}

/**
 * Почему конфиг Agents Studio не годится для API-пути (запасной путь CLI-движков), или `null`.
 * Проверяется до запроса, чтобы вместо молчаливого ухода к вендору была понятная причина.
 */
export function apiConfigProblem(config: AIProviderConfig): AppError | null {
  const model = clean(config.model);
  if (config.provider === 'anthropic') {
    if (usesClaudeCli(config)) {
      return new AppError(config.engine === 'claude-cli' ? 'slots.mainIsSubscription' : 'slots.mainAnthropicNoKey');
    }
    if (!clean(config.apiKey)) return new AppError('slots.mainAnthropicNoKey');
    return null;
  }
  if (config.provider === PROFILE_PROVIDER && !clean(config.profileId)) {
    return new AppError('slots.mainCompatNoProfile');
  }
  if (!model || isDefaultAlias(model)) return new AppError('slots.mainNoModel', { provider: config.provider });
  return null;
}

/**
 * API-слот Swarm, который не сможет ответить: его адресат — Anthropic без ключа (TASK-134.4). Чаще всего
 * так выходит, когда основная модель — Claude Code по подписке, а у слота оставлен движок «API».
 * Совет — какой движок или профиль выбрать, а не просьба указать ключ.
 */
export function apiSlotProblem(config: AIProviderConfig, main: AIProviderConfig): AppError | null {
  if (config.provider !== 'anthropic' || clean(config.apiKey)) return null;
  return new AppError(usesClaudeCli(main) ? 'slots.apiSlotWithSubscription' : 'slots.apiSlotNoKey');
}

/** Короткая подпись провайдера для логов и экспорта: «профиль «Ollama» (локальная)» или «deepseek». */
export function describeProviderInfo(info: ResolvedProviderInfo | undefined): string {
  if (!info) return '—';
  if (info.provider === PROFILE_PROVIDER) {
    const name = info.profileName ?? info.profileId ?? '?';
    return `профиль «${name}»${info.local ? ' (локальная)' : ''}`;
  }
  return `${info.provider}${info.local ? ' (локальная)' : ''}`;
}
