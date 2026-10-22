/**
 * Ошибка main-процесса для человека кодом (TASK-202, [[decision-165]]): код и параметры, английский запасной текст в
 * `message`. Окно и телефон собирают текст по коду на своём языке (`appErrorText.ts`), журнал и модель видят английский.
 *
 * Electron передаёт из `ipcMain.handle` в окно только `message` исключения. Поэтому на пути IPC код едет последней
 * строкой-конвертом `[ph-error] {"code":…,"params":…}` (`withAppErrorEnvelope`), а в RPC телефона и результатах
 * `{ ok: false }` — отдельным полем `errorKey`.
 *
 * Чистый модуль без Electron и React: его используют main, окно и мобильный клиент.
 */
import { appErrorTextEn, type AppErrorCode, type AppErrorLabels } from '../i18n/appErrorText';

export type AppErrorParams = Record<string, string | number>;

export interface AppErrorKey {
  code: AppErrorCode;
  params?: AppErrorParams;
}

/** Начало строки-конверта в `message` ошибки, пришедшей через IPC. */
export const APP_ERROR_ENVELOPE = '[ph-error] ';

/** Префикс, который Electron дописывает к ошибке `ipcRenderer.invoke`. */
const ELECTRON_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

export function fillAppErrorTemplate(template: string, params: AppErrorParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}

/** Текст ошибки по коду и словарю; неизвестный словарю код — `null`. */
export function formatAppError(key: AppErrorKey, labels: Partial<AppErrorLabels>): string | null {
  const template = labels[key.code];
  return typeof template === 'string' ? fillAppErrorTemplate(template, key.params) : null;
}

export class AppError extends Error {
  readonly appErrorKey: AppErrorKey;

  constructor(code: AppErrorCode, params?: AppErrorParams) {
    const key: AppErrorKey = params ? { code, params } : { code };
    super(formatAppError(key, appErrorTextEn) ?? code);
    this.name = 'AppError';
    this.appErrorKey = key;
  }
}

/** Ключ из данных извне (конверт, RPC, результат): только код-строка и параметры-строки или числа. */
export function asAppErrorKey(value: unknown): AppErrorKey | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { code, params } = value as { code?: unknown; params?: unknown };
  if (typeof code !== 'string' || !code) return undefined;
  if (params === undefined) return { code: code as AppErrorCode };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const clean: AppErrorParams = {};
  for (const [name, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') clean[name] = v;
  }
  return { code: code as AppErrorCode, params: clean };
}

/** Ключ ошибки: у `AppError` и у ошибки, которой его приписали (`withAppErrorKey`). */
export function appErrorKeyOf(err: unknown): AppErrorKey | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return asAppErrorKey((err as { appErrorKey?: unknown }).appErrorKey);
}

/** Приписать ключ ошибке, пришедшей по сети (RPC телефона): текст остаётся английским запасным. */
export function withAppErrorKey<E extends Error>(err: E, key: unknown): E {
  const clean = asAppErrorKey(key);
  if (clean) Object.assign(err, { appErrorKey: clean });
  return err;
}

/** Для пути IPC: ошибка с ключом превращается в ошибку, у которой ключ — последней строкой `message`. */
export function withAppErrorEnvelope(err: unknown): unknown {
  const key = appErrorKeyOf(err);
  if (!key || !(err instanceof Error)) return err;
  const wrapped = new Error(`${err.message}\n${APP_ERROR_ENVELOPE}${JSON.stringify(key)}`);
  wrapped.stack = err.stack;
  return wrapped;
}

/** Текст без префикса Electron и без конверта, и ключ из конверта, если он был. */
export function parseAppErrorMessage(message: string): { text: string; key?: AppErrorKey } {
  const text = message.replace(ELECTRON_PREFIX, '');
  const at = text.lastIndexOf(`\n${APP_ERROR_ENVELOPE}`);
  if (at < 0) return { text };
  let key: AppErrorKey | undefined;
  try {
    key = asAppErrorKey(JSON.parse(text.slice(at + 1 + APP_ERROR_ENVELOPE.length)));
  } catch {
    key = undefined;
  }
  return { text: text.slice(0, at), key };
}
