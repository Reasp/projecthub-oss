/**
 * Замечания к плану роли `architect` (TASK-231.1): код и параметры. Модель получает английский текст (`planIssueText(…,
 * 'en')` в повторном запросе), окно — текст на своём языке по тому же коду. Чистый модуль: его берут и main
 * (`planSchema`), и рендерер (`PlanPanel`).
 */
import type { Language } from './types';

export type PlanIssueCode =
  | 'fenceNoJson'
  | 'noPlan'
  | 'badJson'
  | 'schemaEmptyKey'
  | 'schemaTitleShort'
  | 'schemaNoSubtasks'
  | 'schema'
  | 'emptyAfterNormalize'
  | 'cycle';

export interface PlanIssue {
  code: PlanIssueCode;
  params?: Record<string, string>;
}

type Texts = Record<PlanIssueCode, (p: Record<string, string>) => string>;

const en: Texts = {
  fenceNoJson: (p) => `The ${p.fence} block contains no JSON object`,
  noPlan: (p) => `The answer has no plan (a \`\`\`${p.fence}\`\`\` block with the subtasks field)`,
  badJson: (p) => `The plan JSON could not be parsed: ${p.reason}`,
  schemaEmptyKey: (p) => `${p.where} — empty node key`,
  schemaTitleShort: (p) => `${p.where} — title is too short`,
  schemaNoSubtasks: (p) => `${p.where} — the plan has no subtasks`,
  schema: (p) => `${p.where} — ${p.message}`,
  emptyAfterNormalize: () => 'No subtasks left in the plan after normalization',
  cycle: (p) => `The dependencies form a cycle: ${p.cycle}. Dependencies must only point forward.`
};

const ru: Texts = {
  fenceNoJson: (p) => `В блоке ${p.fence} нет JSON-объекта`,
  noPlan: (p) => `В ответе нет плана (блока \`\`\`${p.fence}\`\`\` с полем subtasks)`,
  badJson: (p) => `Не удалось разобрать JSON плана: ${p.reason}`,
  schemaEmptyKey: (p) => `${p.where} — пустой ключ узла`,
  schemaTitleShort: (p) => `${p.where} — слишком короткий заголовок`,
  schemaNoSubtasks: (p) => `${p.where} — в плане нет подзадач`,
  schema: (p) => `${p.where} — ${p.message}`,
  emptyAfterNormalize: () => 'После нормализации в плане не осталось подзадач',
  cycle: (p) => `Зависимости образуют цикл: ${p.cycle}. Зависимости должны вести только вперёд.`
};

const TEXTS: Record<Language, Texts> = { en, ru };

export function planIssueText(issue: PlanIssue, language: Language): string {
  const texts = TEXTS[language] ?? en;
  const format = Object.hasOwn(texts, issue.code) ? texts[issue.code] : undefined;
  return format ? format(issue.params ?? {}) : issue.code;
}
