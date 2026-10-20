import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Файлы состояния в userData (TASK-165, decision-104): перенос с прежнего пути копированием и чтение JSON
 * с полем `version` через цепочку миграций. Без Electron: пути передаёт вызывающий (`appPaths.getStatePath`).
 */

export type LegacyMigrationResult = 'migrated' | 'exists' | 'noLegacy' | 'samePath' | 'failed';

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * Скопировать файл или каталог состояния с прежнего пути, если по новому пути пусто. Прежний не удаляется:
 * его читают другие профили (стенды со своим `--user-data-dir`) и старые сборки. Копия собирается во
 * временном пути и переименовывается целиком — оборванный перенос не оставит половину каталога сессий.
 */
export function migrateLegacyStatePath(target: string, legacy: string | null | undefined): LegacyMigrationResult {
  if (!legacy) return 'noLegacy';
  if (samePath(target, legacy)) return 'samePath';
  if (fs.existsSync(target)) return 'exists';
  if (!fs.existsSync(legacy)) return 'noLegacy';
  const tmp = `${target}.migrating-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(legacy, tmp, { recursive: true, errorOnExist: false, force: true });
    fs.renameSync(tmp, target);
    // Имя файла, без содержимого: в нём могут быть настройки пользователя. Через logger, а не console: перенос
    // идёт при импорте сервисов, до перехвата console, и строка иначе не попала бы в main.log.
    logger.info(`[StateFiles] Copied ${path.basename(target)} from the legacy location; the old copy is kept for other profiles`);
    return 'migrated';
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    logger.warn(`[StateFiles] Could not copy ${path.basename(target)} from the legacy location:`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

/** Описание схемы файла: текущая версия и шаги миграции `n → n + 1` (файл без `version` — версия 0). */
export interface StateSchema<T> {
  version: number;
  migrations?: Record<number, (data: Record<string, unknown>) => Record<string, unknown>>;
  /** Привести данные текущей версии к типу; неизвестные поля можно отбросить. */
  normalize: (data: Record<string, unknown>) => T;
}

export interface UpgradedState<T> {
  data: T;
  /** Версия для записи: не ниже версии файла — старая сборка не понижает метку новой. */
  version: number;
  fromVersion: number;
  /** Файл нужно переписать: была миграция. */
  migrated: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Прочитать данные файла состояния через миграции. Не объект (битый файл, массив) — пустой объект версии 0.
 * Файл новее схемы (записан более новой сборкой) читается как текущая версия, его `version` сохраняется.
 */
export function upgradeState<T>(raw: unknown, schema: StateSchema<T>): UpgradedState<T> {
  let data: Record<string, unknown> = isObject(raw) ? { ...raw } : {};
  const declared = Number(data.version);
  const fromVersion = Number.isInteger(declared) && declared >= 0 ? declared : 0;
  let v = fromVersion;
  while (v < schema.version) {
    const step = schema.migrations?.[v];
    if (step) data = step(data);
    v += 1;
  }
  const { version: _drop, ...rest } = data;
  void _drop;
  return { data: schema.normalize(rest), version: Math.max(v, fromVersion), fromVersion, migrated: fromVersion < schema.version };
}

/**
 * Поля файла без `version` после миграций — для читателей с собственным нормализатором. Нормализатор
 * не видит служебное поле и не считает его неизвестной записью.
 */
export function stateFields(raw: unknown, version: number, migrations?: StateSchema<unknown>['migrations']): Record<string, unknown> {
  return upgradeState(raw, { version, migrations, normalize: (d) => d }).data;
}

/** Данные с полем `version` первым — так его видно при открытии файла. */
export function withVersion<T extends object>(version: number, data: T): { version: number } & T {
  return { version, ...data };
}
