import type { DeviceRights, RemoteConnectionMode } from '../../../src/types/remote';
import { base64UrlToHex } from '../../../src/utils/remotePairingLink';

/**
 * Профиль сопряжённого хоста (TASK-140.1). Хранится в защищённом хранилище платформы
 * (`platform/*`): в браузере и Mini App — в хранилище страницы, как раньше, в приложении —
 * только в Keychain/Keystore (decision-79 п. 2).
 */
export interface HostProfile {
  /** Идентификатор хоста; до первого `handshake_ack` может быть пустым. */
  hostId: string;
  machineName?: string;
  /** E2EE-ключ хоста (hex, 64 символа). Без ключа клиент не подключается: открытым текстом не говорим. */
  key: string;
  /** PIN нужен только для первого сопряжения и не сохраняется. */
  pin?: string;
  mode: RemoteConnectionMode;
  /** Адрес для LAN Direct: `host:port` или `http(s)://host[:port]`. */
  lanAddress?: string;
  relayUrl?: string;
  deviceId: string;
  /** Per-device токен, выданный хостом при сопряжении. */
  deviceToken?: string;
  rights?: DeviceRights;
}

/** То, что приходит в ссылке сопряжения (QR, deep-link Telegram, вставленный текст). */
export interface PairingLink {
  hostId?: string;
  key?: string;
  pin?: string;
  relayUrl?: string;
  mode?: RemoteConnectionMode;
  lanAddress?: string;
}

const KEY_RE = /^[0-9a-f]{64}$/i;

export function isValidKeyHex(key: string | undefined | null): key is string {
  return typeof key === 'string' && KEY_RE.test(key.trim());
}

function normalizeMode(value: string | null | undefined): RemoteConnectionMode | undefined {
  if (value === 'relay' || value === 'lan') return value;
  return undefined;
}

function setIf<K extends keyof PairingLink>(target: PairingLink, key: K, value: PairingLink[K] | null | undefined): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value as PairingLink[K];
}

/**
 * Разбор hash ссылки сопряжения: `#hostId=…&key=…&pin=…&relay=…&mode=…&host=…`. Формат задаёт
 * `RemoteControlBadge` (QR встроенного клиента и Mini App). `host` — адрес LAN, но в старых
 * ссылках туда попадал идентификатор машины `ph_host_…`, его переносим в `hostId`.
 */
export function parsePairingHash(hash: string): PairingLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const link: PairingLink = {};
  setIf(link, 'key', params.get('key')?.trim());
  setIf(link, 'pin', params.get('pin')?.trim());
  setIf(link, 'hostId', params.get('hostId')?.trim());
  setIf(link, 'relayUrl', params.get('relay')?.trim());
  setIf(link, 'mode', normalizeMode(params.get('mode')));

  const host = params.get('host')?.trim();
  if (host) {
    if (host.startsWith('ph_host_')) {
      if (!link.hostId) link.hostId = host;
    } else {
      link.lanAddress = host;
    }
  }
  return link;
}

/**
 * `start_param` Telegram (`?startapp=` в ссылке бота, не длиннее 64 символов `[A-Za-z0-9_-]`):
 * `kb_<base64url>` — ключ целиком, `k_<hex>` — ключ в hex (старые ссылки), `host_<hostId>` —
 * хост для релея; иначе base64 от query-строки или JSON. Совместимо со ссылками старой Mini App.
 */
export function parseTelegramStartParam(startParam: string, decodeBase64: (s: string) => string = atob): PairingLink {
  const value = startParam.trim();
  if (!value) return {};
  if (value.startsWith('kb_')) {
    const hex = base64UrlToHex(value.slice(3), decodeBase64);
    return hex && isValidKeyHex(hex) ? { key: hex } : {};
  }
  if (value.startsWith('k_')) return { key: value.slice(2) };
  if (value.startsWith('host_')) return { hostId: value.slice(5), mode: 'relay' };

  try {
    const decoded = decodeBase64(value);
    if (decoded.includes('key=')) return parsePairingHash(decoded);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const link: PairingLink = {};
    const str = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined);
    setIf(link, 'key', str('key'));
    setIf(link, 'pin', str('pin'));
    setIf(link, 'hostId', str('hostId'));
    setIf(link, 'relayUrl', str('relay'));
    setIf(link, 'mode', normalizeMode(str('mode')));
    setIf(link, 'lanAddress', str('host'));
    return link;
  } catch {
    return isValidKeyHex(value) ? { key: value } : {};
  }
}

/**
 * Разбор того, что пользователь вставил или отсканировал: полная ссылка с hash, сам hash или
 * голый ключ. Неизвестный текст даёт пустой результат, а не исключение.
 */
export function parsePairingText(text: string): PairingLink {
  const value = text.trim();
  if (!value) return {};
  const hashIdx = value.indexOf('#');
  if (hashIdx >= 0) {
    const link = parsePairingHash(value.slice(hashIdx + 1));
    // Ссылка вида http://192.168.1.5:42050/remote#… — адрес LAN берём из неё самой.
    if (!link.lanAddress) {
      try {
        const url = new URL(value.slice(0, hashIdx));
        if (url.protocol === 'http:' || url.protocol === 'https:') link.lanAddress = `${url.protocol}//${url.host}`;
      } catch {
        // не URL — только hash
      }
    }
    return link;
  }
  if (value.includes('=')) return parsePairingHash(value);
  return isValidKeyHex(value) ? { key: value } : {};
}

/** Ссылка дополняет профиль: новые значения перекрывают старые, пустые — не стирают. */
export function applyPairingLink(profile: HostProfile, link: PairingLink): HostProfile {
  const next: HostProfile = { ...profile };
  if (link.key) next.key = link.key.trim().toLowerCase();
  if (link.pin) next.pin = link.pin;
  if (link.hostId) next.hostId = link.hostId;
  if (link.relayUrl) next.relayUrl = link.relayUrl;
  if (link.lanAddress) next.lanAddress = link.lanAddress;
  if (link.mode) next.mode = link.mode;
  // Ключ другого хоста — старый токен этому хосту не принадлежит.
  if (link.hostId && profile.hostId && link.hostId !== profile.hostId) {
    next.deviceToken = undefined;
    next.rights = undefined;
    next.machineName = undefined;
  }
  return next;
}

export type ProfileProblem = 'no_key' | 'bad_key' | 'no_relay' | 'no_host_id' | 'no_lan_address';

/** Чего не хватает профилю для подключения; пустой массив — можно подключаться. */
export function profileProblems(profile: HostProfile): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  if (!profile.key) problems.push('no_key');
  else if (!isValidKeyHex(profile.key)) problems.push('bad_key');
  if (profile.mode === 'relay') {
    if (!profile.relayUrl) problems.push('no_relay');
    if (!profile.hostId) problems.push('no_host_id');
  } else if (!profile.lanAddress) {
    problems.push('no_lan_address');
  }
  return problems;
}

export interface WsTarget {
  url: string;
  viaRelay: boolean;
}

/**
 * URL сокета по текущему протоколу (v1).
 *
 * - LAN: сокет прямо к хосту, аутентификация в query (`pin`/`key`/`token`), как у прежних
 *   клиентов. Хост по `key` в query решает, что сессия зашифрована.
 * - Relay: сокет к релею `?role=client&hostId=…&clientId=…`, а ключ/PIN/токен уезжают хосту
 *   зашифрованным пакетом `handshake` после `relay_ack` — релей ничего не аутентифицирует.
 */
export function buildWsTarget(profile: HostProfile, deviceName: string): WsTarget {
  if (profile.mode === 'relay') {
    const url = new URL((profile.relayUrl || '').replace(/^http/i, 'ws'));
    url.searchParams.set('role', 'client');
    url.searchParams.set('hostId', profile.hostId);
    url.searchParams.set('clientId', profile.deviceId);
    url.searchParams.set('name', deviceName);
    return { url: url.toString(), viaRelay: true };
  }

  const address = (profile.lanAddress || '').trim();
  let origin: string;
  if (/^https?:\/\//i.test(address)) {
    const url = new URL(address);
    origin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  } else if (/^wss?:\/\//i.test(address)) {
    origin = `${new URL(address).protocol}//${new URL(address).host}`;
  } else {
    // У LAN Direct нет TLS: голый адрес — всегда ws://.
    origin = `ws://${address}`;
  }

  const query = new URLSearchParams({ key: profile.key, deviceId: profile.deviceId, name: deviceName });
  if (profile.pin) query.set('pin', profile.pin);
  if (profile.deviceToken) query.set('token', profile.deviceToken);
  return { url: `${origin}/?${query.toString()}`, viaRelay: false };
}

/** Идентификатор устройства: префикс платформы + случайная часть. */
export function generateDeviceId(prefix: string, random: () => number = Math.random): string {
  let tail = '';
  while (tail.length < 10) tail += Math.floor(random() * 36).toString(36);
  return `${prefix}_${tail.slice(0, 10)}`;
}
