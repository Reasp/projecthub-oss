/**
 * Файлы worktree, которые читает и пишет хост (TASK-246, [[decision-191]]): карточки одобрения с прежним содержимым
 * файла, отчёт безопасности слота, отчёты эстафеты, инструменты API-агента изолированного участника. Агент управляет
 * содержимым worktree и может заменить файл или каталог симлинком (junction) наружу — на `~/.ssh`, `<userData>`, чужой
 * worktree. Хост таким ссылкам не следует:
 *
 * - путь должен оставаться под корнем (`..` и абсолютные пути вне него — отказ);
 * - каждый компонент пути от корня проверяется `lstat`: симлинк или junction — отказ;
 * - файл открывается с `O_NOFOLLOW` (где он есть), после открытия сверяется, что открыт именно этот файл: на Linux —
 *   по `/proc/self/fd`, на остальных ОС — повторной проверкой компонентов и сравнением `dev`/`ino` с открытым
 *   дескриптором. Подмену каталога между проверкой и открытием это ловит; запись идёт только после сверки.
 *
 * На Windows симлинк, созданный в Linux-контейнере на смонтированном каталоге, — точка повторного разбора WSL, которую
 * Win32 не открывает вовсе; проверки выше закрывают и обычные симлинки и junction, созданные на хосте.
 */
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// FIFO, подложенный между проверкой и открытием, не блокирует поток libuv навсегда (ревью TASK-246).
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
/** Больше этого хост из worktree не читает: огромный (в том числе разреженный) файл не роняет main-процесс. */
export const WORKTREE_READ_LIMIT = 10 * 1024 * 1024;

/** Путь относительно корня или `null`, если он выходит из корня. Пустая строка — сам корень. */
export function worktreeRelative(root: string, p: string): string | null {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(base, p));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel;
}

function relOrThrow(root: string, p: string): string {
  const rel = worktreeRelative(root, p);
  if (rel === null) throw new AppError('worktree.outside', { path: p });
  return rel;
}

function notFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR';
}

/**
 * Каждый компонент `rel` под `root` — не симлинк. Возвращает `lstat` последнего или `null`, если его (или каталога на
 * пути) нет.
 */
async function walk(root: string, rel: string): Promise<BigIntStats | null> {
  let cur = root;
  let st: BigIntStats | null = null;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      st = await fs.lstat(cur, { bigint: true });
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
    if (st.isSymbolicLink()) throw new AppError('worktree.symlink', { path: rel });
  }
  return st;
}

/** Открытый дескриптор — тот самый файл под корнем, без симлинков на пути. */
async function verifyOpened(fh: fs.FileHandle, root: string, rel: string): Promise<BigIntStats> {
  const opened = await fh.stat({ bigint: true });
  if (!opened.isFile()) throw new AppError('worktree.notFile', { path: rel });
  if (process.platform === 'linux') {
    const real = await fs.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    if (real !== null) {
      if (real !== path.join(root, rel)) throw new AppError('worktree.symlink', { path: rel });
      return opened;
    }
  }
  const now = await walk(root, rel);
  if (!now || now.dev !== opened.dev || now.ino !== opened.ino) throw new AppError('worktree.symlink', { path: rel });
  return opened;
}

/** Корень после `realpath`: сам каталог worktree хоста не подменяется агентом, но путь к нему может идти через ссылку. */
async function realRoot(root: string): Promise<string> {
  return fs.realpath(root);
}

/** Чтение файла под корнем без следования симлинкам. Нет файла — `ENOENT`, как у `fs.readFile`. */
export async function readWorktreeFile(root: string, p: string): Promise<string> {
  const base = await realRoot(root);
  const rel = relOrThrow(root, p);
  if (rel === '') throw new AppError('worktree.notFile', { path: p });
  const st = await walk(base, rel);
  if (st && !st.isFile()) throw new AppError('worktree.notFile', { path: rel });
  const fh = await fs.open(path.join(base, rel), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = await verifyOpened(fh, base, rel);
    if (opened.size > BigInt(WORKTREE_READ_LIMIT)) throw new AppError('worktree.tooLarge', { path: rel });
    // Файл может расти во время чтения: читается не больше предела.
    const buf = Buffer.alloc(WORKTREE_READ_LIMIT + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > WORKTREE_READ_LIMIT) throw new AppError('worktree.tooLarge', { path: rel });
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Запись файла под корнем без следования симлинкам: недостающие каталоги создаются по одному с проверкой каждого,
 * существующий файл должен быть обычным файлом без жёстких ссылок; содержимое заменяется только после сверки
 * открытого дескриптора.
 */
export async function writeWorktreeFile(root: string, p: string, content: string): Promise<void> {
  const base = await realRoot(root);
  const rel = relOrThrow(root, p);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length === 0) throw new AppError('worktree.notFile', { path: p });
  let cur = base;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    let st = await fs.lstat(cur).catch((e) => (notFound(e) ? null : Promise.reject(e)));
    if (!st) {
      await fs.mkdir(cur).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)));
      st = await fs.lstat(cur);
    }
    if (st.isSymbolicLink()) throw new AppError('worktree.symlink', { path: rel });
    if (!st.isDirectory()) throw new AppError('worktree.notFile', { path: rel });
  }
  const abs = path.join(base, rel);
  const before = await fs.lstat(abs).catch((e) => (notFound(e) ? null : Promise.reject(e)));
  if (before && (before.isSymbolicLink() || !before.isFile())) throw new AppError(before.isSymbolicLink() ? 'worktree.symlink' : 'worktree.notFile', { path: rel });
  const fh = await fs.open(abs, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o666);
  try {
    const opened = await verifyOpened(fh, base, rel);
    // Жёсткая ссылка на файл вне worktree: запись изменила бы и его.
    if (opened.nlink > 1n) throw new AppError('worktree.symlink', { path: rel });
    await fh.truncate(0);
    await fh.write(content, 0, 'utf8');
  } finally {
    await fh.close();
  }
}

/** Содержимое каталога под корнем; симлинки показываются именами, как файлы, без перехода по ним. */
export async function listWorktreeDir(root: string, p: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  const base = await realRoot(root);
  const rel = relOrThrow(root, p);
  const st = await walk(base, rel);
  if (rel !== '' && !st) {
    const err = new Error(`ENOENT: no such directory, '${p}'`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  if (st && !st.isDirectory()) throw new AppError('worktree.notFile', { path: rel });
  const dir = path.join(base, rel);
  if (process.platform === 'linux') {
    // Каталог открыт без следования ссылке и сверен по /proc/self/fd: читается именно он, а не подменённый в гонке.
    const fh = await fs.open(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW | NONBLOCK);
    try {
      if ((await fs.readlink(`/proc/self/fd/${fh.fd}`)) !== dir) throw new AppError('worktree.symlink', { path: rel });
      const entries = await fs.readdir(`/proc/self/fd/${fh.fd}`, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } finally {
      await fh.close();
    }
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // Каталог подменили ссылкой между проверкой и чтением — список отбрасывается.
  const after = await walk(base, rel);
  if (rel !== '' && (!after || !st || after.dev !== st.dev || after.ino !== st.ino)) throw new AppError('worktree.symlink', { path: rel });
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
}

/** Есть ли обычный файл или каталог по пути под корнем без симлинков на пути (для синхронных проверок). */
export function worktreePathExistsSync(root: string, p: string): boolean {
  const rel = worktreeRelative(root, p);
  if (rel === null) return false;
  let cur = path.resolve(root);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}
