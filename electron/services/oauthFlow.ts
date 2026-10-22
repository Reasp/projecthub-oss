import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthSpec } from './connectionCatalog.js';
import { redactSensitiveValues } from './sensitiveValues.js';
import { REDACTION_PATTERNS } from './secretPatterns.js';
import { AppError } from '../../src/lib/appError.js';

/**
 * Протокольная часть OAuth 2.0 для слоя подключений (decision-102 п. 3): PKCE (RFC 7636), адрес входа,
 * запросы к token endpoint, device flow (RFC 8628), проверка возврата на loopback. Без Electron и сети:
 * функции собирают запросы и разбирают ответы, отправляет их `connectionService`.
 */

export const DEVICE_SLOW_DOWN_STEP_SEC = 5;
export const DEFAULT_DEVICE_INTERVAL_SEC = 5;
export const CALLBACK_PATH = '/callback';

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Верификатор — 43 символа base64url из 32 случайных байт; вызов — SHA-256 от него (метод S256). */
export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64Url(random(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function createState(random: (size: number) => Buffer = randomBytes): string {
  return base64Url(random(24));
}

/** Сравнение за константное время: время ответа не выдаёт, сколько символов `state` совпало. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AuthorizeParams {
  spec: OAuthSpec;
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge?: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(p.spec.authorizeUrl(p.baseUrl));
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', p.state);
  if (p.scopes.length > 0) url.searchParams.set('scope', p.scopes.join(p.spec.scopeSeparator));
  if (p.spec.pkce && p.codeChallenge) {
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

/** Запрос к token endpoint: параметры в теле формы или в адресе (ClickUp). */
function tokenEndpointRequest(spec: OAuthSpec, url: string, params: Record<string, string | undefined>): HttpRequest {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') form.set(k, v);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (spec.tokenRequest === 'query') {
    const target = new URL(url);
    for (const [k, v] of form) target.searchParams.set(k, v);
    return { url: target.toString(), method: 'POST', headers };
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return { url, method: 'POST', headers, body: form.toString() };
}

export function buildCodeExchangeRequest(p: {
  spec: OAuthSpec;
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): HttpRequest {
  return tokenEndpointRequest(p.spec, p.spec.tokenUrl(p.baseUrl), {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.spec.pkce ? p.codeVerifier : undefined
  });
}

export function buildRefreshRequest(p: {
  spec: OAuthSpec;
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): HttpRequest {
  return tokenEndpointRequest(p.spec, p.spec.tokenUrl(p.baseUrl), {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    refresh_token: p.refreshToken
  });
}

export function buildDeviceCodeRequest(p: { spec: OAuthSpec; baseUrl: string; clientId: string; scopes: string[] }): HttpRequest {
  if (!p.spec.deviceCodeUrl) throw new AppError('connections.deviceCodeUnsupported');
  return tokenEndpointRequest({ ...p.spec, tokenRequest: 'form' }, p.spec.deviceCodeUrl(p.baseUrl), {
    client_id: p.clientId,
    scope: p.scopes.length > 0 ? p.scopes.join(p.spec.scopeSeparator) : undefined
  });
}

export function buildDevicePollRequest(p: {
  spec: OAuthSpec;
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  deviceCode: string;
}): HttpRequest {
  return tokenEndpointRequest({ ...p.spec, tokenRequest: 'form' }, p.spec.tokenUrl(p.baseUrl), {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    device_code: p.deviceCode
  });
}

/** Тело ответа как объект: JSON или форма (GitHub без `Accept: application/json`). */
export function parseResponseBody(bodyText: string, contentType: string | null | undefined): Record<string, unknown> {
  const text = (bodyText ?? '').trim();
  if (!text) return {};
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (ct.includes('x-www-form-urlencoded') || /^[\w.-]+=/.test(text)) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return {};
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

export type TokenResult = { ok: true; token: TokenSet } | { ok: false; error: string; description?: string; status: number };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Ответ token endpoint. GitHub сообщает об ошибке со статусом 200 и полем `error`, поэтому статус
 * успеха сам по себе ничего не значит.
 */
export function parseTokenResponse(status: number, contentType: string | null | undefined, bodyText: string, now: number): TokenResult {
  const body = parseResponseBody(bodyText, contentType);
  const error = str(body.error);
  const accessToken = str(body.access_token);
  if (error || !accessToken || status < 200 || status >= 300) {
    return {
      ok: false,
      error: error ?? (status >= 200 && status < 300 ? 'invalid_response' : `http_${status}`),
      description: str(body.error_description),
      status
    };
  }
  const expiresIn = Number(body.expires_in);
  const scope = str(body.scope);
  return {
    ok: true,
    token: {
      accessToken,
      refreshToken: str(body.refresh_token),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
      scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : undefined
    }
  };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSec: number;
}

export function parseDeviceCodeResponse(
  status: number,
  contentType: string | null | undefined,
  bodyText: string,
  now: number
): { ok: true; device: DeviceCode } | { ok: false; error: string; description?: string } {
  const body = parseResponseBody(bodyText, contentType);
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  // GitHub и GitLab называют поле `verification_uri`, старые черновики RFC — `verification_url`.
  const verificationUri = str(body.verification_uri) ?? str(body.verification_url);
  if (status < 200 || status >= 300 || !deviceCode || !userCode || !verificationUri) {
    return { ok: false, error: str(body.error) ?? `http_${status}`, description: str(body.error_description) };
  }
  const expiresIn = Number(body.expires_in);
  const interval = Number(body.interval);
  return {
    ok: true,
    device: {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: str(body.verification_uri_complete),
      expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
      intervalSec: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DEVICE_INTERVAL_SEC
    }
  };
}

export type DevicePollStep = { action: 'wait'; intervalSec: number } | { action: 'fail'; reason: 'expired' | 'denied' | 'error' };

/** Что делать после ошибки опроса device flow (RFC 8628 §3.5). */
export function nextDevicePollStep(error: string, intervalSec: number): DevicePollStep {
  if (error === 'authorization_pending') return { action: 'wait', intervalSec };
  if (error === 'slow_down') return { action: 'wait', intervalSec: intervalSec + DEVICE_SLOW_DOWN_STEP_SEC };
  if (error === 'expired_token') return { action: 'fail', reason: 'expired' };
  if (error === 'access_denied') return { action: 'fail', reason: 'denied' };
  return { action: 'fail', reason: 'error' };
}

export type CallbackCheck = { ok: true; code: string } | { ok: false; error: 'path' | 'state' | 'denied' | 'noCode'; detail?: string };

/** Проверка запроса на loopback: путь, `state`, отказ пользователя, наличие кода. */
export function checkCallback(requestUrl: string, expectedState: string): CallbackCheck {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) return { ok: false, error: 'path' };
  const state = url.searchParams.get('state') ?? '';
  if (!state || !safeEqual(state, expectedState)) return { ok: false, error: 'state' };
  const err = url.searchParams.get('error');
  if (err) return { ok: false, error: 'denied', detail: err };
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, error: 'noCode' };
  return { ok: true, code };
}

/**
 * Текст ошибки сервиса для статуса и лога: код и описание, без значений секретов, не длиннее 200 символов.
 * Тела ответов целиком наружу не отдаются (decision-102 п. 8).
 */
export function describeOAuthError(error: string, description?: string): string {
  let text = description ? `${error}: ${description}` : error;
  text = redactSensitiveValues(text);
  for (const [re, replacement] of REDACTION_PATTERNS) text = text.replace(re, replacement);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
