/**
 * Текст ошибки для тоста и экрана на языке телефона (TASK-202, decision-165): ошибка RPC с кодом хоста собирается по
 * общему словарю `src/i18n/appErrorText.ts`, без кода — английский текст хоста как есть.
 */
import { appErrorText } from '../../../src/lib/appErrorText';
import { t } from '../i18n';

export function errorText(err: unknown): string {
  return appErrorText(err, t().models.appErrors);
}
