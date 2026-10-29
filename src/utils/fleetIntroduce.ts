/**
 * Знакомство ПК через телефон (TASK-186, [[decision-143]]). Чистый модуль без Electron и DOM: телефон планирует пары
 * и проводит знакомство, ПК выбирает адрес соседа. RPC передаётся снаружи, поэтому логика проверяется без сети.
 *
 * Пара «A получает B»: `enroll_device` на B выдаёт токен для A, `federation_add_peer` на A сохраняет B пиром hub-режима.
 * Если A токен не принял, телефон отзывает его на B (`revoke_introduced_device`).
 */

import type { RemoteEndpoint } from './remoteEndpoints';
import { appErrorKeyOf, type AppErrorKey } from '../lib/appError';

/** ПК, сопряжённый с телефоном: `id` — профиль телефона, `hostId` — сам ПК. */
export interface IntroduceHost {
  id: string;
  hostId: string;
  name: string;
  /** Имя ПК, через который телефон видит этот (federation), — пометка в строке пары (TASK-232). */
  via?: string;
}

/** `to` получает `peer` пиром hub-режима. */
export interface IntroducePair {
  to: IntroduceHost;
  peer: IntroduceHost;
}

/** Методы хоста, которые зовёт знакомство: подмножество `RemoteRpcMethod`. */
export type IntroduceMethod = 'get_federation_hosts' | 'enroll_device' | 'federation_add_peer' | 'revoke_introduced_device';

export type IntroduceRpc = (profileId: string, method: IntroduceMethod, params?: Record<string, unknown>) => Promise<unknown>;

export interface IntroduceOutcome {
  pair: IntroducePair;
  status: 'added' | 'already' | 'failed';
  /** Английский текст причины; телефон показывает её по `errorKey` на своём языке (decision-165). */
  error?: string;
  errorKey?: AppErrorKey;
}

/** Что ПК-B выдаёт для ПК-A (`enroll_device` с `peerHostId`). Те же поля, что `RemoteEnrollment`. */
export interface PeerIntroduction {
  hostId: string;
  machineName: string;
  hostKey: string;
  deviceId: string;
  deviceToken: string;
  endpoints: RemoteEndpoint[];
  relayUrl?: string;
}

/** Пары, которых не хватает: каждый ПК получает каждого, с кем ещё не сопряжён. Порядок — порядок `hosts`. */
export function planIntroductions(hosts: IntroduceHost[], paired: Record<string, readonly string[]>): IntroducePair[] {
  const unique = hosts.filter((h, i) => hosts.findIndex((x) => x.hostId === h.hostId) === i);
  const pairs: IntroducePair[] = [];
  for (const to of unique) {
    const known = new Set(paired[to.hostId] ?? []);
    for (const peer of unique) {
      if (peer.hostId !== to.hostId && !known.has(peer.hostId)) pairs.push({ to, peer });
    }
  }
  return pairs;
}

/** Ключ пары по `hostId`: профили телефона меняются при повторном сопряжении, ПК — нет. */
export function introducePairKey(pair: IntroducePair): string {
  return `${pair.to.hostId}>${pair.peer.hostId}`;
}

/** Ключ набора ПК для перепроверки пар: меняется, когда ПК появляется или пропадает. */
export function introduceHostSetKey(hosts: readonly Pick<IntroduceHost, 'hostId'>[]): string {
  return [...new Set(hosts.map((h) => h.hostId))].sort().join('|');
}

/**
 * Пары, которые человек снял в листе знакомства (TASK-232), и ПК, которые он при этом видел. Хранится на телефоне.
 * Снятие действует, пока на связи нет ПК, которого не было в `hosts`: ПК, ушедший в сон, решения не отменяет, новый — отменяет.
 */
export interface DismissedIntroductions {
  hosts: string[];
  pairs: string[];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : null;
}

/** Запись из хранилища; повреждённая — `null`. */
export function parseDismissedIntroductions(value: unknown): DismissedIntroductions | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const hosts = strings(v.hosts);
  const pairs = strings(v.pairs);
  return hosts && pairs ? { hosts, pairs } : null;
}

function stillApplies(dismissed: DismissedIntroductions | null, hostIds: readonly string[]): dismissed is DismissedIntroductions {
  if (!dismissed) return false;
  const seen = new Set(dismissed.hosts);
  return hostIds.every((id) => seen.has(id));
}

/** Пары к показу: снятые не предлагаются снова, пока не появится новый ПК. `hostIds` — ПК, которые видны сейчас. */
export function offeredIntroductions(pairs: IntroducePair[], hostIds: readonly string[], dismissed: DismissedIntroductions | null): IntroducePair[] {
  if (!stillApplies(dismissed, hostIds)) return pairs;
  const skip = new Set(dismissed.pairs);
  return pairs.filter((p) => !skip.has(introducePairKey(p)));
}

/**
 * Что запомнить, когда человек закрыл лист или нажал «Познакомить»: снятые сейчас пары плюс снятые раньше, если прежнее
 * решение ещё действует. После появления нового ПК прежние снятия забываются — он мог поменять решение человека.
 */
export function rememberDismissed(
  offered: IntroducePair[],
  unchecked: ReadonlySet<string>,
  hostIds: readonly string[],
  previous: DismissedIntroductions | null
): DismissedIntroductions {
  const keep = stillApplies(previous, hostIds);
  const now = offered.map(introducePairKey).filter((k) => unchecked.has(k));
  return {
    hosts: [...new Set([...(keep ? previous.hosts : []), ...hostIds])].sort(),
    pairs: [...new Set([...(keep ? previous.pairs : []), ...now])]
  };
}

/**
 * С кем каждый ПК уже сопряжён: `enrollable` в `get_federation_hosts`. Пир, с которым связи нет (`peerConnected: false`),
 * сопряжённым не считается: знакомство починит пару (TASK-190). Хост старой сборки поля не шлёт — верим `enrollable`.
 * ПК, не ответивший, — в `errors`.
 */
export async function loadPairedPeers(
  hosts: IntroduceHost[],
  rpc: IntroduceRpc
): Promise<{ paired: Record<string, string[]>; errors: Record<string, string> }> {
  const paired: Record<string, string[]> = {};
  const errors: Record<string, string> = {};
  await Promise.all(
    hosts.map(async (h) => {
      try {
        const res = (await rpc(h.id, 'get_federation_hosts')) as {
          hosts?: Array<{ hostId?: unknown; enrollable?: unknown; peerConnected?: unknown }>;
        } | null;
        paired[h.hostId] = (res?.hosts ?? [])
          .filter((x) => x.enrollable === true && x.peerConnected !== false && typeof x.hostId === 'string')
          .map((x) => String(x.hostId));
      } catch (err) {
        errors[h.hostId] = errorText(err);
      }
    })
  );
  return { paired, errors };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Проверка ответа `enroll_device`: без ключа и токена знакомить нечем. */
export function isPeerIntroduction(value: unknown, hostId: string): value is PeerIntroduction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.hostId === hostId &&
    typeof v.hostKey === 'string' &&
    /^[A-Za-z0-9_-]{87}$/.test(v.hostKey) &&
    typeof v.deviceId === 'string' &&
    v.deviceId.length > 0 &&
    typeof v.deviceToken === 'string' &&
    v.deviceToken.length > 0 &&
    Array.isArray(v.endpoints)
  );
}

/** Пары по очереди: два знакомства одного ПК одновременно перебивали бы друг другу список пиров. */
export async function introduceComputers(pairs: IntroducePair[], rpc: IntroduceRpc, onProgress?: (done: number, total: number) => void): Promise<IntroduceOutcome[]> {
  const out: IntroduceOutcome[] = [];
  for (const pair of pairs) {
    out.push(await introducePair(pair, rpc));
    onProgress?.(out.length, pairs.length);
  }
  return out;
}

async function introducePair(pair: IntroducePair, rpc: IntroduceRpc): Promise<IntroduceOutcome> {
  let intro: unknown;
  try {
    intro = await rpc(pair.peer.id, 'enroll_device', { deviceName: pair.to.name, rights: 'full', peerHostId: pair.to.hostId });
  } catch (err) {
    return failed(pair, err);
  }
  if (!isPeerIntroduction(intro, pair.peer.hostId)) {
    return { pair, status: 'failed', error: `Computer “${pair.peer.name}” answered without a key: update ProjectHub on it`, errorKey: { code: 'remote.peerNoKey', params: { name: pair.peer.name } } };
  }
  const revoke = () => rpc(pair.peer.id, 'revoke_introduced_device', { deviceId: intro.deviceId }).catch(() => undefined);
  try {
    const res = (await rpc(pair.to.id, 'federation_add_peer', { introduction: intro })) as { status?: string } | null;
    if (res?.status === 'already') {
      await revoke();
      return { pair, status: 'already' };
    }
    return { pair, status: 'added' };
  } catch (err) {
    await revoke();
    return failed(pair, err);
  }
}

function failed(pair: IntroducePair, err: unknown): IntroduceOutcome {
  const key = appErrorKeyOf(err);
  return { pair, status: 'failed', error: errorText(err), ...(key ? { errorKey: key } : {}) };
}

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

function sameSubnet24(a: string, b: string): boolean {
  const x = ipv4(a);
  const y = ipv4(b);
  return Boolean(x && y && x[0] === y[0] && x[1] === y[1] && x[2] === y[2]);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface PeerAddress {
  transport: 'lan' | 'relay';
  address: string;
}

/**
 * Адреса соседа для hub-режима в порядке предпочтения (decision-143 п. 3): LAN в той же подсети /24, что у этого ПК, затем
 * VPN, туннель, релей, затем любой LAN. Остальные — запасные, если первый недоступен: macOS без разрешения «Локальная
 * сеть» не пускает в LAN (TASK-198).
 */
export function peerAddressCandidates(intro: { endpoints: RemoteEndpoint[]; relayUrl?: string }, localIps: readonly string[]): PeerAddress[] {
  const eps = intro.endpoints.filter((e) => e && typeof e.url === 'string');
  const lan = eps.filter((e) => e.kind === 'lan');
  const near = lan.find((e) => localIps.some((ip) => sameSubnet24(ip, hostOf(e.url))));
  const relay = eps.find((e) => e.kind === 'relay')?.url ?? intro.relayUrl;
  const out: PeerAddress[] = [];
  const add = (transport: PeerAddress['transport'], address: string | undefined) => {
    if (address && !out.some((a) => a.address === address)) out.push({ transport, address });
  };
  add('lan', near?.url);
  add('lan', eps.find((e) => e.kind === 'vpn')?.url);
  add('lan', eps.find((e) => e.kind === 'tunnel')?.url);
  if (relay && /^wss?:\/\//i.test(relay)) add('relay', relay);
  add('lan', lan[0]?.url);
  return out;
}

/** Предпочтительный адрес соседа (`peerAddressCandidates`). `null` — адресов нет. */
export function pickPeerAddress(intro: { endpoints: RemoteEndpoint[]; relayUrl?: string }, localIps: readonly string[]): PeerAddress | null {
  return peerAddressCandidates(intro, localIps)[0] ?? null;
}
