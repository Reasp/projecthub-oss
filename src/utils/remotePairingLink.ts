/**
 * Ссылки сопряжения Remote Control (TASK-140.1). Общий модуль: QR в `RemoteControlBadge` строит
 * ссылки здесь, мобильный клиент (`mobile/src/protocol/pairing.ts`) разбирает тем же форматом.
 *
 * Ключ едет только в hash (`#key=…`): браузер не отправляет hash на сервер, поэтому ни туннель,
 * ни прокси его не видят. В `start_param` Telegram (≤ 64 символов `[A-Za-z0-9_-]`) hex-ключ из
 * 64 символов не помещается — туда кладётся base64url (`kb_` + 43 символа).
 *
 * Адреса хоста (TASK-140.9, decision-82) едут повторяемым параметром `ep` (`ep=l:192.168.1.5:42050`,
 * `ep=v:100.70.1.2:42050`, `ep=t:abc.trycloudflare.com`). Протокол v2 ([[TASK-140.2]], decision-111) добавил
 * ключ сессий хоста `hk` (ECDSA P-256, 87 символов base64url): клиент проверяет им подпись рукопожатия. В `start_param` Telegram
 * полный ключ не помещается — туда идёт его 96-битный отпечаток (`kc_` + ключ E2EE + отпечаток).
 */

import { decodeEndpointParam, encodeEndpointParam, relayEndpoint, type RemoteEndpoint } from './remoteEndpoints';

/** hex → base64url без `=`. */
export function hexToBase64Url(hex: string, encodeBase64: (s: string) => string = btoa): string {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return encodeBase64(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (без `=`) → hex; `null`, если строка не base64url. */
export function base64UrlToHex(value: string, decodeBase64: (s: string) => string = atob): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const bin = decodeBase64(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

export interface PairingSource {
  hostId: string;
  key: string;
  relayServerUrl: string;
  mode: 'lan' | 'relay';
  port: number;
  /** Первый адрес LAN; без него — `localhost`. */
  localIp?: string;
  /** Публичный HTTPS-туннель, если запущен. */
  tunnelUrl?: string;
  /** Все адреса хоста для телефона (`getStatus().endpoints`). */
  endpoints?: RemoteEndpoint[];
  /** Ключ сессий хоста в base64url (`getStatus().hostKey`). */
  hostKey?: string;
  /** Отпечаток ключа хоста (`getStatus().hostKeyFingerprint`). */
  hostKeyFingerprint?: string;
}

/**
 * Hash ссылки. Релей с адресом loopback (по умолчанию `ws://127.0.0.1:42055`) с телефона недостижим —
 * в ссылку он попадает, только если хост явно в режиме релея. Адрес страницы клиент берёт из самой
 * ссылки, поэтому повторять его в `ep` незачем.
 */
export function buildPairingHash(src: PairingSource, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ hostId: src.hostId, key: src.key });
  if (src.mode === 'relay' || relayEndpoint(src.relayServerUrl)) params.set('relay', src.relayServerUrl);
  params.set('mode', src.mode);
  if (src.hostKey) params.set('hk', src.hostKey);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const pageHost = clientPageOrigin(src).replace(/^https?:\/\//, '');
  const eps = (src.endpoints ?? [])
    .map(encodeEndpointParam)
    .filter((v): v is string => typeof v === 'string' && v.slice(2) !== pageHost);
  // `:` в hash допустим (RFC 3986), не кодируем его — QR остаётся меньше.
  return [params.toString(), ...eps.map((v) => `ep=${v}`)].join('&');
}

/** `start_param` Mini App с полным ключом и, если известен, отпечатком ключа хоста (62 символа из 64). */
export function buildTelegramStartParam(key: string, hostKeyFingerprint?: string): string {
  const keyPart = hexToBase64Url(key);
  if (hostKeyFingerprint && /^[A-Za-z0-9_-]{16}$/.test(hostKeyFingerprint) && keyPart.length === 43) return `kc_${keyPart}${hostKeyFingerprint}`;
  return `kb_${keyPart}`;
}

/**
 * Адрес страницы клиента. HTTPS-туннель предпочтительнее LAN: только в защищённом контексте
 * браузер даёт WebCrypto, без которого клиент не шифрует и не подключается (decision-80).
 */
export function clientPageOrigin(src: PairingSource): string {
  return src.tunnelUrl ? src.tunnelUrl.replace(/\/+$/, '') : `http://${src.localIp || 'localhost'}:${src.port}`;
}

/** Ссылка на встроенный клиент для QR. */
export function buildEmbeddedPairingUrl(src: PairingSource): string {
  return `${clientPageOrigin(src)}/remote#${buildPairingHash(src)}`;
}

/**
 * Ссылка приглашения по одноразовому коду (участник общего хоста, decision-126): страница клиента, хост, его ключ
 * сессий и адреса — но без ключа хоста. Код идёт в поле `pin`: клиент сопрягается им, как PIN, только по протоколу v2.
 */
export function buildInvitePairingUrl(src: PairingSource, code: string): string {
  return `${clientPageOrigin(src)}/remote#${buildPairingHash({ ...src, key: '' }, { pin: code })}`.replace('key=&', '');
}

/** Ссылка на Mini App: через бота (`startapp`), иначе страница Mini App на хосте с hash. */
export function buildTelegramPairingUrl(src: PairingSource, botUsername?: string): string {
  if (botUsername) return `https://t.me/${botUsername}?startapp=${buildTelegramStartParam(src.key, src.hostKeyFingerprint)}`;
  return `${clientPageOrigin(src)}/telegram#${buildPairingHash(src)}`;
}

/** Что форма удалённого ПК (hub-режим, TASK-166) берёт из ссылки сопряжения другого ПК. */
export interface PeerPairingFields {
  hostId: string;
  secretKey?: string;
  /** Ключ сессий хоста `hk`: с ним hub сразу идёт по v2. */
  hostKey?: string;
  /** Код приглашения участника (decision-138) — в поле PIN формы. */
  pin?: string;
  transport: 'lan' | 'relay';
  /** LAN: `host:port`; relay: URL релея. */
  address: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
const HOST_KEY = /^[A-Za-z0-9_-]{87}$/;

/** Схема ссылок приложения (decision-143 п. 4): `projecthub://pair?…` открывает форму добавления хоста. */
export const DESKTOP_LINK_SCHEME = 'projecthub';

function isLocalHostname(hostname: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
}

/** `addr` ссылки приложения: `host:port` страницы или `https://` туннеля. Loopback бесполезен на другом ПК. */
function addressParam(value: string | null): string {
  const v = value?.trim() ?? '';
  if (/^https:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return isLocalHostname(u.hostname) ? '' : u.origin;
    } catch {
      return '';
    }
  }
  const m = /^([A-Za-z0-9.-]{1,253})(?::\d{1,5})?$/.exec(v);
  return m && !isLocalHostname(m[1]) ? v : '';
}

/**
 * Ссылка для другого ПК: `projecthub://pair?<параметры ссылки сопряжения>&addr=<адрес страницы>`. Адрес страницы
 * в `projecthub://` не виден, поэтому едет параметром; секреты — те же, что в QR.
 */
export function buildDesktopPairingLink(src: PairingSource): string {
  const origin = clientPageOrigin(src);
  const addr = origin.startsWith('https://') ? origin : origin.replace(/^http:\/\//, '');
  return `${DESKTOP_LINK_SCHEME}://pair?${buildPairingHash(src, { addr })}`;
}

/** Страница клиента `http(s)://…/remote#…` → та же ссылка для приложения на этом ПК; `null` — не ссылка сопряжения. */
export function desktopLinkFromPage(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (!params.get('hostId')) return null;
  if (!isLocalHostname(url.hostname)) params.set('addr', url.protocol === 'https:' ? url.origin : url.host);
  return `${DESKTOP_LINK_SCHEME}://pair?${params.toString()}`;
}

/**
 * Ссылка сопряжения другого ПК в поля формы:
 * - `http(s)://<адрес>/remote#hostId=…&key=…&hk=…&ep=…` — адрес хоста самой ссылки;
 * - `projecthub://pair?…` (decision-143) — те же параметры в query или hash, адрес — параметр `addr`.
 *
 * Если адреса нет или он `localhost` — первый адрес LAN или VPN из `ep`; без них — релей. `null` — не ссылка.
 */
export function parsePeerPairingLink(text: string): PeerPairingFields | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const desktop = url.protocol === `${DESKTOP_LINK_SCHEME}:`;
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (desktop) for (const [k, v] of new URLSearchParams(url.search)) params.append(k, v);
  const hostId = params.get('hostId')?.trim() ?? '';
  if (!/^[A-Za-z0-9_.-]{3,128}$/.test(hostId)) return null;
  const key = params.get('key')?.trim();
  const hk = params.get('hk')?.trim();
  const pin = params.get('pin')?.trim();
  const fields: PeerPairingFields = { hostId, transport: 'lan', address: '' };
  if (key && HEX_KEY.test(key)) fields.secretKey = key.toLowerCase();
  if (hk && HOST_KEY.test(hk)) fields.hostKey = hk;
  if (pin && /^[A-Za-z0-9-]{4,64}$/.test(pin)) fields.pin = pin;
  if (desktop) {
    const addr = addressParam(params.get('addr'));
    if (addr) {
      fields.address = addr;
      return fields;
    }
  } else if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLocalHostname(url.hostname) && url.host) {
    fields.address = url.protocol === 'https:' ? url.origin : url.host;
    return fields;
  }
  const direct = params
    .getAll('ep')
    .map(decodeEndpointParam)
    .find((ep): ep is RemoteEndpoint => Boolean(ep && (ep.kind === 'lan' || ep.kind === 'vpn')));
  if (direct) {
    fields.address = new URL(direct.url).host;
    return fields;
  }
  const relay = params.get('relay')?.trim();
  if (relay && /^wss?:\/\//i.test(relay)) {
    fields.transport = 'relay';
    fields.address = relay;
  }
  return fields;
}
