/**
 * Подпись части документа в ветках документации (TASK-202.11, [[decision-151]]): у служебных частей — начало
 * frontmatter, текст до первого заголовка, документ целиком — подпись из словаря по ключу части, у остальных —
 * имя поля или заголовок раздела из самого документа. Main кладёт в `label` английский запасной текст.
 *
 * Чистый модуль без React.
 */

export type DocSpecialPart = 'fm:' | 'body:' | 'file:';

export type DocSpecialPartLabels = Record<DocSpecialPart, string>;

export function docPartLabel(part: { key: string; label: string }, labels: DocSpecialPartLabels): string {
  return (labels as Record<string, string>)[part.key] ?? part.label;
}
