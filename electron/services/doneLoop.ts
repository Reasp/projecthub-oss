/**
 * Цикл «до готовности» (Done-loop, TASK-75, decision-28): чистая логика без Electron и IO.
 *
 * Здесь — схема и разбор отчёта агента, сверка критериев приёмки, решение «закончить /
 * повторить / прервать», тексты инструкций и повторного хода, итоговое резюме для задачи и
 * слияние настроек. Побочные эффекты (запуск агента, проверки, запись в Backlog) живут в
 * `doneLoopService`. Покрыт unit-тестами (`tests/unit/doneLoop.test.ts`).
 */
import { z } from 'zod';
import type { Language } from '../../src/i18n/types.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';
import { formatAppError, keyedText, type AppErrorKey, type AppErrorParams } from '../../src/lib/appError.js';
import { hostText } from '../i18n/hostText.js';
import { extractJsonObject } from './reviewerPrompt.js';
import { isFailedStatus, scriptCommand, summarizeCheckResult, DEFAULT_CHECK_TIMEOUT_MS } from './arenaChecks.js';
import type { CheckDefinition, CheckRunResult } from './arenaTypes.js';
import { isUiSmokeCheck, iterationScreenshots, resolveScreenshotRef, type IterationArtifact } from './visualArtifacts.js';
import type {
  AgentReport,
  CriterionReportStatus,
  CriterionScreenshot,
  CriterionVerification,
  DoneLoopOutcome,
  DoneLoopProjectSettings,
  DoneLoopSettings
} from './doneLoopTypes.js';

export const DEFAULT_DONE_LOOP_MAX_ITERATIONS = 5;
export const MAX_DONE_LOOP_ITERATIONS = 20;
/** Evidence короче этого не считается доказательством («готово», «ok»). */
export const MIN_EVIDENCE_CHARS = 12;
/** Язык ограды, в которой агент возвращает отчёт. */
export const REPORT_FENCE = 'projecthub-report';
/** Сколько символов хвоста одной проверки уходит в промпт повторного хода. */
export const RETRY_CHECK_TAIL_CHARS = 3000;

// ─────────────────────────────── Отчёт агента ───────────────────────────────

const STATUS_ALIASES: Record<string, CriterionReportStatus> = {
  done: 'done',
  met: 'done',
  complete: 'done',
  completed: 'done',
  passed: 'done',
  not_done: 'not_done',
  'not-done': 'not_done',
  notdone: 'not_done',
  unmet: 'not_done',
  partial: 'not_done',
  todo: 'not_done',
  failed: 'not_done',
  blocked: 'blocked'
};

function criterionIndex(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value === 'string') {
    const m = value.match(/(\d+)/);
    const n = m ? Number.parseInt(m[1], 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

const CriterionReportSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const r = raw as Record<string, unknown>;
    const status = typeof r.status === 'string' ? STATUS_ALIASES[r.status.trim().toLowerCase()] ?? r.status : r.status;
    const shotsRaw = r.screenshots ?? r.screenshot ?? r.artifacts;
    const shots = (Array.isArray(shotsRaw) ? shotsRaw : typeof shotsRaw === 'string' ? [shotsRaw] : [])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    return {
      index: criterionIndex(r.index ?? r.acId ?? r.id),
      status,
      evidence: typeof r.evidence === 'string' ? r.evidence.trim() : '',
      ...(shots.length > 0 ? { screenshots: shots } : {})
    };
  },
  z.object({
    index: z.number().int().positive(),
    status: z.enum(['done', 'not_done', 'blocked']),
    evidence: z.string(),
    screenshots: z.array(z.string()).optional()
  })
);

/** Схема отчёта агента: описана в инструкции явно, валидируется zod. */
export const AgentReportSchema = z.object({
  summary: z.string().optional().default(''),
  criteria: z.array(CriterionReportSchema)
});

export const REPORT_EXAMPLE = `{
  "summary": "What was done in this turn, 2-4 sentences",
  "criteria": [
    { "index": 1, "status": "done", "evidence": "src/foo.ts:42 — function bar; test tests/unit/foo.test.ts 'bar adds numbers' passes" },
    { "index": 2, "status": "not_done", "evidence": "Empty input handling is missing" }
  ]
}`;

/** Причина для модели и журнала по-английски и её код для окна и телефона (decision-165). */
const keyed = keyedText;

/** Все сбалансированные JSON-объекты верхнего уровня в тексте (с учётом строк и экранирования). */
function jsonObjectsIn(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('{');
    if (start < 0) break;
    const obj = extractJsonObject(rest);
    if (!obj) {
      // Незакрытая скобка (кусок кода в тексте) — пропускаем её и ищем дальше.
      rest = rest.slice(start + 1);
      continue;
    }
    out.push(obj);
    rest = rest.slice(start + obj.length);
  }
  return out;
}

export type ParsedAgentReport = { ok: true; report: AgentReport } | { ok: false; error: string; errorKey: AppErrorKey };

function reportFailure(code: AppErrorCode, params?: AppErrorParams): ParsedAgentReport {
  const { text, key } = keyed(code, params);
  return { ok: false, error: text, errorKey: key };
}

/**
 * Разбор отчёта из финального сообщения агента. Предпочтение — последней ограде
 * ```projecthub-report```; без неё берётся последний JSON-объект с полем `criteria`
 * (агенты печатают по ходу работы и другие JSON). Отчёт должен пройти схему.
 */
export function parseAgentReport(text: string): ParsedAgentReport {
  const source = text ?? '';
  const fenceRe = new RegExp('```\\s*' + REPORT_FENCE + '\\s*\\n([\\s\\S]*?)```', 'g');
  const fenced = [...source.matchAll(fenceRe)];

  let candidate: string | null;
  if (fenced.length > 0) {
    candidate = extractJsonObject(fenced[fenced.length - 1][1]);
    if (!candidate) return reportFailure('loop.reportNoJson', { fence: REPORT_FENCE });
  } else {
    const objects = jsonObjectsIn(source).filter((o) => /"criteria"\s*:/.test(o));
    candidate = objects.length > 0 ? objects[objects.length - 1] : null;
  }
  if (!candidate) return reportFailure('loop.reportMissing', { fence: REPORT_FENCE });

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return reportFailure('loop.reportBadJson', { detail: err instanceof Error ? err.message : String(err) });
  }
  const result = AgentReportSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path?.length ? issue.path.join('.') : 'report';
    return reportFailure('loop.reportSchema', { path: where, detail: issue?.message ?? 'invalid' });
  }
  return { ok: true, report: result.data };
}

// ───────────────────────────── Сверка критериев ─────────────────────────────

export interface CriterionInput {
  text: string;
  completed: boolean;
}

/**
 * Вердикт ProjectHub по каждому критерию задачи. Засчитывается только `done` с evidence не
 * короче `MIN_EVIDENCE_CHARS`. Набор и порядок критериев задаёт задача, а не агент: пропущенный
 * в отчёте критерий остаётся незакрытым. Уже отмеченные до цикла критерии не пересматриваются.
 */
/** Критерий про UI (decision-55 п. 7): метка `[ui]` в тексте требует скриншот проверки. */
export function isUiCriterion(text: string): boolean {
  return /\[ui\]/i.test(text ?? '');
}

export function verifyCriteria(
  criteria: CriterionInput[],
  report: AgentReport | null,
  minEvidenceChars = MIN_EVIDENCE_CHARS,
  /** Скриншоты проверок этой итерации (`iterationScreenshots`) — ссылки отчёта сверяются с ними. */
  screenshots: readonly IterationArtifact[] = []
): CriterionVerification[] {
  const byIndex = new Map<number, AgentReport['criteria'][number]>();
  for (const item of report?.criteria ?? []) {
    if (!byIndex.has(item.index)) byIndex.set(item.index, item);
  }

  return criteria.map((c, i) => {
    const index = i + 1;
    const item = byIndex.get(index);
    const ui = isUiCriterion(c.text);
    const resolved: CriterionScreenshot[] = [];
    const missing: string[] = [];
    for (const ref of item?.screenshots ?? []) {
      const r = resolveScreenshotRef(ref, screenshots);
      if (r.ok) resolved.push({ ref, checkId: r.match.checkId, name: r.match.artifact.name, relPath: r.match.artifact.relPath });
      else missing.push(r.error === 'ambiguous' ? `“${ref}” (${(r.candidates ?? []).join(', ')})` : `“${ref}”`);
    }
    const why = (code: AppErrorCode, params?: AppErrorParams): Pick<CriterionVerification, 'reason' | 'reasonKey'> => {
      const { text, key } = keyed(code, params);
      return { reason: text, reasonKey: key };
    };
    const base: CriterionVerification = {
      index,
      text: c.text,
      accepted: false,
      ...(item ? { reported: item.status, evidence: item.evidence } : {}),
      ...(ui ? { ui: true } : {}),
      ...(resolved.length > 0 ? { screenshots: resolved } : {})
    };
    if (c.completed) return { ...base, accepted: true, alreadyChecked: true, ...why('loop.criterionPreChecked') };
    if (!report) return { ...base, ...why('loop.criterionNoReport') };
    if (!item) return { ...base, ...why('loop.criterionNotReported') };
    if (item.status !== 'done') {
      return { ...base, ...why(item.status === 'blocked' ? 'loop.criterionBlocked' : 'loop.criterionNotDone') };
    }
    if (missing.length > 0) {
      return { ...base, ...why('loop.criterionScreenshotMissing', { refs: missing.join(', ') }) };
    }
    if (ui && resolved.length === 0) {
      return { ...base, ...why('loop.criterionUiNeedsScreenshot') };
    }
    // Найденный скриншот — evidence наравне с текстом (decision-55 п. 7).
    if (resolved.length === 0 && item.evidence.trim().length < minEvidenceChars) {
      return { ...base, ...why('loop.criterionNoEvidence') };
    }
    return { ...base, accepted: true };
  });
}

/** Проверки прошли: ни одна блокирующая не упала (пропущенные не мешают). */
export function checksPassed(checks: CheckRunResult[]): boolean {
  return checks.every((c) => !c.blocking || !isFailedStatus(c.status));
}

// ───────────────────────────── Машина состояний ─────────────────────────────

export interface DecideInput {
  /** Номер только что завершённой итерации (1-based). */
  iteration: number;
  maxIterations: number;
  /** Человек остановил сессию. */
  stopped: boolean;
  /** Статус слота агента по итогам хода. */
  agentStatus: string;
  agentError?: string;
  agentErrorKey?: AppErrorKey;
  checksPassed: boolean;
  allCriteriaAccepted: boolean;
  costUsd?: number;
  budgetUsd?: number;
}

export type DoneLoopDecision =
  | { action: 'finish' }
  | { action: 'retry' }
  | { action: 'fail'; outcome: Exclude<DoneLoopOutcome, 'success'>; reason: string; reasonKey?: AppErrorKey };

function failWith(outcome: Exclude<DoneLoopOutcome, 'success'>, code: AppErrorCode, params?: AppErrorParams): DoneLoopDecision {
  const { text, key } = keyed(code, params);
  return { action: 'fail', outcome, reason: text, reasonKey: key };
}

/** Ошибка хода агента: его собственный текст и код, без текста — общая причина. */
function agentFailure(input: DecideInput, outcome: 'budget' | 'agent_error', fallback: AppErrorCode): DoneLoopDecision {
  if (!input.agentError) return failWith(outcome, fallback);
  return { action: 'fail', outcome, reason: input.agentError, ...(input.agentErrorKey ? { reasonKey: input.agentErrorKey } : {}) };
}

/**
 * Переход после хода: `run → check → verify → finish | retry | fail`.
 * Порядок важен: остановка человеком сильнее всего; успешный ход завершает цикл даже на
 * границе бюджета или лимита (работа уже сделана и проверена); ошибка агента не повторяется
 * вслепую; дальше бюджет и лимит итераций.
 */
export function decideNext(input: DecideInput): DoneLoopDecision {
  if (input.stopped || input.agentStatus === 'stopped') {
    return failWith('stopped', 'loop.stoppedByHuman');
  }
  if (input.agentStatus === 'budget_exceeded') return agentFailure(input, 'budget', 'loop.agentBudgetStopped');
  if (input.agentStatus === 'failed') return agentFailure(input, 'agent_error', 'loop.agentTurnFailed');
  if (input.checksPassed && input.allCriteriaAccepted) return { action: 'finish' };

  const budget = input.budgetUsd;
  if (typeof budget === 'number' && budget > 0 && typeof input.costUsd === 'number' && input.costUsd >= budget) {
    return failWith('budget', 'loop.budgetExhausted', { budget: budget.toFixed(2), spent: input.costUsd.toFixed(2), n: input.iteration });
  }
  if (input.iteration >= input.maxIterations) {
    return failWith('iteration_limit', 'loop.iterationLimit', { max: input.maxIterations, summary: { code: failureSummary(input) } });
  }
  return { action: 'retry' };
}

function failureSummary(input: DecideInput): AppErrorCode {
  if (!input.checksPassed && !input.allCriteriaAccepted) return 'loop.goalChecksAndCriteria';
  if (!input.checksPassed) return 'loop.goalChecks';
  if (!input.allCriteriaAccepted) return 'loop.goalCriteria';
  return 'loop.goalNotReached';
}

// ───────────────────────────────── Промпты ─────────────────────────────────

/** Системная инструкция цикла — одинаковая для Claude CLI, Codex, Gemini и API-движка. */
export function buildDoneLoopInstructions(input: {
  taskId: string;
  criteria: CriterionInput[];
  checks: CheckDefinition[];
  maxIterations: number;
}): string {
  const criteriaLines = input.criteria.length
    ? input.criteria.map((c, i) => `${i + 1}. ${c.completed ? '[already checked] ' : ''}${c.text}`).join('\n')
    : '(the task has no checklist — follow its description)';
  const checkLines = input.checks.length
    ? input.checks.map((c) => `- ${c.name}: \`${c.command}\`${c.blocking === false ? ' (non-blocking)' : ''}`).join('\n')
    : '- (no checks are configured for the project)';
  const uiSmoke = input.checks.filter(isUiSmokeCheck);
  const hasUiCriteria = input.criteria.some((c) => !c.completed && isUiCriterion(c.text));

  return [
    '# “Until done” mode (ProjectHub Done-loop)',
    `You are working on task ${input.taskId} in a closed loop. After each of your turns ProjectHub ` +
      'commits the changes, runs the project checks and verifies the acceptance criteria against your report. ' +
      `If something does not add up, you get the errors and continue in the same session (at most ${input.maxIterations} turns).`,
    `## Acceptance criteria\n${criteriaLines}`,
    `## Checks ProjectHub runs after the turn\n${checkLines}`,
    '## Rules\n' +
      '- Do not tick criteria checkboxes and do not change `status` in the Backlog.md task file — only ProjectHub does that; such edits are reverted.\n' +
      '- Before the report, run the checks yourself if you can and fix the errors.\n' +
      '- Mark a criterion `done` only with specific evidence: file path and line, test name, command and its result. A criterion without evidence is not accepted.\n' +
      '- Honestly use `not_done` or `blocked` with an explanation — that is cheaper than another turn over a false `done`.',
    '## Report at the end of every turn\n' +
      `As the last block of your final message, print the report in a \`\`\`${REPORT_FENCE} fence:\n` +
      '```' + REPORT_FENCE + '\n' + REPORT_EXAMPLE + '\n```\n' +
      '`index` is the criterion number from the list above; give a line for every criterion that is not closed. ' +
      '`status`: `done` | `not_done` | `blocked`.',
    ...(uiSmoke.length > 0 ? [buildScreenshotEvidenceSection(uiSmoke)] : []),
    ...(hasUiCriteria && uiSmoke.length === 0
      ? [
          '## [ui] criteria\nCriteria tagged `[ui]` are accepted only with a screenshot of a `ui-smoke` check, and the project has ' +
            'no such check: report them as `blocked` and explain that a `ui-smoke` check in `.projecthub.json` is needed.'
        ]
      : [])
  ].join('\n\n');
}

/** Раздел инструкции о скриншотах как evidence — только если среди проверок есть `ui-smoke`. */
function buildScreenshotEvidenceSection(uiSmoke: CheckDefinition[]): string {
  const names = uiSmoke.map((c) => `\`${c.id}\``).join(', ');
  return (
    '## Screenshots as evidence\n' +
    `Checks ${names} save screenshots to the directory from the \`PROJECTHUB_ARTIFACTS_DIR\` environment variable ` +
    '(Playwright: `page.screenshot({ path: path.join(process.env.PROJECTHUB_ARTIFACTS_DIR, \'home.png\') })`). ' +
    'For a UI criterion, add the field `"screenshots": ["home.png"]` to its report line — the names of the files the test creates. ' +
    'ProjectHub matches them against the check artifacts of this iteration; a name that is not found means the criterion is not accepted. ' +
    'Criteria tagged `[ui]` are not accepted without a screenshot. Your own Playwright MCP snapshots are not evidence.'
  );
}

function tail(text: string, max: number): string {
  const value = text ?? '';
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}

/** Промпт повторного хода: что упало и какие критерии не засчитаны — с причинами. */
export function buildRetryPrompt(input: {
  iteration: number;
  maxIterations: number;
  checks: CheckRunResult[];
  criteria: CriterionVerification[];
  reportError?: string;
  tailChars?: number;
}): string {
  const tailChars = input.tailChars ?? RETRY_CHECK_TAIL_CHARS;
  const sections: string[] = [
    `[ProjectHub Done-loop] Iteration ${input.iteration} of ${input.maxIterations} was not accepted. Continue in the same working directory: ` +
      'fix what is listed below, do not start the task over.'
  ];

  const failed = input.checks.filter((c) => isFailedStatus(c.status));
  if (failed.length > 0) {
    const blocks = failed.map(
      (c) =>
        `### ${c.name} (\`${c.command}\`) — ${summarizeCheckResult(c)}${c.blocking ? '' : ', non-blocking'}\n` +
        '```text\n' +
        tail(c.outputTail || c.detail || '(no output)', tailChars) +
        '\n```'
    );
    sections.push(`## Failed checks\n${blocks.join('\n\n')}`);
  } else if (input.checks.length > 0) {
    sections.push('## Checks\nAll checks passed — do not break them.');
  }

  if (input.reportError) sections.push(`## Report\nThe report was not accepted: ${input.reportError}.`);

  const shots = iterationScreenshots(input.checks);
  if (shots.length > 0) {
    const lines = shots.slice(0, 40).map((s) => `- ${s.checkId}/${s.artifact.name}`);
    sections.push(`## Check screenshots of this iteration\nYou can refer to them in the \`screenshots\` field:\n${lines.join('\n')}`);
  }

  const open = input.criteria.filter((c) => !c.accepted);
  if (open.length > 0) {
    const lines = open.map((c) => `- #${c.index} ${c.text} — ${c.reason ?? 'not accepted'}${c.evidence ? ` (your evidence: “${tail(c.evidence, 300)}”)` : ''}`);
    sections.push(`## Open acceptance criteria\n${lines.join('\n')}`);
  }

  sections.push(`At the end of the turn, print the report in a \`\`\`${REPORT_FENCE}\`\`\` fence again for all open criteria.`);
  return sections.join('\n\n');
}

/** Подписи итога для журнала — по-английски; файл задачи получает их на языке хоста (`hostText`). */
export const OUTCOME_LABELS: Record<DoneLoopOutcome, string> = hostText('en').doneLoop.outcomes;

/** Итоговое резюме для секции `Final Summary` задачи. */
export function buildDoneLoopFinalSummary(input: {
  outcome: DoneLoopOutcome;
  iterations: number;
  maxIterations: number;
  /** Итераций в текущем отрезке цикла, если цикл продолжали после отката (decision-48 п. 2.3). */
  segmentIterations?: number;
  agentName: string;
  engine: string;
  criteria: CriterionVerification[];
  checks: CheckRunResult[];
  costUsd?: number;
  durationMs?: number;
  reportSummary?: string;
  branch?: string;
  commitHash?: string;
  /** Язык хоста (decision-161): файл задачи читает человек. */
  lang?: Language;
}): string {
  const lang = input.lang ?? 'en';
  const tx = hostText(lang).doneLoop;
  const labels = hostText(lang).appErrors;
  const lines: string[] = [];
  // Лимит действует на отрезок, а номера итераций сквозные: после продолжения показываем оба числа.
  const inSegment = input.segmentIterations;
  const count =
    inSegment !== undefined && inSegment !== input.iterations
      ? tx.iterationsAfterRewind(input.iterations, inSegment, input.maxIterations)
      : tx.iterations(input.iterations, input.maxIterations);
  lines.push(tx.headline(input.agentName, input.engine, tx.outcomes[input.outcome], count));
  if (input.reportSummary) lines.push('', input.reportSummary.trim());

  if (input.criteria.length > 0) {
    lines.push('', tx.criteriaHeader);
    for (const c of input.criteria) {
      const mark = c.accepted ? 'x' : ' ';
      const reason = (c.reasonKey && formatAppError(c.reasonKey, labels)) ?? c.reason ?? '';
      const note = c.alreadyChecked ? tx.preChecked : c.accepted ? c.evidence ?? '' : reason;
      // Только имена: пути userData машинозависимы, а файл задачи коммитится (decision-55 п. 7).
      const shots = c.accepted && c.screenshots?.length ? ` (${tx.screenshots(c.screenshots.map((s) => `${s.checkId}/${s.name}`).join(', '))})` : '';
      lines.push(`- [${mark}] #${c.index} ${c.text}${note ? ` — ${note.replace(/\s+/g, ' ').trim()}` : ''}${shots}`);
    }
  }

  if (input.checks.length > 0) {
    lines.push('', tx.checksHeader);
    for (const c of input.checks) lines.push(`- ${c.name} (\`${c.command}\`): ${summarizeCheckResult(c, lang)}`);
  } else {
    lines.push('', tx.checksNone);
  }

  const meta: string[] = [];
  meta.push(tx.cost(typeof input.costUsd === 'number' ? `$${input.costUsd.toFixed(4)}` : undefined));
  if (typeof input.durationMs === 'number') meta.push(tx.duration(Math.round(input.durationMs / 1000)));
  if (input.branch) meta.push(tx.branch(input.branch));
  if (input.commitHash) meta.push(tx.commit(input.commitHash.slice(0, 7)));
  lines.push('', tx.total(meta.join(', ')));
  return lines.join('\n');
}

// ───────────────────────────────── Настройки ─────────────────────────────────

/** Скрипты документации, которые done-loop добавляет к проверкам проекта, если они есть. */
const DOC_CHECK_SCRIPTS: Array<{ script: string; id: string; name: string }> = [
  { script: 'lint:docs', id: 'lint-docs', name: 'Docs lint' },
  { script: 'check-index', id: 'check-index', name: 'RAG index' }
];

export interface ResolveDoneLoopInput {
  /** Проверки проекта (секция `checks` или дефолты из `package.json`) — те же, что у арены. */
  projectChecks: CheckDefinition[];
  project?: DoneLoopProjectSettings;
  scripts?: Record<string, string>;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** Выбор пользователя в модалке запуска — сильнее настроек проекта. */
  overrides?: Partial<Pick<DoneLoopProjectSettings, 'maxIterations' | 'budgetUsd' | 'checkIds' | 'autoReview'>>;
}

function clampIterations(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_DONE_LOOP_ITERATIONS, Math.max(1, Math.trunc(value)));
}

function positiveOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Слияние: выбор в модалке → `.projecthub.json` → дефолты. Чистая функция — покрыта тестами. */
export function resolveDoneLoopSettings(input: ResolveDoneLoopInput): DoneLoopSettings {
  const project = input.project ?? {};
  const overrides = input.overrides ?? {};

  const checks = input.projectChecks.filter((c) => c.enabled !== false);
  if (project.docChecks !== false && input.scripts) {
    for (const doc of DOC_CHECK_SCRIPTS) {
      const command = input.scripts[doc.script];
      if (typeof command !== 'string' || !command.trim()) continue;
      if (checks.some((c) => c.id === doc.id || c.command.includes(doc.script))) continue;
      checks.push({
        id: doc.id,
        kind: 'custom',
        name: doc.name,
        command: scriptCommand(input.packageManager ?? 'npm', doc.script),
        timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
        blocking: true,
        enabled: true
      });
    }
  }

  const checkIds = overrides.checkIds ?? project.checkIds;
  const selected = Array.isArray(checkIds) ? checks.filter((c) => checkIds.includes(c.id)) : checks;

  return {
    maxIterations: clampIterations(overrides.maxIterations) ?? clampIterations(project.maxIterations) ?? DEFAULT_DONE_LOOP_MAX_ITERATIONS,
    ...(positiveOrUndefined(overrides.budgetUsd ?? project.budgetUsd) !== undefined
      ? { budgetUsd: positiveOrUndefined(overrides.budgetUsd ?? project.budgetUsd) }
      : {}),
    checks: selected,
    autoReview: (overrides.autoReview ?? project.autoReview) !== false
  };
}

/** Имя статуса «на ревью» из конфига проекта (TASK-68): регистр и пробелы не важны. */
export function findReviewStatus(statuses: string[] | undefined): string | undefined {
  return (statuses ?? []).find((s) => s.replace(/\s+/g, '').toLowerCase() === 'review');
}
