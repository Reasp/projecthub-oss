/**
 * Текст ошибки для тоста и экрана на языке телефона (TASK-202, decision-165): ошибка RPC с кодом хоста собирается по
 * общему словарю `src/i18n/appErrorText.ts`, без кода — английский текст хоста как есть.
 */
import { appErrorText, appFailureText } from '../../../src/lib/appErrorText';
import { providerErrorAdvice, providerErrorTitle } from '../../../src/lib/providerErrorView';
import type { ProviderErrorInfo } from '../../../src/types/electron';
import { t } from '../i18n';

export function errorText(err: unknown): string {
  return appErrorText(err, t().models.appErrors);
}

/** Причина в данных хоста (`{ error, errorKey }`) на языке телефона. */
export function failureText(failure: { error?: string | null; errorKey?: unknown }): string {
  return appFailureText(failure, t().models.appErrors);
}

/** Ошибка агента: по снимку провайдера — что случилось и что сделать из общего словаря, иначе код или текст хоста. */
export function agentErrorText(agent: { error?: string | null; errorKey?: unknown; providerError?: ProviderErrorInfo }): string {
  const info = agent.providerError;
  if (!info) return failureText(agent);
  const dict = t().models.providerErrors;
  const title = providerErrorTitle(info, dict);
  const advice = providerErrorAdvice(info, dict, t().models.appErrors);
  return advice ? `${title}. ${advice}` : title;
}
