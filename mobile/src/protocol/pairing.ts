import type { DeviceRights, RemoteConnectionMode } from '../../../src/types/remote';
import { base64UrlToHex } from '../../../src/utils/remotePairingLink';
import {
  decodeEndpointParam,
  endpointFromAddress,
  normalizeEndpoint,
  orderCandidates,
  relayEndpoint,
  sanitizeEndpoints,
  type RemoteEndpoint
} from '../../../src/utils/remoteEndpoints';

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
  /**
   * Все адреса хоста (TASK-140.9): из QR и от самого хоста (`handshake_ack`, событие `host:endpoints`).
   * Хост присылает свежий список при каждом подключении, поэтому новый адрес туннеля доходит без QR.
   */
  endpoints?: RemoteEndpoint[];
  /** URL адреса, через который клиент последний раз дошёл до `ready`: с него начинается перебор. */
  lastEndpoint?: string;
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
  /** Адреса из параметров `ep` (TASK-140.9). */
  endpoints?: RemoteEndpoint[];
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

  const endpoints = sanitizeEndpoints(params.getAll('ep').map(decodeEndpointParam));
  if (endpoints.length > 0) link.endpoints = endpoints;

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
  if (link.endpoints?.length) next.endpoints = link.endpoints;
  // Ключ другого хоста — старый токен и адреса этому хосту не принадлежат.
  if (link.hostId && profile.hostId && link.hostId !== profile.hostId) {
    next.deviceToken = undefined;
    next.rights = undefined;
    next.machineName = undefined;
    next.lastEndpoint = undefined;
    if (!link.endpoints?.length) next.endpoints = undefined;
  }
  return next;
}

/**
 * Релей как кандидат: нужен `hostId`. Явный режим релея (старые ссылки, ручной ввод) принимает любой
 * адрес, иначе релей с loopback-адресом (`ws://127.0.0.1:42055` по умолчанию) отбрасывается.
 */
function relayCandidate(profile: HostProfile): RemoteEndpoint | null {
  if (!profile.relayUrl || !profile.hostId) return null;
  if (profile.mode !== 'relay') return relayEndpoint(profile.relayUrl);
  try {
    const url = new URL(profile.relayUrl.trim().replace(/^http/i, 'ws'));
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    url.search = '';
    url.hash = '';
    return { kind: 'relay', url: url.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
}

/** Все адреса профиля без повторов: адрес страницы или старой ссылки, список хоста, релей. */
export function profileEndpoints(profile: HostProfile): RemoteEndpoint[] {
  const list: RemoteEndpoint[] = [];
  const seen = new Set<string>();
  const push = (ep: RemoteEndpoint | null) => {
    if (!ep || seen.has(ep.url)) return;
    seen.add(ep.url);
    list.push(ep);
  };
  push(endpointFromAddress(profile.lanAddress));
  for (const ep of profile.endpoints ?? []) push(normalizeEndpoint(ep));
  push(relayCandidate(profile));
  return list;
}

/**
 * Порядок перебора адресов (TASK-140.9): последний удачный, затем LAN → VPN → туннель → релей. На
 * HTTPS-странице (встроенный клиент через туннель) `ws://` браузер заблокирует — такие адреса пропускаем.
 */
export function connectionCandidates(profile: HostProfile, opts: { secureOnly?: boolean; firstUrl?: string } = {}): RemoteEndpoint[] {
  return orderCandidates(profileEndpoints(profile), {
    lastUrl: opts.firstUrl || profile.lastEndpoint,
    preferRelay: profile.mode === 'relay',
    secureOnly: opts.secureOnly
  });
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
  } else if (profileEndpoints(profile).length === 0) {
    problems.push('no_lan_address');
  }
  return problems;
}

export interface WsTarget {
  url: string;
  viaRelay: boolean;
}

/**
 * URL сокета для одного адреса хоста. В URL нет ни ключа, ни PIN, ни токена (TASK-140.9): через туннель
 * TLS заканчивается у посредника, и query-строку он видит. Секреты уезжают хосту первым E2EE-пакетом
 * `handshake`.
 *
 * - Прямой адрес (LAN, VPN, туннель): `?deviceId=…&auth=e2ee`, `handshake` — сразу после открытия сокета.
 *   Имя устройства тоже едет в `handshake`.
 * - Релей: `?role=client&hostId=…&clientId=…`, `handshake` — после `relay_ack`.
 */
export function buildWsTarget(profile: HostProfile, endpoint: RemoteEndpoint, deviceName: string): WsTarget {
  if (endpoint.kind === 'relay') {
    const url = new URL(endpoint.url);
    url.searchParams.set('role', 'client');
    url.searchParams.set('hostId', profile.hostId);
    url.searchParams.set('clientId', profile.deviceId);
    url.searchParams.set('name', deviceName);
    return { url: url.toString(), viaRelay: true };
  }
  const query = new URLSearchParams({ deviceId: profile.deviceId, auth: 'e2ee' });
  return { url: `${endpoint.url}/?${query.toString()}`, viaRelay: false };
}

/** Идентификатор устройства: префикс платформы + случайная часть. */
export function generateDeviceId(prefix: string, random: () => number = Math.random): string {
  let tail = '';
  while (tail.length < 10) tail += Math.floor(random() * 36).toString(36);
  return `${prefix}_${tail.slice(0, 10)}`;
}
