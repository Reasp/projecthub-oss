/**
 * Прозрачный скоринг кандидатов Swarm Arena (decision-12 п.2, TASK-61).
 *
 * Балл — взвешенная сумма компонентов, каждый нормализован в 0..1 (больше — лучше). Величины,
 * у которых нет абсолютной шкалы (размер диффа, стоимость, время), нормализуются относительно
 * когорты: лучший кандидат получает 1, худший — 0. Единственный блокирующий критерий — статус
 * блокирующих проверок: заблокированный кандидат не может быть рекомендован, каким бы ни был балл.
 * Компонент `security` (decision-56 п. 6) — абсолютный, не когортный: секреты в диффе дают 0, пакет с флагом риска — 0.5;
 * он не блокирует рекомендацию, но запрещает авто-мердж вместе с любыми изменениями зависимостей.
 *
 * Чистый модуль без Electron и IO — покрыт unit-тестами.
 */
import { isCountedStatus, isFailedStatus } from './arenaChecks.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';
import { keyedText, type AppErrorKey, type AppErrorParams } from '../../src/lib/appError.js';
import type {
  CandidateScore,
  CheckRunResult,
  CriterionVerdict,
  ScoreComponent,
  ScoreComponentKey,
  ScoreWeights
} from './arenaTypes.js';

/**
 * Веса по умолчанию — консервативные (decision-12): основная масса у объективных проверок и
 * покрытия критериев приёмки, размер диффа и стоимость влияют слабо, чтобы скоринг нельзя было
 * «переобучить» на «кто написал меньше строк».
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  checks: 40,
  acceptance: 25,
  review: 15,
  diffSize: 8,
  locality: 6,
  cost: 4,
  time: 2,
  security: 10
};

export const SCORE_COMPONENT_KEYS: ScoreComponentKey[] = [
  'checks',
  'acceptance',
  'review',
  'diffSize',
  'locality',
  'cost',
  'time',
  'security'
];

/** Нейтральная оценка компонента, по которому нет данных: не наказывает и не награждает. */
export const UNKNOWN_NORMALIZED = 0.5;

/** Вклад вердикта ревьюера по одному критерию приёмки в покрытие AC. */
const CRITERION_WEIGHT: Record<CriterionVerdict, number> = {
  met: 1,
  partial: 0.5,
  unmet: 0,
  unknown: UNKNOWN_NORMALIZED
};

/** Штраф за найденную проблему по степени серьёзности (вычитается из оценки ревью). */
const SEVERITY_PENALTY = { critical: 0.5, major: 0.25, minor: 0.08, info: 0 } as const;

export interface CandidateScoreInput {
  agentId: string;
  checks: CheckRunResult[];
  /** Вердикты ревьюера по критериям приёмки задачи. */
  criteria?: Array<{ verdict: CriterionVerdict }>;
  /** Общая оценка ревьюера 0..1, если он её дал. */
  reviewOverall?: number;
  reviewFindings?: Array<{ severity: keyof typeof SEVERITY_PENALTY }>;
  reviewFailed?: boolean;
  diff?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    /** Затронутые модули (каталоги первого-второго уровня) — метрика локальности. */
    modules?: number;
    /** Число зависимых символов по GitNexus: чем больше, тем шире радиус поражения. */
    dependents?: number;
  };
  costUsd?: number;
  durationMs?: number;
  /** Безопасность диффа кандидата (decision-56 п. 5); без поля — скана не было. */
  security?: CandidateSecurityInput;
}

export interface CandidateSecurityInput {
  /** Находок секретов в добавленных строках (после исключений). */
  secrets: number;
  /** Пакетов с флагом риска registry: not_found, recent, young, deprecated. */
  riskyDependencies: number;
  /** Добавленных и изменённых зависимостей — любые требуют человека при слиянии. */
  dependencyChanges: number;
}

/** Сводка по когорте: максимумы, относительно которых нормализуются «чем меньше, тем лучше». */
export interface CohortStats {
  maxDiffLines: number;
  maxLocality: number;
  maxCostUsd: number;
  maxDurationMs: number;
}

export function collectCohortStats(inputs: CandidateScoreInput[]): CohortStats {
  let maxDiffLines = 0;
  let maxLocality = 0;
  let maxCostUsd = 0;
  let maxDurationMs = 0;
  for (const c of inputs) {
    if (c.diff) {
      maxDiffLines = Math.max(maxDiffLines, c.diff.insertions + c.diff.deletions);
      maxLocality = Math.max(maxLocality, localityUnits(c.diff));
    }
    if (typeof c.costUsd === 'number' && Number.isFinite(c.costUsd)) maxCostUsd = Math.max(maxCostUsd, c.costUsd);
    if (typeof c.durationMs === 'number' && Number.isFinite(c.durationMs)) maxDurationMs = Math.max(maxDurationMs, c.durationMs);
  }
  return { maxDiffLines, maxLocality, maxCostUsd, maxDurationMs };
}

/**
 * Условные «единицы разброса» изменения: модули важнее файлов, зависимые символы по GitNexus
 * учитываются в десятых долях, чтобы одна популярная утилита не перевешивала всё остальное.
 */
export function localityUnits(diff: NonNullable<CandidateScoreInput['diff']>): number {
  const modules = diff.modules ?? 0;
  const dependents = diff.dependents ?? 0;
  return modules * 2 + diff.filesChanged + dependents * 0.1;
}

/** «Чем меньше, тем лучше» в 0..1 относительно максимума когорты. */
export function normalizeLowerIsBetter(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return UNKNOWN_NORMALIZED;
  if (!Number.isFinite(max) || max <= 0) return 1;
  return clamp01(1 - value / max);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Доля пройденных проверок среди тех, что реально отработали. */
export function checksScore(checks: CheckRunResult[]): { normalized: number; passed: number; counted: number } {
  const counted = checks.filter((c) => isCountedStatus(c.status));
  if (counted.length === 0) return { normalized: UNKNOWN_NORMALIZED, passed: 0, counted: 0 };
  const passed = counted.filter((c) => c.status === 'passed').length;
  return { normalized: passed / counted.length, passed, counted: counted.length };
}

/** Первая проваленная блокирующая проверка — причина блокировки кандидата. */
export function blockingFailure(checks: CheckRunResult[]): CheckRunResult | undefined {
  return checks.find((c) => c.blocking && isFailedStatus(c.status));
}

/** Покрытие критериев приёмки по вердиктам ревьюера. */
export function acceptanceScore(criteria: Array<{ verdict: CriterionVerdict }> | undefined): {
  normalized: number;
  met: number;
  total: number;
  known: boolean;
} {
  if (!criteria || criteria.length === 0) return { normalized: UNKNOWN_NORMALIZED, met: 0, total: 0, known: false };
  const sum = criteria.reduce((acc, c) => acc + (CRITERION_WEIGHT[c.verdict] ?? UNKNOWN_NORMALIZED), 0);
  const met = criteria.filter((c) => c.verdict === 'met').length;
  return { normalized: clamp01(sum / criteria.length), met, total: criteria.length, known: true };
}

/** Оценка ревью: собственная оценка ревьюера минус штрафы за найденные проблемы. */
export function reviewScore(input: CandidateScoreInput): { normalized: number; known: boolean; penalty: number } {
  const findings = input.reviewFindings ?? [];
  const penalty = findings.reduce((acc, f) => acc + (SEVERITY_PENALTY[f.severity] ?? 0), 0);
  if (input.reviewFailed) return { normalized: UNKNOWN_NORMALIZED, known: false, penalty: 0 };
  const base = typeof input.reviewOverall === 'number' && Number.isFinite(input.reviewOverall)
    ? clamp01(input.reviewOverall)
    : undefined;
  if (base === undefined && findings.length === 0) return { normalized: UNKNOWN_NORMALIZED, known: false, penalty: 0 };
  return { normalized: clamp01((base ?? 1) - penalty), known: true, penalty };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Текст для журнала и модели по-английски и код для окна (decision-165). */
type Keyed = { text: string; key: AppErrorKey };

function reasonOf(code: AppErrorCode, params?: AppErrorParams): { reason: string; reasonKey: AppErrorKey } {
  const { text, key } = keyedText(code, params);
  return { reason: text, reasonKey: key };
}

/** Оценка безопасности: 1 — чисто, 0 — секреты, 0.5 — пакет с флагом риска; без скана — нейтральная. */
export function securityScore(security: CandidateSecurityInput | undefined): { normalized: number; known: boolean; detail: Keyed } {
  if (!security) return { normalized: UNKNOWN_NORMALIZED, known: false, detail: keyedText('judge.securityUnknown') };
  if (security.secrets > 0) {
    return { normalized: 0, known: true, detail: keyedText('judge.securitySecrets', { n: security.secrets }) };
  }
  if (security.riskyDependencies > 0) {
    return { normalized: 0.5, known: true, detail: keyedText('judge.securityRisky', { n: security.riskyDependencies }) };
  }
  return {
    normalized: 1,
    known: true,
    detail:
      security.dependencyChanges > 0
        ? keyedText('judge.securityDependencyChanges', { n: security.dependencyChanges })
        : keyedText('judge.securityClean')
  };
}

/** Почему авто-мердж кандидата невозможен по безопасности; `undefined` — препятствий нет. */
export function securityAutoMergeBlock(security: CandidateSecurityInput | undefined): { reason: string; reasonKey: AppErrorKey } | undefined {
  if (!security) return undefined;
  if (security.secrets > 0) return reasonOf('judge.autoMergeSecrets', { n: security.secrets });
  if (security.dependencyChanges > 0) return reasonOf('judge.autoMergeDependencies', { n: security.dependencyChanges });
  return undefined;
}

/** Сумма весов: балл всегда приводится к шкале 0..100, как бы пользователь ни задал веса. */
export function totalWeight(weights: ScoreWeights): number {
  return SCORE_COMPONENT_KEYS.reduce((acc, key) => acc + Math.max(0, weights[key] ?? 0), 0);
}

/** Приводит произвольный объект из `.projecthub.json` к полному набору весов. */
export function normalizeWeights(raw: unknown): ScoreWeights {
  const out = { ...DEFAULT_SCORE_WEIGHTS };
  if (raw && typeof raw === 'object') {
    for (const key of SCORE_COMPONENT_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    }
  }
  return out;
}

/**
 * Итоговый балл кандидата с разложением по компонентам.
 *
 * Балл считается и для заблокированного кандидата (чтобы было видно, насколько он был близок),
 * но `blocked` запрещает рекомендацию и авто-мердж.
 */
export function computeCandidateScore(
  input: CandidateScoreInput,
  cohort: CohortStats,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
  now: number = Date.now()
): CandidateScore {
  const w = normalizeWeights(weights);
  const components: ScoreComponent[] = [];

  const push = (
    key: ScoreComponentKey,
    normalized: number,
    detail: Keyed,
    options: { raw?: number; unknown?: boolean } = {}
  ) => {
    const weight = Math.max(0, w[key] ?? 0);
    components.push({
      key,
      weight,
      normalized: round2(clamp01(normalized)),
      points: round2(weight * clamp01(normalized)),
      detail: detail.text,
      detailKey: detail.key,
      ...(options.raw !== undefined ? { raw: round2(options.raw) } : {}),
      ...(options.unknown ? { unknown: true } : {})
    });
  };

  const checks = checksScore(input.checks);
  push(
    'checks',
    checks.normalized,
    checks.counted === 0 ? keyedText('judge.checksNotRun') : keyedText('judge.checksPassed', { passed: checks.passed, counted: checks.counted }),
    { raw: checks.passed, unknown: checks.counted === 0 }
  );

  const acceptance = acceptanceScore(input.criteria);
  push(
    'acceptance',
    acceptance.normalized,
    acceptance.known
      ? keyedText('judge.acceptanceMet', { met: acceptance.met, total: acceptance.total })
      : keyedText('judge.acceptanceUnknown'),
    { raw: acceptance.total ? acceptance.met / acceptance.total : undefined, unknown: !acceptance.known }
  );

  const review = reviewScore(input);
  push(
    'review',
    review.normalized,
    review.known ? keyedText('judge.reviewScore', { penalty: round2(review.penalty) }) : keyedText('judge.reviewUnknown'),
    { unknown: !review.known }
  );

  if (input.diff) {
    const lines = input.diff.insertions + input.diff.deletions;
    push('diffSize', normalizeLowerIsBetter(lines, cohort.maxDiffLines), keyedText('judge.diffLines', { n: lines }), { raw: lines });

    const units = localityUnits(input.diff);
    push(
      'locality',
      normalizeLowerIsBetter(units, cohort.maxLocality),
      typeof input.diff.dependents === 'number'
        ? keyedText('judge.localityDependents', { files: input.diff.filesChanged, modules: input.diff.modules ?? 0, dependents: input.diff.dependents })
        : keyedText('judge.locality', { files: input.diff.filesChanged, modules: input.diff.modules ?? 0 }),
      { raw: units }
    );
  } else {
    push('diffSize', UNKNOWN_NORMALIZED, keyedText('judge.diffUnknown'), { unknown: true });
    push('locality', UNKNOWN_NORMALIZED, keyedText('judge.diffUnknown'), { unknown: true });
  }

  const hasCost = typeof input.costUsd === 'number' && Number.isFinite(input.costUsd);
  push(
    'cost',
    hasCost ? normalizeLowerIsBetter(input.costUsd as number, cohort.maxCostUsd) : UNKNOWN_NORMALIZED,
    hasCost ? keyedText('judge.cost', { usd: (input.costUsd as number).toFixed(4) }) : keyedText('judge.costUnknown'),
    { raw: hasCost ? (input.costUsd as number) : undefined, unknown: !hasCost }
  );

  const hasTime = typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs > 0;
  push(
    'time',
    hasTime ? normalizeLowerIsBetter(input.durationMs as number, cohort.maxDurationMs) : UNKNOWN_NORMALIZED,
    hasTime ? keyedText('judge.time', { s: ((input.durationMs as number) / 1000).toFixed(1) }) : keyedText('judge.timeUnknown'),
    { raw: hasTime ? (input.durationMs as number) : undefined, unknown: !hasTime }
  );

  const security = securityScore(input.security);
  push('security', security.normalized, security.detail, {
    ...(input.security ? { raw: input.security.secrets } : {}),
    unknown: !security.known
  });

  const weightSum = totalWeight(w);
  const points = components.reduce((acc, c) => acc + c.points, 0);
  const total = weightSum > 0 ? round2((points / weightSum) * 100) : 0;

  const blocker = blockingFailure(input.checks);
  return {
    agentId: input.agentId,
    total,
    blocked: Boolean(blocker),
    ...(blocker ? blockedFields(blocker) : {}),
    components,
    computedAt: now
  };
}

function blockedFields(blocker: CheckRunResult): Pick<CandidateScore, 'blockedReason' | 'blockedReasonKey'> {
  const { text, key } = keyedText('judge.blockedByCheck', { name: blocker.name, status: blocker.status });
  return { blockedReason: text, blockedReasonKey: key };
}

/** Баллы всех кандидатов в одной когорте (нормализация относительная — считать нужно вместе). */
export function scoreCandidates(
  inputs: CandidateScoreInput[],
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
  now: number = Date.now()
): CandidateScore[] {
  const cohort = collectCohortStats(inputs);
  return inputs.map((input) => computeCandidateScore(input, cohort, weights, now));
}

/** Порядок показа: сначала незаблокированные по убыванию балла, потом заблокированные. */
export function rankCandidates(scores: CandidateScore[]): CandidateScore[] {
  return [...scores].sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    if (b.total !== a.total) return b.total - a.total;
    return a.agentId.localeCompare(b.agentId);
  });
}

/**
 * Кого рекомендовать: лучший незаблокированный кандидат. Если лидеров с одинаковым баллом
 * несколько, рекомендации нет — выбор в этом случае действительно за человеком.
 */
export function recommendCandidate(scores: CandidateScore[]): { agentId?: string; reason: string; reasonKey: AppErrorKey } {
  const eligible = rankCandidates(scores).filter((s) => !s.blocked);
  if (eligible.length === 0) return reasonOf('judge.allBlocked');
  const best = eligible[0];
  const tied = eligible.filter((s) => s.total === best.total);
  if (tied.length > 1) {
    return reasonOf('judge.tie', { score: best.total, agents: tied.map((s) => s.agentId).join(', ') });
  }
  return { agentId: best.agentId, ...reasonOf('judge.best', { score: best.total, n: eligible.length }) };
}

/**
 * Разрешён ли авто-мердж (decision-12 п.4): только незаблокированный рекомендованный кандидат
 * с баллом не ниже порога и без единой проваленной проверки — даже неблокирующей.
 */
export function autoMergeDecision(
  scores: CandidateScore[],
  checksByAgent: Record<string, CheckRunResult[]>,
  config: { enabled: boolean; minScore: number },
  securityByAgent: Record<string, CandidateSecurityInput | undefined> = {}
): { allowed: boolean; agentId?: string; reason: string; reasonKey: AppErrorKey } {
  if (!config.enabled) return { allowed: false, ...reasonOf('judge.autoMergeDisabled') };
  const recommendation = recommendCandidate(scores);
  const { agentId } = recommendation;
  if (!agentId) return { allowed: false, reason: recommendation.reason, reasonKey: recommendation.reasonKey };

  const score = scores.find((s) => s.agentId === agentId);
  if (!score) return { allowed: false, ...reasonOf('judge.scoreNotFound') };
  if (score.total < config.minScore) {
    return { allowed: false, agentId, ...reasonOf('judge.belowThreshold', { score: score.total, min: config.minScore }) };
  }
  const checks = checksByAgent[agentId] ?? [];
  if (checks.length === 0) {
    return { allowed: false, agentId, ...reasonOf('judge.autoMergeNoChecks') };
  }
  const failed = checks.filter((c) => isFailedStatus(c.status));
  if (failed.length > 0) {
    return { allowed: false, agentId, ...reasonOf('judge.checksNotGreen', { names: failed.map((c) => c.name).join(', ') }) };
  }
  const securityBlock = securityAutoMergeBlock(securityByAgent[agentId]);
  if (securityBlock) return { allowed: false, agentId, ...securityBlock };
  return { allowed: true, agentId, ...reasonOf('judge.autoMergeAllowed', { score: score.total, min: config.minScore }) };
}
