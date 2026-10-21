import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { listProjectDocs } from './docsService';
import type { RemoteDocContent, RemoteDocEntry } from '../../src/types/remote';

/**
 * Документация проекта для телефона (TASK-140.17): лёгкий список документов и решений с хэшем содержимого и чтение
 * одного документа со сверкой версии. Frontmatter разбирает `listProjectDocs` (строки через `toOptionalString`,
 * правило 16) — здесь только хэш, проверка пути и ответ «не изменился» без текста.
 */

/** Документы в `backlog/` — Markdown; больше этого с телефона не читаем (в кэш телефона он всё равно не влез бы). */
export const REMOTE_DOC_MAX_BYTES = 2 * 1024 * 1024;

const DOC_ROOTS = ['backlog/docs/', 'backlog/decisions/'];

/**
 * Хэш содержимого файла: sha256 байтов, первые 32 hex-символа (128 бит). Сравнивается только на равенство — версия
 * у телефона и на ПК, — для этого длины хватает с запасом, а список из сотен документов остаётся лёгким.
 */
export function docContentHash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

interface HashRecord {
  mtime: string;
  size: number;
  hash: string;
}

/**
 * Хэши по пути файла, пока не изменились время записи и размер. Список читается при каждом открытии вкладки на
 * телефоне: без запоминания каждый раз хэшировались бы все файлы. Чтение документа (`get_doc`) хэширует файл заново
 * всегда — сверка версии опирается на него, а не на запомненный хэш.
 */
export class DocHashCache {
  private readonly records = new Map<string, HashRecord>();

  constructor(private readonly maxEntries = 5000) {}

  get(filePath: string, mtime: string, size: number): string | null {
    const rec = this.records.get(filePath);
    return rec && rec.mtime === mtime && rec.size === size ? rec.hash : null;
  }

  set(filePath: string, mtime: string, size: number, hash: string): void {
    this.records.delete(filePath);
    this.records.set(filePath, { mtime, size, hash });
    // Map хранит порядок вставки: самый старый — первый.
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  get size(): number {
    return this.records.size;
  }
}

const defaultHashCache = new DocHashCache();

/** Список документов и решений проекта без текстов: раздел, путь от корня проекта и хэш содержимого. */
export async function listRemoteDocs(projectPath: string, cache: DocHashCache = defaultHashCache): Promise<RemoteDocEntry[]> {
  const items = await listProjectDocs(projectPath);
  const entries: RemoteDocEntry[] = [];
  for (const item of items) {
    const mtime = item.updatedAt ?? '';
    let hash = mtime ? cache.get(item.filePath, mtime, item.size) : null;
    if (!hash) {
      try {
        hash = docContentHash(await fs.readFile(item.filePath));
      } catch {
        continue; // файл удалили между чтением списка и хэшем
      }
      if (mtime) cache.set(item.filePath, mtime, item.size, hash);
    }
    entries.push({
      kind: item.category === 'decision' ? 'decision' : 'doc',
      id: item.id,
      title: item.title,
      ...(item.section ? { section: item.section } : {}),
      path: item.fileRelative,
      hash,
      size: item.size,
      ...(item.date ? { date: item.date } : {}),
      ...(item.status ? { status: item.status } : {})
    });
  }
  return entries;
}

/** Путь от телефона не принят: вне `backlog/docs`/`backlog/decisions`, не `.md` или выход наверх. */
export class RemoteDocPathError extends Error {}

function inside(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Путь документа из запроса телефона → абсолютный путь в проекте. Принимается только относительный путь
 * `backlog/docs/…` или `backlog/decisions/…` к `.md` без `..` и `.` — так же, как его отдаёт `get_docs`.
 */
export function resolveRemoteDocPath(projectPath: string, raw: unknown): { relative: string; absolute: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || raw.includes('\0')) {
    throw new RemoteDocPathError('Путь документа не задан');
  }
  const relative = raw.trim().replace(/\\/g, '/');
  const segments = relative.split('/');
  if (
    path.isAbsolute(relative) ||
    path.posix.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    segments.some((s) => s === '' || s === '.' || s === '..') ||
    !DOC_ROOTS.some((root) => relative.toLowerCase().startsWith(root)) ||
    !relative.toLowerCase().endsWith('.md')
  ) {
    throw new RemoteDocPathError('Документ должен быть .md в backlog/docs или backlog/decisions проекта');
  }
  const root = path.resolve(projectPath);
  const absolute = path.resolve(root, ...segments);
  if (!inside(path.join(root, 'backlog'), absolute)) {
    throw new RemoteDocPathError('Документ должен быть .md в backlog/docs или backlog/decisions проекта');
  }
  return { relative, absolute };
}

/**
 * Один документ со сверкой версии: `knownHash` совпал с хэшем файла — ответ без текста (`unchanged`), иначе текст
 * целиком (с frontmatter: телефон показывает его шапкой) и новый хэш.
 */
export async function readRemoteDoc(
  projectPath: string,
  rawPath: unknown,
  knownHash?: unknown,
  cache: DocHashCache = defaultHashCache
): Promise<RemoteDocContent> {
  const { relative, absolute } = resolveRemoteDocPath(projectPath, rawPath);
  let real: string;
  let stat;
  try {
    real = await fs.realpath(absolute);
    stat = await fs.stat(real);
  } catch {
    throw new Error(`Документ не найден: ${relative}`);
  }
  // Ссылка (symlink/junction) внутри backlog не должна вывести за его пределы.
  const realBacklog = await fs.realpath(path.join(path.resolve(projectPath), 'backlog'));
  if (!inside(realBacklog, real)) throw new RemoteDocPathError('Документ ведёт за пределы backlog проекта');
  if (!stat.isFile()) throw new Error(`Документ не найден: ${relative}`);
  if (stat.size > REMOTE_DOC_MAX_BYTES) throw new Error(`Документ больше ${REMOTE_DOC_MAX_BYTES / 1024 / 1024} МБ — откройте его на ПК`);

  const bytes = await fs.readFile(real);
  const hash = docContentHash(bytes);
  cache.set(absolute, stat.mtime.toISOString(), stat.size, hash);
  if (typeof knownHash === 'string' && knownHash === hash) return { path: relative, hash, unchanged: true };
  return { path: relative, hash, content: bytes.toString('utf-8'), size: bytes.length };
}
