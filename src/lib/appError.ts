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

/**
 * Параметр — строка, число или вложенная ошибка с кодом: причина внутри ошибки («агент не запустился: <причина>»)
 * собирается по тому же словарю на том же языке, а не английским текстом.
 */
export type AppErrorParam = string | number | AppErrorKey;
export type AppErrorParams = Record<string, AppErrorParam>;

export interface AppErrorKey {
  code: AppErrorCode;
  params?: AppErrorParams;
}

/** Начало строки-конверта в `message` ошибки, пришедшей через IPC. */
export const APP_ERROR_ENVELOPE = '[ph-error] ';

/** Префикс, который Electron дописывает к ошибке `ipcRenderer.invoke`. */
const ELECTRON_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

/** Вложенная ошибка без словаря или с неизвестным ему кодом подставляется своим кодом. */
export function fillAppErrorTemplate(template: string, params: AppErrorParams | undefined, labels?: Partial<AppErrorLabels>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => {
    if (!(name in params)) return all;
    const value = params[name];
    if (typeof value !== 'object') return String(value);
    return (labels && formatAppError(value, labels)) ?? value.code;
  });
}

/** Текст ошибки по коду и словарю; неизвестный словарю код — `null`. */
export function formatAppError(key: AppErrorKey, labels: Partial<AppErrorLabels>): string | null {
  const template = labels[key.code];
  return typeof template === 'string' ? fillAppErrorTemplate(template, key.params, labels) : null;
}

export class AppError extends Error {
  readonly appErrorKey: AppErrorKey;

  /** Вложенную `AppError` в параметрах можно передать как есть: в ключ попадёт её код. */
  constructor(code: AppErrorCode, params?: Record<string, AppErrorParam | AppError>) {
    const clean = params
      ? Object.fromEntries(Object.entries(params).map(([name, v]) => [name, v instanceof AppError ? v.appErrorKey : v]))
      : undefined;
    const key: AppErrorKey = clean ? { code, params: clean } : { code };
    super(formatAppError(key, appErrorTextEn) ?? code);
    this.name = 'AppError';
    this.appErrorKey = key;
  }
}

/** Ключ из данных извне (конверт, RPC, результат): только код-строка и параметры-строки, числа или вложенные ключи. */
export function asAppErrorKey(value: unknown, depth = 0): AppErrorKey | undefined {
  if (!value || typeof value !== 'object' || depth > 3) return undefined;
  const { code, params } = value as { code?: unknown; params?: unknown };
  if (typeof code !== 'string' || !code) return undefined;
  if (params === undefined) return { code: code as AppErrorCode };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const clean: AppErrorParams = {};
  for (const [name, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') clean[name] = v;
    else {
      const nested = asAppErrorKey(v, depth + 1);
      if (nested) clean[name] = nested;
    }
  }
  return { code: code as AppErrorCode, params: clean };
}

/** Ключ ошибки: у `AppError` и у ошибки, которой его приписали (`withAppErrorKey`). */
export function appErrorKeyOf(err: unknown): AppErrorKey | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return asAppErrorKey((err as { appErrorKey?: unknown }).appErrorKey);
}

/** Поля ошибки для результата или состояния `{ error, errorKey }`: английский текст и код рядом, если он есть. */
export function appErrorFields(err: unknown): { error: string; errorKey?: AppErrorKey } {
  const key = appErrorKeyOf(err);
  const error = err instanceof Error ? err.message : String(err);
  return key ? { error, errorKey: key } : { error };
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
