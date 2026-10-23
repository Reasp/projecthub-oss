import fs from 'node:fs';
import path from 'node:path';
import { execGit, type GitRunner } from './checkpointGit';
import { TASK_DIRS, formatBacklogId, indexBacklogPaths, nextSubtaskNumber, nextTopNumber, parseBacklogId, type BacklogIdKind } from './backlogIds';

/**
 * Единая выдача номера задач, решений, документов, памяти и milestones (decision-76 п. 8, TASK-135).
 *
 * Номер — максимум занятых плюс один, где занятые:
 * - файлы `backlog/` проекта (задачи — во всех каталогах, включая `archive/drafts`);
 * - закоммиченные локальные ветки, удалённые ветки после последнего `fetch` и ветки документации
 *   (`git ls-tree`, без checkout);
 * - незакоммиченные файлы `backlog/` соседних worktree проекта.
 * Без git или при ошибке git — только диск: создание задачи из-за git не ломается.
 */

const SCAN_DIRS = [...TASK_DIRS, 'decisions', 'docs', 'memory', 'milestones', 'archive/milestones'];
const MAX_DOCS_DEPTH = 6;

/**
 * Каталог внутри git-репозитория? Ищем `.git` (каталог или файл worktree) вверх по дереву, не запуская git:
 * unit-тесты во временных каталогах не должны порождать процессы (decision-93).
 */
export function insideGitRepo(start: string): boolean {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Пути файлов сущностей на диске относительно `backlog/` (с `/`). */
export async function listDiskBacklogPaths(backlogDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(backlogDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(child);
      else if (e.isDirectory() && rel.startsWith('docs') && depth < MAX_DOCS_DEPTH) await walk(child, depth + 1);
    }
  };
  for (const dir of SCAN_DIRS) await walk(dir, 0);
  return out;
}

/** Деревья коммитов не меняются: пути `backlog/` по sha кэшируются на время жизни процесса. */
const treeCache = new Map<string, string[]>();
const TREE_CACHE_LIMIT = 500;

/** Пути сущностей (относительно `backlog/`) в коммите `sha`; `backlogPrefix` — путь `backlog/` от корня репозитория. */
export async function backlogPathsAtCommit(git: GitRunner, cwd: string, sha: string, backlogPrefix: string): Promise<string[]> {
  const key = `${sha}:${backlogPrefix}`;
  const cached = treeCache.get(key);
  if (cached) return cached;
  // -z: без него git берёт пути с кириллицей в кавычки и экранирует (core.quotePath).
  const out = await git(['ls-tree', '-r', '-z', '--name-only', '--full-name', sha, '--', backlogPrefix], { cwd });
  const paths = out
    .split('\0')
    .filter((l) => l.startsWith(backlogPrefix))
    .map((l) => l.slice(backlogPrefix.length));
  if (treeCache.size >= TREE_CACHE_LIMIT) treeCache.clear();
  treeCache.set(key, paths);
  return paths;
}

export interface CollectOptions {
  git?: GitRunner;
}

/**
 * Все занятые пути сущностей (относительно `backlog/`): диск проекта, ветки репозитория, соседние worktree.
 * Повторы не убираются — для выдачи номера важно множество id, а не пути.
 */
export async function collectTakenBacklogPaths(projectPath: string, options: CollectOptions = {}): Promise<string[]> {
  const root = path.resolve(projectPath);
  const paths = await listDiskBacklogPaths(path.join(root, 'backlog'));
  if (!insideGitRepo(root)) return paths;
  const git = options.git ?? execGit;
  try {
    const prefix = (await git(['rev-parse', '--show-prefix'], { cwd: root })).trim().replace(/\\/g, '/');
    const backlogPrefix = `${prefix}backlog/`;
    // refs/projecthub/docs — ветки документации (decision-151): номер, выданный в ветке, тоже занят.
    const refs = await git(['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/projecthub/docs'], { cwd: root });
    for (const sha of new Set(refs.split('\n').map((l) => l.trim()).filter(Boolean))) {
      paths.push(...(await backlogPathsAtCommit(git, root, sha, backlogPrefix).catch(() => [])));
    }
    const worktrees = await git(['worktree', 'list', '--porcelain'], { cwd: root });
    for (const line of worktrees.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const wt = path.resolve(line.slice('worktree '.length).trim());
      if (samePath(wt, root)) continue;
      paths.push(...(await listDiskBacklogPaths(path.join(wt, prefix, 'backlog'))));
    }
  } catch (err) {
    console.warn('[backlogIdAllocator] git недоступен, номера — только по диску:', err instanceof Error ? err.message : String(err));
  }
  return paths;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export interface AllocateOptions extends CollectOptions {
  /** Для подзадачи — родитель (`TASK-80`): номер выдаётся внутри него. */
  parentTaskId?: string;
  /** Дополнительно занятые id (например, по frontmatter файлов, где имя и id расходятся). */
  extraTaken?: Iterable<string>;
}

/**
 * Выданные номера, файла которых ещё нет: между выдачей и записью файла вызывающий ждёт (`await`), и параллельные
 * создания на общем хосте — телефон участника, его ПК и окно владельца — иначе получают один номер (TASK-184).
 * Резерв снимается, как только файл с этим номером виден, или через {@link RESERVE_MS}, если запись не случилась.
 */
const RESERVE_MS = 30_000;
const reserved = new Map<string, Map<string, number>>();
const allocating = new Map<string, Promise<unknown>>();

function projectKeyOf(projectPath: string): string {
  const p = path.resolve(projectPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Следующий свободный канонический id (`TASK-135`, `TASK-80.4`, `decision-94`, `doc-14`, `mem-7`, `m-2`). */
export async function allocateBacklogId(projectPath: string, kind: BacklogIdKind, options: AllocateOptions = {}): Promise<string> {
  // Выдача по проекту — по одной: следующая видит резерв предыдущей.
  const key = projectKeyOf(projectPath);
  const prev = allocating.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => allocateNow(key, projectPath, kind, options));
  allocating.set(key, run);
  try {
    return await run;
  } finally {
    if (allocating.get(key) === run) allocating.delete(key);
  }
}

async function allocateNow(key: string, projectPath: string, kind: BacklogIdKind, options: AllocateOptions): Promise<string> {
  const { ids } = indexBacklogPaths(await collectTakenBacklogPaths(projectPath, options));
  const taken = new Set<string>(ids.get(kind) ?? []);
  const pending = reserved.get(key) ?? new Map<string, number>();
  const now = Date.now();
  for (const [id, until] of pending) {
    if (until <= now || (parseBacklogId(id)?.kind === kind && taken.has(id))) pending.delete(id);
    else if (parseBacklogId(id)?.kind === kind) taken.add(id);
  }
  for (const raw of options.extraTaken ?? []) {
    const ref = parseBacklogId(raw);
    if (ref && ref.kind === kind) taken.add(ref.id);
  }
  let id: string;
  if (kind === 'task' && options.parentTaskId) {
    const parent = parseBacklogId(options.parentTaskId);
    if (!parent || parent.kind !== 'task') throw new Error(`The subtask parent is not a task: ${options.parentTaskId}`);
    id = `${parent.id}.${nextSubtaskNumber(parent.id, taken)}`;
  } else {
    id = formatBacklogId(kind, [nextTopNumber(kind, taken)]);
  }
  pending.set(id, now + RESERVE_MS);
  reserved.set(key, pending);
  return id;
}

/** Только для тестов: забыть резервы номеров. */
export function resetBacklogIdReservationsForTests(): void {
  reserved.clear();
}
