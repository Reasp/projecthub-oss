import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isInsideProject } from './pathGuard.js';
import { normalizeAddDirs } from '../../src/lib/studioAddDir.js';

/**
 * Дополнительные каталоги вкладки Agents Studio для Claude Code (`/add-dir`, TASK-285, decision-206): проверка
 * каталога при добавлении и список для запуска `claude -p --add-dir`.
 */

export type AddDirCheck =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty' | 'notFound' | 'notDirectory' | 'insideWorkDir' };

/** `~` и `~/…` — домашний каталог, как в терминале; остальное — от каталога вкладки. */
function resolveInput(input: string, baseDir: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return path.resolve(baseDir, input);
}

/**
 * Каталог, который человек добавляет вкладке: существует, это каталог, и он не внутри каталога вкладки — туда агент
 * и так ходит. Путь возвращается настоящий (`realpath`): ссылка не уводит политику HITL в другой каталог.
 */
export async function checkAddDir(input: string, baseDir: string): Promise<AddDirCheck> {
  const raw = input.trim();
  if (!raw || raw.includes('\0')) return { ok: false, reason: 'empty' };
  let real: string;
  try {
    real = await fs.realpath(resolveInput(raw, baseDir));
  } catch {
    return { ok: false, reason: 'notFound' };
  }
  try {
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: 'notDirectory' };
  } catch {
    return { ok: false, reason: 'notFound' };
  }
  if (isInsideProject(baseDir, real)) return { ok: false, reason: 'insideWorkDir' };
  return { ok: true, path: real };
}

/**
 * Каталоги для хода: абсолютные, существующие, вне каталога вкладки. Удалённый с диска каталог молча выпадает —
 * CLI на нём не падает, но и давать агенту путь в никуда незачем.
 */
export function usableAddDirs(value: unknown, workDir: string): string[] {
  return normalizeAddDirs(value).filter((dir) => {
    if (!path.isAbsolute(dir) || isInsideProject(workDir, dir)) return false;
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}
