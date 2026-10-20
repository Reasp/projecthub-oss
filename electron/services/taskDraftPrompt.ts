/**
 * Черновик описания и критериев приёмки задачи (TASK-134.4, decision-99): промпт и разбор ответа.
 *
 * Модель выбирает назначение «Черновик описания задачи» (по умолчанию тир `cheap`, без тиров — основная
 * модель); сам вызов — в main-процессе. Чистый модуль без Electron — покрыт unit-тестами.
 */

export interface TaskDraftInput {
  title: string;
  /** Уже написанное описание — контекст, модель его не переписывает. */
  description?: string;
  /** Критерии, которые уже есть: модель не повторяет их. */
  existingCriteria?: string[];
  language: 'ru' | 'en';
}

export interface TaskDraft {
  description: string;
  criteria: string[];
}

export const TASK_DRAFT_MAX_CRITERIA = 6;
const MAX_FIELD = 4000;

export function buildTaskDraftPrompt(input: TaskDraftInput): string {
  const ru = input.language === 'ru';
  const lines = [
    ru
      ? 'Ты помогаешь разработчику оформить задачу. Напиши краткое техническое описание и 3–5 проверяемых критериев приёмки.'
      : 'You help a developer write up a task. Write a short technical description and 3–5 verifiable acceptance criteria.',
    ru
      ? 'Ответь только JSON без пояснений: {"description": "<описание>", "criteria": ["<критерий>", ...]}. Пиши по-русски.'
      : 'Reply with JSON only, no commentary: {"description": "<description>", "criteria": ["<criterion>", ...]}. Write in English.',
    '',
    `${ru ? 'Задача' : 'Task'}: ${input.title.trim().slice(0, 300)}`
  ];
  const description = input.description?.trim();
  if (description) lines.push('', `${ru ? 'Уже написанное описание' : 'Existing description'}:`, description.slice(0, MAX_FIELD));
  const existing = (input.existingCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (existing.length > 0) {
    lines.push('', ru ? 'Эти критерии уже есть, не повторяй их:' : 'These criteria already exist, do not repeat them:');
    for (const c of existing.slice(0, 20)) lines.push(`- ${c.slice(0, 300)}`);
  }
  return lines.join('\n');
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD) : '';
}

function fromJson(text: string): TaskDraft | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const criteria = Array.isArray(raw.criteria) ? raw.criteria.map(cleanText).filter(Boolean) : [];
    const description = cleanText(raw.description);
    return description || criteria.length > 0 ? { description, criteria } : null;
  } catch {
    return null;
  }
}

/** Запасной разбор: «Описание: …» и список «- [ ] …» / «- …» после «Критерии:». */
function fromLines(text: string): TaskDraft | null {
  let description = '';
  const criteria: string[] = [];
  let inCriteria = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(критерии|criteria|acceptance criteria)\s*:/i.test(trimmed)) {
      inCriteria = true;
      continue;
    }
    if (inCriteria) {
      const item = trimmed.match(/^(?:[-*]|\d+[.)])\s*(?:\[[ xX]?\]\s*)?(.+)$/);
      if (item) criteria.push(item[1].trim());
    } else if (/^(описание|description)\s*:/i.test(trimmed)) {
      description = trimmed.replace(/^(описание|description)\s*:\s*/i, '');
    } else if (trimmed && !trimmed.startsWith('```')) {
      description += (description ? '\n' : '') + trimmed;
    }
  }
  return criteria.length > 0 ? { description: description.slice(0, MAX_FIELD), criteria } : null;
}

/** Ответ модели → черновик. `null` — ответ не похож на черновик; выдумывать вместо него ничего не нужно. */
export function parseTaskDraft(text: string): TaskDraft | null {
  const draft = fromJson(text) ?? fromLines(text);
  if (!draft) return null;
  const seen = new Set<string>();
  const criteria = draft.criteria.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { description: draft.description, criteria: criteria.slice(0, TASK_DRAFT_MAX_CRITERIA) };
}
