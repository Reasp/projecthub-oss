/**
 * Текст пойманной ошибки для журнала и английского запасного `error` (TASK-241): ровно `err?.message || String(err)`,
 * но для `unknown` в `catch` без `any`.
 */
export function errorMessage(err: unknown): string {
  const message = err !== null && err !== undefined ? (err as { message?: unknown }).message : undefined;
  return message ? String(message) : String(err);
}
