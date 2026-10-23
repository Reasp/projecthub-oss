import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import { AppError } from '../../src/lib/appError';
import type { DocItem, CreateDocParams, DocFileType, DecisionStatus, DocLinkIndex, ProjectGraph } from '../../src/types/electron';
import { normalizeSection, sectionFromRelativePath } from '../../src/utils/docTree';
import { buildDocLinkIndex, type DocLinkSource } from '../../src/utils/docBacklinks';
import { buildDocLinkGraph, type DocGraphSource } from '../../src/utils/docLinkGraph';
import { allocateBacklogId } from './backlogIdAllocator';

/**
 * YAML в frontmatter превращает незакавыченные значения вида `2026-09-03` в объекты Date,
 * а числа — в number. Рендерер ожидает строки (React падает на Date как child),
 * поэтому всё, что уходит в UI, приводим к строкам здесь.
 */
function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return String(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => toOptionalString(v)).filter((v): v is string => v !== undefined);
}

// ─── Формат Backlog.md (правило 13 CLAUDE.md) ────────────────────────────────
//
// backlog/docs/doc-<N> - <Title-Slug>.md
//   id: doc-<N>, title, type: guide|readme|specification|other, created_date: "YYYY-MM-DD HH:mm"
// backlog/decisions/decision-<N> - <Title-Slug>.md
//   id: decision-<N>, title, date: "YYYY-MM-DD HH:mm", status: accepted|proposed|rejected|deprecated

const DOC_FILE_TYPES: DocFileType[] = ['guide', 'readme', 'specification', 'other'];
const DECISION_STATUSES: DecisionStatus[] = ['accepted', 'proposed', 'rejected', 'deprecated'];

type DocCategory = DocItem['category'];

function idPrefix(category: DocCategory): 'doc' | 'decision' {
  return category === 'decision' ? 'decision' : 'doc';
}

/**
 * Slug для имени файла в стиле Backlog.md: регистр и кириллица сохраняются,
 * пробелы → `-`, запрещённые для файловой системы символы убираются.
 */
function titleSlug(text: string): string {
  const slug = text
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

/** Номер из id вида `doc-12` / `decision-3` (только для указанного префикса). */
function idNumber(value: unknown, prefix: 'doc' | 'decision'): number | null {
  const str = toOptionalString(value);
  if (!str) return null;
  const match = str.trim().match(new RegExp(`^${prefix}-(\\d+)$`, 'i'));
  return match ? parseInt(match[1], 10) : null;
}

/** Номер из имени файла `doc-12 - Title.md` / `decision-3 - Title.md`. */
function fileNameNumber(fileName: string, prefix: 'doc' | 'decision'): number | null {
  const match = fileName.match(new RegExp(`^${prefix}-(\\d+)(?:\\s|\\.|$)`, 'i'));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * id документа: из frontmatter, если он там есть; иначе из имени файла `doc-N - ...`;
 * иначе — старая схема `doc-<имя файла>`, чтобы файлы без id всё же попадали в список.
 */
function resolveDocId(data: Record<string, unknown>, fileName: string, category: DocCategory): string {
  const prefix = idPrefix(category);
  const fmId = toOptionalString(data.id)?.trim();
  if (fmId) return fmId;
  const num = fileNameNumber(fileName, prefix);
  if (num !== null) return `${prefix}-${num}`;
  return `${prefix}-${fileName}`;
}

async function collectMarkdownFiles(dir: string, maxDepth = 3): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string, depth: number) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push(fullPath);
      }
    }
  }
  await walk(dir, 0);
  return result;
}

/**
 * Следующий свободный номер: максимум по id из frontmatter и по номерам в именах файлов + 1.
 * Смотрим и на frontmatter, и на имя файла, чтобы не столкнуться ни с документами Backlog.md CLI,
 * ни с файлами, где id прописан только в одном из мест.
 */
async function nextFreeNumber(projectPath: string, dir: string, prefix: 'doc' | 'decision'): Promise<number> {
  const fromFrontmatter: string[] = [];
  if (existsSync(dir)) {
    for (const filePath of await collectMarkdownFiles(dir)) {
      const fromName = fileNameNumber(path.basename(filePath), prefix);
      if (fromName !== null) fromFrontmatter.push(`${prefix}-${fromName}`);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const fromFm = idNumber(matter(raw).data?.id, prefix);
        if (fromFm !== null) fromFrontmatter.push(`${prefix}-${fromFm}`);
      } catch {
        // битый frontmatter — номер берём только из имени файла
      }
    }
  }
  // Ветки репозитория и соседние worktree — общей выдачей номера (decision-76 п. 8).
  const id = await allocateBacklogId(projectPath, prefix, { extraTaken: fromFrontmatter });
  return parseInt(id.slice(prefix.length + 1), 10);
}

function normalizeDocFileType(value: unknown): DocFileType {
  const str = toOptionalString(value)?.trim().toLowerCase();
  return (DOC_FILE_TYPES as string[]).includes(str || '') ? (str as DocFileType) : 'other';
}

function normalizeDecisionStatus(value: unknown): DecisionStatus {
  const str = toOptionalString(value)?.trim().toLowerCase();
  return (DECISION_STATUSES as string[]).includes(str || '') ? (str as DecisionStatus) : 'accepted';
}

/** "YYYY-MM-DD HH:mm" в локальном времени — как пишет Backlog.md CLI. */
function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Скалярная строка YAML: всегда в двойных кавычках (правило 16 — даты и числа только строками). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlStringList(values: string[]): string {
  return `[${values.map((v) => yamlString(v)).join(', ')}]`;
}

async function readDocItem(
  filePath: string,
  projectRoot: string,
  category: DocCategory,
  categoryRoot: string
): Promise<DocItem> {
  const fileName = path.basename(filePath);
  const stat = await fs.stat(filePath);
  const raw = await fs.readFile(filePath, 'utf-8');
  let data: Record<string, unknown> = {};
  let content = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data ?? {};
    content = parsed.content;
  } catch (e) {
    console.error(`Frontmatter не парсится: ${filePath}`, e);
  }

  let title = toOptionalString(data.title);
  if (!title) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    title = h1Match ? h1Match[1].trim() : fileName.replace(/\.md$/i, '');
  }

  const status =
    category === 'decision'
      ? toOptionalString(data.status) || 'accepted'
      : toOptionalString(data.status);
  // У документов дата создания хранится в created_date, у решений — в date.
  const date = toOptionalString(data.date) ?? toOptionalString(data.created_date);

  return {
    id: resolveDocId(data, fileName, category),
    title,
    category,
    filePath,
    fileRelative: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
    tags: toStringList(data.tags),
    // Раздел дерева: поле `section` frontmatter, иначе вложенная папка (decision-68).
    section:
      normalizeSection(toOptionalString(data.section)) ??
      sectionFromRelativePath(path.relative(categoryRoot, filePath)),
    status,
    date,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size
  };
}

export async function listProjectDocs(projectPath: string): Promise<DocItem[]> {
  const items: DocItem[] = [];
  const normalizedProject = path.normalize(projectPath);

  const sources: Array<{ dir: string; category: DocCategory }> = [
    { dir: path.join(normalizedProject, 'backlog', 'decisions'), category: 'decision' },
    { dir: path.join(normalizedProject, 'backlog', 'docs'), category: 'doc' }
  ];

  for (const { dir, category } of sources) {
    if (!existsSync(dir)) continue;
    const files = await collectMarkdownFiles(dir);
    for (const filePath of files) {
      try {
        items.push(await readDocItem(filePath, normalizedProject, category, dir));
      } catch (e) {
        console.error(`Error reading ${category}:`, filePath, e);
      }
    }
  }

  return items.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Связи документации проекта (TASK-122, decision-69): обратные ссылки на решения и документы из
 * решений, документов, задач и фактов памяти, плюс заголовки документов для ссылок вида `[[decision-46#Decision]]`.
 * Задачи читаются из файлов целиком: ссылка может стоять в плане, заметках или итоге.
 */
export async function buildProjectDocLinkIndex(projectPath: string): Promise<DocLinkIndex> {
  return buildDocLinkIndex(await collectDocLinkSources(projectPath));
}

/**
 * Граф связей документации (TASK-175, decision-134) по тем же источникам, что и индекс обратных ссылок:
 * решения, документы, задачи из корня `backlog/tasks` и факты памяти.
 */
export async function buildProjectDocLinkGraph(projectPath: string): Promise<ProjectGraph> {
  return buildDocLinkGraph(await collectDocLinkSources(projectPath));
}

async function collectDocLinkSources(projectPath: string): Promise<DocGraphSource[]> {
  const normalizedProject = path.normalize(projectPath);
  const sources: DocGraphSource[] = [];

  const readSource = async (filePath: string, kind: DocLinkSource['kind'], categoryRoot?: string) => {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      let data: Record<string, unknown> = {};
      try {
        data = matter(raw).data ?? {};
      } catch {
        // битый frontmatter — id и заголовок берём из имени файла
      }
      const fileName = path.basename(filePath);
      const id =
        kind === 'task'
          ? toOptionalString(data.id)?.trim() || fileName.match(/^(task-\d+(?:\.\d+)*)/i)?.[1].toUpperCase()
          : kind === 'mem'
          ? toOptionalString(data.id)?.trim() || fileName.match(/^(mem-\d+)/i)?.[1].toLowerCase()
          : resolveDocId(data, fileName, kind);
      if (!id) return;
      const source: DocGraphSource = {
        id,
        kind,
        title: toOptionalString(data.title) || fileName.replace(/\.md$/i, ''),
        status: toOptionalString(data.status),
        content: raw,
        filePath: path.relative(normalizedProject, filePath).split(path.sep).join('/')
      };
      // Раздел дерева: поле `section` frontmatter, иначе вложенная папка (decision-68).
      const section =
        normalizeSection(toOptionalString(data.section)) ??
        (categoryRoot ? sectionFromRelativePath(path.relative(categoryRoot, filePath)) : undefined);
      if (section) source.section = section;
      const dependencies = toStringList(data.dependencies);
      if (dependencies.length > 0) source.dependencies = dependencies;
      sources.push(source);
    } catch (e) {
      console.error(`Error reading ${kind} for link index:`, filePath, e);
    }
  };

  const documentDirs: Array<{ dir: string; kind: DocLinkSource['kind'] }> = [
    { dir: path.join(normalizedProject, 'backlog', 'decisions'), kind: 'decision' },
    { dir: path.join(normalizedProject, 'backlog', 'docs'), kind: 'doc' }
  ];
  for (const { dir, kind } of documentDirs) {
    if (!existsSync(dir)) continue;
    for (const filePath of await collectMarkdownFiles(dir)) await readSource(filePath, kind, dir);
  }

  // Доска показывает только задачи из корня backlog/tasks — на остальные перейти нельзя.
  const tasksDir = path.join(normalizedProject, 'backlog', 'tasks');
  if (existsSync(tasksDir)) {
    for (const filePath of await collectMarkdownFiles(tasksDir, 0)) await readSource(filePath, 'task');
  }

  // Факты памяти проекта (decision-51, decision-70): один факт — один файл `mem-N - ….md`.
  const memoryDir = path.join(normalizedProject, 'backlog', 'memory');
  if (existsSync(memoryDir)) {
    for (const filePath of await collectMarkdownFiles(memoryDir, 0)) {
      if (/^mem-\d+/i.test(path.basename(filePath))) await readSource(filePath, 'mem');
    }
  }

  return sources;
}

export async function readDocFile(filePath: string): Promise<string> {
  const normalized = path.normalize(filePath);
  if (!existsSync(normalized)) {
    throw new AppError('docs.fileNotFound', { path: normalized });
  }
  return await fs.readFile(normalized, 'utf-8');
}

export async function saveDocFile(filePath: string, content: string): Promise<boolean> {
  const normalized = path.normalize(filePath);
  const parentDir = path.dirname(normalized);
  if (!existsSync(parentDir)) {
    await fs.mkdir(parentDir, { recursive: true });
  }
  await fs.writeFile(normalized, content, 'utf-8');
  return true;
}

function decisionTemplate(title: string): string {
  return `# ${title}

## Контекст и проблематика
Опишите контекст проблемы, технические ограничения и требования, которые привели к необходимости принятия этого архитектурного решения.

## Рассматриваемые варианты
1. **Вариант 1**: Плюсы и минусы
2. **Вариант 2**: Плюсы и минусы

## Принятое решение
Опишите выбранный подход и обоснование выбора.

## Последствия
### Положительные
-

### Отрицательные / Риски
-
`;
}

function docTemplate(title: string): string {
  return `# ${title}

## Обзор
Краткое описание назначения и содержания данного документа.

## Основные разделы
### 1. Введение
Описание архитектуры или процесса.

### 2. Спецификация
Детальные спецификации, схемы или примеры использования.
`;
}

/**
 * Тело из пользовательского content: если он уже содержит frontmatter, берём только тело,
 * а его frontmatter-поля (tags/status/type) учитываем как значения по умолчанию —
 * сам frontmatter всегда генерируется по стандарту Backlog.md, чтобы id и имя файла совпадали.
 */
function splitUserContent(content: string | undefined): { body?: string; data: Record<string, unknown> } {
  if (!content || !content.trim()) return { data: {} };
  try {
    const parsed = matter(content);
    return { body: parsed.content.replace(/^\r?\n/, ''), data: parsed.data ?? {} };
  } catch {
    return { body: content, data: {} };
  }
}

export async function createProjectDoc(
  projectPath: string,
  params: CreateDocParams
): Promise<DocItem> {
  const normalizedProject = path.normalize(projectPath);
  const category: DocCategory = params.type === 'decision' ? 'decision' : 'doc';
  const prefix = idPrefix(category);
  const cleanTitle = params.title.trim();
  if (!cleanTitle) {
    throw new AppError('docs.titleEmpty');
  }

  const targetDir = path.join(normalizedProject, 'backlog', category === 'decision' ? 'decisions' : 'docs');
  await fs.mkdir(targetDir, { recursive: true });

  // Номер выбираем непосредственно перед записью, чтобы не поймать гонку с CLI/другой сессией;
  // если файл с таким id уже успел появиться — берём следующий.
  let num = await nextFreeNumber(normalizedProject, targetDir, prefix);
  let id = `${prefix}-${num}`;
  let fullPath = path.join(targetDir, `${id} - ${titleSlug(cleanTitle)}.md`);
  while (existsSync(fullPath)) {
    num += 1;
    id = `${prefix}-${num}`;
    fullPath = path.join(targetDir, `${id} - ${titleSlug(cleanTitle)}.md`);
  }

  const rendered = renderNewDocFile(params, id);

  // 'wx' — не перезаписывать, если файл появился между проверкой и записью.
  await fs.writeFile(fullPath, rendered.content, { encoding: 'utf-8', flag: 'wx' });

  const stat = await fs.stat(fullPath);
  return {
    id,
    title: cleanTitle,
    category,
    filePath: fullPath,
    fileRelative: path.relative(normalizedProject, fullPath).replace(/\\/g, '/'),
    tags: rendered.tags,
    section: rendered.section,
    status: rendered.status,
    date: rendered.date,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size
  };
}

export interface RenderedDocFile {
  /** Имя файла `<id> - <Title-Slug>.md`. */
  fileName: string;
  /** Каталог относительно `backlog/`: `docs` или `decisions`. */
  dir: 'docs' | 'decisions';
  content: string;
  tags: string[];
  section?: string;
  status?: string;
  date: string;
}

/**
 * Файл нового документа или решения по стандарту Backlog.md с уже выданным `id`: frontmatter, шаблон тела,
 * имя файла. Без записи на диск — ветка документации (decision-151) кладёт его в свой коммит.
 */
export function renderNewDocFile(params: CreateDocParams, id: string): RenderedDocFile {
  const category: DocCategory = params.type === 'decision' ? 'decision' : 'doc';
  const cleanTitle = params.title.trim();
  if (!cleanTitle) throw new AppError('docs.titleEmpty');
  const user = splitUserContent(params.content);
  const tags = (params.tags && params.tags.length > 0 ? params.tags : toStringList(user.data.tags))
    .map((t) => t.trim())
    .filter(Boolean);

  const stamp = nowStamp();
  const lines: string[] = ['---'];
  let status: string | undefined;
  lines.push(`id: ${id}`);
  lines.push(`title: ${yamlString(cleanTitle)}`);
  if (category === 'decision') {
    status = normalizeDecisionStatus(params.status ?? user.data.status);
    lines.push(`date: ${yamlString(stamp)}`);
    lines.push(`status: ${status}`);
  } else {
    lines.push(`type: ${normalizeDocFileType(params.docType ?? user.data.type)}`);
    lines.push(`created_date: ${yamlString(stamp)}`);
  }
  if (tags.length > 0) lines.push(`tags: ${yamlStringList(tags)}`);
  const section = normalizeSection(params.section ?? toOptionalString(user.data.section));
  if (section) lines.push(`section: ${yamlString(section)}`);
  lines.push('---', '');

  const body = user.body ?? (category === 'decision' ? decisionTemplate(cleanTitle) : docTemplate(cleanTitle));
  return {
    fileName: `${id} - ${titleSlug(cleanTitle)}.md`,
    dir: category === 'decision' ? 'decisions' : 'docs',
    content: lines.join('\n') + '\n' + body,
    tags,
    section,
    status,
    date: stamp
  };
}

/** Документ из текста файла без чтения диска: для файлов ветки документации (decision-151). */
export function docItemFromContent(raw: string, fileRelative: string, projectRoot: string): DocItem {
  const rel = fileRelative.replace(/\\/g, '/');
  const category: DocCategory = rel.startsWith('backlog/decisions/') ? 'decision' : 'doc';
  const categoryRoot = category === 'decision' ? 'backlog/decisions' : 'backlog/docs';
  const fileName = path.posix.basename(rel);
  let data: Record<string, unknown> = {};
  let content = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data ?? {};
    content = parsed.content;
  } catch {
    // битый frontmatter — id и заголовок из имени файла
  }
  const h1 = content.match(/^#\s+(.+)$/m);
  return {
    id: resolveDocId(data, fileName, category),
    title: toOptionalString(data.title) || (h1 ? h1[1].trim() : fileName.replace(/\.md$/i, '')),
    category,
    filePath: path.join(projectRoot, ...rel.split('/')),
    fileRelative: rel,
    tags: toStringList(data.tags),
    section: normalizeSection(toOptionalString(data.section)) ?? sectionFromRelativePath(path.posix.relative(categoryRoot, rel)),
    status: category === 'decision' ? toOptionalString(data.status) || 'accepted' : toOptionalString(data.status),
    date: toOptionalString(data.date) ?? toOptionalString(data.created_date),
    updatedAt: new Date(0).toISOString(),
    size: Buffer.byteLength(raw, 'utf-8')
  };
}
