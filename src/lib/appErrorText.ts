/**
 * Текст ошибки main-процесса для человека на языке клиента (TASK-202, [[decision-165]]). Одна утилита на окно и
 * мобильный клиент вместо копий `cleanIpcError` и прямых `err.message`.
 *
 * Чистый модуль без React и Electron.
 */
import type { AppErrorLabels } from '../i18n/appErrorText';
import { appErrorKeyOf, asAppErrorKey, formatAppError, parseAppErrorMessage } from './appError';

/**
 * Ошибка из `invoke`, RPC или кода клиента. Ключ ищется у самой ошибки, затем в конверте `message`; текст собирается по
 * словарю. Без ключа или с кодом, которого словарь не знает (клиент старее main), — английский текст без префикса
 * Electron и без конверта.
 */
export function appErrorText(err: unknown, labels: AppErrorLabels): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  const parsed = parseAppErrorMessage(message);
  const key = appErrorKeyOf(err) ?? parsed.key;
  return (key && formatAppError(key, labels)) ?? parsed.text;
}

/** Результат `{ ok: false, error, errorKey }`: текст по ключу, иначе `error` как есть. */
export function appFailureText(failure: { error?: string | null; errorKey?: unknown }, labels: AppErrorLabels): string {
  const key = asAppErrorKey(failure.errorKey);
  return (key && formatAppError(key, labels)) ?? parseAppErrorMessage(failure.error ?? '').text;
}
