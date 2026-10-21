import type { RemoteDocEntry } from '../../../src/types/remote';

/**
 * Чистые функции экрана документации (TASK-140.17): frontmatter, поиск, ссылки `[[…]]` и якоря заголовков.
 * Без React и DOM — покрыты unit-тестами.
 *
 * Без lookbehind в регулярных выражениях (Safari до 16.4 не разбирает бандл с ними), поэтому разбор ссылок
 * `src/utils/docRefs.ts` сюда не подключается.
 */

export interface DocFrontmatter {
  body: string;
  /** Скалярные поля frontmatter строками, без кавычек; списки и вложенные поля не разбираются. */
  fields: Record<string, string>;
}

/** Отделяет YAML frontmatter (`---` … `---` в начале файла) от тела документа. */
export function splitFrontmatter(text: string): DocFrontmatter {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { body: src, fields: {} };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (!value || value === '>-' || value === '|' || value === '>') continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[m[1]] = value;
  }
  return { body: src.slice(match[0].length), fields };
}

/**
 * Тело для показа: без frontmatter и без первого заголовка `# …`, если он повторяет название из шапки экрана.
 */
export function docBodyForDisplay(text: string, title?: string): string {
  const { body } = splitFrontmatter(text);
  const trimmed = body.replace(/^\s+/, '');
  const h1 = trimmed.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  if (h1 && title && h1[1].trim().toLowerCase() === title.trim().toLowerCase()) return trimmed.slice(h1[0].length);
  return trimmed;
}

/** Поиск по названию и id без учёта регистра; пустой запрос — все документы. */
export function filterDocs(docs: readonly RemoteDocEntry[], query: string): RemoteDocEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...docs];
  return docs.filter((d) => d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q));
}

/** Документ по id ссылки `[[decision-46]]`: регистр id не важен. */
export function findDocById(docs: readonly RemoteDocEntry[], id: string): RemoteDocEntry | null {
  const key = id.trim().toLowerCase();
  return docs.find((d) => d.id.toLowerCase() === key) ?? null;
}

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
