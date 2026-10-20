/**
 * Черновик модели в карточке задачи (TASK-134.4): написанное человеком не затирается.
 *
 * Описание подставляется, только если его ещё нет; критерии добавляются к имеющимся без повторов.
 * Чистый модуль без React — покрыт unit-тестами.
 */

export interface DraftCriterion {
  text: string;
  completed: boolean;
}

export function mergeTaskDraft(
  current: { description: string; criteria: DraftCriterion[] },
  draft: { description: string; criteria: string[] }
): { description: string; criteria: DraftCriterion[]; added: number } {
  const description = current.description.trim() ? current.description : draft.description.trim();
  const seen = new Set(current.criteria.map((c) => c.text.trim().toLowerCase()));
  const added: DraftCriterion[] = [];
  for (const text of draft.criteria) {
    const clean = text.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    added.push({ text: clean, completed: false });
  }
  return { description, criteria: [...current.criteria, ...added], added: added.length };
}
