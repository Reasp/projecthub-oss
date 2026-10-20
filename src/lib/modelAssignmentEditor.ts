/**
 * Редактор назначений моделей и выбор движка основной модели (TASK-134.3, decision-96).
 *
 * Каталог назначений и правило подписки берутся из чистых модулей main-процесса (`modelPurposes.ts`,
 * `modelTarget.ts`): в renderer у них нет копий, правило записано в одном месте ([[decision-74]] п. 2).
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import { MODEL_PURPOSES, MODEL_PURPOSE_SPECS, purposeEngines } from '../../electron/services/modelPurposes';
import { mainEngineOf } from '../../electron/services/modelTarget';
import type {
  AIProviderConfig,
  ModelAssignments,
  ModelPurpose,
  ModelTargetSpec,
  ModelTier,
  PurposeAssignment,
  TierEngine
} from '../types/electron';

/** `default` — назначение не задано пользователем и идёт по каталогу. */
export type AssignmentMode = 'default' | 'main' | 'tier' | 'custom';

export const ASSIGNMENT_MODES: readonly AssignmentMode[] = ['default', 'main', 'tier', 'custom'];

/** Строки таблицы — все назначения каталога в его порядке. */
export const PURPOSE_ROWS: readonly ModelPurpose[] = MODEL_PURPOSES;

export function isFixedPurpose(purpose: ModelPurpose): boolean {
  return MODEL_PURPOSE_SPECS[purpose].fixed === true;
}

/** Чем назначение обслуживается по каталогу, пока пользователь его не менял. */
export function catalogAssignment(purpose: ModelPurpose): PurposeAssignment {
  const tier = MODEL_PURPOSE_SPECS[purpose].defaultTier;
  return tier ? { mode: 'tier', tier } : { mode: 'main' };
}

/** Движки, которыми назначение умеет работать (по виду вызова). */
export function purposeEngineOptions(purpose: ModelPurpose): readonly TierEngine[] {
  return purposeEngines(purpose);
}

export function assignmentModeOf(draft: ModelAssignments, purpose: ModelPurpose): AssignmentMode {
  return draft.assignments[purpose]?.mode ?? 'default';
}

function withEntry(draft: ModelAssignments, purpose: ModelPurpose, entry: PurposeAssignment | undefined): ModelAssignments {
  const assignments = { ...draft.assignments };
  if (entry) assignments[purpose] = entry;
  else delete assignments[purpose];
  return { ...draft, assignments };
}

/**
 * Смена режима. Тир сохраняет выбранный раньше, иначе берёт тир каталога: тир — класс модели, а не модель,
 * поэтому это не предвыбор модели ([[decision-26]] п. 0). Своя цель начинается пустой.
 */
export function withAssignmentMode(draft: ModelAssignments, purpose: ModelPurpose, mode: AssignmentMode): ModelAssignments {
  if (isFixedPurpose(purpose)) return draft;
  const current = draft.assignments[purpose];
  switch (mode) {
    case 'default':
      return withEntry(draft, purpose, undefined);
    case 'main':
      return withEntry(draft, purpose, { mode: 'main' });
    case 'tier': {
      const tier: ModelTier =
        current?.mode === 'tier' ? current.tier : (MODEL_PURPOSE_SPECS[purpose].defaultTier ?? 'balanced');
      return withEntry(draft, purpose, { mode: 'tier', tier });
    }
    case 'custom':
      return withEntry(draft, purpose, { mode: 'custom', target: current?.mode === 'custom' ? current.target : {} });
  }
}

export function withTier(draft: ModelAssignments, purpose: ModelPurpose, tier: ModelTier): ModelAssignments {
  return isFixedPurpose(purpose) ? draft : withEntry(draft, purpose, { mode: 'tier', tier });
}

/**
 * Правка своей цели. Пустые строки убираются; у движка CLI адресата API нет, поэтому профиль и провайдер
 * сбрасываются при выборе такого движка.
 */
export function withTargetPatch(draft: ModelAssignments, purpose: ModelPurpose, patch: Partial<ModelTargetSpec>): ModelAssignments {
  if (isFixedPurpose(purpose)) return draft;
  const current = draft.assignments[purpose];
  const target: ModelTargetSpec = { ...(current?.mode === 'custom' ? current.target : {}), ...patch };
  for (const key of Object.keys(target) as Array<keyof ModelTargetSpec>) {
    const value = target[key];
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) delete target[key];
  }
  if (target.engine && target.engine !== 'api') {
    delete target.profile;
    delete target.provider;
  }
  return withEntry(draft, purpose, { mode: 'custom', target });
}

export type AssignmentDraftProblem = 'empty_target';

/** Проблемы черновика, из-за которых сохранять нельзя: своя цель без единого поля. */
export function assignmentDraftProblems(draft: ModelAssignments): Partial<Record<ModelPurpose, AssignmentDraftProblem>> {
  const problems: Partial<Record<ModelPurpose, AssignmentDraftProblem>> = {};
  for (const purpose of PURPOSE_ROWS) {
    const entry = draft.assignments[purpose];
    if (entry?.mode !== 'custom') continue;
    const t = entry.target;
    if (!t.engine && !t.profile && !t.provider && !t.model && !t.modelTier) problems[purpose] = 'empty_target';
  }
  return problems;
}

// ─────────────────────────── Движок основной модели ───────────────────────────

/** Пункт списка «Провайдер»: подписка и API-ключ Anthropic — разные пункты (TASK-134.3). */
export type MainChoice = 'claude-subscription' | 'anthropic-api' | Exclude<AIProviderConfig['provider'], 'anthropic'>;

/**
 * Какой пункт выбран. Настройки без явного движка (до TASK-134) открываются тем пунктом, который соответствует
 * их поведению: Anthropic без ключа — подписка. Форма при этом не меняется до «Сохранить».
 */
export function mainChoiceOf(form: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): MainChoice {
  if (form.provider !== 'anthropic') return form.provider;
  return mainEngineOf(form) === 'claude-cli' ? 'claude-subscription' : 'anthropic-api';
}

/** Провайдер и движок формы для пункта списка. Движок пишется явно только у Anthropic. */
export function mainChoicePatch(choice: MainChoice): Pick<AIProviderConfig, 'provider' | 'engine'> {
  if (choice === 'claude-subscription') return { provider: 'anthropic', engine: 'claude-cli' };
  if (choice === 'anthropic-api') return { provider: 'anthropic', engine: 'api' };
  return { provider: choice, engine: undefined };
}

/** Движок основной модели формы — для подсказок усилия рассуждений и полей Anthropic. */
export function mainEngineOfForm(form: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): 'claude-cli' | 'api' {
  return mainEngineOf(form);
}
