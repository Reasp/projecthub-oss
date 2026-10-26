/**
 * Отметка сборки (decision-92, TASK-158): какой коммит собран и когда. Версия приложения всегда
 * `0.1.0`, поэтому без отметки по окну не понять, какая сборка запущена — на Mac после пересборки
 * продолжал работать старый процесс из строки меню.
 *
 * `scripts/build-info.mjs` пишет `build/build-info.json` в начале `npm run build`, electron-builder
 * кладёт его в ресурсы (`resources/build-info.json`, на macOS — `Contents/Resources/build-info.json`).
 * Модуль чистый, кроме чтения файла.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_INFO_FILE = 'build-info.json';

export interface BuildInfo {
  /** Полный хэш коммита или `unknown`, если git недоступен. */
  commit: string;
  /** Время коммита (ISO). */
  commitDate: string | null;
  /** Незакоммиченных изменений в рабочем дереве на момент сборки. */
  dirtyFiles: number;
  /** Время сборки (ISO) — по нему видно, что сборку на диске заменили. */
  builtAt: string;
  /** Редакция сборки (TASK-144.4); у сборок до неё поля нет. */
  edition?: 'open' | 'team';
}

export function parseBuildInfo(text: string | null): BuildInfo | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.builtAt !== 'string' || !raw.builtAt) return null;
    return {
      commit: typeof raw.commit === 'string' && raw.commit ? raw.commit : 'unknown',
      commitDate: typeof raw.commitDate === 'string' ? raw.commitDate : null,
      dirtyFiles: typeof raw.dirtyFiles === 'number' && raw.dirtyFiles > 0 ? Math.floor(raw.dirtyFiles) : 0,
      builtAt: raw.builtAt,
      ...(raw.edition === 'open' || raw.edition === 'team' ? { edition: raw.edition } : {})
    };
  } catch {
    return null;
  }
}

/** Короткая строка для лога и окна: `4a838f3 · собрано 2026-10-19 10:40 UTC (+3 файла не в коммите)`. */
export function formatBuildInfo(info: BuildInfo | null): string {
  if (!info) return 'unknown build';
  const built = info.builtAt.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
  const dirty = info.dirtyFiles > 0 ? ` (+${info.dirtyFiles} uncommitted)` : '';
  return `${info.commit.slice(0, 7)} · built ${built}${dirty}`;
}

/** Сборку на диске заменили: другое время сборки или другой коммит. Пропавший файл — не замена (идёт копирование). */
export function isBuildReplaced(running: BuildInfo | null, onDisk: BuildInfo | null): boolean {
  if (!running || !onDisk) return false;
  return running.builtAt !== onDisk.builtAt || running.commit !== onDisk.commit;
}

/**
 * Где лежит отметка: в собранном приложении — в ресурсах, при запуске из исходников — в `build/`
 * репозитория (если сборку запускали).
 */
export function buildInfoPath(isPackaged: boolean, resourcesPath: string | undefined, appPath: string): string {
  return isPackaged && resourcesPath ? path.join(resourcesPath, BUILD_INFO_FILE) : path.join(appPath, 'build', BUILD_INFO_FILE);
}

export function readBuildInfo(file: string): BuildInfo | null {
  try {
    return parseBuildInfo(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}
