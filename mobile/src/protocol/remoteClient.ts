import type {
  DeviceRights,
  EncryptedPacket,
  PlainPacket,
  RemoteHandshakeAck,
  RemoteRpcMethod
} from '../../../src/types/remote';
import {
  ENDPOINT_KIND_ORDER,
  endpointFromAddress,
  sanitizeEndpoints,
  type EndpointKind,
  type RemoteEndpoint
} from '../../../src/utils/remoteEndpoints';
import {
  HandshakeError,
  SESSION_PROTOCOL_V1,
  SESSION_PROTOCOL_V2,
  isSessionFrameV2,
  type ClientHandshake,
  type SessionFrameV2,
  type WebSessionV2
} from '../../../src/utils/remoteSessionV2';
import { buildWsTarget, connectionCandidates, isValidHostKey, isValidKeyHex, profileProblemText, profileProblems, type HostProfile } from './pairing';
import { t } from '../i18n';
import { withAppErrorKey } from '../../../src/lib/appError';

/**
 * Клиент Remote Control для телефона (TASK-140.1): соединение, сопряжение, RPC и события. Протокол v2
 * (TASK-140.2, [[decision-111]]) — рукопожатие X25519 с подписью хоста, если ключ хоста закреплён в профиле и
 * платформа умеет X25519/Ed25519; иначе v1 ([[decision-11]]). Чистый модуль без React и DOM — сокет, шифрование
 * и таймеры внедряются, поэтому всё поведение проверяется unit-тестами в Node.
 */

/** Минимум WebSocket, который нужен клиенту (браузерный `WebSocket` подходит как есть). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Шифрование пакетов ключом хоста (`remoteCryptoWeb.ts` в браузере). */
export interface PacketCodec {
  encrypt(packet: PlainPacket): Promise<EncryptedPacket>;
  decrypt(packet: EncryptedPacket): Promise<PlainPacket>;
}

export type CodecFactory = (keyHex: string) => PacketCodec;

/** Протокол v2 на платформе: есть ли X25519/Ed25519 и начало рукопожатия (`remoteSessionV2.ts`). */
export interface SessionV2Port {
  supported(): Promise<boolean>;
  begin(): Promise<ClientHandshake>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
};

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'pairing'
  | 'awaiting_approval'
  | 'ready'
  | 'reconnecting'
  | 'failed';

export interface ClientSnapshot {
  state: ConnectionState;
  /** Понятная причина последней ошибки (для экрана). */
  error: string | null;
  hostId: string;
  rights: DeviceRights | null;
  readOnly: boolean;
  viaRelay: boolean;
  /** Путь текущего (или пробуемого) подключения: локальная сеть, VPN, туннель, релей (TASK-140.9). */
  route: EndpointKind | null;
  /** Подпись адреса для экрана: `туннель abc.trycloudflare.com`. */
  endpoint: string | null;
  lastEventId: number;
  /** Через сколько миллисекунд будет следующая попытка (только в `reconnecting`). */
  retryInMs: number | null;
  /** Версия текущей сессии: 2 — forward secrecy, 1 — общий ключ; `null` до рукопожатия. */
  protocol: number | null;
  /** `deviceId` профиля — им же назван ключ подтверждения в Keystore. */
  deviceId: string;
  /** Хост знает ключ подтверждения этого устройства: решение `high` можно подписать биометрией (decision-114). */
  biometricConfirm: boolean;
}

/** Метод мобильного клиента — тот же набор, что объявлен в `RemoteRpcMethod`. */
export type RpcMethod = RemoteRpcMethod;

export interface RemoteClientOptions {
  socketFactory: SocketFactory;
  codecFactory: CodecFactory;
  deviceName: string;
  /** Профиль изменился (выдан токен, узнали hostId/права) — платформа сохраняет его. */
  onProfileChange?: (profile: HostProfile) => void;
  /** Протокол v2; без него клиент говорит только по v1. */
  v2?: SessionV2Port;
  timers?: Timers;
  rpcTimeoutMs?: number;
  heartbeatMs?: number;
  /**
   * Сколько ждать открытия сокета, прежде чем перейти к следующему адресу. По умолчанию зависит от вида
   * адреса (`CONNECT_TIMEOUT_BY_KIND`): адрес в LAN из мобильной сети молчит, ждать его долго незачем.
   */
  connectTimeoutMs?: number;
  /** Страница открыта по HTTPS: адреса `ws://` браузер не откроет (mixed content). */
  secureOnly?: boolean;
  /**
   * Как часто, будучи на связи через VPN, туннель или релей, проверять адреса лучше (TASK-140.9): телефон
   * вернулся домой — связь переходит на локальную сеть. 0 — не проверять.
   */
  upgradeProbeMs?: number;
  /**
   * Открытый ключ подтверждения для первого сопряжения (TASK-140.6, decision-112 п. 4): платформа создаёт ключ с
   * биометрией под `deviceId`. Хост принимает его только вместе с PIN или ключом из QR, поэтому по токену не шлём.
   */
  confirmKey?: (deviceId: string) => Promise<string | null | undefined>;
}

/** После неудачного перехода на адрес лучше не пробовать его снова столько, мс. */
const UPGRADE_COOLDOWN_MS = 5 * 60_000;

/** Ожидание открытия сокета по видам адресов, мс. */
export const CONNECT_TIMEOUT_BY_KIND: Record<EndpointKind, number> = { lan: 5000, vpn: 8000, tunnel: 12_000, relay: 12_000 };

/** Экспоненциальная задержка переподключения, как у хоста и прежних клиентов: 1с, 2с, 4с … ≤ 30с. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempt)));
}

/**
 * Ошибки хоста, после которых повторять подключение нельзя: неверный PIN/ключ (повтор быстро
 * упрётся в блокировку по частоте попыток) и отзыв устройства на ПК.
 */
export function isFatalHostError(message: string): boolean {
  return /Invalid pairing PIN or secret key|Too many failed attempts|Authentication failed|Rate limited|only protocol v2/i.test(message);
}

/** Хост в режиме «только v2» (decision-116), а у профиля нет ключа хоста или платформа без WebCrypto. */
export function v2RequiredText(): string {
  return t().store.v2Required;
}

/** Понятный текст фатальной ошибки хоста; прочие — как есть. */
export function fatalHostErrorText(message: string): string {
  return /only protocol v2/i.test(message) ? v2RequiredText() : message;
}

/** Закрытие сокета хостом из списка устройств («Отключить» на ПК) — токен отозван. */
export function isRevokedClose(code: number | undefined, reason: string | undefined): boolean {
  return code === 1000 && /Disconnected by host/i.test(reason || '');
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

type EventListener = (event: string, data: unknown) => void;
type SnapshotListener = (snapshot: ClientSnapshot) => void;

const OPEN = 1;

/** Сокет, от которого отказались (таймаут, сторож): его события больше не обрабатываются. */
function abandonSocket(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try {
    socket.close();
  } catch {
    // уже закрыт
  }
}

/**
 * Свежие адреса хоста в профиль (TASK-140.9): список хоста заменяет прежний, адрес старой ссылки,
 * которого в нём нет (например, туннель прошлого запуска), убирается. Релей меняется, только если хост
 * его назвал. `true` — профиль изменился.
 */
export function mergeHostEndpoints(profile: HostProfile, info: { endpoints?: unknown; relayUrl?: unknown }): boolean {
  let changed = false;
  if (Array.isArray(info.endpoints)) {
    const next = sanitizeEndpoints(info.endpoints);
    if (JSON.stringify(next) !== JSON.stringify(profile.endpoints ?? [])) {
      profile.endpoints = next;
      changed = true;
    }
    const legacy = endpointFromAddress(profile.lanAddress);
    if (legacy && !next.some((ep) => ep.url === legacy.url)) {
      profile.lanAddress = undefined;
      changed = true;
    }
  }
  if (typeof info.relayUrl === 'string' && info.relayUrl && info.relayUrl !== profile.relayUrl) {
    profile.relayUrl = info.relayUrl;
    changed = true;
  }
  return changed;
}

/** Подпись пути для экрана: «локальная сеть», «VPN», «туннель», «релей». */
export function routeLabel(route: EndpointKind | null): string {
  return route ? t().store.route[route] : '';
}

/** Короткая подпись адреса для экрана на языке клиента: `туннель abc.trycloudflare.com`. */
export function endpointLabel(ep: RemoteEndpoint): string {
  let host = ep.url;
  try {
    host = new URL(ep.url).hostname || ep.url;
  } catch {
    // не URL — показываем как есть
  }
  return `${routeLabel(ep.kind)} ${host}`;
}

/**
 * Текст кадра WebSocket. Релей до TASK-140.1 пересылал сообщения хоста бинарными кадрами
 * (`Buffer` из `ws`), и браузер отдавал их как `Blob` — старые клиенты молча не понимали ответов
 * через релей. Принимаем и строку, и `Blob`, и `ArrayBuffer`/`Uint8Array`.
 */
export async function frameText(raw: unknown): Promise<string> {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  if (typeof Blob !== 'undefined' && raw instanceof Blob) return await raw.text();
  return String(raw);
}

// Тексты ошибок — функции, а не константы: язык меняется на ходу, строка берётся в момент ошибки (TASK-140.15).

export function connectTimeoutError(): string {
  return t().store.connectTimeout;
}

export function noSecureEndpointError(): string {
  return t().store.noSecureEndpoint;
}

/**
 * Понятная причина, когда ни один адрес не ответил (TASK-140.9). Если в профиле только адреса локальной
 * сети — почти наверняка телефон не дома, а путей через интернет нет.
 */
export function unreachableMessage(tried: RemoteEndpoint[], failures: string[]): string {
  if (tried.length > 0 && tried.every((ep) => ep.kind === 'lan')) return connectTimeoutError();
  const s = t().store;
  const parts = [s.unreachable(failures.join('; ')), s.unreachableCheck];
  if (tried.some((ep) => ep.kind === 'tunnel')) parts.push(s.unreachableTunnel);
  if (tried.some((ep) => ep.kind === 'vpn')) parts.push(s.unreachableVpn);
  return parts.join(' ');
}

export function wrongKeyError(): string {
  return t().store.wrongKey;
}

export function staleKeyError(): string {
  return t().store.staleKey;
}

export function hostKeyError(): string {
  return t().store.hostKey;
}

export function v2UnsupportedError(): string {
  return t().store.v2Unsupported;
}

export function hostTooOldError(): string {
  return t().store.hostTooOld;
}

/** Понятная причина отказа рукопожатия v2 для экрана. */
export function handshakeErrorMessage(err: unknown): string {
  if (err instanceof HandshakeError) {
    if (err.code === 'host_key_mismatch' || err.code === 'bad_signature' || err.code === 'host_id_mismatch') return hostKeyError();
  }
  return t().store.handshakeFailed(err instanceof Error ? err.message : String(err));
}

export class RemoteClient {
  private readonly opts: Required<Omit<RemoteClientOptions, 'onProfileChange' | 'v2' | 'confirmKey'>> &
    Pick<RemoteClientOptions, 'onProfileChange' | 'v2' | 'confirmKey'>;
  private profile: HostProfile | null = null;
  private codec: PacketCodec | null = null;
  /** Сессия v2 текущего сокета и начатое на нём рукопожатие. */
  private session: WebSessionV2 | null = null;
  private pendingHandshake: ClientHandshake | null = null;
  private socket: SocketLike | null = null;
  private pending = new Map<string, PendingRpc>();
  private eventListeners = new Set<EventListener>();
  private snapshotListeners = new Set<SnapshotListener>();
  private rpcCounter = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  /** Последний виденный eventId: нужен догону после разрыва (decision-11 п. 6). */
  private lastEventId = 0;
  /** Хотя бы раз были в `ready` с этим хостом — следующее подключение догоняет события. */
  private hadSession = false;
  /** Ручное отключение или фатальная ошибка: переподключаться не нужно. */
  private stopped = true;
  private snapshot: ClientSnapshot = {
    state: 'idle',
    error: null,
    hostId: '',
    rights: null,
    readOnly: false,
    viaRelay: false,
    route: null,
    endpoint: null,
    lastEventId: 0,
    retryInMs: null,
    protocol: null,
    deviceId: '',
    biometricConfirm: false
  };
  /** Адреса текущего цикла перебора и номер пробуемого. */
  private candidates: RemoteEndpoint[] = [];
  private candidateIdx = 0;
  private cycleFailures: string[] = [];
  private current: RemoteEndpoint | null = null;
  /** Причина неудачи текущей попытки (ответ релея), если её назвал хост или релей. */
  private attemptError: string | null = null;
  /** Сокет, дошедший до `ready`: его разрыв — потеря сессии, а не неудачная попытка адреса. */
  private readySocket: SocketLike | null = null;
  /** Когда пришёл последний кадр: молчащий дольше двух пингов сокет считаем мёртвым. */
  private lastFrameAt = 0;
  private upgradeTimer: unknown = null;
  /** Адрес, с которого начать следующий цикл (проверка нашла путь лучше); действует один цикл. */
  private preferUrl: string | null = null;
  private upgradeBusy = false;
  /** Адреса, переход на которые не удался: url → до какого времени их не пробовать. */
  private upgradeCooldown = new Map<string, number>();

  constructor(options: RemoteClientOptions) {
    this.opts = {
      timers: defaultTimers,
      rpcTimeoutMs: 15_000,
      heartbeatMs: 25_000,
      connectTimeoutMs: 0,
      secureOnly: false,
      upgradeProbeMs: 30_000,
      ...options
    };
  }

  getSnapshot(): ClientSnapshot {
    return this.snapshot;
  }

  getProfile(): HostProfile | null {
    return this.profile;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Подключение к хосту по профилю. Повторный вызов с другим профилем рвёт текущее соединение. */
  connect(profile: HostProfile): void {
    const problems = profileProblems(profile);
    if (problems.length > 0) {
      this.update({ state: 'failed', error: t().store.profileIncomplete(problems.map(profileProblemText).join(', ')) });
      return;
    }
    const sameHost = this.profile && this.profile.hostId && this.profile.hostId === profile.hostId;
    if (!sameHost) {
      this.lastEventId = 0;
      this.hadSession = false;
    }
    this.closeSocket();
    this.clearReconnect();
    this.profile = { ...profile };
    this.codec = isValidKeyHex(profile.key) ? this.opts.codecFactory(profile.key) : null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.openCycle();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    this.closeSocket();
    this.update({ state: 'idle', error: null, retryInMs: null });
  }

  /** Немедленная повторная попытка (кнопка «Переподключить»). */
  retryNow(): void {
    if (!this.profile) return;
    this.stopped = false;
    this.clearReconnect();
    this.closeSocket();
    this.reconnectAttempt = 0;
    this.openCycle();
  }

  /**
   * RPC к хосту. Права и режим «только чтение» проверяет хост в `dispatchRpc` — клиент лишь
   * прячет недоступные кнопки, отказ хоста приходит ошибкой.
   */
  rpc<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.snapshot.state !== 'ready' || (!this.session && !this.codec)) {
      return Promise.reject(new Error(t().store.notConnected));
    }
    return this.sendRpc<T>(socket, method, params);
  }

  // ── внутреннее ──

  private sendRpc<T>(socket: SocketLike, method: RpcMethod, params: Record<string, unknown>): Promise<T> {
    const id = `m${Date.now().toString(36)}_${++this.rpcCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = this.opts.timers.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(t().store.rpcTimeout(method)));
      }, this.opts.rpcTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendEncrypted(socket, { type: 'rpc_req', id, method, params }).catch((err: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.opts.timers.clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async sendEncrypted(socket: SocketLike, packet: PlainPacket): Promise<void> {
    let encrypted: EncryptedPacket | SessionFrameV2;
    // Сессия принадлежит сокету: после переподключения пакет старой сессии на новый сокет не уходит.
    const session = this.session;
    if (session) encrypted = await session.seal(packet);
    else if (this.codec) encrypted = await this.codec.encrypt(packet);
    else throw new Error(t().store.noEncryptionKey);
    if (session && session !== this.session) return;
    if (socket.readyState === OPEN) socket.send(JSON.stringify(encrypted));
  }

  /** Закреплён ли ключ хоста так, что можно идти по v2, и умеет ли это платформа. */
  private async wantsV2(): Promise<boolean> {
    const profile = this.profile;
    if (!profile || !this.opts.v2) return false;
    if (!isValidHostKey(profile.hostKey) && !profile.hostKeyFp) return false;
    return this.opts.v2.supported();
  }

  /** Первый пакет сокета: `client_hello` протокола v2 или зашифрованный общим ключом `handshake` v1. */
  private async startHandshake(socket: SocketLike): Promise<void> {
    this.session = null;
    this.pendingHandshake = null;
    if (await this.wantsV2()) {
      try {
        const hs = await this.opts.v2!.begin();
        if (this.socket !== socket) return;
        this.pendingHandshake = hs;
        if (socket.readyState === OPEN) socket.send(JSON.stringify(hs.hello));
      } catch (err) {
        this.update({ error: handshakeErrorMessage(err) });
      }
      return;
    }
    if (!this.codec) {
      // Соседа по федерации знаем только по ключу хоста — без v2 к нему не подключиться.
      this.stopped = true;
      this.update({ state: 'failed', error: v2UnsupportedError() });
      socket.close();
      return;
    }
    await this.sendHandshake(socket);
  }

  /** Ответ хоста на `client_hello`: проверка подписи закреплённым ключом и прежний `handshake` уже в сессии. */
  private async handleServerHello(socket: SocketLike, serverHello: unknown): Promise<void> {
    const hs = this.pendingHandshake;
    const profile = this.profile;
    if (!hs || !profile) return;
    this.pendingHandshake = null;
    try {
      const result = await hs.finish(serverHello, {
        deviceId: profile.deviceId,
        hostId: profile.hostId || undefined,
        hostKey: isValidHostKey(profile.hostKey) ? profile.hostKey : undefined,
        hostKeyFp: profile.hostKeyFp
      });
      if (this.socket !== socket) return;
      this.session = result.session;
      if (profile.hostKey !== result.hostKey) {
        // Ключ из отпечатка Telegram подтверждён — дальше сверяем с полным ключом.
        profile.hostKey = result.hostKey;
        this.opts.onProfileChange?.({ ...profile });
      }
      this.update({ protocol: SESSION_PROTOCOL_V2 });
      await this.sendHandshake(socket);
    } catch (err) {
      if (this.socket !== socket) return;
      this.stopped = true;
      this.update({ state: 'failed', error: handshakeErrorMessage(err) });
      socket.close();
    }
  }

  /** Новый цикл перебора: адреса профиля по порядку, последний удачный — первым (TASK-140.9). */
  private openCycle(): void {
    const profile = this.profile;
    if (!profile) return;
    this.candidates = connectionCandidates(profile, { secureOnly: this.opts.secureOnly, firstUrl: this.preferUrl ?? undefined });
    this.preferUrl = null;
    this.candidateIdx = 0;
    this.cycleFailures = [];
    if (this.candidates.length === 0) {
      this.stopped = true;
      this.update({ state: 'failed', error: noSecureEndpointError(), route: null, endpoint: null, retryInMs: null });
      return;
    }
    this.openCandidate();
  }

  private openCandidate(): void {
    const profile = this.profile;
    const endpoint = this.candidates[this.candidateIdx];
    if (!profile || !endpoint) return;
    this.current = endpoint;
    this.attemptError = null;
    const target = buildWsTarget(profile, endpoint, this.opts.deviceName);
    this.update({
      state: this.hadSession ? 'reconnecting' : 'connecting',
      viaRelay: target.viaRelay,
      route: endpoint.kind,
      endpoint: endpointLabel(endpoint),
      hostId: profile.hostId,
      deviceId: profile.deviceId,
      retryInMs: null,
      protocol: null
    });

    let socket: SocketLike;
    try {
      socket = this.opts.socketFactory(target.url);
    } catch (err) {
      this.candidateFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;

    // Брандмауэр, выключенный Remote Control или адрес LAN из мобильной сети часто не отвечают вовсе —
    // без таймаута клиент висел бы на одном адресе.
    const timeoutMs = this.opts.connectTimeoutMs || CONNECT_TIMEOUT_BY_KIND[endpoint.kind];
    const connectTimer = this.opts.timers.setTimeout(() => {
      if (this.socket !== socket || socket.readyState === OPEN) return;
      this.socket = null;
      abandonSocket(socket);
      this.candidateFailed(t().store.notResponding);
    }, timeoutMs);

    socket.onopen = () => {
      this.opts.timers.clearTimeout(connectTimer);
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      this.update({ state: 'pairing' });
      // Напрямую секреты не едут в URL: первым пакетом идёт рукопожатие. Через релей — после relay_ack.
      if (!target.viaRelay) void this.startHandshake(socket);
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      void this.handleRaw(socket, ev.data);
    };
    socket.onerror = () => {
      // Подробностей браузер не даёт; закрытие придёт отдельно.
    };
    socket.onclose = (ev) => {
      this.opts.timers.clearTimeout(connectTimer);
      this.onSocketClosed(socket, ev);
    };
  }

  private onSocketClosed(socket: SocketLike, ev: { code?: number; reason?: string }): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.session = null;
    this.pendingHandshake = null;
    this.stopHeartbeat();
    this.rejectAllPending(new Error(t().store.connectionLost));
    if (isRevokedClose(ev.code, ev.reason)) {
      this.forgetToken();
      this.stopped = true;
      this.update({ state: 'failed', error: t().store.deviceRevoked });
      return;
    }
    if (this.stopped) return;
    if (this.readySocket === socket) {
      // Сессия была — после паузы начинаем новый цикл с того же (последнего удачного) адреса.
      this.readySocket = null;
      this.scheduleReconnect();
      return;
    }
    this.candidateFailed(this.attemptError || t().store.unavailable);
  }

  /** Адрес не сработал: сразу пробуем следующий, а когда кончились — пауза и новый цикл. */
  private candidateFailed(reason: string): void {
    if (this.stopped) return;
    if (this.current) this.cycleFailures.push(`${endpointLabel(this.current)} — ${reason}`);
    this.candidateIdx++;
    if (this.candidateIdx < this.candidates.length) {
      this.openCandidate();
      return;
    }
    this.update({ error: unreachableMessage(this.candidates, this.cycleFailures) });
    this.scheduleReconnect();
  }

  private async handleRaw(socket: SocketLike, raw: unknown): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await frameText(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    // Служебные сообщения релея и ошибки хоста идут открытым текстом.
    if (parsed.type === 'relay_ack' && parsed.role === 'client') {
      await this.startHandshake(socket);
      return;
    }
    if (parsed.type === 'server_hello') {
      await this.handleServerHello(socket, parsed);
      return;
    }
    if (parsed.type === 'host_disconnected') {
      this.attemptError = t().store.hostLeftRelay;
      socket.close();
      return;
    }
    if (parsed.type === 'error') {
      this.handleHostError(socket, String(parsed.error || t().store.hostError));
      return;
    }

    let packet: PlainPacket;
    if (isSessionFrameV2(parsed)) {
      if (!this.session) return;
      try {
        packet = (await this.session.open(parsed)) as PlainPacket;
      } catch {
        // Повтор или подделка — пакет отбрасываем, счётчик сессии не сдвигается.
        return;
      }
    } else if (this.session || this.pendingHandshake) {
      // Сокет говорит по v2: пакет v1 или открытый ack — не от нашей сессии.
      return;
    } else if (parsed.e2ee === true) {
      try {
        packet = await this.codec!.decrypt(parsed as unknown as EncryptedPacket);
      } catch {
        // Чужой ключ или подделка — пакет отбрасываем.
        return;
      }
    } else if (parsed.type === 'handshake_ack') {
      // В LAN хост отвечает на апгрейд сокета открытым текстом; содержимое ack — права и токен.
      packet = parsed as unknown as PlainPacket;
    } else {
      // Остальное открытым текстом не принимаем: сессия всегда зашифрована. Хост отвечает так,
      // только если наш ключ ему уже не подходит (ключ перевыпустили на ПК), а токен ещё жив.
      if (parsed.type === 'rpc_res' || parsed.type === 'event') {
        this.stopped = true;
        this.update({ state: 'failed', error: staleKeyError() });
        socket.close();
      }
      return;
    }

    this.handlePacket(socket, packet);
  }

  private handleHostError(socket: SocketLike, message: string): void {
    // Старый хост не понял `client_hello` и ответил как неодобренному устройству.
    if (this.pendingHandshake && /not approved/i.test(message)) {
      this.pendingHandshake = null;
      this.stopped = true;
      this.update({ state: 'failed', error: hostTooOldError() });
      socket.close();
      return;
    }
    if (isFatalHostError(message)) {
      this.stopped = true;
      this.update({ state: 'failed', error: fatalHostErrorText(message) });
      socket.close();
      return;
    }
    // Через релей хост не смог расшифровать наш handshake — ключ не от этого компьютера.
    if (/decrypt failure/i.test(message) && this.snapshot.state !== 'ready') {
      this.stopped = true;
      this.update({ state: 'failed', error: wrongKeyError() });
      socket.close();
      return;
    }
    if (/not approved/i.test(message)) {
      this.update({ state: 'awaiting_approval', error: null });
      return;
    }
    // Например, «Host offline or not found» от релея: сокет закроется, клиент перейдёт к следующему адресу.
    if (this.snapshot.state === 'ready') this.update({ error: message });
    else this.attemptError = /offline or not found/i.test(message) ? t().store.hostNotOnRelay : message;
  }

  private async sendHandshake(socket: SocketLike): Promise<void> {
    const profile = this.profile!;
    const data: Record<string, string> = { name: this.opts.deviceName };
    if (profile.key) data.key = profile.key;
    if (profile.pin) data.pin = profile.pin;
    if (profile.deviceToken) data.token = profile.deviceToken;
    else if ((profile.key || profile.pin) && this.opts.confirmKey) {
      const confirmKey = await this.opts.confirmKey(profile.deviceId).catch(() => null);
      if (this.socket !== socket) return;
      if (confirmKey) data.confirmKey = confirmKey;
    }
    try {
      await this.sendEncrypted(socket, { type: 'handshake', data });
    } catch (err) {
      this.update({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handlePacket(socket: SocketLike, packet: PlainPacket): void {
    if (packet.type === 'handshake_ack') {
      void this.handleAck(socket, (packet.result || {}) as RemoteHandshakeAck);
      return;
    }
    if ((packet.type === 'rpc_res' || (packet.type as string) === 'response') && packet.id) {
      const entry = this.pending.get(packet.id);
      if (!entry) return;
      this.pending.delete(packet.id);
      this.opts.timers.clearTimeout(entry.timer);
      if (packet.error) entry.reject(withAppErrorKey(new Error(packet.error), packet.errorKey));
      else entry.resolve(packet.result);
      return;
    }
    if (packet.type === 'event' && packet.event) {
      if (typeof packet.eventId === 'number') {
        // Повтор уже виденного (догон и живой поток пересеклись) — пропускаем.
        if (packet.eventId <= this.lastEventId) return;
        this.lastEventId = packet.eventId;
        this.update({ lastEventId: this.lastEventId });
      }
      if (packet.event === 'host:endpoints') this.applyHostEndpoints(packet.data);
      this.emit(packet.event, packet.data);
    }
  }

  private async handleAck(socket: SocketLike, ack: RemoteHandshakeAck): Promise<void> {
    const profile = this.profile!;
    let changed = false;
    if (ack.deviceToken && ack.deviceToken !== profile.deviceToken) {
      profile.deviceToken = ack.deviceToken;
      changed = true;
    }
    if (ack.hostId && ack.hostId !== profile.hostId) {
      profile.hostId = ack.hostId;
      changed = true;
    }
    if (ack.rights && ack.rights !== profile.rights) {
      profile.rights = ack.rights;
      changed = true;
    }
    // PIN одноразовый: после выдачи токена он не нужен и не хранится.
    if (profile.pin && (ack.deviceToken || profile.deviceToken)) {
      profile.pin = undefined;
      changed = true;
    }
    if (mergeHostEndpoints(profile, ack)) changed = true;
    // Адрес, через который хост ответил и одобрил устройство, становится первым в следующем переборе.
    if (ack.approved !== false && this.current && profile.lastEndpoint !== this.current.url) {
      profile.lastEndpoint = this.current.url;
      changed = true;
    }
    if (changed) this.opts.onProfileChange?.({ ...profile });

    // Хост v1 → v2 (decision-111): по сессии, защищённой общим ключом, хост сообщил свой ключ. Закрепляем его и
    // сразу переподключаемся по v2 с того же адреса — повторное сопряжение не нужно.
    if (
      !this.session &&
      ack.approved !== false &&
      !isValidHostKey(profile.hostKey) &&
      !profile.hostKeyFp &&
      Array.isArray(ack.protocols) &&
      ack.protocols.includes(SESSION_PROTOCOL_V2) &&
      isValidHostKey(ack.hostKey) &&
      this.opts.v2 &&
      (await this.opts.v2.supported())
    ) {
      if (this.socket !== socket) return;
      profile.hostKey = ack.hostKey;
      this.opts.onProfileChange?.({ ...profile });
      if (this.current) this.preferUrl = this.current.url;
      this.closeSocket();
      this.reconnectAttempt = 0;
      this.openCycle();
      return;
    }

    this.update({
      hostId: profile.hostId,
      rights: ack.rights ?? profile.rights ?? null,
      readOnly: Boolean(ack.readOnly),
      protocol: this.session ? SESSION_PROTOCOL_V2 : SESSION_PROTOCOL_V1,
      biometricConfirm: ack.biometricConfirm === true
    });

    if (ack.approved === false) {
      this.update({ state: 'awaiting_approval', error: null });
      return;
    }
    if (this.snapshot.state === 'ready') return;

    const catchUp = this.hadSession && this.lastEventId > 0;
    if (!catchUp && typeof ack.lastEventId === 'number') {
      // Первое подключение: историю не проигрываем, только запоминаем точку в потоке.
      this.lastEventId = ack.lastEventId;
    }
    this.reconnectAttempt = 0;
    this.hadSession = true;
    this.readySocket = socket;
    if (this.current) this.upgradeCooldown.delete(this.current.url);
    this.update({ state: 'ready', error: null, lastEventId: this.lastEventId, retryInMs: null });
    this.startHeartbeat(socket);
    this.startUpgradeProbe(socket);
    if (catchUp) await this.catchUpEvents(socket);
    this.emit('client:ready', { catchUp });
  }

  /** Догон событий, пропущенных за разрыв (кольцевой буфер хоста, `get_events_since`). */
  private async catchUpEvents(socket: SocketLike): Promise<void> {
    try {
      const res = await this.sendRpc<{ events?: Array<{ id: number; event: string; data: unknown }>; lastEventId?: number }>(
        socket,
        'get_events_since',
        { sinceId: this.lastEventId }
      );
      for (const e of res?.events ?? []) {
        if (typeof e.id !== 'number' || e.id <= this.lastEventId) continue;
        this.lastEventId = e.id;
        this.emit(e.event, e.data);
      }
      if (typeof res?.lastEventId === 'number' && res.lastEventId > this.lastEventId) this.lastEventId = res.lastEventId;
      this.update({ lastEventId: this.lastEventId });
    } catch {
      // Догон не критичен: экраны всё равно перечитают данные по `client:ready`.
    }
  }

  private startHeartbeat(socket: SocketLike): void {
    this.stopHeartbeat();
    // Туннели и прокси рвут молчащие сокеты (Cloudflare — около 100 с).
    this.heartbeatTimer = this.opts.timers.setInterval(() => {
      if (this.socket !== socket) return;
      // Сеть сменилась (Wi-Fi → мобильная), а сокет не закрылся: хост молчит дольше двух пингов — сессия мертва.
      if (Date.now() - this.lastFrameAt > this.opts.heartbeatMs * 2 + 10_000) {
        abandonSocket(socket);
        this.onSocketClosed(socket, { code: 4002, reason: 'heartbeat timeout' });
        return;
      }
      if (socket.readyState === OPEN) {
        void this.sendEncrypted(socket, { type: 'ping', id: `p${Date.now().toString(36)}` }).catch(() => undefined);
      }
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.opts.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.upgradeTimer !== null) {
      this.opts.timers.clearInterval(this.upgradeTimer);
      this.upgradeTimer = null;
    }
  }

  /**
   * Пока связь идёт через путь хуже лучшего из известных (VPN, туннель, релей), раз в `upgradeProbeMs`
   * проверяем адреса лучше. Ответил — переподключаемся на него: дома связь возвращается на LAN, хотя после
   * разрыва клиент начинал с последнего удачного туннеля.
   */
  private startUpgradeProbe(socket: SocketLike): void {
    if (!this.opts.upgradeProbeMs || !this.current || this.current.kind === 'lan') return;
    this.upgradeTimer = this.opts.timers.setInterval(() => void this.tryUpgrade(socket), this.opts.upgradeProbeMs);
  }

  private async tryUpgrade(socket: SocketLike): Promise<void> {
    const profile = this.profile;
    const current = this.current;
    if (this.upgradeBusy || !profile || !current || this.socket !== socket || this.snapshot.state !== 'ready') return;
    const rank = (kind: EndpointKind) => ENDPOINT_KIND_ORDER.indexOf(kind);
    const now = Date.now();
    const better = connectionCandidates(profile, { secureOnly: this.opts.secureOnly }).filter(
      (ep) => ep.kind !== 'relay' && rank(ep.kind) < rank(current.kind) && (this.upgradeCooldown.get(ep.url) ?? 0) <= now
    );
    if (better.length === 0) return;
    this.upgradeBusy = true;
    try {
      for (const ep of better) {
        if (!(await this.probe(ep))) continue;
        if (this.socket !== socket || this.snapshot.state !== 'ready') return;
        // Если переход не удастся, этот адрес не пробуем ещё 5 минут — иначе связь дёргалась бы каждые 30 с.
        this.upgradeCooldown.set(ep.url, Date.now() + UPGRADE_COOLDOWN_MS);
        this.preferUrl = ep.url;
        this.closeSocket();
        this.reconnectAttempt = 0;
        this.openCycle();
        return;
      }
    } finally {
      this.upgradeBusy = false;
    }
  }

  /** Сокет к адресу открывается — адрес рабочий. Хост закрывает `?probe=1` сразу, ничего не регистрируя. */
  private probe(ep: RemoteEndpoint): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let socket: SocketLike | null = null;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.opts.timers.clearTimeout(timer);
        if (socket) abandonSocket(socket);
        resolve(ok);
      };
      const timer = this.opts.timers.setTimeout(() => finish(false), CONNECT_TIMEOUT_BY_KIND[ep.kind]);
      try {
        socket = this.opts.socketFactory(`${ep.url}/?probe=1`);
      } catch {
        finish(false);
        return;
      }
      socket.onopen = () => finish(true);
      socket.onclose = () => finish(false);
      socket.onerror = () => undefined;
      socket.onmessage = () => undefined;
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.update({ state: 'reconnecting', retryInMs: delay });
    this.reconnectTimer = this.opts.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.openCycle();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.opts.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.readySocket = null;
    this.session = null;
    this.pendingHandshake = null;
    this.stopHeartbeat();
    this.rejectAllPending(new Error(t().store.connectionClosed));
    if (socket) {
      try {
        socket.close();
      } catch {
        // уже закрыт
      }
    }
  }

  /** Хост прислал свежий список адресов (событие `host:endpoints`) — сохраняем без нового QR. */
  private applyHostEndpoints(data: unknown): void {
    if (!this.profile || !data || typeof data !== 'object') return;
    if (mergeHostEndpoints(this.profile, data as { endpoints?: unknown; relayUrl?: unknown })) this.opts.onProfileChange?.({ ...this.profile });
  }

  private forgetToken(): void {
    if (!this.profile) return;
    this.profile.deviceToken = undefined;
    this.profile.rights = undefined;
    this.opts.onProfileChange?.({ ...this.profile });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      this.opts.timers.clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, data);
      } catch {
        // ошибка экрана не должна ронять поток событий
      }
    }
  }

  private update(patch: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.snapshotListeners) listener(this.snapshot);
  }
}
