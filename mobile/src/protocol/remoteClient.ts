import type {
  DeviceRights,
  EncryptedPacket,
  PlainPacket,
  RemoteHandshakeAck,
  RemoteRpcMethod
} from '../../../src/types/remote';
import { buildWsTarget, profileProblems, type HostProfile } from './pairing';

/**
 * Клиент Remote Control для телефона (TASK-140.1): соединение, сопряжение, RPC и события по
 * текущему протоколу v1 ([[decision-11]]). Чистый модуль без React и DOM — сокет, шифрование и
 * таймеры внедряются, поэтому всё поведение проверяется unit-тестами в Node.
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
  lastEventId: number;
  /** Через сколько миллисекунд будет следующая попытка (только в `reconnecting`). */
  retryInMs: number | null;
}

/** Метод мобильного клиента — тот же набор, что объявлен в `RemoteRpcMethod`. */
export type RpcMethod = RemoteRpcMethod;

export interface RemoteClientOptions {
  socketFactory: SocketFactory;
  codecFactory: CodecFactory;
  deviceName: string;
  /** Профиль изменился (выдан токен, узнали hostId/права) — платформа сохраняет его. */
  onProfileChange?: (profile: HostProfile) => void;
  timers?: Timers;
  rpcTimeoutMs?: number;
  heartbeatMs?: number;
}

/** Экспоненциальная задержка переподключения, как у хоста и прежних клиентов: 1с, 2с, 4с … ≤ 30с. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempt)));
}

/**
 * Ошибки хоста, после которых повторять подключение нельзя: неверный PIN/ключ (повтор быстро
 * упрётся в блокировку по частоте попыток) и отзыв устройства на ПК.
 */
export function isFatalHostError(message: string): boolean {
  return /Invalid pairing PIN or secret key|Too many failed attempts|Authentication failed|Rate limited/i.test(message);
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

export const WRONG_KEY_ERROR = 'Ключ не подходит к этому компьютеру. Отсканируйте QR-код заново.';

export const STALE_KEY_ERROR = 'Ключ шифрования устарел: хост отвечает без шифрования. Сопрягите устройство заново.';

export class RemoteClient {
  private readonly opts: Required<Omit<RemoteClientOptions, 'onProfileChange'>> & Pick<RemoteClientOptions, 'onProfileChange'>;
  private profile: HostProfile | null = null;
  private codec: PacketCodec | null = null;
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
    lastEventId: 0,
    retryInMs: null
  };

  constructor(options: RemoteClientOptions) {
    this.opts = {
      timers: defaultTimers,
      rpcTimeoutMs: 15_000,
      heartbeatMs: 25_000,
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
      this.update({ state: 'failed', error: `Профиль неполный: ${problems.join(', ')}` });
      return;
    }
    const sameHost = this.profile && this.profile.hostId && this.profile.hostId === profile.hostId;
    if (!sameHost) {
      this.lastEventId = 0;
      this.hadSession = false;
    }
    this.closeSocket();
    this.profile = { ...profile };
    this.codec = this.opts.codecFactory(profile.key);
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.open();
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
    this.open();
  }

  /**
   * RPC к хосту. Права и режим «только чтение» проверяет хост в `dispatchRpc` — клиент лишь
   * прячет недоступные кнопки, отказ хоста приходит ошибкой.
   */
  rpc<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.snapshot.state !== 'ready' || !this.codec) {
      return Promise.reject(new Error('Нет подключения к ProjectHub'));
    }
    return this.sendRpc<T>(socket, method, params);
  }

  // ── внутреннее ──

  private sendRpc<T>(socket: SocketLike, method: RpcMethod, params: Record<string, unknown>): Promise<T> {
    const id = `m${Date.now().toString(36)}_${++this.rpcCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = this.opts.timers.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Хост не ответил на ${method}`));
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
    if (!this.codec) throw new Error('Нет ключа шифрования');
    const encrypted = await this.codec.encrypt(packet);
    if (socket.readyState === OPEN) socket.send(JSON.stringify(encrypted));
  }

  private open(): void {
    const profile = this.profile;
    if (!profile) return;
    const target = buildWsTarget(profile, this.opts.deviceName);
    this.update({
      state: this.hadSession ? 'reconnecting' : 'connecting',
      viaRelay: target.viaRelay,
      hostId: profile.hostId,
      retryInMs: null
    });

    let socket: SocketLike;
    try {
      socket = this.opts.socketFactory(target.url);
    } catch (err) {
      this.update({ error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      // В LAN хост сам присылает handshake_ack после проверки query; через релей ждём relay_ack.
      this.update({ state: 'pairing', error: null });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      void this.handleRaw(socket, ev.data);
    };
    socket.onerror = () => {
      // Подробностей браузер не даёт; закрытие придёт отдельно.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.rejectAllPending(new Error('Соединение разорвано'));
      if (isRevokedClose(ev.code, ev.reason)) {
        this.forgetToken();
        this.stopped = true;
        this.update({ state: 'failed', error: 'Устройство отключено на ПК. Сопрягите его заново.' });
        return;
      }
      if (this.stopped) return;
      this.scheduleReconnect();
    };
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
      await this.sendHandshake(socket);
      return;
    }
    if (parsed.type === 'host_disconnected') {
      this.update({ error: 'Хост отключился от релея' });
      socket.close();
      return;
    }
    if (parsed.type === 'error') {
      this.handleHostError(socket, String(parsed.error || 'Ошибка хоста'));
      return;
    }

    let packet: PlainPacket;
    if (parsed.e2ee === true) {
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
        this.update({ state: 'failed', error: STALE_KEY_ERROR });
        socket.close();
      }
      return;
    }

    this.handlePacket(socket, packet);
  }

  private handleHostError(socket: SocketLike, message: string): void {
    if (isFatalHostError(message)) {
      this.stopped = true;
      this.update({ state: 'failed', error: message });
      socket.close();
      return;
    }
    // Через релей хост не смог расшифровать наш handshake — ключ не от этого компьютера.
    if (/decrypt failure/i.test(message) && this.snapshot.state !== 'ready') {
      this.stopped = true;
      this.update({ state: 'failed', error: WRONG_KEY_ERROR });
      socket.close();
      return;
    }
    if (/not approved/i.test(message)) {
      this.update({ state: 'awaiting_approval', error: null });
      return;
    }
    // Например, «Host offline or not found» от релея: сокет закроется, сработает backoff.
    this.update({ error: message });
  }

  private async sendHandshake(socket: SocketLike): Promise<void> {
    const profile = this.profile!;
    const data: Record<string, string> = { key: profile.key };
    if (profile.pin) data.pin = profile.pin;
    if (profile.deviceToken) data.token = profile.deviceToken;
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
      if (packet.error) entry.reject(new Error(packet.error));
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
    if (changed) this.opts.onProfileChange?.({ ...profile });

    this.update({
      hostId: profile.hostId,
      rights: ack.rights ?? profile.rights ?? null,
      readOnly: Boolean(ack.readOnly)
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
    this.update({ state: 'ready', error: null, lastEventId: this.lastEventId, retryInMs: null });
    this.startHeartbeat(socket);
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
      if (this.socket === socket && socket.readyState === OPEN) {
        void this.sendEncrypted(socket, { type: 'ping', id: `p${Date.now().toString(36)}` }).catch(() => undefined);
      }
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.opts.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.update({ state: 'reconnecting', retryInMs: delay });
    this.reconnectTimer = this.opts.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
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
    this.stopHeartbeat();
    this.rejectAllPending(new Error('Соединение закрыто'));
    if (socket) {
      try {
        socket.close();
      } catch {
        // уже закрыт
      }
    }
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
