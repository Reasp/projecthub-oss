/**
 * Адреса хоста Remote Control для телефона (TASK-140.9, decision-82). Чистый модуль без Electron и DOM:
 * хост строит список, QR несёт его в hash ссылки сопряжения, клиент перебирает адреса по порядку.
 *
 * Виды адресов:
 * - `lan` — частная сеть ПК (Wi-Fi, Ethernet), `ws://ip:port`;
 * - `vpn` — оверлейная сеть (Tailscale/Headscale `100.64/10`, WireGuard, ZeroTier), `ws://ip:port`;
 * - `tunnel` — HTTPS-туннель (Cloudflare Quick или именованный), `wss://host`;
 * - `relay` — свой релей ([[decision-11]]), к нему клиент подключается как `role=client`.
 *
 * Адрес — не секрет: ключ E2EE едет отдельно, а сессия через любой адрес зашифрована. Но через туннель
 * и релей адрес видит посредник, поэтому в URL сокета нет ни ключа, ни токена (`buildWsTarget`).
 */

export type EndpointKind = 'lan' | 'vpn' | 'tunnel' | 'relay';

export interface RemoteEndpoint {
  kind: EndpointKind;
  /** `ws://host:port` для lan/vpn, `wss://host[:port]` для туннеля, URL релея как есть. */
  url: string;
}

/** Порядок перебора по умолчанию: ближе и дешевле — раньше. */
export const ENDPOINT_KIND_ORDER: readonly EndpointKind[] = ['lan', 'vpn', 'tunnel', 'relay'];

/** Короткие коды видов в hash ссылки (`ep=l:192.168.1.5:42050`): QR должен оставаться небольшим. */
const KIND_CODE: Record<Exclude<EndpointKind, 'relay'>, string> = { lan: 'l', vpn: 'v', tunnel: 't' };
const CODE_KIND: Record<string, Exclude<EndpointKind, 'relay'>> = { l: 'lan', v: 'vpn', t: 'tunnel' };

/** `host` или `host:port`: буквы, цифры, точка, дефис; порт 1–65535. IPv6 в адресах хоста не используем. */
const HOST_PORT_RE = /^[A-Za-z0-9.-]{1,253}(?::(\d{1,5}))?$/;

function validHostPort(value: string, requirePort: boolean): boolean {
  const m = HOST_PORT_RE.exec(value);
  if (!m) return false;
  if (m[1] === undefined) return !requirePort;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

/** Адрес из оверлейной сети Tailscale/Headscale (CGNAT `100.64.0.0/10`). */
export function isCgnatAddress(host: string): boolean {
  const p = ipv4Parts(host);
  return Boolean(p && p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/** Loopback и link-local: с телефона недостижимы, в список адресов не попадают. */
export function isUnreachableFromPhone(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  const p = ipv4Parts(h);
  return Boolean(p && (p[0] === 127 || (p[0] === 169 && p[1] === 254)));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Канонический URL адреса или `null`, если адрес нельзя использовать. */
export function normalizeEndpoint(raw: unknown): RemoteEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, url } = raw as { kind?: unknown; url?: unknown };
  if (typeof url !== 'string' || !ENDPOINT_KIND_ORDER.includes(kind as EndpointKind)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim().replace(/^http/i, 'ws'));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  if (isUnreachableFromPhone(parsed.hostname)) return null;
  const k = kind as EndpointKind;
  // Туннель — только TLS: Cloudflare и прокси отдают HTTPS, а ws:// к публичному адресу шёл бы открыто.
  if (k === 'tunnel' && parsed.protocol !== 'wss:') return null;
  if (k === 'relay') {
    parsed.search = '';
    parsed.hash = '';
    return { kind: k, url: parsed.toString().replace(/\/$/, '') };
  }
  return { kind: k, url: `${parsed.protocol}//${parsed.host}` };
}

/** Список адресов от хоста или из хранилища: только валидные, без повторов, не больше 8. */
export function sanitizeEndpoints(list: unknown): RemoteEndpoint[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RemoteEndpoint[] = [];
  for (const item of list) {
    const ep = normalizeEndpoint(item);
    if (!ep || seen.has(ep.url)) continue;
    seen.add(ep.url);
    out.push(ep);
    if (out.length >= 8) break;
  }
  return out;
}

/** Значение параметра `ep` в hash ссылки; релей едет отдельным параметром `relay`, как в v1. */
export function encodeEndpointParam(ep: RemoteEndpoint): string | null {
  if (ep.kind === 'relay') return null;
  const url = new URL(ep.url);
  const hostPort = ep.kind === 'tunnel' && (url.port === '' || url.port === '443') ? url.hostname : url.host;
  return `${KIND_CODE[ep.kind]}:${hostPort}`;
}

/** Разбор `ep=l:192.168.1.5:42050`, `ep=v:100.70.1.2:42050`, `ep=t:abc.trycloudflare.com`. */
export function decodeEndpointParam(value: string): RemoteEndpoint | null {
  const m = /^([a-z]):(.+)$/.exec(value.trim());
  if (!m) return null;
  const kind = CODE_KIND[m[1]];
  const target = m[2];
  if (!kind) return null;
  if (kind === 'tunnel') {
    if (!validHostPort(target, false)) return null;
    return normalizeEndpoint({ kind, url: `wss://${target}` });
  }
  if (!validHostPort(target, true)) return null;
  return normalizeEndpoint({ kind, url: `ws://${target}` });
}

/**
 * Адрес, введённый вручную или взятый из старой ссылки (`lanAddress`): `host:port`, `http(s)://…`,
 * `ws(s)://…`. HTTPS — туннель, `100.64/10` — VPN, остальное — локальная сеть.
 */
export function endpointFromAddress(address: string | undefined | null): RemoteEndpoint | null {
  const value = (address || '').trim();
  if (!value) return null;
  let url: string;
  if (/^https:\/\//i.test(value) || /^wss:\/\//i.test(value)) url = value.replace(/^https/i, 'wss');
  else if (/^http:\/\//i.test(value) || /^ws:\/\//i.test(value)) url = value.replace(/^http/i, 'ws');
  else url = `ws://${value}`;
  const secure = url.startsWith('wss:');
  const host = hostOf(url);
  if (!host) return null;
  const kind: EndpointKind = secure ? 'tunnel' : isCgnatAddress(host) ? 'vpn' : 'lan';
  return normalizeEndpoint({ kind, url });
}

/** Релей как адрес: только если он достижим с телефона (по умолчанию релей — `ws://127.0.0.1`). */
export function relayEndpoint(relayUrl: string | undefined | null): RemoteEndpoint | null {
  if (!relayUrl) return null;
  return normalizeEndpoint({ kind: 'relay', url: relayUrl });
}

export interface CandidateOptions {
  /** Последний адрес, через который клиент дошёл до `ready`, — пробуется первым. */
  lastUrl?: string;
  /** Предпочесть релей (старые ссылки с `mode=relay`). */
  preferRelay?: boolean;
  /** Страница открыта по HTTPS: `ws://` браузер заблокирует как mixed content. */
  secureOnly?: boolean;
}

/** Порядок перебора: последний удачный, затем по виду (lan → vpn → tunnel → relay), внутри вида — как пришли. */
export function orderCandidates(list: RemoteEndpoint[], opts: CandidateOptions = {}): RemoteEndpoint[] {
  const order: EndpointKind[] = opts.preferRelay ? ['relay', 'lan', 'vpn', 'tunnel'] : [...ENDPOINT_KIND_ORDER];
  const usable = list.filter((ep) => !opts.secureOnly || ep.url.startsWith('wss:'));
  const sorted = usable
    .map((ep, i) => ({ ep, i }))
    .sort((a, b) => order.indexOf(a.ep.kind) - order.indexOf(b.ep.kind) || a.i - b.i)
    .map((x) => x.ep);
  const lastIdx = opts.lastUrl ? sorted.findIndex((ep) => ep.url === opts.lastUrl) : -1;
  if (lastIdx > 0) sorted.unshift(...sorted.splice(lastIdx, 1));
  return sorted;
}

export interface HostAddress {
  address: string;
  kind: 'lan' | 'vpn';
}

export interface HostEndpointSource {
  /** Адреса ПК по видам, лучшие первыми (`classifyLanAddresses`). */
  addresses: HostAddress[];
  port: number;
  /** Работающий туннель (Quick или заданный владельцем). */
  tunnelUrl?: string;
  /** Постоянный публичный HTTPS-адрес, заданный владельцем (именованный туннель, свой прокси). */
  publicUrl?: string;
}

/** Адреса хоста для телефона: до 3 LAN, до 2 VPN, постоянный публичный адрес и туннель. Релей — отдельно. */
export function buildHostEndpoints(src: HostEndpointSource): RemoteEndpoint[] {
  const lan = src.addresses.filter((a) => a.kind === 'lan').slice(0, 3);
  const vpn = src.addresses.filter((a) => a.kind === 'vpn').slice(0, 2);
  return sanitizeEndpoints([
    ...lan.map((a) => ({ kind: 'lan', url: `ws://${a.address}:${src.port}` })),
    ...vpn.map((a) => ({ kind: 'vpn', url: `ws://${a.address}:${src.port}` })),
    ...(src.publicUrl ? [{ kind: 'tunnel', url: src.publicUrl }] : []),
    ...(src.tunnelUrl ? [{ kind: 'tunnel', url: src.tunnelUrl }] : [])
  ]);
}
