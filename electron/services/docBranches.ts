import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { AppError } from '../../src/lib/appError.js';
import path from 'node:path';
import { execGit, splitNul, type GitRunner } from './checkpointGit';
import { allocateBacklogId, insideGitRepo, listDiskBacklogPaths } from './backlogIdAllocator';
import {
  entityFromBacklogPath,
  markRenumberedFrom,
  planBacklogRenumber,
  renameBacklogPath,
  replaceBacklogIds,
  type BacklogRenumbering
} from './backlogIds';
import { diffDocParts, mergeDocText, type DocConflict, type DocPartChange, type DocResolution } from './docSectionMerge';
import { renderNewDocFile } from './docsService';
import type { CreateDocParams } from '../../src/types/electron';

/**
 * Ветки документации (TASK-194, decision-151): агент правит документы и решения в своей ветке, не трогая рабочее
 * дерево, основную ветку и чужие worktree; человек или роль с правом слияния принимает правки целиком или по
 * документам. Чистый модуль без Electron: git внедряется.
 *
 * Хранение — настоящие коммиты git вне истории веток:
 * - ref `refs/projecthub/docs/<id>`; первый коммит ветки — снимок: дерево HEAD, в котором `backlog/docs` и
 *   `backlog/decisions` заменены текущим содержимым рабочего дерева (с незакоммиченными правками) — это база
 *   трёхстороннего слияния;
 * - правки ветки — коммиты поверх снимка через временный индекс (`GIT_INDEX_FILE`, `hash-object`, `update-index`,
 *   `commit-tree`, `update-ref` со старым значением — правки двух сессий в одну ветку не теряются);
 * - статус, автор, предложение и уже принятые документы — `<git-common-dir>/projecthub/doc-branches.json`.
 *
 * Основная сторона слияния — файлы рабочего дерева основного каталога проекта: так же, как `doc_update` без ветки,
 * принятие пишет файлы и не коммитит (коммит — решение человека, правило 9).
 */

export const DOC_BRANCH_REF_ROOT = 'refs/projecthub/docs';
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ProjectHub Docs',
  GIT_AUTHOR_EMAIL: 'docs@projecthub.local',
  GIT_COMMITTER_NAME: 'ProjectHub Docs',
  GIT_COMMITTER_EMAIL: 'docs@projecthub.local'
};
const DOC_DIRS = ['backlog/docs', 'backlog/decisions'] as const;

export type DocBranchStatus = 'open' | 'proposed' | 'merged' | 'closed';

export interface DocBranchMeta {
  id: string;
  title: string;
  status: DocBranchStatus;
  /** Путь проекта внутри репозитория (`''` или `sub/dir/`). */
  prefix: string;
  /** Коммит-снимок, от которого считается дифф ветки. */
  base: string;
  /** Кто открыл ветку: имя агента, роль или «человек». */
  author?: string;
  sessionId?: string;
  /** Задача, к которой относится ветка (`TASK-12`). */
  task?: string;
  createdAt: string;
  updatedAt: string;
  /** Сообщение предложения слияния: что и зачем изменено. */
  proposal?: string;
  proposedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  closedAt?: string;
  /** Уже принятые документы: путь от корня репозитория → blob ветки на момент принятия. */
  accepted?: Record<string, string>;
}

interface StoreFile {
  version: 1;
  next: number;
  branches: DocBranchMeta[];
}

export interface DocBranchEnv {
  git?: GitRunner;
  now?: () => Date;
  tmpDir?: string;
}

/** Решения конфликтов: документ (id или путь от корня проекта) → ключ части → решение. */
export type DocBranchResolutions = Record<string, Record<string, DocResolution>>;

/** Решения из недоверенного источника (рендерер, телефон): только известные формы, лишнее отбрасывается. */
export function sanitizeResolutions(raw: unknown): DocBranchResolutions {
  const out: DocBranchResolutions = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [doc, map] of Object.entries(raw as Record<string, unknown>)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      let resolution: DocResolution | null = null;
      if (value === 'ours' || value === 'theirs' || value === 'both') resolution = value;
      else if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') resolution = { text: (value as { text: string }).text };
      if (resolution) (out[doc] ??= {})[key] = resolution;
    }
  }
  return out;
}

export interface DocBranchFile {
  /** Путь от корня проекта (`backlog/docs/doc-5 - X.md`) — с учётом перенумерации. */
  path: string;
  /** Путь в ветке до перенумерации. */
  branchPath: string;
  docId: string;
  title: string;
  change: 'added' | 'modified' | 'removed';
  /** Какие разделы и поля ветка изменила относительно базы. */
  parts: DocPartChange[];
  /** Основная ветка тоже изменила документ после ответвления. */
  mainChanged: boolean;
  conflicts: DocConflict[];
  /** Новый номер документа, если его номер в основной уже занят (decision-76). */
  renumberedFrom?: string;
  base: string | null;
  branch: string | null;
  main: string | null;
  /** Итог слияния, если конфликтов нет (`null` — документ будет удалён). */
  merged: string | null;
}

export interface DocBranchDiff {
  branch: DocBranchMeta;
  files: DocBranchFile[];
  renumbered: BacklogRenumbering[];
}

export interface DocBranchConflict extends DocConflict {
  /** id документа. */
  doc: string;
  path: string;
}

export interface DocBranchMergeResult {
  status: 'merged' | 'partial' | 'conflict' | 'nothing';
  written: string[];
  removed: string[];
  renumbered: BacklogRenumbering[];
  conflicts: DocBranchConflict[];
  branch: DocBranchMeta;
}

export interface DocBranchSyncResult {
  status: 'up-to-date' | 'synced' | 'conflict';
  conflicts: DocBranchConflict[];
  branch: DocBranchMeta;
}

interface Repo {
  root: string;
  top: string;
  prefix: string;
  commonDir: string;
  git: GitRunner;
  now: () => Date;
  tmpDir: string;
}

// ── инфраструктура ───────────────────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/** Операции над ветками одного репозитория — по одной: файл состояния и ref меняются вместе. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

async function openRepo(projectRoot: string, env: DocBranchEnv = {}): Promise<Repo> {
  const root = path.resolve(projectRoot);
  if (!insideGitRepo(root)) throw new AppError('docs.branchesNeedGit');
  const git = env.git ?? execGit;
  const top = path.resolve((await git(['rev-parse', '--show-toplevel'], { cwd: root })).trim());
  const prefix = (await git(['rev-parse', '--show-prefix'], { cwd: root })).trim().replace(/\\/g, '/');
  const commonDir = path.resolve(root, (await git(['rev-parse', '--git-common-dir'], { cwd: root })).trim());
  return { root, top, prefix, commonDir, git, now: env.now ?? (() => new Date()), tmpDir: env.tmpDir ?? os.tmpdir() };
}

const storePath = (repo: Repo) => path.join(repo.commonDir, 'projecthub', 'doc-branches.json');
const refOf = (id: string) => `${DOC_BRANCH_REF_ROOT}/${id}`;
const lockKey = (repo: Repo) => (process.platform === 'win32' ? repo.commonDir.toLowerCase() : repo.commonDir);

async function readStore(repo: Repo): Promise<StoreFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(repo), 'utf-8')) as Partial<StoreFile>;
    return { version: 1, next: Number(parsed.next) > 0 ? Number(parsed.next) : 1, branches: Array.isArray(parsed.branches) ? parsed.branches : [] };
  } catch {
    return { version: 1, next: 1, branches: [] };
  }
}

async function writeStore(repo: Repo, store: StoreFile): Promise<void> {
  const file = storePath(repo);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

function tmpIndexPath(repo: Repo): string {
  return path.join(repo.tmpDir, `projecthub-docbranch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.index`);
}

async function withTmpIndex<T>(repo: Repo, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const tmpIndex = tmpIndexPath(repo);
  try {
    return await fn({ GIT_INDEX_FILE: tmpIndex });
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
    await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => undefined);
  }
}

const docDirsInRepo = (repo: Repo) => DOC_DIRS.map((d) => `${repo.prefix}${d}`);
/** Путь от корня репозитория → путь от корня проекта. */
const toProjectPath = (repo: Repo, repoPath: string) => (repoPath.startsWith(repo.prefix) ? repoPath.slice(repo.prefix.length) : repoPath);
const toRepoPath = (repo: Repo, projectPath: string) => `${repo.prefix}${projectPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
const normEol = (s: string | null) => (s === null ? null : s.replace(/\r\n/g, '\n'));

async function resolveHead(repo: Repo): Promise<string | null> {
  try {
    return (await repo.git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo.top })).trim() || null;
  } catch {
    return null;
  }
}

async function refTip(repo: Repo, id: string): Promise<string | null> {
  try {
    return (await repo.git(['rev-parse', '--verify', '-q', `${refOf(id)}^{commit}`], { cwd: repo.top })).trim() || null;
  } catch {
    return null;
  }
}

async function readBlob(repo: Repo, commit: string, repoPath: string): Promise<string | null> {
  try {
    return await repo.git(['cat-file', 'blob', `${commit}:${repoPath}`], { cwd: repo.top });
  } catch {
    return null;
  }
}

async function blobId(repo: Repo, commit: string, repoPath: string): Promise<string | null> {
  try {
    return (await repo.git(['rev-parse', '--verify', '-q', `${commit}:${repoPath}`], { cwd: repo.top })).trim() || null;
  } catch {
    return null;
  }
}

async function readMain(repo: Repo, repoPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repo.top, ...repoPath.split('/')), 'utf-8');
  } catch {
    return null;
  }
}

/** Файлы документации в коммите (пути от корня репозитория). */
async function docPathsAt(repo: Repo, commit: string): Promise<string[]> {
  const out = await repo.git(['ls-tree', '-r', '-z', '--name-only', '--full-name', commit, '--', ...docDirsInRepo(repo)], { cwd: repo.top });
  return splitNul(out).filter((p) => p.toLowerCase().endsWith('.md'));
}

/** Пути сущностей `backlog/` (относительно `backlog/`) в коммите — для перенумерации. */
async function backlogPathsAt(repo: Repo, commit: string): Promise<string[]> {
  const prefix = `${repo.prefix}backlog/`;
  const out = await repo.git(['ls-tree', '-r', '-z', '--name-only', '--full-name', commit, '--', prefix], { cwd: repo.top });
  return splitNul(out)
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length));
}

/**
 * Снимок документации рабочего дерева: дерево `parent` (HEAD), в котором каталоги документов заменены их содержимым
 * на диске. Индекс и рабочее дерево не меняются.
 */
async function snapshotDocs(repo: Repo, parent: string | null, message: string): Promise<string> {
  return withTmpIndex(repo, async (env) => {
    await repo.git(parent ? ['read-tree', parent] : ['read-tree', '--empty'], { cwd: repo.top, env });
    for (const dir of docDirsInRepo(repo)) {
      if (existsSync(path.join(repo.top, ...dir.split('/')))) await repo.git(['add', '-A', '--', dir], { cwd: repo.top, env });
      else await repo.git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', dir], { cwd: repo.top, env });
    }
    const tree = (await repo.git(['write-tree'], { cwd: repo.top, env })).trim();
    return (await repo.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd: repo.top, env: AUTHOR_ENV })).trim();
  });
}

interface FileWrite {
  repoPath: string;
  /** `null` — удалить файл из ветки. */
  content: string | null;
}

/** Коммит в ветку: дерево `from` плюс изменения файлов; ref двигается, только если вершина всё ещё `expectedTip`. */
async function commitToBranch(
  repo: Repo,
  id: string,
  opts: { from: string; parents: string[]; expectedTip: string; files: FileWrite[]; message: string }
): Promise<string> {
  const commit = await withTmpIndex(repo, async (env) => {
    await repo.git(['read-tree', opts.from], { cwd: repo.top, env });
    for (const file of opts.files) {
      if (file.content === null) {
        await repo.git(['update-index', '--force-remove', '--', file.repoPath], { cwd: repo.top, env });
        continue;
      }
      const tmp = `${tmpIndexPath(repo)}.blob`;
      try {
        await fs.writeFile(tmp, file.content, 'utf-8');
        // --path: фильтры (autocrlf) — как при обычном `git add` этого пути.
        const sha = (await repo.git(['hash-object', '-w', `--path=${file.repoPath}`, tmp], { cwd: repo.top })).trim();
        await repo.git(['update-index', '--add', '--cacheinfo', `100644,${sha},${file.repoPath}`], { cwd: repo.top, env });
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    const tree = (await repo.git(['write-tree'], { cwd: repo.top, env })).trim();
    const parentArgs = opts.parents.flatMap((p) => ['-p', p]);
    return (await repo.git(['commit-tree', tree, ...parentArgs, '-m', opts.message], { cwd: repo.top, env: AUTHOR_ENV })).trim();
  });
  await repo.git(['update-ref', '-m', opts.message, refOf(id), commit, opts.expectedTip], { cwd: repo.top });
  return commit;
}

function findMeta(store: StoreFile, repo: Repo, id: string): DocBranchMeta {
  const wanted = id.trim().toLowerCase();
  const meta = store.branches.find((b) => b.id.toLowerCase() === wanted && b.prefix === repo.prefix);
  if (!meta) throw new AppError('docs.branchNotFound', { id });
  return meta;
}

function requireActive(meta: DocBranchMeta): void {
  if (meta.status === 'merged') throw new AppError('docs.branchMerged', { id: meta.id });
  if (meta.status === 'closed') throw new AppError('docs.branchClosed', { id: meta.id });
}

async function activeTip(repo: Repo, meta: DocBranchMeta): Promise<string> {
  requireActive(meta);
  const tip = await refTip(repo, meta.id);
  if (!tip) throw new AppError('docs.branchRefMissing', { id: meta.id, ref: refOf(meta.id) });
  return tip;
}

/** id документа по пути от корня репозитория. */
function docIdOfPath(repo: Repo, repoPath: string): string | null {
  const backlogRel = toProjectPath(repo, repoPath).replace(/^backlog\//, '');
  return entityFromBacklogPath(backlogRel)?.id ?? null;
}

function titleOf(text: string | null, fallback: string): string {
  if (!text) return fallback;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const t = fm ? /^title:\s*(.+)$/m.exec(fm[1]) : null;
  if (t) return t[1].trim().replace(/^["']|["']$/g, '');
  const h1 = /^#\s+(.+)$/m.exec(text);
  return h1 ? h1[1].trim() : fallback;
}

// ── чтение ───────────────────────────────────────────────────────────────────────────────────────

/** Ветки проекта: по умолчанию только открытые и предложенные. */
export async function listDocBranches(projectRoot: string, options: { all?: boolean } = {}, env: DocBranchEnv = {}): Promise<DocBranchMeta[]> {
  const repo = await openRepo(projectRoot, env);
  const store = await readStore(repo);
  return store.branches
    .filter((b) => b.prefix === repo.prefix)
    .filter((b) => options.all || b.status === 'open' || b.status === 'proposed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getDocBranch(projectRoot: string, id: string, env: DocBranchEnv = {}): Promise<DocBranchMeta> {
  const repo = await openRepo(projectRoot, env);
  return findMeta(await readStore(repo), repo, id);
}

/** Документ в ветке по id (`doc-5`, `decision-7`) или пути: путь от корня проекта и текст. */
export async function readDocInBranch(
  projectRoot: string,
  id: string,
  doc: string,
  env: DocBranchEnv = {}
): Promise<{ path: string; docId: string; content: string } | null> {
  const repo = await openRepo(projectRoot, env);
  const meta = findMeta(await readStore(repo), repo, id);
  const tip = await activeTip(repo, meta);
  const repoPath = await findDocPath(repo, tip, doc);
  if (!repoPath) return null;
  const content = await readBlob(repo, tip, repoPath);
  return content === null ? null : { path: toProjectPath(repo, repoPath), docId: docIdOfPath(repo, repoPath) ?? doc, content };
}

async function findDocPath(repo: Repo, commit: string, doc: string): Promise<string | null> {
  const wanted = doc.trim().replace(/\\/g, '/');
  const paths = await docPathsAt(repo, commit);
  if (wanted.includes('/')) {
    const repoPath = toRepoPath(repo, wanted);
    return paths.includes(repoPath) ? repoPath : null;
  }
  const lower = wanted.toLowerCase();
  return paths.find((p) => (docIdOfPath(repo, p) ?? '').toLowerCase() === lower) ?? null;
}

// ── изменение ────────────────────────────────────────────────────────────────────────────────────

export interface OpenDocBranchParams {
  title: string;
  author?: string;
  sessionId?: string;
  task?: string;
}

/** Новая ветка от текущего состояния документации основного каталога проекта. */
export async function openDocBranch(projectRoot: string, params: OpenDocBranchParams, env: DocBranchEnv = {}): Promise<DocBranchMeta> {
  const repo = await openRepo(projectRoot, env);
  const title = params.title.trim();
  if (!title) throw new AppError('docs.branchTitleEmpty');
  return withLock(lockKey(repo), async () => {
    const store = await readStore(repo);
    const id = `db-${store.next}`;
    const base = await snapshotDocs(repo, await resolveHead(repo), `docs: snapshot for branch ${id} “${title}”`);
    // Пустое старое значение: ref должен не существовать (ветка с таким номером осталась от чужой копии store).
    await repo.git(['update-ref', '-m', `docs: open ${id}`, refOf(id), base, ''], { cwd: repo.top });
    const stamp = repo.now().toISOString();
    const meta: DocBranchMeta = {
      id,
      title,
      status: 'open',
      prefix: repo.prefix,
      base,
      ...(params.author ? { author: params.author } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.task ? { task: params.task } : {}),
      createdAt: stamp,
      updatedAt: stamp
    };
    store.next += 1;
    store.branches.push(meta);
    await writeStore(repo, store);
    return meta;
  });
}

async function touch(repo: Repo, id: string, patch: Partial<DocBranchMeta>): Promise<DocBranchMeta> {
  const store = await readStore(repo);
  const meta = findMeta(store, repo, id);
  Object.assign(meta, patch, { updatedAt: repo.now().toISOString() });
  await writeStore(repo, store);
  return meta;
}

/** Новый документ или решение в ветке. Номер выдаётся с учётом основной, веток и worktree (decision-76). */
export async function createDocInBranch(
  projectRoot: string,
  id: string,
  params: CreateDocParams,
  env: DocBranchEnv = {}
): Promise<{ docId: string; path: string; title: string }> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const meta = findMeta(await readStore(repo), repo, id);
    const tip = await activeTip(repo, meta);
    const kind = params.type === 'decision' ? 'decision' : 'doc';
    const taken = (await docPathsAt(repo, tip)).map((p) => docIdOfPath(repo, p)).filter((x): x is string => !!x);
    const docId = await allocateBacklogId(repo.root, kind, { extraTaken: taken, git: repo.git });
    const rendered = renderNewDocFile(params, docId);
    const projectPath = `backlog/${rendered.dir}/${rendered.fileName}`;
    await commitToBranch(repo, meta.id, {
      from: tip,
      parents: [tip],
      expectedTip: tip,
      files: [{ repoPath: toRepoPath(repo, projectPath), content: rendered.content }],
      message: `docs(${meta.id}): ${docId} ${params.title.trim()}`
    });
    await touch(repo, meta.id, meta.status === 'proposed' ? { status: 'open' } : {});
    return { docId, path: projectPath, title: params.title.trim() };
  });
}

/**
 * Правка документа в ветке: `transform` получает текст из ветки и возвращает новый. Документ, которого в ветке ещё
 * нет (его создали в основной после ответвления), сначала берётся из основной.
 */
export async function updateDocInBranch(
  projectRoot: string,
  id: string,
  doc: string,
  transform: (raw: string) => string,
  env: DocBranchEnv = {}
): Promise<{ docId: string; path: string }> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const meta = findMeta(await readStore(repo), repo, id);
    const tip = await activeTip(repo, meta);
    const repoPath = await findDocPath(repo, tip, doc);
    const raw = repoPath ? await readBlob(repo, tip, repoPath) : null;
    if (repoPath === null || raw === null) {
      throw new AppError('docs.branchDocMissing', { doc, id: meta.id });
    }
    // Изменение предложенной ветки возвращает её в работу: предложение устарело.
    const next = transform(raw);
    if (normEol(next) === normEol(raw)) return { docId: docIdOfPath(repo, repoPath) ?? doc, path: toProjectPath(repo, repoPath) };
    await commitToBranch(repo, meta.id, {
      from: tip,
      parents: [tip],
      expectedTip: tip,
      files: [{ repoPath, content: next }],
      message: `docs(${meta.id}): edit ${docIdOfPath(repo, repoPath) ?? repoPath}`
    });
    await touch(repo, meta.id, meta.status === 'proposed' ? { status: 'open' } : {});
    return { docId: docIdOfPath(repo, repoPath) ?? doc, path: toProjectPath(repo, repoPath) };
  });
}

// ── дифф и слияние ───────────────────────────────────────────────────────────────────────────────

async function changedDocPaths(repo: Repo, base: string, tip: string): Promise<Array<{ status: string; repoPath: string }>> {
  const out = await repo.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', base, tip, '--', ...docDirsInRepo(repo)], { cwd: repo.top });
  const parts = splitNul(out);
  const rows: Array<{ status: string; repoPath: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i + 1].toLowerCase().endsWith('.md')) rows.push({ status: parts[i][0], repoPath: parts[i + 1] });
  }
  return rows;
}

function resolutionsFor(resolutions: DocBranchResolutions | undefined, file: { path: string; branchPath: string; docId: string }): Record<string, DocResolution> {
  if (!resolutions) return {};
  const keys = new Set([file.path, file.branchPath, file.docId].map((k) => k.toLowerCase()));
  const out: Record<string, DocResolution> = {};
  for (const [doc, map] of Object.entries(resolutions)) {
    if (keys.has(doc.trim().replace(/\\/g, '/').toLowerCase())) Object.assign(out, map);
  }
  return out;
}

/** Слияние одного файла: base — снимок, main — рабочее дерево, branch — ветка (`null` — нет/удалён). */
function mergeFile(
  base: string | null,
  main: string | null,
  branch: string | null,
  resolutions: Record<string, DocResolution>
): { merged: string | null; conflicts: DocConflict[] } {
  const whole = (b: string | null, o: string | null, t: string | null): { merged: string | null; conflicts: DocConflict[] } => {
    const r = resolutions['file:'];
    if (r === 'ours') return { merged: o, conflicts: [] };
    if (r === 'theirs') return { merged: t, conflicts: [] };
    if (r && typeof r === 'object') return { merged: r.text, conflicts: [] };
    return { merged: o, conflicts: [{ key: 'file:', label: '(whole document)', scope: 'section', base: b, ours: o, theirs: t }] };
  };
  if (branch === null) {
    // Ветка удалила документ: удаляем, если основная его не меняла.
    if (main === null) return { merged: null, conflicts: [] };
    if (base !== null && normEol(main) === normEol(base)) return { merged: null, conflicts: [] };
    return whole(base, main, null);
  }
  if (main === null) {
    if (base === null) return { merged: branch, conflicts: [] };
    // Основная удалила документ, ветка правила.
    return whole(base, null, branch);
  }
  if (normEol(main) === normEol(branch)) return { merged: main, conflicts: [] };
  if (base !== null && normEol(main) === normEol(base)) {
    // Основная не менялась: текст ветки с переводами строк основной.
    const text = branch.replace(/\r\n/g, '\n');
    return { merged: main.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text, conflicts: [] };
  }
  const result = mergeDocText(base, main, branch, resolutions);
  return { merged: result.conflicts.length ? null : result.text, conflicts: result.conflicts };
}

async function computeDiff(repo: Repo, meta: DocBranchMeta, tip: string, resolutions?: DocBranchResolutions): Promise<DocBranchDiff> {
  const changed = await changedDocPaths(repo, meta.base, tip);
  const accepted = meta.accepted ?? {};
  const pending: typeof changed = [];
  for (const row of changed) {
    const blob = row.status === 'D' ? 'deleted' : await blobId(repo, tip, row.repoPath);
    if (accepted[row.repoPath] && accepted[row.repoPath] === blob) continue;
    pending.push(row);
  }

  // Номера новых документов ветки, занятые в основной после ответвления (decision-76: уступает ветка).
  let renumbered: BacklogRenumbering[] = [];
  if (pending.some((r) => r.status === 'A')) {
    const [basePaths, tipPaths, mainPaths] = await Promise.all([
      backlogPathsAt(repo, meta.base),
      backlogPathsAt(repo, tip),
      listDiskBacklogPaths(path.join(repo.root, 'backlog'))
    ]);
    // Документы, уже принятые из этой ветки, на диске основной — не коллизия.
    const acceptedBacklog = new Set(Object.keys(accepted).map((p) => toProjectPath(repo, p).replace(/^backlog\//, '')));
    renumbered = planBacklogRenumber({ base: basePaths, ours: mainPaths.filter((p) => !acceptedBacklog.has(p)), theirs: tipPaths }).filter(
      (r) => r.kind === 'doc' || r.kind === 'decision'
    );
  }

  const files: DocBranchFile[] = [];
  for (const row of pending) {
    const base = await readBlob(repo, meta.base, row.repoPath);
    let branch = row.status === 'D' ? null : await readBlob(repo, tip, row.repoPath);
    let targetRepoPath = row.repoPath;
    let renumberedFrom: string | undefined;
    const originalId = docIdOfPath(repo, row.repoPath);
    if (renumbered.length && branch !== null) {
      branch = replaceBacklogIds(branch, renumbered);
      const backlogRel = toProjectPath(repo, row.repoPath).replace(/^backlog\//, '');
      const renamed = renameBacklogPath(backlogRel, renumbered);
      if (renamed !== backlogRel) {
        targetRepoPath = toRepoPath(repo, `backlog/${renamed}`);
        renumberedFrom = originalId ?? undefined;
        if (renumberedFrom) branch = markRenumberedFrom(branch, renumberedFrom);
      }
    }
    const main = await readMain(repo, targetRepoPath);
    const docId = docIdOfPath(repo, targetRepoPath) ?? originalId ?? toProjectPath(repo, targetRepoPath);
    const projectPath = toProjectPath(repo, targetRepoPath);
    const fileResolutions = resolutionsFor(resolutions, { path: projectPath, branchPath: toProjectPath(repo, row.repoPath), docId });
    const merged = mergeFile(base, main, branch, fileResolutions);
    files.push({
      path: projectPath,
      branchPath: toProjectPath(repo, row.repoPath),
      docId,
      title: titleOf(branch ?? base, docId),
      change: row.status === 'A' ? 'added' : row.status === 'D' ? 'removed' : 'modified',
      parts: branch === null ? [] : diffDocParts(base, branch),
      mainChanged: base === null ? main !== null : normEol(main) !== normEol(base),
      conflicts: merged.conflicts,
      ...(renumberedFrom ? { renumberedFrom } : {}),
      base,
      branch,
      main,
      merged: merged.conflicts.length ? null : merged.merged
    });
  }
  return { branch: meta, files, renumbered };
}

/** Что ветка меняет относительно основной: документы, разделы, конфликты с правками основной. */
export async function diffDocBranch(projectRoot: string, id: string, env: DocBranchEnv = {}): Promise<DocBranchDiff> {
  const repo = await openRepo(projectRoot, env);
  const meta = findMeta(await readStore(repo), repo, id);
  if (meta.status === 'merged' || meta.status === 'closed') return { branch: meta, files: [], renumbered: [] };
  return computeDiff(repo, meta, await activeTip(repo, meta));
}

const flattenConflicts = (files: DocBranchFile[]): DocBranchConflict[] =>
  files.flatMap((f) => f.conflicts.map((c) => ({ ...c, doc: f.docId, path: f.path })));

/**
 * Подтянуть в ветку текущее состояние основной (как `sync_base_branch`, decision-141): новый снимок основной
 * становится базой, документы ветки сливаются с ним по разделам. Конфликт — структурированный список частей; с
 * решениями `resolutions` слияние доводится до конца. При конфликте ветка не меняется.
 */
export async function resolveDocBranch(
  projectRoot: string,
  id: string,
  resolutions: DocBranchResolutions = {},
  env: DocBranchEnv = {}
): Promise<DocBranchSyncResult> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const store = await readStore(repo);
    const meta = findMeta(store, repo, id);
    const tip = await activeTip(repo, meta);
    const diff = await computeDiff(repo, meta, tip, resolutions);
    const conflicts = flattenConflicts(diff.files);
    if (conflicts.length) return { status: 'conflict', conflicts, branch: meta };
    if (!diff.files.some((f) => f.mainChanged) && !diff.renumbered.length) return { status: 'up-to-date', conflicts: [], branch: meta };

    const snapshot = await snapshotDocs(repo, await resolveHead(repo), `docs: snapshot of main for ${meta.id}`);
    const files: FileWrite[] = [];
    for (const f of diff.files) {
      const target = toRepoPath(repo, f.path);
      if (f.branchPath !== f.path) files.push({ repoPath: toRepoPath(repo, f.branchPath), content: null });
      files.push({ repoPath: target, content: f.merged });
    }
    await commitToBranch(repo, meta.id, {
      from: snapshot,
      parents: [tip, snapshot],
      expectedTip: tip,
      files,
      message: `docs(${meta.id}): merged main`
    });
    const updated = await touch(repo, meta.id, { base: snapshot, accepted: {} });
    return { status: 'synced', conflicts: [], branch: updated };
  });
}

/** Предложить слияние: ветка ждёт решения человека или роли с правом слияния. */
export async function proposeDocBranch(projectRoot: string, id: string, message: string, env: DocBranchEnv = {}): Promise<DocBranchDiff> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const meta = findMeta(await readStore(repo), repo, id);
    const tip = await activeTip(repo, meta);
    const diff = await computeDiff(repo, meta, tip);
    if (diff.files.length === 0) throw new AppError('docs.branchNoChanges', { id: meta.id });
    const stamp = repo.now().toISOString();
    const updated = await touch(repo, meta.id, { status: 'proposed', proposal: message.trim() || meta.title, proposedAt: stamp });
    return { ...diff, branch: updated };
  });
}

/** Закрыть ветку без слияния: ref удаляется, запись остаётся в истории со статусом `closed`. */
export async function closeDocBranch(projectRoot: string, id: string, env: DocBranchEnv = {}): Promise<DocBranchMeta> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const meta = findMeta(await readStore(repo), repo, id);
    requireActive(meta);
    await repo.git(['update-ref', '-d', refOf(meta.id)], { cwd: repo.top }).catch(() => undefined);
    return touch(repo, meta.id, { status: 'closed', closedAt: repo.now().toISOString() });
  });
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * Принять ветку в основную: целиком или только документы `docs` (id или пути). Файлы пишутся в `backlog/` основного
 * каталога, коммита нет. Конфликт без решения — ничего не пишется, возвращается список частей.
 */
export async function mergeDocBranch(
  projectRoot: string,
  id: string,
  options: { docs?: string[]; resolutions?: DocBranchResolutions; by: string },
  env: DocBranchEnv = {}
): Promise<DocBranchMergeResult> {
  const repo = await openRepo(projectRoot, env);
  return withLock(lockKey(repo), async () => {
    const meta = findMeta(await readStore(repo), repo, id);
    const tip = await activeTip(repo, meta);
    const diff = await computeDiff(repo, meta, tip, options.resolutions);
    const wanted = (options.docs ?? []).map((d) => d.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean);
    const selected = wanted.length
      ? diff.files.filter((f) => [f.docId, f.path, f.branchPath].some((k) => wanted.includes(k.toLowerCase())))
      : diff.files;
    if (wanted.length && selected.length === 0) throw new AppError('docs.branchDocsNotChanged', { id: meta.id, docs: options.docs!.join(', ') });
    if (selected.length === 0) return { status: 'nothing', written: [], removed: [], renumbered: [], conflicts: [], branch: meta };

    const conflicts = flattenConflicts(selected);
    if (conflicts.length) return { status: 'conflict', written: [], removed: [], renumbered: diff.renumbered, conflicts, branch: meta };

    const backlogDir = path.join(repo.root, 'backlog');
    const written: string[] = [];
    const removed: string[] = [];
    const accepted = { ...(meta.accepted ?? {}) };
    for (const f of selected) {
      const abs = path.resolve(repo.root, ...f.path.split('/'));
      if (!abs.startsWith(backlogDir + path.sep)) throw new AppError('docs.branchPathOutsideBacklog', { path: f.path });
      if (f.merged === null) {
        if (f.main !== null) {
          await fs.rm(abs, { force: true });
          removed.push(f.path);
        }
      } else if (f.main === null || normEol(f.main) !== normEol(f.merged)) {
        await writeAtomic(abs, f.merged);
        written.push(f.path);
      }
      const branchRepoPath = toRepoPath(repo, f.branchPath);
      accepted[branchRepoPath] = f.change === 'removed' ? 'deleted' : (await blobId(repo, tip, branchRepoPath)) ?? '';
    }

    const rest = diff.files.length - selected.length;
    const stamp = repo.now().toISOString();
    const renumbered = diff.renumbered.filter((r) => selected.some((f) => f.renumberedFrom === r.from));
    if (rest === 0) {
      await repo.git(['update-ref', '-d', refOf(meta.id)], { cwd: repo.top }).catch(() => undefined);
      const updated = await touch(repo, meta.id, { status: 'merged', mergedAt: stamp, mergedBy: options.by, accepted });
      return { status: 'merged', written, removed, renumbered, conflicts: [], branch: updated };
    }
    const updated = await touch(repo, meta.id, { accepted });
    return { status: 'partial', written, removed, renumbered, conflicts: [], branch: updated };
  });
}

/** Ветки, в которых изменён документ (для плашки в окне документа). */
export async function branchesTouchingDoc(projectRoot: string, docPath: string, env: DocBranchEnv = {}): Promise<DocBranchMeta[]> {
  const repo = await openRepo(projectRoot, env);
  const target = toRepoPath(repo, docPath);
  const out: DocBranchMeta[] = [];
  for (const meta of await listDocBranches(projectRoot, {}, env)) {
    const tip = await refTip(repo, meta.id);
    if (!tip) continue;
    const changed = await changedDocPaths(repo, meta.base, tip);
    if (changed.some((r) => r.repoPath === target)) out.push(meta);
  }
  return out;
}
