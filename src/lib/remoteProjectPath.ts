/**
 * Виртуальный путь проекта другого ПК (TASK-280): `phr://<hostId>/<путь на хосте>`. Окно работает с удалённым
 * проектом теми же экранами, что с локальным; preload по такому пути понимает, что вызов надо исполнить на хосте, снимает
 * префикс с аргументов и возвращает его путям в ответе. Чистый модуль: его используют preload, окно и тесты.
 */

export const REMOTE_PATH_PREFIX = 'phr://';

/** Идентификатор хоста — без `/`: по первому `/` после префикса начинается путь на хосте. */
const REMOTE_PATH_RE = /^phr:\/\/([^/\\]+)\/(.+)$/s;

export interface RemotePathParts {
  hostId: string;
  hostPath: string;
}

export function toRemotePath(hostId: string, hostPath: string): string {
  return `${REMOTE_PATH_PREFIX}${hostId}/${hostPath}`;
}

export function parseRemotePath(value: string): RemotePathParts | null {
  if (!value.startsWith(REMOTE_PATH_PREFIX)) return null;
  const m = REMOTE_PATH_RE.exec(value);
  return m ? { hostId: m[1], hostPath: m[2] } : null;
}

export function isRemotePath(value: unknown): value is string {
  return typeof value === 'string' && parseRemotePath(value) !== null;
}

/** Хост удалённого пути или `null` для локального. */
export function remoteHostOf(value: string | null | undefined): string | null {
  return value ? parseRemotePath(value)?.hostId ?? null : null;
}

const MAX_DEPTH = 8;

/** Обход значения с заменой строк; объекты и массивы копируются, остальное возвращается как есть. */
function mapStrings(value: unknown, fn: (s: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1));
  // Не трогаем бинарные данные и прочие не-простые объекты: их IPC передаёт как есть.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn, depth + 1);
  return out;
}

export interface StrippedArgs {
  /** Хост вызова; `null` — в аргументах нет удалённых путей. */
  hostId: string | null;
  args: unknown[];
  /** Пути на хосте, встреченные в аргументах: по ним ответу возвращается префикс. */
  roots: string[];
}

/** Ошибка: в одном вызове пути двух разных ПК. */
export class MixedRemoteHostsError extends Error {
  constructor() {
    super('One call refers to projects of different computers');
    this.name = 'MixedRemoteHostsError';
  }
}

/** Снять префикс со всех удалённых путей в аргументах вызова. */
export function stripRemoteArgs(args: unknown[]): StrippedArgs {
  let hostId: string | null = null;
  const roots = new Set<string>();
  const mapped = args.map((arg) =>
    mapStrings(arg, (s) => {
      const parts = parseRemotePath(s);
      if (!parts) return s;
      if (hostId && hostId !== parts.hostId) throw new MixedRemoteHostsError();
      hostId = parts.hostId;
      roots.add(parts.hostPath);
      return parts.hostPath;
    })
  );
  return { hostId, args: mapped, roots: [...roots] };
}

/** Путь лежит внутри корня (или совпадает с ним): разделители `/` и `\` равноправны, корень хоста — как есть. */
export function isUnderRoot(value: string, root: string): boolean {
  if (!root) return false;
  if (value === root) return true;
  if (!value.startsWith(root)) return false;
  const next = value.charAt(root.length);
  return next === '/' || next === '\\' || root.endsWith('/') || root.endsWith('\\');
}

/** Вернуть префикс путям хоста в ответе или событии: строкам, лежащим в одном из известных корней. */
export function prefixHostPaths(value: unknown, hostId: string, roots: readonly string[]): unknown {
  if (roots.length === 0) return value;
  // Длинные корни первыми: worktree внутри проекта — тоже путь проекта, но так совпадение точнее.
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  // Многострочный текст (содержимое файла, вывод) — не путь, даже если начинается с пути проекта.
  return mapStrings(value, (s) => (!/[\r\n]/.test(s) && sorted.some((r) => isUnderRoot(s, r)) ? toRemotePath(hostId, s) : s));
}

/** Ключи, по которым значения считаются идентификаторами объектов хоста (сессия терминала, процесс, рой, запрос HITL). */
const ID_KEY_RE = /^(id|[a-z]+Id)$/;
const ID_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;

/**
 * Идентификаторы объектов в ответе или событии хоста. Последующий вызов с таким id (запись в терминал, остановка
 * процесса, решение HITL) идёт на тот же хост, хотя пути проекта в нём нет.
 */
export function collectIds(value: unknown, depth = 0, out: Set<string> = new Set()): Set<string> {
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, depth + 1, out);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      if (ID_KEY_RE.test(k) && ID_VALUE_RE.test(v)) out.add(v);
    } else {
      collectIds(v, depth + 1, out);
    }
  }
  return out;
}

/** Маршрут вызова по известным id: строки аргументов верхнего уровня и поля объектов первого уровня. */
export function routeByKnownIds<T>(args: unknown[], routes: ReadonlyMap<string, T>): T | null {
  if (routes.size === 0) return null;
  for (const arg of args) {
    if (typeof arg === 'string') {
      const route = routes.get(arg);
      if (route) return route;
    } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      for (const v of Object.values(arg as Record<string, unknown>)) {
        if (typeof v === 'string') {
          const route = routes.get(v);
          if (route) return route;
        }
      }
    }
  }
  return null;
}

/** Корень проекта для пути на хосте: самый длинный зарегистрированный корень, в котором он лежит, иначе сам путь. */
export function projectRootFor(hostPath: string, roots: Iterable<string>): string {
  let best: string | null = null;
  for (const r of roots) if (isUnderRoot(hostPath, r) && (!best || r.length > best.length)) best = r;
  return best ?? hostPath;
}
