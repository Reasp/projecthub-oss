/**
 * Подписи окна `/memory` Agents Studio (TASK-286): короткий путь файла относительно каталога вкладки и порядок строк.
 * Без React и Electron — покрыто unit-тестами.
 */

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Путь внутри каталога вкладки — `./CLAUDE.md`; вне его — полный путь как есть. */
export function memoryPathLabel(filePath: string, workDir: string): string {
  const file = norm(filePath);
  const root = norm(workDir);
  if (!root) return filePath;
  // Пути Windows сравниваются без учёта регистра, как их сравнивает система.
  const windows = /^[a-z]:\//i.test(root);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const prefix = file.slice(0, root.length + 1);
  if (file.length > root.length && same(prefix, `${root}/`)) return `./${file.slice(root.length + 1)}`;
  return filePath;
}

/** Совпадение путей с учётом разделителей и регистра диска Windows. */
export function sameMemoryPath(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return /^[a-z]:\//i.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Время изменения записи памяти: дата для старых, время для сегодняшних. */
export function memoryModifiedLabel(ms: number, now: number, locale: string): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(locale);
}
