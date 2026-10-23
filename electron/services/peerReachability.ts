/**
 * Доступность адреса соседнего ПК (TASK-198). Без Electron: знакомство через телефон пробует адреса соседа и сохраняет
 * первый, до которого доходит TCP, а ошибку LAN на macOS объясняет разрешением «Локальная сеть».
 */

import net from 'node:net';
import { AppError, appErrorKeyOf } from '../../src/lib/appError.js';
import { isLinkLocal, isPrivateLan } from './lanAddresses.js';

const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Ошибка соединения с соседом для человека. macOS 15+ без разрешения «Конфиденциальность и безопасность → Локальная
 * сеть» отвечает на соединение с адресом в LAN `EHOSTUNREACH` — такая ошибка получает код с подсказкой, что включить
 * (decision-165). Остальные — системный текст как есть.
 */
export function peerConnectError(err: unknown, platform: NodeJS.Platform = process.platform): Error {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; address?: unknown };
  if (typeof e.message !== 'string' || !e.message) return new AppError('federation.connectError');
  const address = typeof e.address === 'string' ? e.address : '';
  if (platform !== 'darwin' || !UNREACHABLE.has(String(e.code)) || !(isPrivateLan(address) || isLinkLocal(address))) return new Error(e.message);
  return new AppError('federation.localNetworkBlocked', { detail: e.message });
}

/** Все адреса соседа недоступны; `localNetworkBlocked` — хотя бы один не пустила «Локальная сеть» macOS. */
export class PeerUnreachableError extends Error {
  constructor(
    message: string,
    readonly localNetworkBlocked: boolean
  ) {
    super(message);
    this.name = 'PeerUnreachableError';
  }
}

type ProbeResult = { ok: true } | { ok: false; error: string; localNetworkBlocked?: boolean };

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

/** Открывается ли TCP до адреса за `timeoutMs`. Ошибка — системным текстом; отказ «Локальной сети» macOS помечен. */
export function probePeerAddress(address: string, timeoutMs: number): Promise<ProbeResult> {
  const target = peerSocketTarget(address);
  if (!target) return Promise.resolve({ ok: false, error: `Not an address: ${address}` });
  return new Promise((resolve) => {
    const socket = net.connect(target);
    const done = (result: ProbeResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: `No response within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => {
      const key = appErrorKeyOf(peerConnectError(err));
      if (key?.code === 'federation.localNetworkBlocked') done({ ok: false, error: String(key.params?.detail ?? err.message), localNetworkBlocked: true });
      else done({ ok: false, error: err.message || 'Connection error' });
    });
  });
}

/**
 * Первый по порядку адрес, до которого доходит TCP. Пробы идут параллельно: знакомство укладывается в тайм-аут RPC
 * телефона, даже если LAN молчит. Все недоступны — ошибка со всеми причинами.
 */
export async function firstReachableAddress<T extends { address: string }>(
  candidates: readonly T[],
  timeoutMs: number,
  probe: (address: string, timeoutMs: number) => Promise<ProbeResult> = probePeerAddress
): Promise<T> {
  const results = await Promise.all(candidates.map((c) => probe(c.address, timeoutMs)));
  const index = results.findIndex((r) => r.ok);
  if (index >= 0) return candidates[index];
  throw new PeerUnreachableError(
    results.map((r, i) => `${candidates[i].address}: ${r.ok ? '' : r.error}`).join('; ') || 'No addresses',
    results.some((r) => !r.ok && r.localNetworkBlocked)
  );
}
