/**
 * Доступность адреса соседнего ПК (TASK-198). Без Electron: знакомство через телефон пробует адреса соседа и сохраняет
 * первый, до которого доходит TCP, а ошибку LAN на macOS объясняет разрешением «Локальная сеть».
 */

import net from 'node:net';
import { isLinkLocal, isPrivateLan } from './lanAddresses.js';

const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Текст ошибки соединения с соседом. macOS 15+ без разрешения «Конфиденциальность и безопасность → Локальная сеть»
 * отвечает на соединение с адресом в LAN `EHOSTUNREACH` — к такой ошибке добавляется, что включить.
 */
export function describePeerConnectError(err: unknown, platform: NodeJS.Platform = process.platform): string {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; address?: unknown };
  const message = typeof e.message === 'string' && e.message ? e.message : 'Ошибка соединения';
  const address = typeof e.address === 'string' ? e.address : '';
  if (platform !== 'darwin' || !UNREACHABLE.has(String(e.code)) || !(isPrivateLan(address) || isLinkLocal(address))) return message;
  return `${message}. macOS не пускает ProjectHub в локальную сеть: включите ProjectHub в «Системные настройки → Конфиденциальность и безопасность → Локальная сеть» и перезапустите приложение`;
}

/** Хост и порт адреса пира: `ws://host:port`, `https://…`, `host:port`. `null` — не адрес. */
export function peerSocketTarget(address: string): { host: string; port: number } | null {
  const raw = address.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`);
  } catch {
    return null;
  }
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host && port > 0 && port < 65536 ? { host, port } : null;
}

/** Открывается ли TCP до адреса за `timeoutMs`. Ошибка — текстом `describePeerConnectError`. */
export function probePeerAddress(address: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = peerSocketTarget(address);
  if (!target) return Promise.resolve({ ok: false, error: `Не адрес: ${address}` });
  return new Promise((resolve) => {
    const socket = net.connect(target);
    const done = (result: { ok: true } | { ok: false; error: string }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: `Нет ответа за ${Math.round(timeoutMs / 1000)} с` }), timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => done({ ok: false, error: describePeerConnectError(err) }));
  });
}

/**
 * Первый по порядку адрес, до которого доходит TCP. Пробы идут параллельно: знакомство укладывается в тайм-аут RPC
 * телефона, даже если LAN молчит. Все недоступны — ошибка со всеми причинами.
 */
export async function firstReachableAddress<T extends { address: string }>(
  candidates: readonly T[],
  timeoutMs: number,
  probe: (address: string, timeoutMs: number) => Promise<{ ok: true } | { ok: false; error: string }> = probePeerAddress
): Promise<T> {
  const results = await Promise.all(candidates.map((c) => probe(c.address, timeoutMs)));
  const index = results.findIndex((r) => r.ok);
  if (index >= 0) return candidates[index];
  throw new Error(results.map((r, i) => `${candidates[i].address}: ${r.ok ? '' : r.error}`).join('; ') || 'Нет адресов');
}
