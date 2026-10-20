import type { FieldValues, RemoteStatus, RemoteTask, TrackerTarget, TrackerTargetGroup } from './trackerTypes.js';

/**
 * Модель адаптеров трекеров (TASK-128, decision-103 п. 1; ссылки от адреса подключения — TASK-129, decision-106)
 * и общий запрос к API с ожиданием лимитов. Сеть адаптер получает функцией `http` поверх подключения
 * (decision-102 п. 7) и токенов не видит. Чистый модуль: без Electron.
 */

export type TrackerHttp = (path: string, init?: RequestInit) => Promise<Response>;

export interface NewRemoteTask {
  title: string;
  description: string;
  status?: string;
  parentId?: string;
}

/**
 * Откуда адаптер строит и узнаёт свои ссылки (decision-106 п. 2): адрес веб-интерфейса подключения
 * (GitHub Enterprise, Jira Server) и адрес задачи из ответа сервиса (рабочее пространство Linear).
 */
export interface TrackerLinkContext {
  /** База подключения: `https://github.com`, `https://acme.atlassian.net`. */
  webBase: string;
  /** Адрес задачи, который вернул сервис. */
  url?: string;
}

export interface TrackerAdapter {
  id: string;
  label: string;
  /** Сервис слоя подключений (decision-102). */
  serviceId: string;
  listTargets(http: TrackerHttp): Promise<TrackerTargetGroup[]>;
  getStatuses(http: TrackerHttp, target: TrackerTarget): Promise<RemoteStatus[]>;
  listTasks(http: TrackerHttp, target: TrackerTarget): Promise<RemoteTask[]>;
  getTask(http: TrackerHttp, id: string): Promise<RemoteTask | null>;
  createTask(http: TrackerHttp, target: TrackerTarget, task: NewRemoteTask): Promise<RemoteTask>;
  updateTask(http: TrackerHttp, id: string, fields: Partial<FieldValues>): Promise<RemoteTask>;
  /** Ссылка для `references` задачи (decision-103 п. 2). */
  linkFor(id: string, ctx?: TrackerLinkContext): string;
  /** id внешней задачи из ссылки; `null` — ссылка не этого адаптера или не этого подключения. */
  parseLink(reference: string, ctx?: TrackerLinkContext): string | null;
}

export class TrackerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'TrackerHttpError';
  }
}

export interface TrackerCallOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Сколько раз повторять ответ о превышении лимита. */
  maxRetries?: number;
}

export const MAX_RATE_WAIT_MS = 60_000;

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * Сколько ждать перед повтором, если сервис ответил о лимите: `Retry-After` (секунды),
 * `X-RateLimit-Reset` (секунды эпохи; GitHub — с 403 и нулём оставшихся запросов). `null` — это не лимит.
 */
export function rateLimitWaitMs(res: Response, now: number): number | null {
  const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  if (!limited) return null;
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000 - now;
  return 1000;
}

/**
 * Запрос JSON к API трекера: ожидание лимита (не дольше `MAX_RATE_WAIT_MS`, decision-103 п. 7) и ошибка
 * `TrackerHttpError` с кодом и сообщением, которые достаёт `describe` из тела ответа.
 */
export async function callTrackerJson(
  http: TrackerHttp,
  path: string,
  init: RequestInit | undefined,
  options: TrackerCallOptions & {
    label: string;
    describe: (json: unknown, status: number) => { code?: string; message?: string };
    /** Заголовки успешного ответа — для постраничного чтения по `Link` (GitHub). */
    onHeaders?: (headers: Headers) => void;
  }
): Promise<unknown> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const res = await http(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }
    });
    const wait = rateLimitWaitMs(res, now());
    if (wait !== null && attempt < maxRetries) {
      await sleep(Math.min(Math.max(wait, 1000), MAX_RATE_WAIT_MS));
      continue;
    }
    const body = await res.text();
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const d = options.describe(json, res.status);
      throw new TrackerHttpError(res.status, d.code || `http_${res.status}`, d.message || `${options.label} ответил ${res.status}`);
    }
    options.onHeaders?.(res.headers);
    return json;
  }
}

/** Адрес без завершающего `/` для сравнения ссылок. */
export function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Время из ответа сервиса в мс; Jira пишет смещение без двоеточия (`+0000`). */
export function parseTime(value: unknown): number {
  const s = text(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}
