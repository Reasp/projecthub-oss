/**
 * Дополнительные каталоги вкладки Agents Studio — `/add-dir` Claude Code (TASK-285). Ходы вкладки идут с `--add-dir`,
 * политика HITL пускает чтение в них без карточки, а запись — только по решению человека. Модуль чистый: его берут и
 * окно (список вкладки), и main (запись сессии на диск, запуск CLI).
 */

/** Сколько каталогов держит одна вкладка. */
export const MAX_ADD_DIRS = 20;
/** Предел длины пути: длиннее — испорченная запись, а не каталог. */
export const MAX_ADD_DIR_LENGTH = 1000;

/** Ключ сравнения путей: разделители и завершающий слэш не важны, регистр — тоже (Windows и macOS). */
function dirKey(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Список каталогов вкладки из чего угодно: строки без пустых и повторов, не длиннее пределов. */
export function normalizeAddDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const dir = raw.trim();
    if (!dir || dir.length > MAX_ADD_DIR_LENGTH || dir.includes('\0')) continue;
    const key = dirKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
    if (out.length >= MAX_ADD_DIRS) break;
  }
  return out;
}

/** Каталог уже есть в списке (тот же путь в другом написании). */
export function hasAddDir(dirs: readonly string[] | undefined, dir: string): boolean {
  const key = dirKey(dir.trim());
  return (dirs ?? []).some((d) => dirKey(d) === key);
}

/** Список с добавленным каталогом; повтор не добавляется, сверх предела — тоже. */
export function withAddDir(dirs: readonly string[] | undefined, dir: string): string[] {
  return normalizeAddDirs([...(dirs ?? []), dir]);
}

/** Список без каталога. */
export function withoutAddDir(dirs: readonly string[] | undefined, dir: string): string[] {
  const key = dirKey(dir.trim());
  return (dirs ?? []).filter((d) => dirKey(d) !== key);
}

/**
 * Аргумент `/add-dir` как в терминале: путь может быть в кавычках, пустой аргумент — выбор каталога в системном
 * диалоге.
 */
export function addDirArgument(rest: string): string {
  const arg = rest.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(arg);
  return (quoted ? quoted[2] : arg).trim();
}
