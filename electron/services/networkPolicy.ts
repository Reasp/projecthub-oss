/**
 * Политика сети закрытого контура (TASK-147.1, [[decision-186]]). Чистый модуль без Electron и IO: разбор политики
 * и решение «пускать ли запрос по этому адресу». Обёртки над `fetch`, `http(s).request` и сессией Electron — в
 * `networkGuard.ts`.
 *
 * В режиме `airGapped` запрос проходит, только если адрес внутри контура: loopback, частные сети, CGNAT (VPN контура),
 * имена `*.local` и хосты из `allowedHosts`. Link-local `169.254/16` запрещён: там метаданные облака. Проверка идёт по
 * адресу из URL, без DNS: внутренние имена администратор перечисляет в `allowedHosts`.
 */
import { isLinkLocal, isPrivateLan } from './lanAddresses.js';

export interface NetworkPolicy {
  airGapped: boolean;
  /** Имена (`gitlab.corp.example`) и суффиксы (`.corp.example`) внутри контура, в нижнем регистре. */
  allowedHosts: string[];
}

export const OPEN_NETWORK_POLICY: NetworkPolicy = { airGapped: false, allowedHosts: [] };

function hostList(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(items.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter((h) => /^\.?[a-z0-9.-]+$/.test(h)))];
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Политика из файла и окружения. Окружение включает режим и дополняет список хостов; выключить режим, включённый
 * файлом администратора, окружением нельзя. Битый файл — режим не включён файлом (ошибку покажет журнал вызывающего).
 */
export function parseNetworkPolicy(file: unknown, env: Record<string, string | undefined>): NetworkPolicy {
  const raw = file && typeof file === 'object' && !Array.isArray(file) ? (file as Record<string, unknown>) : {};
  const airGapped = raw.airGapped === true || TRUE_VALUES.has(String(env.PROJECTHUB_AIR_GAPPED ?? '').trim().toLowerCase());
  return { airGapped, allowedHosts: [...new Set([...hostList(raw.allowedHosts), ...hostList(env.PROJECTHUB_ALLOWED_HOSTS)])] };
}

function isCgnat(address: string): boolean {
  const p = address.split('.').map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const p = host.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && p[0] === 127;
}

/** IPv6 уникальные локальные адреса `fc00::/7` — частная сеть. */
function isUniqueLocalV6(host: string): boolean {
  return /^f[cd][0-9a-f]{2}:/i.test(host);
}

/** IPv4 из IPv4-mapped IPv6 (`::ffff:127.0.0.1` или нормализованный `URL` вид `::ffff:7f00:1`). */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Хост внутри контура по политике. */
export function isHostInside(hostname: string, policy: NetworkPolicy): boolean {
  let host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  host = mappedIpv4(host) ?? host;
  // «Любой адрес» этого компьютера: соединение с ним уходит на сам компьютер.
  if (host === '0.0.0.0' || host === '::') return true;
  if (isLinkLocal(host)) return false;
  if (isLoopbackHost(host) || isPrivateLan(host) || isCgnat(host) || isUniqueLocalV6(host)) return true;
  if (host.endsWith('.local')) return true;
  return policy.allowedHosts.some((allowed) => (allowed.startsWith('.') ? host.endsWith(allowed) || host === allowed.slice(1) : host === allowed));
}

export type EgressDecision = { allowed: true } | { allowed: false; host: string };

/** Пускать ли запрос по адресу. Без режима — всегда да; не-сетевые схемы (`file:`, `data:`, приложения) — да. */
export function egressDecision(url: string | URL, policy: NetworkPolicy): EgressDecision {
  if (!policy.airGapped) return { allowed: true };
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    // Адрес, который не разбирается, не проверить — в закрытом контуре такой запрос не пускаем.
    return { allowed: false, host: String(url).slice(0, 80) };
  }
  if (!/^(https?|wss?|ftp):$/.test(parsed.protocol)) return { allowed: true };
  return isHostInside(parsed.hostname, policy) ? { allowed: true } : { allowed: false, host: parsed.hostname };
}
