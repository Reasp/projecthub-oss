import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { rankFuzzy } from '../../src/lib/composerCompletion.js';

const execFileAsync = promisify(execFile);

/**
 * Файлы рабочего каталога вкладки для `@` в поле ввода Agents Studio (TASK-300, decision-214). Только имена, без чтения
 * содержимого. В git-репозитории — `git ls-files` (отслеживаемые и новые, без игнорируемых по `.gitignore`), вне его —
 * обход каталога без тяжёлых служебных папок. Список кэшируется на {@link CACHE_MS}: набор символов не перечитывает
 * диск, а свежий файл появится через несколько секунд.
 */

export const MAX_INDEX_FILES = 50_000;
const CACHE_MS = 20_000;
const MAX_WALK_DEPTH = 12;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'release', '.next', 'target', '.venv', 'venv', '__pycache__', '.cache']);

export interface FileIndexEntry {
  /** Путь от рабочего каталога через `/`; у каталога — с `/` на конце. */
  path: string;
  dir: boolean;
}

interface CacheItem {
  at: number;
  entries: Promise<FileIndexEntry[]>;
}

const cache = new Map<string, CacheItem>();

async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z'], {
      cwd,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024
    });
    return stdout.split('\0').filter(Boolean).slice(0, MAX_INDEX_FILES);
  } catch {
    return null;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  while (queue.length && files.length < MAX_INDEX_FILES) {
    const dir = queue.shift()!;
    const items = await fs.readdir(dir.abs, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const rel = dir.rel ? `${dir.rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name) && dir.depth < MAX_WALK_DEPTH) queue.push({ abs: path.join(dir.abs, item.name), rel, depth: dir.depth + 1 });
      } else if (item.isFile()) {
        files.push(rel);
        if (files.length >= MAX_INDEX_FILES) break;
      }
    }
  }
  return files;
}

/** Файлы и каталоги (из путей файлов); каталоги идут первыми — так их видно при пустом запросе. */
export function indexEntries(files: readonly string[]): FileIndexEntry[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let i = file.indexOf('/');
    while (i > 0) {
      dirs.add(`${file.slice(0, i)}/`);
      i = file.indexOf('/', i + 1);
    }
  }
  return [...[...dirs].sort().map((p) => ({ path: p, dir: true })), ...files.map((p) => ({ path: p, dir: false }))];
}

export function projectFileEntries(cwd: string, now = Date.now()): Promise<FileIndexEntry[]> {
  const key = path.resolve(cwd);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.entries;
  const entries = (async () => indexEntries(((await gitFiles(key)) ?? (await walkFiles(key))).map((f) => f.replace(/\\/g, '/'))))();
  cache.set(key, { at: now, entries });
  entries.catch(() => cache.delete(key));
  return entries;
}

/** Каталог, в котором показывать содержимое: запрос `src/comp` — содержимое `src/`; пустой — верхний уровень. */
function browseDir(query: string): string {
  const i = query.lastIndexOf('/');
  return i >= 0 ? query.slice(0, i + 1) : '';
}

/**
 * Поиск для `@`: пустой запрос или запрос, оканчивающийся на `/`, — содержимое этого каталога (без вложенных уровней),
 * иначе нечёткий поиск по всем путям.
 */
export function searchFileEntries(entries: readonly FileIndexEntry[], query: string, limit: number): FileIndexEntry[] {
  const q = query.replace(/\\/g, '/');
  if (!q || q.endsWith('/')) {
    const dir = browseDir(q);
    const children = entries.filter((e) => {
      if (!e.path.startsWith(dir) || e.path === dir) return false;
      const rest = e.path.slice(dir.length);
      const slash = rest.indexOf('/');
      return slash < 0 || slash === rest.length - 1;
    });
    return children.slice(0, limit);
  }
  return rankFuzzy(entries, q, (e) => e.path, limit);
}

export async function searchProjectFiles(cwd: string, query: string, limit = 50): Promise<{ entries: FileIndexEntry[]; truncated: boolean }> {
  const all = await projectFileEntries(cwd);
  const files = all.reduce((n, e) => n + (e.dir ? 0 : 1), 0);
  return { entries: searchFileEntries(all, query, Math.max(1, Math.min(limit, 200))), truncated: files >= MAX_INDEX_FILES };
}
