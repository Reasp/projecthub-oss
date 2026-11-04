/**
 * Буфер вывода сессии терминала в main (TASK-292, decision-216): окно, открывшее терминал позже первого вывода
 * (окно входа, переключение вкладки, повторно открытая панель), сначала получает накопленный вывод, затем живой поток.
 * Без него Ink-интерфейс Claude Code терял первый кадр и дальше дорисовывал только изменённые строки.
 */

/** Сколько последних символов вывода держать на сессию. */
export const PTY_OUTPUT_CAP = 512 * 1024;
/** Насколько дальше точки отреза искать перевод строки, чтобы не начинать буфер с середины escape-последовательности. */
const LINE_SEARCH_WINDOW = 4096;

/** Дописать вывод с ограничением по размеру; отрез — по ближайшему переводу строки после лишней части. */
export function appendPtyOutput(buffer: string, chunk: string, cap: number = PTY_OUTPUT_CAP): string {
  const combined = buffer + chunk;
  if (combined.length <= cap) return combined;
  const cut = combined.length - cap;
  const newline = combined.indexOf('\n', cut);
  return newline >= 0 && newline - cut <= LINE_SEARCH_WINDOW ? combined.slice(newline + 1) : combined.slice(cut);
}
