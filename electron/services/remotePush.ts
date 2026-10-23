import crypto from 'node:crypto';
import net from 'node:net';
import { AppError } from '../../src/lib/appError.js';
import type { HitlRequest, HitlRisk } from './hitlTypes.js';
import { WEB_PUSH_MAX_PLAINTEXT, parseWebPushKeys } from './webPushCrypto.js';

/**
 * Зашифрованные push на телефон (TASK-140.3, [[decision-115]]): чистые функции без Electron — регистрация push
 * устройства, содержимое уведомления, когда его не слать, подпись запроса к шлюзу `ph-push` и проверка кнопок
 * уведомления. Отправку и хранение делает `remotePushService`.
 */

export type PushKind = 'unifiedpush' | 'fcm' | 'apns';

/** Регистрация push сопряжения: хранится в записи устройства в secretStorage рядом с токеном. */
export interface PushRegistration {
  kind: PushKind;
  /** UnifiedPush: адрес дистрибьютора, на который хост шлёт шифртекст напрямую. */
  endpoint?: string;
  /** FCM/APNs: токен устройства, уходит только в шлюз. */
  token?: string;
  /** Ключ получателя P-256 (несжатая точка) и секрет `auth` RFC 8291, base64url. */
  p256dh: string;
  auth: string;
  /** Ключ HMAC кнопок уведомления (32 байта, base64url): им телефон подписывает «Одобрить» и «Отклонить». */
  actionKey: string;
  /** Случайный id регистрации: по нему телефон выбирает ключ, когда push пришёл через FCM/APNs. */
  regId: string;
  createdAt: number;
}

const MAX_ENDPOINT = 1000;

/**
 * Адрес UnifiedPush: http(s) без логина и пароля, не loopback, не link-local (метаданные облака), не multicast.
 * Частная сеть разрешена — свой ntfy дома. Так сопряжённое устройство не направит запросы хоста на его же сервисы.
 */
export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224) return false;
  } else if (net.isIPv6(host)) {
    if (host === '::1' || host === '::' || /^fe[89ab]/.test(host) || host.startsWith('ff') || host.startsWith('::ffff:127.')) return false;
  }
  return true;
}

/** Разбор `push_register`; ошибка — текст для телефона. */
export function parsePushRegistration(params: Record<string, unknown>, now: number, random: () => Buffer = () => crypto.randomBytes(9)): PushRegistration {
  const raw = params.kind;
  if (raw !== 'unifiedpush' && raw !== 'fcm' && raw !== 'apns') throw new Error('kind must be unifiedpush, fcm or apns');
  const kind: PushKind = raw;
  if (!parseWebPushKeys(params.p256dh, params.auth)) throw new AppError('remote.pushKeysInvalid');
  const actionKey = typeof params.actionKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(params.actionKey) ? params.actionKey : '';
  if (!actionKey) throw new Error('actionKey is required');
  const base = { kind, p256dh: String(params.p256dh), auth: String(params.auth), actionKey, regId: random().toString('base64url'), createdAt: now };
  if (kind === 'unifiedpush') {
    if (!isAllowedPushEndpoint(params.endpoint)) throw new AppError('remote.unifiedPushEndpointInvalid');
    return { ...base, endpoint: params.endpoint };
  }
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  if (!/^[A-Za-z0-9_:.-]{20,4096}$/.test(token)) throw new Error('token is required');
  return { ...base, token };
}

/** Адрес хоста для кнопок уведомления: телефон шлёт решение сюда напрямую (LAN, VPN, туннель). */
export interface PushHostEndpoint {
  url: string;
  kind: string;
}

/** Открытый текст push: поля короткие, чтобы запись влезла в 3993 байта. */
export interface HitlPushPayload {
  v: 1;
  t: 'hitl';
  /** Хост и устройство: телефон открывает именно этот ПК и подписывает кнопку своим ключом. */
  hid: string;
  host: string;
  did: string;
  rid: string;
  title: string;
  /** Заголовок кодом (TASK-205): телефон собирает его на языке устройства, `title` — запасной английский текст. */
  tk?: HitlPushTextKey;
  cmd?: string;
  file?: string;
  risk: HitlRisk;
  why?: string;
  proj?: string;
  agent?: string;
  /** Может ли устройство решать: без права кнопок нет. */
  dec: boolean;
  ep: PushHostEndpoint[];
  ts: number;
}

/** Код заголовка в push — короткие поля, как весь пакет: код, цель, агент, параметры шаблона (TASK-202.8). */
export interface HitlPushTextKey {
  c: string;
  t?: string;
  a?: string;
  p?: Record<string, string>;
}

export interface HitlDonePushPayload {
  v: 1;
  t: 'hitl_done';
  hid: string;
  rid: string;
  ts: number;
}

export interface TestPushPayload {
  v: 1;
  t: 'test';
  hid: string;
  host: string;
  ts: number;
}

/** Сообщение агента `projecthub_notify` (TASK-140.5, decision-117 п. 8): текст только внутри шифртекста. */
export interface NotePushPayload {
  v: 1;
  t: 'note';
  hid: string;
  host: string;
  /** Id записи ленты: нажатие открывает «Входящие» этого ПК. */
  nid: string;
  text: string;
  lvl: 'info' | 'success' | 'warning' | 'error';
  proj?: string;
  agent?: string;
  ts: number;
}

/** Ход агента (TASK-140.7, decision-121 п. 1): постоянное уведомление и виджет на телефоне. */
export interface ProgressPushPayload {
  v: 1;
  t: 'prog';
  hid: string;
  host: string;
  /** Рой: по нему телефон обновляет одно и то же уведомление. */
  sid: string;
  title: string;
  st: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  step: string;
  pct?: number;
  proj?: string;
  ts: number;
}

export type PushPayload = HitlPushPayload | HitlDonePushPayload | TestPushPayload | NotePushPayload | ProgressPushPayload;

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function hitlPushPayload(
  request: HitlRequest,
  ctx: { hostId: string; machineName: string; deviceId: string; canDecide: boolean; endpoints: PushHostEndpoint[]; now: number }
): HitlPushPayload {
  return {
    v: 1,
    t: 'hitl',
    hid: ctx.hostId,
    host: ctx.machineName,
    did: ctx.deviceId,
    rid: request.id,
    title: request.title,
    ...(request.textKey
      ? {
          tk: {
            c: request.textKey.code,
            ...(request.textKey.target ? { t: request.textKey.target } : {}),
            ...(request.textKey.agent ? { a: request.textKey.agent } : {}),
            ...(request.textKey.params && Object.keys(request.textKey.params).length ? { p: request.textKey.params } : {})
          }
        }
      : {}),
    ...(request.command ? { cmd: request.command } : {}),
    ...(request.filePath ? { file: request.filePath } : {}),
    risk: request.risk ?? 'high',
    ...(request.riskReason ? { why: request.riskReason } : {}),
    ...(request.projectPath ? { proj: projectName(request.projectPath) } : {}),
    ...(request.agentName || request.role ? { agent: request.agentName || request.role } : {}),
    dec: ctx.canDecide,
    ep: ctx.endpoints.slice(0, 4),
    ts: ctx.now
  };
}

/**
 * JSON уведомления не длиннее предела записи: сначала сокращаются команда, путь и заголовок, затем убираются адреса.
 * Полный запрос телефон всё равно читает в приложении (`get_hitl_detail`).
 */
export function encodePushPayload(payload: PushPayload, limit = WEB_PUSH_MAX_PLAINTEXT): Buffer {
  const fits = (p: PushPayload) => Buffer.byteLength(JSON.stringify(p), 'utf8') <= limit;
  if (fits(payload)) return Buffer.from(JSON.stringify(payload), 'utf8');
  const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
  const cutParams = (p: Record<string, string> | undefined, n: number) =>
    p ? { p: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, cut(v, n)!])) } : {};
  const cutKey = (tk: HitlPushTextKey | undefined, n: number) => (tk ? { tk: { ...tk, ...(tk.t ? { t: cut(tk.t, n) } : {}), ...cutParams(tk.p, n) } } : {});
  if (payload.t === 'prog') {
    const p: ProgressPushPayload = { ...payload, title: cut(payload.title, 120)!, step: cut(payload.step, 160)!, proj: cut(payload.proj, 60) };
    if (fits(p)) return Buffer.from(JSON.stringify(p), 'utf8');
    throw new Error('Push payload is too large');
  }
  if (payload.t === 'note') {
    for (const n of [300, 120]) {
      const p: NotePushPayload = { ...payload, text: cut(payload.text, n)!, proj: cut(payload.proj, 60), agent: cut(payload.agent, 60) };
      if (fits(p)) return Buffer.from(JSON.stringify(p), 'utf8');
    }
    throw new Error('Push payload is too large');
  }
  if (payload.t !== 'hitl') throw new Error('Push payload is too large');
  for (const n of [1200, 600, 300, 160, 80]) {
    const p: HitlPushPayload = { ...payload, title: cut(payload.title, n)!, ...cutKey(payload.tk, n), cmd: cut(payload.cmd, n), file: cut(payload.file, n), why: cut(payload.why, 120) };
    if (fits(p)) return Buffer.from(JSON.stringify(p), 'utf8');
  }
  const bare: HitlPushPayload = { ...payload, title: cut(payload.title, 80)!, ...cutKey(payload.tk, 80), cmd: cut(payload.cmd, 80), file: cut(payload.file, 80), why: undefined, ep: [] };
  if (fits(bare)) return Buffer.from(JSON.stringify(bare), 'utf8');
  throw new Error('Push payload is too large');
}

/**
 * Не слать push, пока человек и так видит запрос: окно ProjectHub в фокусе и ПК не простаивает, или приложение на
 * этом телефоне открыто и на связи с этим хостом. Решает каждый хост сам за себя.
 */
export function shouldSuppressPush(state: { windowFocused: boolean; idleSeconds: number; deviceOnline: boolean }, activeIdleLimitSec = 120): boolean {
  if (state.deviceOnline) return true;
  return state.windowFocused && state.idleSeconds < activeIdleLimitSec;
}

// ── шлюз ph-push ──

export const GATEWAY_LABEL = 'projecthub-push-v1';

/** Что подписывает хост: время, разовое значение и хэш тела — подпись не переносится на другой запрос. */
export function gatewaySignedString(ts: number, nonce: string, body: Buffer | string): string {
  const hash = crypto.createHash('sha256').update(body).digest('base64url');
  return [GATEWAY_LABEL, String(ts), nonce, hash].join('\n');
}

export interface GatewayPushBody {
  kind: 'fcm' | 'apns';
  token: string;
  /** Шифртекст RFC 8291, base64url. */
  payload: string;
  regId: string;
  ttl: number;
  urgency: 'high' | 'normal';
  /** Заменить прежнее уведомление с тем же ключом (запрос решён — уведомление обновляется). */
  collapseKey?: string;
}

/** Заголовки запроса к шлюзу: ключ хоста (несжатая точка P-256), время, разовое значение, подпись ECDSA SHA-256. */
export function signGatewayRequest(body: string, hostKeyRaw: Buffer, privateKeyPem: string, now: number): Record<string, string> {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(gatewaySignedString(now, nonce, body)), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return {
    'Content-Type': 'application/json',
    'X-PH-Host-Key': hostKeyRaw.toString('base64url'),
    'X-PH-Timestamp': String(now),
    'X-PH-Nonce': nonce,
    'X-PH-Signature': signature.toString('base64url')
  };
}

// ── кнопки уведомления ──

export const PUSH_ACTION_LABEL = 'projecthub-push-action-v1';
/** Кнопка уведомления действительна 10 минут: телефон мог быть без сети. */
export const PUSH_ACTION_WINDOW_MS = 10 * 60_000;

export interface PushAction {
  deviceId: string;
  requestId: string;
  decision: 'allow' | 'deny';
  /** `notification` — кнопка на заблокированном экране, `unlocked` — после разблокировки (decision-112 п. 3). */
  confirm: 'notification' | 'unlocked';
  ts: number;
  mac: string;
}

export function pushActionString(hostId: string, a: Omit<PushAction, 'mac'>): string {
  return [PUSH_ACTION_LABEL, hostId, a.deviceId, a.requestId, a.decision, a.confirm, String(a.ts)].join('\n');
}

export function pushActionMac(actionKey: string, hostId: string, a: Omit<PushAction, 'mac'>): string {
  return crypto.createHmac('sha256', Buffer.from(actionKey, 'base64url')).update(pushActionString(hostId, a)).digest('base64url');
}

export function parsePushAction(value: unknown): PushAction | null {
  const v = (value || {}) as Record<string, unknown>;
  const str = (k: string, re: RegExp) => (typeof v[k] === 'string' && re.test(v[k] as string) ? (v[k] as string) : null);
  const deviceId = str('deviceId', /^[A-Za-z0-9_.:-]{1,128}$/);
  const requestId = str('requestId', /^[A-Za-z0-9_.:-]{1,128}$/);
  const mac = str('mac', /^[A-Za-z0-9_-]{43}$/);
  const decision = v.decision === 'allow' || v.decision === 'deny' ? v.decision : null;
  const confirm = v.confirm === 'notification' || v.confirm === 'unlocked' ? v.confirm : null;
  const ts = typeof v.ts === 'number' && Number.isFinite(v.ts) ? v.ts : null;
  if (!deviceId || !requestId || !mac || !decision || !confirm || ts === null) return null;
  return { deviceId, requestId, decision, confirm, ts, mac };
}

/** Подпись кнопки верна и свежая. Класс риска и права проверяет `hitlService.decide`, как для любого решения. */
export function verifyPushAction(actionKey: string, hostId: string, action: PushAction, now: number): boolean {
  if (Math.abs(now - action.ts) > PUSH_ACTION_WINDOW_MS) return false;
  const expected = Buffer.from(pushActionMac(actionKey, hostId, action), 'base64url');
  const got = Buffer.from(action.mac, 'base64url');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
