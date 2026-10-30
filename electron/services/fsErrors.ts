/**
 * Ошибки файловой системы для человека (TASK-259, [[decision-165]]): код Node (`EACCES`, `EBUSY`, …) → `AppError` с кодом
 * словаря, текст на языке окна. Неизвестный код — исходная ошибка без изменений: её текст уйдёт в журнал как есть.
 * Чистый модуль без Electron.
 */
import { AppError } from '../../src/lib/appError.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';

const BY_ERRNO: Record<string, AppErrorCode> = {
  ENOENT: 'files.notFound',
  EEXIST: 'files.exists',
  EACCES: 'files.accessDenied',
  EPERM: 'files.accessDenied',
  EBUSY: 'files.busy',
  EISDIR: 'files.isDirectory',
  ENOTDIR: 'files.notDirectory',
  ENOTEMPTY: 'files.notEmpty',
  ENOSPC: 'files.noSpace',
  EROFS: 'files.readOnly',
  ENAMETOOLONG: 'files.nameTooLong'
};

/**
 * Ошибка операции с файлом `path` (путь, как его видит человек — относительный к проекту). `overrides` — свой смысл кода
 * для операции: при создании `ENOENT` значит недопустимое имя, а не «не найден». Код Node без перевода — общий
 * `files.failed` с этим кодом; ошибка без кода Node остаётся как есть.
 */
export function fileSystemError(err: unknown, path: string, overrides: Partial<Record<string, AppErrorCode>> = {}): unknown {
  if (err instanceof AppError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return err;
  const appCode = overrides[code] ?? BY_ERRNO[code];
  const coded = appCode ? new AppError(appCode, { path }) : new AppError('files.failed', { path, reason: code });
  return Object.assign(coded, { cause: err });
}

/** Операция с файлом: системная ошибка — кодом для окна. */
export async function withFileErrors<T>(path: string, op: () => Promise<T>, overrides?: Partial<Record<string, AppErrorCode>>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw fileSystemError(err, path, overrides);
  }
}
