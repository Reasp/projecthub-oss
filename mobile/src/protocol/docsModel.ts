/**
 * Чистые функции экрана документации (TASK-140.17): frontmatter, поиск, ссылки `[[…]]` и якоря заголовков.
 * Без React и DOM — покрыты unit-тестами.
 *
 * Без lookbehind в регулярных выражениях (Safari до 16.4 не разбирает бандл с ними), поэтому разбор ссылок
 * `src/utils/docRefs.ts` сюда не подключается.
 */

// frontmatter, поиск и поиск по id общие с ПК (TASK-229) — в src/utils/remoteDocs.ts.
export { splitFrontmatter, docBodyForDisplay, filterDocs, findDocById, type DocFrontmatter } from '../../../src/utils/remoteDocs';

/**
 * Ключ заголовка для сравнения с якорем `[[decision-46#Decision]]`: регистр, знаки препинания и разметка не важны —
 * как `headingAnchorKey` на ПК (decision-69).
 */
export function headingKey(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Ссылка документации внутри приложения — только на документы и решения; задачи и память здесь не открываются. */
export function isDocRefOpenable(id: string): boolean {
  return /^(doc|decision)-\d+(?:\.\d+)*$/i.test(id.trim());
}
