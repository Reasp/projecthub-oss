import type { RemoteDocEntry } from '../types/remote';

/**
 * Документация удалённого проекта — общая для телефона и ПК (TASK-140.17, TASK-229): frontmatter, поиск и
 * разделы по ответу `get_docs`. Без React и DOM.
 *
 * Без lookbehind в регулярных выражениях: модуль входит в бандл телефона, а Safari до 16.4 не разбирает их.
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

export interface RemoteDocSection {
  /** Раздел из поля `section` (decision-68); пустая строка — документы без раздела. */
  section: string;
  docs: RemoteDocEntry[];
}

function idNumber(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Разделы документации для списка на ПК: по алфавиту, документы без раздела — в конце. Внутри раздела — сначала
 * документы, потом решения, каждые по номеру.
 */
export function groupDocsBySection(docs: readonly RemoteDocEntry[]): RemoteDocSection[] {
  const sections = new Map<string, RemoteDocEntry[]>();
  for (const doc of docs) {
    const key = (doc.section || '').trim();
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(doc);
  }
  return [...sections.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([section, list]) => ({
      section,
      docs: [...list].sort((a, b) => (a.kind === b.kind ? idNumber(a.id) - idNumber(b.id) : a.kind === 'doc' ? -1 : 1))
    }));
}

/** Найденный объект ссылки `[[id]]` в удалённом проекте: название и статус для подсказки. */
export interface RemoteRefTarget {
  title: string;
  status?: string;
}

/**
 * Ссылка `[[id]]` документа удалённого проекта (TASK-229): документы и решения — по списку `get_docs`, задачи — по
 * `get_tasks`, факты памяти считаются существующими (их список телефону и ПК-клиенту не отдаётся).
 */
export function resolveRemoteRef(
  ref: { kind: 'decision' | 'doc' | 'task' | 'mem'; id: string },
  docs: readonly RemoteDocEntry[],
  tasks: ReadonlyArray<{ id: string; title: string; status: string }>
): RemoteRefTarget | null {
  if (ref.kind === 'mem') return { title: ref.id };
  if (ref.kind === 'task') {
    const key = ref.id.toLowerCase();
    const task = tasks.find((t) => t.id.toLowerCase() === key);
    return task ? { title: task.title, status: task.status } : null;
  }
  const doc = findDocById(docs, ref.id);
  return doc ? { title: doc.title, ...(doc.status ? { status: doc.status } : {}) } : null;
}
