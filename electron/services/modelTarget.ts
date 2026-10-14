/**
 * Цель модели и движок основной модели (TASK-134.1, decision-74).
 *
 * `ModelTarget` — одна форма для всех мест, где пользователь указывает, чем работать: основная модель,
 * запись тира, роль, слот Swarm и назначение. До неё каждое место описывало модель по-своему.
 *
 * Здесь же единственное место правила «Anthropic без API-ключа — это Claude Code CLI по подписке»
 * ([[decision-35]]): `mainEngineOf`. Остальной код спрашивает движок у этой функции и сам правило не
 * повторяет.
 *
 * Чистый модуль без Electron — импортируется unit-тестами напрямую.
 */
import type { AIProviderConfig } from './aiAgentService.js';
import { isModelTier, isTierEngine, type ModelTier, type TierEngine } from './modelTiers.js';
import { normalizeReasoningEffort, type ReasoningEffort } from './reasoningEffort.js';

/** Движок вызова: CLI-агент или API-провайдер. */
export type ModelEngine = TierEngine;

/** Движок основной модели: AI Studio работает через Claude Code CLI или через API-провайдера. */
export type MainEngine = 'claude-cli' | 'api';

export const MAIN_ENGINES: readonly MainEngine[] = ['claude-cli', 'api'];

/** Чем работать: движок, куда ходить (профиль или прежний провайдер), модель или её тир, усилие. */
export interface ModelTarget {
  engine?: ModelEngine;
  /** Профиль OpenAI-совместимого провайдера: имя или id ([[decision-40]] п. 2). Важнее `provider`. */
  profile?: string;
  /** Прежний провайдер (`anthropic`, `ollama`…). */
  provider?: string;
  /** Id модели или алиас CLI. Пусто или `default` — модель не задана. */
  model?: string;
  /** Класс модели вместо id ([[decision-44]]). */
  modelTier?: ModelTier;
  reasoningEffort?: ReasoningEffort;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

/** Модель задана: не пусто и не сентинел `default` («не выбрана», [[decision-26]] п. 0). */
export function cleanModelId(value: unknown): string | undefined {
  const model = clean(value);
  return model && model !== 'default' ? model : undefined;
}

export function isMainEngine(value: unknown): value is MainEngine {
  return typeof value === 'string' && (MAIN_ENGINES as readonly string[]).includes(value);
}

/**
 * Движок основной модели — единственное место правила подписки.
 *
 * - явный `engine: 'claude-cli'` при провайдере `anthropic` — Claude Code CLI, даже если ключ сохранён;
 * - явный `engine: 'api'` — API-путь: Anthropic без ключа тогда честно падает с «нет ключа»;
 * - без поля (настройки до TASK-134) — прежний вывод: `anthropic` без ключа означает вход по подписке.
 *
 * `claude-cli` с другим провайдером не имеет смысла (CLI ходит только в Anthropic) и считается API.
 */
export function mainEngineOf(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): MainEngine {
  if (config.provider !== 'anthropic') return 'api';
  if (isMainEngine(config.engine)) return config.engine;
  return config.apiKey?.trim() ? 'api' : 'claude-cli';
}

/** Конфиг ведёт в Claude Code CLI по подписке. */
export function usesClaudeCli(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): boolean {
  return mainEngineOf(config) === 'claude-cli';
}

/** Поле `engine` из файла настроек: неизвестное значение отбрасывается, а не ломает чтение. */
export function normalizeMainEngineField<T extends { engine?: unknown }>(config: T): T {
  if (config.engine === undefined || isMainEngine(config.engine)) return config;
  const rest = { ...config };
  delete rest.engine;
  return rest;
}

/** В цели есть что-то кроме тира: движок, адресат или модель. */
export function hasExplicitTarget(target: ModelTarget | undefined): boolean {
  if (!target) return false;
  return Boolean(target.engine || clean(target.profile) || clean(target.provider) || cleanModelId(target.model));
}

/** Цель из произвольного объекта (файл назначений, ввод из UI). `undefined` — в объекте нет ни одного поля цели. */
export function normalizeModelTarget(raw: unknown): ModelTarget | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const target: ModelTarget = {};
  if (isTierEngine(r.engine)) target.engine = r.engine;
  const profile = clean(r.profile);
  const provider = clean(r.provider);
  // Профиль и провайдер относятся к API-пути: у CLI-движка адресат свой.
  if (!target.engine || target.engine === 'api') {
    if (profile) target.profile = profile;
    else if (provider) target.provider = provider;
  }
  const model = cleanModelId(r.model);
  if (model) target.model = model;
  if (isModelTier(r.modelTier)) target.modelTier = r.modelTier;
  const effort = normalizeReasoningEffort(r.reasoningEffort);
  if (effort) target.reasoningEffort = effort;
  return Object.keys(target).length > 0 ? target : undefined;
}

/** Поля роли реестра, из которых складывается цель. */
export interface RoleTargetFields {
  engine?: ModelEngine;
  provider?: string;
  profile?: string;
  model?: string;
  modelTier?: ModelTier;
}

export function targetFromRole(role: RoleTargetFields | undefined): ModelTarget | undefined {
  return role ? normalizeModelTarget(role) : undefined;
}

/** Поля слота Swarm, из которых складывается цель. */
export interface SlotTargetFields {
  engine?: ModelEngine;
  providerConfig?: Partial<Pick<AIProviderConfig, 'provider' | 'profileId' | 'model' | 'reasoningEffort'>>;
  modelTier?: ModelTier;
}

/** Слот хранит профиль по id в `providerConfig.profileId`; ссылка на профиль понимает и id, и имя. */
export function targetFromSlot(slot: SlotTargetFields | undefined): ModelTarget | undefined {
  if (!slot) return undefined;
  const pc = slot.providerConfig;
  return normalizeModelTarget({
    engine: slot.engine,
    profile: pc?.profileId,
    provider: pc?.provider && pc.provider !== 'openai-compatible' ? pc.provider : undefined,
    model: pc?.model,
    modelTier: slot.modelTier,
    reasoningEffort: pc?.reasoningEffort
  });
}

const ENGINE_LABELS: Readonly<Record<ModelEngine, string>> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  api: 'API'
};

export function engineLabel(engine: ModelEngine): string {
  return ENGINE_LABELS[engine];
}
