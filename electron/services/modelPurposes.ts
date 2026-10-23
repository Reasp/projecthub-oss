/**
 * Каталог назначений моделей и файл назначений пользователя (TASK-134.1, decision-74).
 *
 * Назначение — место, где приложение зовёт модель: планировщик, ревью, голос и т.д. По умолчанию каждое
 * назначение обслуживает основная модель или его тир; пользователь может указать назначению свою цель.
 * Файл `<userData>/model-assignments.json` хранит только то, что пользователь изменил.
 *
 * Тир по умолчанию — класс модели, а не id ([[decision-26]] п. 0): пока тир пуст, работает основная модель.
 *
 * Чистый модуль без Electron — импортируется unit-тестами напрямую.
 */
import { TIER_ENGINES, isModelTier, type ModelTier } from './modelTiers.js';
import { formatAppError, type AppErrorKey } from '../../src/lib/appError.js';
import { appErrorTextEn } from '../../src/i18n/appErrorText.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';
import { normalizeModelTarget, type ModelEngine, type ModelTarget } from './modelTarget.js';

/**
 * Вид вызова:
 * - `complete` — одноразовый запрос «промпт → текст» без инструментов;
 * - `turn` — один ход с чтением проекта, без worktree и без записи;
 * - `agent` — агент с инструментами и HITL.
 */
export type ModelCallKind = 'complete' | 'turn' | 'agent';

export const MODEL_PURPOSES = [
  'studio',
  'agent',
  'plan.architect',
  'plan.node',
  'arena.reviewer',
  'pr.review',
  'voice.classify',
  'voice.punctuate',
  'voice.computer',
  'task.draft'
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export interface ModelPurposeSpec {
  kind: ModelCallKind;
  /** Тир назначения по умолчанию; без него — основная модель. */
  defaultTier?: ModelTier;
  /** Название для сообщений main-процесса (ru); renderer переводит по идентификатору. */
  label: string;
  /** Назначение всегда обслуживает основная модель и не настраивается. */
  fixed?: boolean;
  /** Движки, которыми назначение умеет работать; без поля — по виду вызова (`enginesForKind`). */
  engines?: readonly ModelEngine[];
}

/** Движки, у которых есть одноразовый запрос и ход без worktree: Codex и Gemini CLI — только агенты (до TASK-71). */
const SERVICE_ENGINES: readonly ModelEngine[] = ['claude-cli', 'api'];

export function enginesForKind(kind: ModelCallKind): readonly ModelEngine[] {
  return kind === 'agent' ? TIER_ENGINES : SERVICE_ENGINES;
}

export const MODEL_PURPOSE_SPECS: Readonly<Record<ModelPurpose, ModelPurposeSpec>> = {
  // Agents Studio и есть основная модель: назначить ей другую нельзя.
  studio: { kind: 'agent', label: 'Agents Studio', fixed: true, engines: SERVICE_ENGINES },
  agent: { kind: 'agent', label: 'Agents: Swarm, done-loop, assigned tasks, Automations' },
  'plan.architect': { kind: 'turn', defaultTier: 'frontier', label: 'Planner: architect' },
  'plan.node': { kind: 'agent', defaultTier: 'balanced', label: 'Planner: plan nodes' },
  'arena.reviewer': { kind: 'turn', defaultTier: 'frontier', label: 'Arena: reviewer' },
  'pr.review': { kind: 'agent', label: 'PR review' },
  'voice.classify': { kind: 'complete', defaultTier: 'cheap', label: 'Voice: command parsing' },
  'voice.punctuate': { kind: 'complete', defaultTier: 'cheap', label: 'Voice: dictation punctuation' },
  // Команду компьютеру исполняет сессия Agents Studio с инструментами computer_* — у неё два движка.
  'voice.computer': { kind: 'agent', label: 'Voice: computer command', engines: SERVICE_ENGINES },
  'task.draft': { kind: 'complete', defaultTier: 'cheap', label: 'Task description draft' }
};

/** Имя назначения в тексте ошибки — кодом словаря (decision-165): окно и телефон показывают его на своём языке. */
const PURPOSE_CODES: Readonly<Record<ModelPurpose, AppErrorCode>> = {
  studio: 'models.purposeStudio',
  agent: 'models.purposeAgent',
  'plan.architect': 'models.purposePlanArchitect',
  'plan.node': 'models.purposePlanNode',
  'arena.reviewer': 'models.purposeArenaReviewer',
  'pr.review': 'models.purposePrReview',
  'voice.classify': 'models.purposeVoiceClassify',
  'voice.punctuate': 'models.purposeVoicePunctuate',
  'voice.computer': 'models.purposeVoiceComputer',
  'task.draft': 'models.purposeTaskDraft'
};

export function purposeKey(purpose: ModelPurpose): AppErrorKey {
  return { code: PURPOSE_CODES[purpose] };
}

export function isModelPurpose(value: unknown): value is ModelPurpose {
  return typeof value === 'string' && (MODEL_PURPOSES as readonly string[]).includes(value);
}

/** Английское имя назначения — для журнала. */
export function purposeLabel(purpose: ModelPurpose): string {
  return MODEL_PURPOSE_SPECS[purpose].label;
}

export function purposeEngines(purpose: ModelPurpose): readonly ModelEngine[] {
  const spec = MODEL_PURPOSE_SPECS[purpose];
  return spec.engines ?? enginesForKind(spec.kind);
}

/** Чем обслуживать назначение: основной моделью, тиром или своей целью. */
export type PurposeAssignment =
  | { mode: 'main' }
  | { mode: 'tier'; tier: ModelTier }
  | { mode: 'custom'; target: ModelTarget };

export interface ModelAssignments {
  version: 1;
  updatedAt?: string;
  /** Только назначения, изменённые пользователем; остальные — по каталогу. */
  assignments: Partial<Record<ModelPurpose, PurposeAssignment>>;
}

export function emptyModelAssignments(): ModelAssignments {
  return { version: 1, assignments: {} };
}

/** Назначение по каталогу: тир по умолчанию или основная модель. */
export function defaultAssignment(purpose: ModelPurpose): PurposeAssignment {
  const tier = MODEL_PURPOSE_SPECS[purpose].defaultTier;
  return tier ? { mode: 'tier', tier } : { mode: 'main' };
}

/** Действующее назначение и признак, что его задал пользователь. */
export function effectiveAssignment(
  settings: ModelAssignments,
  purpose: ModelPurpose
): { assignment: PurposeAssignment; userSet: boolean } {
  const own = MODEL_PURPOSE_SPECS[purpose].fixed ? undefined : settings.assignments[purpose];
  return own ? { assignment: own, userSet: true } : { assignment: defaultAssignment(purpose), userSet: false };
}

/** Проблема чтения файла: английский текст для журнала и код для окна. */
function pushProblem(problems: string[], problemKeys: AppErrorKey[], key: AppErrorKey): void {
  problems.push(formatAppError(key, appErrorTextEn) ?? key.code);
  problemKeys.push(key);
}

/** Нормализует одно назначение; ключ ошибки — причина, по которой оно отброшено. */
export function normalizePurposeAssignment(raw: unknown): PurposeAssignment | AppErrorKey {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { code: 'models.assignmentNotObject' };
  const r = raw as Record<string, unknown>;
  switch (r.mode) {
    case 'main':
      return { mode: 'main' };
    case 'tier':
      return isModelTier(r.tier) ? { mode: 'tier', tier: r.tier } : { code: 'models.unknownTier', params: { tier: String(r.tier) } };
    case 'custom': {
      const target = normalizeModelTarget(r.target);
      return target ? { mode: 'custom', target } : { code: 'models.customTargetEmpty' };
    }
    default:
      return { code: 'models.unknownMode', params: { mode: String(r.mode) } };
  }
}

/**
 * Назначения из файла: неизвестные назначения и битые записи пропускаются, запуск они не ломают.
 * `problems` — что отброшено, для UI.
 */
export function normalizeModelAssignments(raw: unknown): { settings: ModelAssignments; problems: string[]; problemKeys: AppErrorKey[] } {
  const settings = emptyModelAssignments();
  const problems: string[] = [];
  const problemKeys: AppErrorKey[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) pushProblem(problems, problemKeys, { code: 'models.assignmentsFileNotObject' });
    return { settings, problems, problemKeys };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt === 'string' && r.updatedAt.trim()) settings.updatedAt = r.updatedAt.trim();
  const list = r.assignments;
  if (list === undefined || list === null) return { settings, problems, problemKeys };
  if (typeof list !== 'object' || Array.isArray(list)) {
    pushProblem(problems, problemKeys, { code: 'models.assignmentsNotObject' });
    return { settings, problems, problemKeys };
  }
  for (const [key, value] of Object.entries(list as Record<string, unknown>)) {
    if (!isModelPurpose(key)) {
      pushProblem(problems, problemKeys, { code: 'models.unknownPurpose', params: { purpose: key } });
      continue;
    }
    if (MODEL_PURPOSE_SPECS[key].fixed) {
      pushProblem(problems, problemKeys, { code: 'models.purposeFixed', params: { purpose: key } });
      continue;
    }
    const assignment = normalizePurposeAssignment(value);
    if (!('mode' in assignment)) {
      pushProblem(problems, problemKeys, { code: 'models.purposeProblem', params: { purpose: key, reason: assignment } });
      continue;
    }
    settings.assignments[key] = assignment;
  }
  return { settings, problems, problemKeys };
}
