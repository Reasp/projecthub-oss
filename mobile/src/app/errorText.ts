/**
 * Текст ошибки для тоста и экрана на языке телефона (TASK-202, decision-165): ошибка RPC с кодом хоста собирается по
 * общему словарю `src/i18n/appErrorText.ts`, без кода — английский текст хоста как есть.
 */
import { appErrorText, appFailureText } from '../../../src/lib/appErrorText';
import { t } from '../i18n';

export function errorText(err: unknown): string {
  return appErrorText(err, t().models.appErrors);
}

/** Причина в данных хоста (`{ error, errorKey }`) на языке телефона. */
export function failureText(failure: { error?: string | null; errorKey?: unknown }): string {
  return appFailureText(failure, t().models.appErrors);
}
