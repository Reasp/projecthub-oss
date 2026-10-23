/**
 * Промпт и разбор ответа LLM-ревьюера Swarm Arena (decision-12 п.3, TASK-61).
 *
 * Ревьюер — обычная роль реестра (`reviewer`), а не встроенная магия: сюда приходят задача,
 * критерии приёмки, дифф кандидата и результаты проверок, обратно — структурированный вердикт.
 * Ответ модели разбирается толерантно: JSON может приехать в ```-ограде, с текстом до и после,
 * с лишними полями или с частично неверными типами — ничего из этого не должно ронять судью.
 *
 * Чистый модуль без Electron и IO — покрыт unit-тестами.
 */
import type {
  CheckRunResult,
  CriterionVerdict,
  ReviewSeverity,
  ReviewerCriterionVerdict,
  ReviewerFinding
} from './arenaTypes.js';
import { summarizeCheckResult } from './arenaChecks.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';
import { keyedText, type AppErrorKey, type AppErrorParams } from '../../src/lib/appError.js';

/** Сколько символов диффа уходит в промпт ревьюера. */
export const REVIEWER_DIFF_MAX_CHARS = 60_000;

export interface ReviewerPromptInput {
  taskId?: string;
  taskTitle?: string;
  /** Исходная формулировка задачи для агентов. */
  prompt: string;
  /** Критерии приёмки задачи (Backlog.md), 1-based порядок сохраняется. */
  criteria: string[];
  agentName: string;
  agentRole?: string;
  diffPatch: string;
  diffSummary?: { filesChanged: number; insertions: number; deletions: number };
  checks: CheckRunResult[];
  diffMaxChars?: number;
  /** Секреты и изменения зависимостей по данным ProjectHub (decision-56 п. 6) — без значений секретов. */
  securitySummary?: string;
}

function truncateDiff(patch: string, maxChars: number): { text: string; truncated: boolean } {
  const value = patch ?? '';
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/** Схема ответа: описывается в промпте явно, чтобы парсер не гадал. */
export const REVIEWER_RESPONSE_SCHEMA = `{
  "summary": "2-4 sentences: what the candidate did and whether the result is good enough",
  "overall": 0.0,
  "criteria": [{ "index": 1, "verdict": "met|partial|unmet|unknown", "comment": "why" }],
  "findings": [{ "file": "path/file.ts", "line": 42, "severity": "critical|major|minor|info", "message": "finding" }],
  "risks": ["risk 1", "risk 2"]
}`;

/** Промпт ревьюера по одному кандидату. */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const { text: diff, truncated } = truncateDiff(input.diffPatch, input.diffMaxChars ?? REVIEWER_DIFF_MAX_CHARS);
  const sections: string[] = [];

  sections.push(
    'You are a reviewer in the ProjectHub agent arena. Evaluate one candidate solution of the task and return strictly JSON ' +
      'following the schema below — no explanations before or after, no markdown fence.'
  );

  const taskHeader = [input.taskId, input.taskTitle].filter(Boolean).join(' — ');
  sections.push(`## Task\n${taskHeader || '(not linked to a Backlog.md task)'}\n\n${input.prompt}`);

  if (input.criteria.length > 0) {
    const lines = input.criteria.map((text, i) => `${i + 1}. ${text}`).join('\n');
    sections.push(`## Acceptance criteria\n${lines}`);
  } else {
    sections.push('## Acceptance criteria\nThe task has no criteria checklist — evaluate against the task statement.');
  }

  sections.push(`## Candidate\n${input.agentName}${input.agentRole ? ` (role: ${input.agentRole})` : ''}`);

  if (input.checks.length > 0) {
    const lines = input.checks
      .map((c) => `- ${c.name} (${c.kind}${c.blocking ? ', blocking' : ''}): ${summarizeCheckResult(c)}`)
      .join('\n');
    sections.push(`## Check results in the candidate worktree\n${lines}`);
  }

  if (input.securitySummary) {
    sections.push(`## Diff security (ProjectHub check)\n${input.securitySummary}`);
  }

  const summary = input.diffSummary
    ? `Files: ${input.diffSummary.filesChanged}, +${input.diffSummary.insertions} / -${input.diffSummary.deletions}\n\n`
    : '';
  sections.push(
    `## Candidate diff\n${summary}${diff ? `\`\`\`diff\n${diff}\n\`\`\`` : '(empty — the candidate did not change files)'}` +
      (truncated ? '\n\n[the diff is truncated for the prompt; evaluate the shown part]' : '')
  );

  sections.push(
    '## Response format\n' +
      'Return one JSON object:\n' +
      REVIEWER_RESPONSE_SCHEMA +
      '\n\n`overall` is a number 0..1: how ready the result is to merge. `index` in `criteria` is the number ' +
      'of the acceptance criterion from the list above; give a verdict for each. `findings` are specific remarks with ' +
      'a file and, if possible, a line. Do not suggest code edits, do not change files.'
  );

  return sections.join('\n\n');
}

const SEVERITIES: ReviewSeverity[] = ['info', 'minor', 'major', 'critical'];
const VERDICTS: CriterionVerdict[] = ['met', 'partial', 'unmet', 'unknown'];

function toSeverity(value: unknown): ReviewSeverity {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return (SEVERITIES as string[]).includes(v) ? (v as ReviewSeverity) : 'minor';
}

function toVerdict(value: unknown): CriterionVerdict {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if ((VERDICTS as string[]).includes(v)) return v as CriterionVerdict;
  if (v === 'yes' || v === 'pass' || v === 'passed' || v === 'true') return 'met';
  if (v === 'no' || v === 'fail' || v === 'failed' || v === 'false') return 'unmet';
  return 'unknown';
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Первый сбалансированный JSON-объект в тексте: модели любят обрамлять ответ пояснениями или
 * ```json-оградой. Строковые литералы и экранирование учитываются, чтобы `}` внутри строки
 * не обрывал объект раньше времени.
 */
export function extractJsonObject(text: string): string | null {
  const source = text ?? '';
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export interface ParsedReviewerResponse {
  ok: boolean;
  summary?: string;
  overall?: number;
  criteria: ReviewerCriterionVerdict[];
  findings: ReviewerFinding[];
  risks: string[];
  /** Причина, по которой структуру достать не удалось (ответ показывается пользователю как есть). */
  parseError?: string;
  /** Код причины (decision-165). */
  parseErrorKey?: AppErrorKey;
}

/**
 * Разбор ответа ревьюера. `criteria` из аргумента задают тексты и полный набор индексов:
 * критерий, о котором модель промолчала, получает вердикт `unknown`, а не выпадает из оценки.
 */
export function parseReviewerResponse(raw: string, criteria: string[] = []): ParsedReviewerResponse {
  const empty: ParsedReviewerResponse = { ok: false, criteria: [], findings: [], risks: [] };
  const json = extractJsonObject(raw ?? '');
  const failure = (code: AppErrorCode, params?: AppErrorParams): ParsedReviewerResponse => {
    const { text, key } = keyedText(code, params);
    return { ...empty, parseError: text, parseErrorKey: key };
  };
  if (!json) return failure('judge.reviewNoJson');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return failure('judge.reviewBadJson', { detail: err instanceof Error ? err.message : String(err) });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('judge.reviewNotObject');
  }
  const obj = parsed as Record<string, unknown>;

  const byIndex = new Map<number, { verdict: CriterionVerdict; comment?: string }>();
  if (Array.isArray(obj.criteria)) {
    for (const item of obj.criteria) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const index = typeof r.index === 'number' && Number.isInteger(r.index) ? r.index : Number.parseInt(String(r.index), 10);
      if (!Number.isInteger(index) || index < 1) continue;
      byIndex.set(index, { verdict: toVerdict(r.verdict), comment: toStringOrUndefined(r.comment) });
    }
  }

  const criteriaOut: ReviewerCriterionVerdict[] = criteria.length
    ? criteria.map((text, i) => {
        const found = byIndex.get(i + 1);
        return {
          index: i + 1,
          text,
          verdict: found?.verdict ?? 'unknown',
          ...(found?.comment ? { comment: found.comment } : {})
        };
      })
    : [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, value]) => ({
          index,
          text: `Criterion ${index}`,
          verdict: value.verdict,
          ...(value.comment ? { comment: value.comment } : {})
        }));

  const findings: ReviewerFinding[] = Array.isArray(obj.findings)
    ? obj.findings
        .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
        .map((f) => {
          const line = typeof f.line === 'number' && Number.isFinite(f.line) ? Math.trunc(f.line) : undefined;
          return {
            ...(toStringOrUndefined(f.file) ? { file: toStringOrUndefined(f.file) as string } : {}),
            ...(line !== undefined && line > 0 ? { line } : {}),
            severity: toSeverity(f.severity),
            message: toStringOrUndefined(f.message) ?? toStringOrUndefined(f.text) ?? ''
          };
        })
        .filter((f) => f.message.length > 0)
    : [];

  const risks: string[] = Array.isArray(obj.risks)
    ? obj.risks.map((r) => toStringOrUndefined(r)).filter((r): r is string => Boolean(r))
    : [];

  const overallRaw = obj.overall;
  let overall: number | undefined;
  if (typeof overallRaw === 'number' && Number.isFinite(overallRaw)) {
    // Модели иногда отвечают по стобалльной или десятибалльной шкале — приводим к 0..1.
    overall = overallRaw > 1 ? overallRaw / (overallRaw > 10 ? 100 : 10) : overallRaw;
    overall = Math.min(1, Math.max(0, overall));
  }

  return {
    ok: true,
    summary: toStringOrUndefined(obj.summary),
    ...(overall !== undefined ? { overall } : {}),
    criteria: criteriaOut,
    findings,
    risks
  };
}
