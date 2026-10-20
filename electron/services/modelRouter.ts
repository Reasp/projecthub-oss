/**
 * Резолвер модели: какой движок и какая модель обслуживают вызов (TASK-134.1, decision-74).
 *
 * Приоритет — от частного к общему:
 * 1. слот этого запуска (движок, адресат или модель слота);
 * 2. явная цель роли (движок, профиль, провайдер или модель во frontmatter роли);
 * 3. назначение, заданное пользователем (своя цель, тир или «как основная»);
 * 4. тир роли;
 * 5. тир назначения по каталогу;
 * 6. основная модель.
 *
 * Подсказка тира (`tierHint`, например тир подзадачи плана) подменяет тир там, где решение принимается по
 * тиру, и не перебивает явную модель и выбор «как основная».
 *
 * Резолвер не бросает: непригодная цель возвращается с `problem`, чтобы интерфейс показал её до запуска.
 * Исполнители превращают `problem` в `ModelRouteError`. Движок, выбранный явно, не подменяется
 * ([[decision-40]]); пустой тир — это основная модель, а не ошибка.
 *
 * Чистый модуль без Electron — импортируется unit-тестами напрямую.
 */
import type { AIProviderConfig } from './aiAgentService.js';
import {
  buildModelChain,
  tiersForChain,
  type ChainLink,
  type ModelTier,
  type ModelTierSettings
} from './modelTiers.js';
import {
  MODEL_PURPOSES,
  MODEL_PURPOSE_SPECS,
  normalizeModelAssignments,
  purposeEngines,
  purposeLabel,
  type ModelAssignments,
  type ModelCallKind,
  type ModelPurpose
} from './modelPurposes.js';
import {
  cleanModelId,
  engineLabel,
  hasExplicitTarget,
  mainEngineOf,
  type MainEngine,
  type ModelEngine,
  type ModelTarget
} from './modelTarget.js';
import {
  PROFILE_PROVIDER,
  describeProviderInfo,
  providerConfigFromSpec,
  resolveSlotProviderConfig,
  type ProfileRefEntry,
  type ResolvedProviderInfo
} from './slotProvider.js';
import { ProviderError, providerErrorInfoOf, type ProviderErrorReason } from './providerErrors.js';
import type { ReasoningEffort } from './reasoningEffort.js';

/** Что настроено у пользователя на момент вызова. */
export interface ModelRouteContext {
  /** Основная модель — настройки Agents Studio (`ai-config.json`) с расшифрованным ключом. */
  main: AIProviderConfig;
  profiles: readonly ProfileRefEntry[];
  tiers: ModelTierSettings;
  assignments: ModelAssignments;
}

export interface ModelRouteInput {
  purpose: ModelPurpose;
  /** Цель слота этого запуска: слот Swarm или проектное переопределение (`arena.reviewer`). */
  slot?: ModelTarget;
  /** Цель роли реестра. */
  role?: ModelTarget;
  /** Тир, подсказанный задачей (например, `modelTier` подзадачи плана). */
  tierHint?: ModelTier;
}

/** Откуда взято решение. */
export type ModelRouteSource = 'slot' | 'role' | 'purpose' | 'tier' | 'main';

/** Кто назвал тир. `default` — тир назначения по каталогу. */
export type ModelTierSource = 'hint' | 'slot' | 'role' | 'purpose' | 'default';

export type ModelRouteProblemCode =
  /** Движок не умеет вид вызова этого назначения. */
  | 'engine_unsupported'
  | 'no_key'
  | 'no_profile'
  | 'no_model'
  | 'provider';

export interface ModelRouteProblem {
  code: ModelRouteProblemCode;
  /** Готовый текст (ru): называет назначение и говорит, что сделать. */
  message: string;
}

export interface ResolvedModel {
  purpose: ModelPurpose;
  kind: ModelCallKind;
  source: ModelRouteSource;
  engine: ModelEngine;
  /** Модель; без значения CLI-движок берёт свою модель по умолчанию. */
  model?: string;
  /** Тир, по которому выбрана модель или запасные звенья. */
  tier?: ModelTier;
  tierSource?: ModelTierSource;
  reasoningEffort?: ReasoningEffort;
  /**
   * Готовый конфиг вызова для `api` и `claude-cli` (с явным `engine`); у Codex и Gemini CLI его нет —
   * они получают только модель.
   */
  config?: AIProviderConfig;
  /** Снимок провайдера API-пути — для карточек и экспорта ([[decision-40]] п. 5). */
  info?: ResolvedProviderInfo;
  /** Цепочка моделей ([[decision-44]] п. 5): первое звено — выбранная модель. Пусто — запасных нет. */
  chain: ChainLink[];
  /** Пояснения к решению: пустой тир, пропущенные звенья. */
  notes: string[];
  problem?: ModelRouteProblem;
}

interface Draft {
  source: ModelRouteSource;
  engine: ModelEngine;
  model?: string;
  tier?: ModelTier;
  tierSource?: ModelTierSource;
  reasoningEffort?: ReasoningEffort;
  config?: AIProviderConfig;
  info?: ResolvedProviderInfo;
  chain: ChainLink[];
  problem?: { code: ModelRouteProblemCode; text: string };
}

type Addressee = Pick<ModelTarget, 'profile' | 'provider'>;

const SETTINGS_HINT = 'Настройки Agents Studio → Назначения';

const KIND_WHAT: Readonly<Record<ModelCallKind, string>> = {
  complete: 'одноразовый запрос к модели',
  turn: 'один ход без рабочего дерева',
  agent: 'этот вид агента'
};

const PROBLEM_REASON: Readonly<Record<ModelRouteProblemCode, ProviderErrorReason>> = {
  engine_unsupported: 'engine',
  no_key: 'no_key',
  no_profile: 'no_profile',
  no_model: 'no_model',
  provider: 'provider'
};

function problemCodeOf(reason: ProviderErrorReason | undefined): ModelRouteProblemCode {
  if (reason === 'no_key' || reason === 'no_profile' || reason === 'no_model') return reason;
  return 'provider';
}

/** Убирает точку в конце, чтобы текст встал в середину предложения. */
function sentencePart(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

export function resolveModel(input: ModelRouteInput, ctx: ModelRouteContext): ResolvedModel {
  const spec = MODEL_PURPOSE_SPECS[input.purpose];
  const main = ctx.main;
  const mainEngine: MainEngine = mainEngineOf(main);
  const engines = purposeEngines(input.purpose);
  const notes: string[] = [];

  /** Адресат — счёт основной модели: без профиля и с тем же провайдером (или без него). */
  const addressesMain = (a: Addressee): boolean => !a.profile && (!a.provider || a.provider === main.provider);
  /** Звено `api`, которое ведёт на счёт основной модели, а она работает через Claude Code: ключа для API нет. */
  const isDeadApiLink = (link: Addressee & { engine: ModelEngine }): boolean =>
    link.engine === 'api' && mainEngine === 'claude-cli' && addressesMain(link);

  const policy = (): Partial<AIProviderConfig> => ({
    ...(main.autoApprove !== undefined ? { autoApprove: main.autoApprove } : {}),
    ...(main.autoApproveRules ? { autoApproveRules: main.autoApproveRules } : {})
  });

  const cliConfig = (model: string | undefined, effort: ReasoningEffort | undefined): AIProviderConfig => ({
    provider: 'anthropic',
    engine: 'claude-cli',
    model: model ?? 'default',
    ...(effort ? { reasoningEffort: effort } : {}),
    ...policy()
  });

  const apiConfig = (
    addressee: Addressee & { model?: string },
    effort: ReasoningEffort | undefined
  ): Pick<Draft, 'config' | 'info' | 'model' | 'problem'> => {
    try {
      const partial: Partial<AIProviderConfig> = { ...(providerConfigFromSpec(addressee) ?? {}) };
      if (effort) partial.reasoningEffort = effort;
      const resolved = resolveSlotProviderConfig(Object.keys(partial).length > 0 ? partial : undefined, main, ctx.profiles);
      const config: AIProviderConfig = { ...policy(), ...resolved.config, engine: 'api' };
      const model = cleanModelId(config.model);
      const where = describeProviderInfo(resolved.info);
      let problem: Draft['problem'];
      if (config.provider === 'anthropic' && !config.apiKey?.trim()) {
        problem = {
          code: 'no_key',
          text: 'у Anthropic нет API-ключа: укажите ключ в настройках Agents Studio или выберите движок «Claude Code (подписка)»'
        };
      } else if (config.provider === PROFILE_PROVIDER && !config.profileId) {
        problem = { code: 'no_profile', text: 'у OpenAI-совместимого провайдера не выбран профиль' };
      } else if (!model) {
        problem = { code: 'no_model', text: `не выбрана модель (${where})` };
      }
      return { config, info: resolved.info, ...(model ? { model } : {}), ...(problem ? { problem } : {}) };
    } catch (err) {
      const info = providerErrorInfoOf(err);
      const text = sentencePart(err instanceof Error ? err.message : String(err));
      return { problem: { code: problemCodeOf(info?.reason), text } };
    }
  };

  /** Усилие цели; цель на счёте основной модели наследует усилие Agents Studio ([[decision-41]] п. 7). */
  const cliEffort = (target: ModelTarget | undefined): ReasoningEffort | undefined =>
    target?.reasoningEffort ?? (mainEngine === 'claude-cli' ? main.reasoningEffort : undefined);

  const fromMain = (): Draft => {
    if (mainEngine === 'claude-cli') {
      const model = cleanModelId(main.model);
      return {
        source: 'main',
        engine: 'claude-cli',
        ...(model ? { model } : {}),
        ...(main.reasoningEffort ? { reasoningEffort: main.reasoningEffort } : {}),
        config: cliConfig(model, main.reasoningEffort),
        chain: []
      };
    }
    const api = apiConfig({}, undefined);
    return {
      source: 'main',
      engine: 'api',
      ...api,
      ...(api.config?.reasoningEffort ? { reasoningEffort: api.config.reasoningEffort } : {}),
      chain: []
    };
  };

  /** Модель и конфиг для выбранного движка: первое звено цепочки или модель цели. */
  const settle = (
    engine: ModelEngine,
    target: ModelTarget | undefined,
    chain: ChainLink[]
  ): Pick<Draft, 'model' | 'config' | 'info' | 'problem' | 'reasoningEffort'> => {
    const link = chain[0];
    if (engine === 'api') {
      const addressee = link
        ? { profile: link.profile, provider: link.provider, model: link.model }
        : { profile: target?.profile, provider: target?.provider, model: cleanModelId(target?.model) };
      const api = apiConfig(addressee, target?.reasoningEffort);
      return { ...api, ...(api.config?.reasoningEffort ? { reasoningEffort: api.config.reasoningEffort } : {}) };
    }
    // CLI без модели: Claude Code берёт модель основной настройки, если она тоже работает через него.
    const inherited = engine === 'claude-cli' && mainEngine === 'claude-cli' ? cleanModelId(main.model) : undefined;
    const model = link?.model ?? cleanModelId(target?.model) ?? inherited;
    const effort = engine === 'claude-cli' ? cliEffort(target) : target?.reasoningEffort;
    return {
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(engine === 'claude-cli' ? { config: cliConfig(model, effort) } : {})
    };
  };

  const fromTarget = (
    source: ModelRouteSource,
    target: ModelTarget,
    tier: ModelTier | undefined,
    tierSource: ModelTierSource | undefined
  ): Draft => {
    // Цель без движка: счёт основной модели работает её движком, чужой адресат — через API.
    const engine: ModelEngine = target.engine ?? (addressesMain(target) ? mainEngine : 'api');
    const explicitModel = cleanModelId(target.model);
    let chain =
      tier || explicitModel
        ? buildModelChain(ctx.tiers, {
            engine,
            ...(tier ? { tier } : {}),
            explicit: { model: explicitModel, profile: target.profile, provider: target.provider }
          })
        : [];
    // Мёртвые звенья тира отбрасываются; явную модель цели не трогаем — её проблему надо показать.
    chain = chain.filter((link) => link.origin === 'explicit' || !isDeadApiLink(link));
    const usedTier = tier && chain.some((link) => link.origin === 'tier');
    if (tier && !usedTier) notes.push(`тир «${tier}» для движка ${engineLabel(engine)} не настроен`);
    return {
      source,
      engine,
      ...(usedTier ? { tier, ...(tierSource ? { tierSource } : {}) } : {}),
      ...settle(engine, target, chain),
      chain
    };
  };

  const fromTier = (tier: ModelTier, tierSource: ModelTierSource): Draft | undefined => {
    const entries = tiersForChain(tier, ctx.tiers.fallbackToLowerTier).flatMap((t) => ctx.tiers.tiers[t]);
    const first = entries.find((entry) => engines.includes(entry.engine) && !isDeadApiLink(entry));
    if (!first) {
      notes.push(
        entries.length === 0
          ? `тир «${tier}» пуст — работает основная модель`
          : `в тире «${tier}» нет моделей, которыми назначение умеет работать, — работает основная модель`
      );
      return undefined;
    }
    const chain = buildModelChain(ctx.tiers, { engine: first.engine, tier }).filter((link) => !isDeadApiLink(link));
    return { source: 'tier', engine: first.engine, tier, tierSource, ...settle(first.engine, undefined, chain), chain };
  };

  const decide = (): Draft => {
    const { slot, role } = input;
    const user = spec.fixed ? undefined : ctx.assignments.assignments[input.purpose];
    const slotExplicit = hasExplicitTarget(slot);
    // Слот только с тиром — это подсказка тира, а не цель.
    const hint = input.tierHint ?? (!slotExplicit ? slot?.modelTier : undefined);
    const hintSource: ModelTierSource = input.tierHint ? 'hint' : 'slot';

    if (slot && slotExplicit) {
      const tier = input.tierHint ?? slot.modelTier;
      return fromTarget('slot', slot, tier, input.tierHint ? 'hint' : 'slot');
    }
    if (role && hasExplicitTarget(role)) {
      return fromTarget('role', role, hint ?? role.modelTier, hint ? hintSource : 'role');
    }
    if (user?.mode === 'custom' && hasExplicitTarget(user.target)) {
      return fromTarget('purpose', user.target, hint ?? user.target.modelTier, hint ? hintSource : 'purpose');
    }
    if (user?.mode === 'main') return fromMain();

    const tiers: Array<[ModelTier, ModelTierSource]> = [];
    if (hint) tiers.push([hint, hintSource]);
    if (user?.mode === 'tier') tiers.push([user.tier, 'purpose']);
    else if (user?.mode === 'custom' && user.target.modelTier) tiers.push([user.target.modelTier, 'purpose']);
    else if (role?.modelTier) tiers.push([role.modelTier, 'role']);
    else if (spec.defaultTier) tiers.push([spec.defaultTier, 'default']);

    const tried = new Set<ModelTier>();
    for (const [tier, tierSource] of tiers) {
      if (tried.has(tier)) continue;
      tried.add(tier);
      const draft = fromTier(tier, tierSource);
      if (draft) return draft;
    }
    return fromMain();
  };

  const draft = decide();
  const label = purposeLabel(input.purpose);
  let problem: ModelRouteProblem | undefined;
  if (!engines.includes(draft.engine)) {
    problem = {
      code: 'engine_unsupported',
      message:
        `Назначение «${label}»: движок ${engineLabel(draft.engine)} не умеет ${KIND_WHAT[spec.kind]}. ` +
        `Выберите для назначения ${engines.map(engineLabel).join(' или ')} (${SETTINGS_HINT}).`
    };
  } else if (draft.problem) {
    problem = { code: draft.problem.code, message: `Назначение «${label}»: ${draft.problem.text}. ${SETTINGS_HINT}.` };
  } else if (spec.kind === 'complete' && draft.engine === 'claude-cli' && !draft.model) {
    // Одноразовый запрос через CLI идёт только с моделью из настроек пользователя ([[decision-35]] п. 2).
    problem = {
      code: 'no_model',
      message: `Назначение «${label}»: для одноразового запроса через Claude Code не выбрана модель. ${SETTINGS_HINT}.`
    };
  }

  return {
    purpose: input.purpose,
    kind: spec.kind,
    source: draft.source,
    engine: draft.engine,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.tier ? { tier: draft.tier } : {}),
    ...(draft.tierSource ? { tierSource: draft.tierSource } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.config ? { config: draft.config } : {}),
    ...(draft.info ? { info: draft.info } : {}),
    chain: draft.chain,
    notes,
    ...(problem ? { problem } : {})
  };
}

/** Ошибка выбора модели: называет назначение, `info.purpose` ведёт интерфейс в настройки. */
export class ModelRouteError extends ProviderError {
  readonly purpose: ModelPurpose;
  readonly code: ModelRouteProblemCode;

  constructor(resolved: ResolvedModel, problem: ModelRouteProblem) {
    super({
      kind: 'config',
      reason: PROBLEM_REASON[problem.code],
      retryable: false,
      ...(resolved.info ? { provider: describeProviderInfo(resolved.info) } : { provider: engineLabel(resolved.engine) }),
      ...(resolved.model ? { model: resolved.model } : {}),
      message: problem.message,
      purpose: resolved.purpose
    });
    this.name = 'ModelRouteError';
    this.purpose = resolved.purpose;
    this.code = problem.code;
  }
}

/** Цель пригодна — иначе `ModelRouteError`. */
export function assertModelUsable(resolved: ResolvedModel): void {
  if (resolved.problem) throw new ModelRouteError(resolved, resolved.problem);
}

/** Подпись решения для строки «Сейчас: …» и логов: «sonnet · Claude Code», «qwen3 · профиль «Ollama»». */
export function describeResolvedModel(resolved: ResolvedModel): string {
  const model = resolved.model ?? 'модель по умолчанию';
  const where = resolved.engine === 'api' ? describeProviderInfo(resolved.info) : engineLabel(resolved.engine);
  return `${model} · ${where}`;
}

/**
 * Снимок решения для интерфейса и состояния на диске: чем обслуживается назначение. Конфига вызова в нём
 * нет — ключ в renderer и в файлы состояния не попадает.
 */
export interface ModelRouteView {
  purpose: ModelPurpose;
  kind: ModelCallKind;
  source: ModelRouteSource;
  engine: ModelEngine;
  model?: string;
  tier?: ModelTier;
  tierSource?: ModelTierSource;
  /** Адресат API-пути: имя профиля или прежний провайдер. У CLI-движков его нет. */
  provider?: string;
  /** Готовая подпись (ru): «sonnet · Claude Code» — для логов; интерфейс собирает свою по полям. */
  label: string;
  /** Вызов идёт через Claude Code по подписке: цены в USD у него нет, расход ограничен окнами лимитов. */
  subscription: boolean;
  local?: boolean;
  notes: string[];
  problem?: ModelRouteProblem;
}

export function modelRouteView(resolved: ResolvedModel): ModelRouteView {
  return {
    purpose: resolved.purpose,
    kind: resolved.kind,
    source: resolved.source,
    engine: resolved.engine,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.tier ? { tier: resolved.tier } : {}),
    ...(resolved.tierSource ? { tierSource: resolved.tierSource } : {}),
    ...(resolved.engine === 'api' && resolved.info
      ? { provider: resolved.info.profileName ?? resolved.info.profileId ?? resolved.info.provider }
      : {}),
    label: describeResolvedModel(resolved),
    subscription: resolved.engine === 'claude-cli',
    ...(resolved.info?.local !== undefined ? { local: resolved.info.local } : {}),
    notes: [...resolved.notes],
    ...(resolved.problem ? { problem: resolved.problem } : {})
  };
}

/** Черновик окна «Назначения» (TASK-134.3): назначения и основная модель до «Сохранить». */
export interface RoutePreviewDraft {
  assignments?: unknown;
  main?: Partial<AIProviderConfig>;
}

/** Поля основной модели, от которых зависит выбор; остальное (политика одобрений) в предпросмотр не берётся. */
const MAIN_ROUTE_FIELDS = ['provider', 'engine', 'apiKey', 'model', 'profileId', 'baseUrl', 'reasoningEffort'] as const;

/**
 * «Сейчас» для каждого назначения каталога на черновике настроек (TASK-134.3): назначения и основная модель
 * из окна подменяют сохранённые, тиры и профили — сохранённые. Ничего не вызывает и не сохраняет.
 */
export function previewPurposeRoutes(ctx: ModelRouteContext, draft: RoutePreviewDraft = {}): Record<ModelPurpose, ModelRouteView> {
  const main = { ...ctx.main };
  if (draft.main) {
    for (const key of MAIN_ROUTE_FIELDS) {
      if (key in draft.main) (main as Record<string, unknown>)[key] = draft.main[key];
    }
  }
  const assignments = draft.assignments === undefined ? ctx.assignments : normalizeModelAssignments(draft.assignments).settings;
  const preview = { ...ctx, main, assignments };
  return Object.fromEntries(
    MODEL_PURPOSES.map((purpose) => [purpose, modelRouteView(resolveModel({ purpose }, preview))])
  ) as Record<ModelPurpose, ModelRouteView>;
}

/** Поля слота fleet, которыми задаётся движок и модель агента. */
export interface ResolvedSlotFields {
  engine: ModelEngine;
  providerConfig?: Partial<AIProviderConfig>;
  modelTier?: ModelTier;
}

/**
 * Решение резолвера в полях слота Swarm — так агент fleet запускается тем движком и той моделью, которые
 * выбраны по назначению. Тир передаётся дальше: fleet строит по нему цепочку запасных моделей
 * ([[decision-44]] п. 5).
 *
 * У API-слота модель и адресат передаются явно даже при выборе по тиру: цепочка fleet не знает о звеньях,
 * которые резолвер пропустил, и без явной модели могла бы начать с другого звена.
 */
export function slotFieldsFromResolved(resolved: ResolvedModel): ResolvedSlotFields {
  const fields: ResolvedSlotFields = { engine: resolved.engine };
  const byTier = resolved.chain[0]?.origin === 'tier';
  const providerConfig: Partial<AIProviderConfig> = {};
  if (resolved.engine === 'api') {
    const config = resolved.config;
    if (config) {
      providerConfig.provider = config.provider;
      if (config.profileId) providerConfig.profileId = config.profileId;
      if (resolved.model) providerConfig.model = resolved.model;
    }
  } else if (resolved.model && !byTier) {
    // CLI-слоту с тиром модель даст цепочка: так в отчёте агента источник модели — тир, а не явный id.
    providerConfig.model = resolved.model;
  }
  if (resolved.reasoningEffort) providerConfig.reasoningEffort = resolved.reasoningEffort;
  if (Object.keys(providerConfig).length > 0) fields.providerConfig = providerConfig;
  if (resolved.tier) fields.modelTier = resolved.tier;
  return fields;
}
