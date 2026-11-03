/**
 * Поиск в окне `/help` вкладки Claude Code (TASK-287): команда подходит, если запрос есть в её имени, описании или
 * подсказке аргументов, без учёта регистра; ведущий `/` запроса не мешает.
 */
export function commandMatches(command: { name: string; description?: string; argumentHint?: string }, query: string): boolean {
  const q = query.trim().replace(/^\//, '').toLocaleLowerCase();
  if (!q) return true;
  return [command.name, command.description ?? '', command.argumentHint ?? ''].some((part) => part.toLocaleLowerCase().includes(q));
}

/** Текст, который клик по команде вставляет в поле ввода: имя и пробел, если команде нужны аргументы. */
export function commandPrefill(name: string, argumentHint: string): string {
  return argumentHint.trim() ? `/${name} ` : `/${name}`;
}
