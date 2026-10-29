/**
 * Запрет исходящих вызовов в закрытом контуре (TASK-147.1, [[decision-186]] п. 2). Ставится до старта сервисов:
 * обёртки на `globalThis.fetch` и `http(s).request`/`get` (их используют `ws` и библиотеки) отклоняют адреса вне
 * контура ошибкой `network.airGappedBlocked`; сессии Electron (окно, `net`) режутся через `webRequest`.
 * Без режима ничего не ставится — поведение приложения не меняется.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';
import { egressDecision, OPEN_NETWORK_POLICY, parseNetworkPolicy, type NetworkPolicy } from './networkPolicy.js';

/** Файл политики администратора в каталоге данных приложения. */
export const NETWORK_POLICY_FILE = 'network-policy.json';

let activePolicy: NetworkPolicy = OPEN_NETWORK_POLICY;

/** Политика, с которой запущено приложение: сервисы с автоматическими вызовами по ней молчат в закрытом контуре. */
export function getNetworkPolicy(): NetworkPolicy {
  return activePolicy;
}

/** Читает политику из `<userData>/network-policy.json` и окружения и делает её текущей. */
export function loadNetworkPolicy(userDataDir: string, env: Record<string, string | undefined> = process.env): NetworkPolicy {
  let file: unknown = null;
  try {
    file = JSON.parse(readFileSync(path.join(userDataDir, NETWORK_POLICY_FILE), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn(`[NetworkGuard] ${NETWORK_POLICY_FILE} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  activePolicy = parseNetworkPolicy(file, env);
  return activePolicy;
}

export interface EgressGuardTargets {
  global: { fetch: typeof fetch };
  http: Pick<typeof http, 'request' | 'get'>;
  https: Pick<typeof https, 'request' | 'get'>;
  onBlocked?: (host: string, via: string) => void;
}

export function airGappedError(host: string): AppError {
  return new AppError('network.airGappedBlocked', { host });
}

function urlOfFetchInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  return null;
}

/** Адрес запроса `http.request(url | options, [options], [cb])` в виде URL для проверки. */
type HttpOptions = { protocol?: string; hostname?: string; host?: string; port?: number | string; socketPath?: string };

/** Имя хоста из `options.host`: порт срезается только у имени, IPv4 и `[IPv6]:порт` — голый IPv6 остаётся целым. */
function hostOfOption(host: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1];
  return (host.match(/:/g) ?? []).length === 1 ? host.replace(/:\d*$/, '') : host;
}

export function urlOfHttpArgs(args: unknown[], defaultProtocol: 'http:' | 'https:'): string | null {
  const [first, second] = args;
  const base = typeof first === 'string' ? first : first instanceof URL ? first.href : null;
  // Node накладывает `options` поверх URL: хост из второго аргумента главнее хоста адреса.
  const opts = (base ? (second && typeof second === 'object' ? second : null) : first && typeof first === 'object' ? first : null) as HttpOptions | null;
  // Сокет Unix или именованный канал — не сеть.
  if (opts?.socketPath) return null;
  const optHost = opts?.hostname ?? (opts?.host ? hostOfOption(String(opts.host)) : undefined);
  if (base && !optHost) return base;
  let protocol = opts?.protocol ?? defaultProtocol;
  if (base) {
    try {
      protocol = opts?.protocol ?? new URL(base).protocol;
    } catch {
      return base;
    }
  }
  const host = optHost ?? 'localhost';
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}//${bracketed}${opts?.port ? `:${opts.port}` : ''}/`;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/** Ставит обёртки; возвращает функцию снятия (для тестов). Без режима — ничего не делает. */
export function installEgressGuard(policy: NetworkPolicy, targets: EgressGuardTargets = { global: globalThis, http, https }): () => void {
  if (!policy.airGapped) return () => {};
  const restore: Array<() => void> = [];
  const check = (url: string | null, via: string): void => {
    if (!url) return;
    const decision = egressDecision(url, policy);
    if (decision.allowed) return;
    targets.onBlocked?.(decision.host, via);
    throw airGappedError(decision.host);
  };

  const originalFetch = targets.global.fetch;
  // Переадресация проверяется на каждом шаге: сервис внутри контура не уведёт запрос наружу ответом 30x.
  const guardedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const first = urlOfFetchInput(input);
    check(first, 'fetch');
    const follow = init?.redirect === undefined || init.redirect === 'follow';
    if (!follow || !first) return originalFetch(input, init);
    let url: string = first;
    let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let options: RequestInit = { ...init, redirect: 'manual' };
    let response = await originalFetch(input, options);
    for (let hop = 0; hop < MAX_REDIRECTS && REDIRECTS.has(response.status); hop++) {
      const location = response.headers.get('location');
      if (!location) break;
      const next: string = new URL(location, url).href;
      check(next, 'fetch redirect');
      // Как браузер: 303 и 301/302 после POST идут GET без тела.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        options = { ...options, method, body: undefined };
      }
      url = next;
      response = await originalFetch(next, options);
    }
    return response;
  };
  targets.global.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => guardedFetch(input, init)) as typeof fetch;
  restore.push(() => {
    targets.global.fetch = originalFetch;
  });

  for (const [mod, protocol] of [[targets.http, 'http:'], [targets.https, 'https:']] as const) {
    for (const method of ['request', 'get'] as const) {
      const original = mod[method] as (...args: unknown[]) => http.ClientRequest;
      // Запрос вне контура не создаётся вовсе: исключение до открытия сокета.
      (mod as Record<string, unknown>)[method] = (...args: unknown[]) => {
        check(urlOfHttpArgs(args, protocol), `${protocol.slice(0, -1)}.${method}`);
        return original.apply(mod, args);
      };
      restore.push(() => {
        (mod as Record<string, unknown>)[method] = original;
      });
    }
  }
  return () => restore.reverse().forEach((undo) => undo());
}

/** Минимальная часть `Session` Electron, нужная запрету. */
export interface GuardableSession {
  webRequest: { onBeforeRequest: (listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) => void };
}

/** Запрет для сессии Electron: окно и `net` не выходят за контур. */
export function guardSession(session: GuardableSession, policy: NetworkPolicy, onBlocked?: (host: string, via: string) => void): void {
  if (!policy.airGapped) return;
  session.webRequest.onBeforeRequest((details, callback) => {
    const decision = egressDecision(details.url, policy);
    if (!decision.allowed) onBlocked?.(decision.host, 'session');
    callback({ cancel: !decision.allowed });
  });
}
