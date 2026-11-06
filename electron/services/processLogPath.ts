import path from 'node:path';

/** Набор функций path: обычный модуль или `path.win32`/`path.posix` (тесты под обе ОС). */
export type PathApi = typeof path;

/**
 * Файл лога env-tools для имени процесса или null, если имя выводит путь за пределы каталога логов
 * (TASK-264). Имя приходит снаружи — из RPC `get_process_logs` телефона и из рендерера, — поэтому
 * допускается только один сегмент пути: без разделителей `/` и `\`, без `:` (буква диска и
 * альтернативные потоки NTFS), без управляющих символов, не `.`, не `..` и не имя устройства Windows. Итоговый путь
 * дополнительно сверяется через `path.relative`: он обязан лежать прямо в `logsDir`.
 */
export function processLogFile(logsDir: string, processName: string, pathApi: PathApi = path): string | null {
  if (typeof processName !== 'string') return null;
  const name = processName.trim();
  if (!name || name !== processName) return null;
  if (name === '.' || name === '..') return null;
  // eslint-disable-next-line no-control-regex -- управляющие символы в имени файла запрещены намеренно
  if (/[\\/:\u0000-\u001f]/.test(name)) return null;
  // Имена устройств Windows (`CON.log`, `nul.x.log` до Windows 11 — устройство, а не файл): чтение
  // консоли повисло бы. Запрещены на любой ОС — лог должен открываться одинаково везде.
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(name)) return null;
  const file = pathApi.join(logsDir, `${name}.log`);
  const rel = pathApi.relative(pathApi.resolve(logsDir), pathApi.resolve(file));
  if (!rel || rel.startsWith('..') || pathApi.isAbsolute(rel) || rel.includes(pathApi.sep)) return null;
  return file;
}
