/**
 * Схема и нормализация плана роли `architect` (TASK-80, decision-49 п. 2).
 *
 * Чистый модуль без Electron и IO: разбор ответа модели (ограда ```projecthub-plan``` или
 * последний JSON-объект с `subtasks`), zod-валидация, нормализация ключей и зависимостей,
 * поиск циклов, детерминированная топологическая сортировка и текст замечаний для повторного
 * запроса. Создание подзадач, ветки и запуск — в `planService`; решения диспетчера —
 * в `planDispatcher`. Покрыт unit-тестами (`tests/unit/planSchema.test.ts`).
 */
import { z } from 'zod';
import { extractJsonObject } from './reviewerPrompt.js';
import type { AgentPlan, PlanSubtaskDraft } from './planTypes.js';

/** Язык ограды, в которой роль `architect` возвращает план. */
export const PLAN_FENCE = 'projecthub-plan';
/** Больше узлов человек всё равно не проверит, а диспетчер будет держать их часами. */
export const MAX_PLAN_NODES = 20;
export const MAX_NODE_DEPENDENCIES = 8;
/**
 * Заголовок длиннее даёт `ENAMETOOLONG` на Windows: имя файла задачи — это её заголовок,
 * а кириллица в UTF-8 занимает по два байта на символ.
 */
export const MAX_SUBTASK_TITLE = 110;
export const MAX_PLAN_ATTEMPTS = 3;

const TIERS = new Set(['cheap', 'balanced', 'frontier']);
const SIZES = new Set(['small', 'medium', 'large']);

/**
 * Ключ узла из произвольной строки модели: буквы (в том числе кириллица), цифры, дефис.
 * Буквы не латиницей сохраняются намеренно: ключ живёт только в памяти и в состоянии плана,
 * именем файла не становится, а модель, которую попросили отвечать по-русски, называет узлы
 * по-русски — выбросив кириллицу, мы потеряли бы вместе с ключами и все зависимости.
 */
export function planKey(value: unknown, fallback: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

function stringList(value: unknown, limit: number, maxLen = 500): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text) continue;
    const short = text.slice(0, maxLen);
    if (!out.includes(short)) out.push(short);
    if (out.length >= limit) break;
  }
  return out;
}

const SubtaskSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim().replace(/\s+/g, ' ') : '';
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    const tier = typeof r.modelTier === 'string' ? r.modelTier.trim().toLowerCase() : undefined;
    const size = typeof r.size === 'string' ? r.size.trim().toLowerCase() : undefined;
    return {
      key: planKey(r.key ?? r.id ?? title, ''),
      title,
      description,
      acceptanceCriteria: stringList(r.acceptanceCriteria ?? r.acceptance_criteria ?? r.criteria, 20),
      dependsOn: stringList(r.dependsOn ?? r.depends_on ?? r.dependencies, MAX_NODE_DEPENDENCIES, 40).map((d) => planKey(d, '')),
      ...(tier && TIERS.has(tier) ? { modelTier: tier } : {}),
      ...(size && SIZES.has(size) ? { size } : {}),
      labels: stringList(r.labels ?? r.tags, 8, 50)
    };
  },
  z.object({
    key: z.string().min(1, 'empty node key'),
    title: z.string().min(3, 'title is too short'),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    dependsOn: z.array(z.string()),
    modelTier: z.enum(['cheap', 'balanced', 'frontier']).optional(),
    size: z.enum(['small', 'medium', 'large']).optional(),
    labels: z.array(z.string())
  })
);

/** Схема плана: то же строение, что у отчёта done-loop, но со своим корнем. */
export const PlanSchema = z.object({
  summary: z.string().optional().default(''),
  subtasks: z.array(SubtaskSchema).min(1, 'the plan has no subtasks')
});

export const PLAN_EXAMPLE = `{
  "summary": "How the task is split and why, 2-4 sentences",
  "subtasks": [
    {
      "key": "parser",
      "title": "Config parsing: pure module and tests",
      "description": "### What to do\\nOne or two sentences about the point.\\n\\n### Where\\n- file or module\\n- second file",
      "acceptanceCriteria": ["Parsing is covered by unit tests", "An invalid config gives a clear error"],
      "dependsOn": [],
      "modelTier": "balanced",
      "size": "small"
    },
    {
      "key": "ui",
      "title": "Settings screen on top of the parsed config",
      "description": "What to do and in which files",
      "acceptanceCriteria": ["Config values are visible on the screen"],
      "dependsOn": ["parser"]
    }
  ]
}`;

/** Все сбалансированные JSON-объекты верхнего уровня в тексте. */
function jsonObjectsIn(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('{');
    if (start < 0) break;
    const obj = extractJsonObject(rest);
    if (!obj) {
      rest = rest.slice(start + 1);
      continue;
    }
    out.push(obj);
    rest = rest.slice(start + obj.length);
  }
  return out;
}

export type ParsedPlan = { ok: true; plan: AgentPlan; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Нормализация плана: ключи приводятся к слагам и дедуплицируются, заголовок обрезается по
 * `MAX_SUBTASK_TITLE` (остаток уходит в описание), самоссылки и ссылки на неизвестные ключи
 * из `dependsOn` снимаются, число узлов ограничивается. Всё, что пришлось поправить, попадает
 * в `warnings` — они показываются человеку, но план не отвергают.
 */
export function normalizePlan(plan: AgentPlan): { plan: AgentPlan; warnings: string[] } {
  const warnings: string[] = [];
  const subtasks: PlanSubtaskDraft[] = [];
  const used = new Set<string>();

  for (const [i, raw] of plan.subtasks.entries()) {
    if (subtasks.length >= MAX_PLAN_NODES) {
      warnings.push(`The plan has more than ${MAX_PLAN_NODES} subtasks — the extra ones were dropped`);
      break;
    }
    let key = planKey(raw.key, `node-${i + 1}`);
    if (used.has(key)) {
      const base = key;
      let n = 2;
      while (used.has(`${base}-${n}`)) n += 1;
      key = `${base}-${n}`;
      warnings.push(`Key "${base}" was repeated — renamed to "${key}"`);
    }
    used.add(key);

    let title = raw.title.trim().replace(/\s+/g, ' ');
    let description = raw.description.trim();
    if (title.length > MAX_SUBTASK_TITLE) {
      const cut = title.slice(0, MAX_SUBTASK_TITLE).trimEnd();
      description = description ? `${title}\n\n${description}` : title;
      warnings.push(`Title "${cut.slice(0, 40)}…" is longer than ${MAX_SUBTASK_TITLE} characters — cut, the full text is in the description`);
      title = cut;
    }

    subtasks.push({
      key,
      title,
      description,
      acceptanceCriteria: raw.acceptanceCriteria,
      dependsOn: raw.dependsOn,
      ...(raw.modelTier ? { modelTier: raw.modelTier } : {}),
      ...(raw.size ? { size: raw.size } : {}),
      ...(raw.labels && raw.labels.length > 0 ? { labels: raw.labels } : {})
    });
  }

  const known = new Set(subtasks.map((s) => s.key));
  for (const node of subtasks) {
    const deps: string[] = [];
    for (const dep of node.dependsOn) {
      if (dep === node.key) {
        warnings.push(`Subtask "${node.key}" depended on itself — the link was removed`);
        continue;
      }
      if (!known.has(dep)) {
        warnings.push(`Subtask "${node.key}" depended on unknown "${dep}" — the link was removed`);
        continue;
      }
      if (!deps.includes(dep)) deps.push(dep);
    }
    node.dependsOn = deps;
  }

  return { plan: { summary: plan.summary.trim(), subtasks }, warnings };
}

/** Первый найденный цикл зависимостей как список ключей (`a → b → a`); пусто, если циклов нет. */
export function findCycle(subtasks: PlanSubtaskDraft[]): string[] {
  const deps = new Map(subtasks.map((s) => [s.key, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (key: string): string[] => {
    const mark = state.get(key);
    if (mark === 'done') return [];
    if (mark === 'visiting') {
      const from = stack.indexOf(key);
      return [...stack.slice(from), key];
    }
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of deps.get(key) ?? []) {
      const cycle = walk(dep);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    state.set(key, 'done');
    return [];
  };

  for (const node of subtasks) {
    const cycle = walk(node.key);
    if (cycle.length > 0) return cycle;
  }
  return [];
}

/**
 * Детерминированная топологическая сортировка: по уровню (длина максимального пути от корня),
 * внутри уровня — в порядке ответа модели. Возвращает пустой массив, если в графе есть цикл.
 */
export function topoOrder(subtasks: PlanSubtaskDraft[]): string[] {
  if (findCycle(subtasks).length > 0) return [];
  const deps = new Map(subtasks.map((s) => [s.key, s.dependsOn]));
  const levels = new Map<string, number>();

  const level = (key: string): number => {
    const known = levels.get(key);
    if (known !== undefined) return known;
    const parents = deps.get(key) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(level)) + 1;
    levels.set(key, value);
    return value;
  };

  return subtasks
    .map((s, index) => ({ key: s.key, index, level: level(s.key) }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map((s) => s.key);
}

/**
 * Разбор плана из финального сообщения роли `architect`. Предпочтение — последней ограде
 * ```projecthub-plan```; без неё берётся последний JSON-объект с полем `subtasks` (модели
 * печатают по ходу рассуждений и другие JSON).
 */
export function parseAgentPlan(text: string): ParsedPlan {
  const source = text ?? '';
  const fenceRe = new RegExp('```\\s*' + PLAN_FENCE + '\\s*\\n([\\s\\S]*?)```', 'g');
  const fenced = [...source.matchAll(fenceRe)];

  let candidate: string | null;
  if (fenced.length > 0) {
    candidate = extractJsonObject(fenced[fenced.length - 1][1]);
    if (!candidate) return { ok: false, errors: [`The ${PLAN_FENCE} block contains no JSON object`] };
  } else {
    const objects = jsonObjectsIn(source).filter((o) => /"subtasks"\s*:/.test(o));
    candidate = objects.length > 0 ? objects[objects.length - 1] : null;
  }
  if (!candidate) return { ok: false, errors: [`The answer has no plan (a \`\`\`${PLAN_FENCE}\`\`\` block with the subtasks field)`] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, errors: [`The plan JSON could not be parsed: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.slice(0, 5).map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'plan';
      return `${where} — ${issue.message}`;
    });
    return { ok: false, errors };
  }

  const { plan, warnings } = normalizePlan(result.data);
  if (plan.subtasks.length === 0) return { ok: false, errors: ['No subtasks left in the plan after normalization'] };

  const cycle = findCycle(plan.subtasks);
  if (cycle.length > 0) {
    return { ok: false, errors: [`The dependencies form a cycle: ${cycle.join(' → ')}. Dependencies must only point forward.`] };
  }

  return { ok: true, plan, warnings };
}

/** Замечания к неудачной попытке — текст, который уходит модели в повторном запросе. */
export function planRetryPrompt(errors: string[], attempt: number, maxAttempts = MAX_PLAN_ATTEMPTS): string {
  return [
    `The plan was not accepted (attempt ${attempt} of ${maxAttempts}). Remarks:`,
    ...errors.map((e) => `- ${e}`),
    '',
    `Send the plan again: one \`\`\`${PLAN_FENCE}\`\`\` block with JSON in the same schema and no text after it.`
  ].join('\n');
}

/** Инструкция роли `architect`: что вернуть и по каким правилам разбивать. */
export function buildPlanInstructions(taskId: string, criteria: string[]): string {
  const acLines = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return [
    '## How to make the plan',
    `Split task ${taskId} into subtasks that different agents will do in parallel in separate git worktrees.`,
    'Do not implement anything and do not change files: your result is only the plan.',
    '',
    'Splitting rules:',
    `- From 2 to ${MAX_PLAN_NODES} subtasks. If the task cannot be split, return one subtask.`,
    '- Subtasks that do not depend on each other must touch different files: they run at the same time and are merged into one branch, shared files will conflict.',
    '- Add a dependency only if a subtask really cannot start without the result of another.',
    `- Title — up to ${MAX_SUBTASK_TITLE} characters, in the language of the parent task, without numbers or prefixes.`,
    '- Every subtask has verifiable acceptance criteria: what exactly must work.',
    '- The subtask description is Markdown, not one long line: short sections with `###` headings (what to do, where, why), lists for enumerations. Write line breaks inside a JSON string as `\\n`.',
    '- Put pure modules and tests into subtasks separate from integration and UI.',
    '',
    criteria.length > 0 ? `Acceptance criteria of the parent task — the plan as a whole must cover them:\n${acLines}\n` : null,
    '## Answer format',
    // Живой прогон на qwen2.5:7b-instruct показал, что модель переносит в ответ критерии из
    // примера дословно, поэтому пример отдельно помечен как образец формата.
    `As the last block of the message return a \`\`\`${PLAN_FENCE}\`\`\` fence with JSON. The example below shows only the structure — do not copy its texts, all content must be about this task:`,
    '```' + PLAN_FENCE,
    PLAN_EXAMPLE,
    '```',
    'The `dependsOn` field contains only keys of subtasks from this plan. There must be no cycles.'
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
