import crypto, { webcrypto } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { WebSocket } from 'ws';
import type { DeviceRights, FederationPeerState, FederationPeerStatus, PlainPacket } from '../../src/types/remote.js';
import {
  buildPeerSocketUrl,
  checkPeerProtocol,
  framePacket,
  isFatalPeerError,
  nextBackoffDelay,
  parseIncomingPacket,
  peerHandshakeData,
  type PeerTransport
} from './federationProtocol.js';
import {
  HandshakeError,
  SESSION_PROTOCOL_V1,
  SESSION_PROTOCOL_V2,
  createClientHandshake,
  isSessionFrameV2,
  type ClientHandshake,
  type WebSessionV2
} from '../../src/utils/remoteSessionV2.js';
import { isHostKey } from '../../src/utils/remoteSessionV2Node.js';
import { secretStorageService } from './secretStorageService.js';
import { logger } from './logger.js';
import { appEventBus } from './eventBus.js';

/**
 * Hub-режим федерации (TASK-66, decision-11 п.4): ProjectHub как КЛИЕНТ другого ProjectHub.
 *
 * Зеркало `remoteControlService` (тот принимает устройства), только в обратную сторону: этот
 * сервис открывает исходящие соединения к доверенным хостам пользователя, выполняет на них тот
 * же набор RPC, что и телефон, и транслирует их события в рендерер. Права ограничены per-device
 * токеном, который выдал удалённый хост, — hub не получает привилегий сверх своего устройства.
 */

/** Учётные данные пира: хранятся целиком в safeStorage (содержат E2EE-ключ и токен). */
interface PeerCredentials {
  hostId: string;
  machineName: string;
  transport: PeerTransport;
  /** LAN: `host:port`; relay: URL релея. */
  address: string;
  secretKey?: string;
  /**
   * Закреплённый ключ сессий хоста (ECDSA P-256, base64url, decision-111): из ссылки сопряжения или из `handshake_ack`
   * первого подключения по общему ключу. С ним hub говорит с хостом по v2 с forward secrecy.
   */
  hostKey?: string;
  deviceToken?: string;
  /**
   * `deviceId`, под которым хост знает этот ПК. Пусто — hostId этого ПК. Знакомство через телефон (decision-143) выдаёт
   * свой `fed_…`: его выбирает хост, а не мы.
   */
  deviceId?: string;
  /** Автоподключаться при старте приложения. */
  autoConnect?: boolean;
  addedAt: number;
}

export type PeerStatus = FederationPeerStatus;

export type { FederationPeerState };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PeerConnection {
  credentials: PeerCredentials;
  ws: WebSocket | null;
  status: PeerStatus;
  error?: string;
  rights?: DeviceRights;
  readOnly?: boolean;
  protocolVersion?: number;
  lastEventId: number;
  connectedAt?: number;
  pending: Map<string, PendingCall>;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  /** Пин первого сопряжения — держим только в памяти до выдачи токена. */
  pendingPin?: string;
  handshakeWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  /** Пользователь отключил пира вручную — не переподключаться. */
  manualDisconnect: boolean;
  /** Сессия v2 этого сокета; без неё пакеты идут общим ключом v1. */
  session: WebSessionV2 | null;
  /** Рукопожатие v2 ждёт `server_hello`. */
  pendingHandshake: ClientHandshake | null;
  /** Входящие кадры обрабатываются по очереди: расшифровка v2 асинхронна, порядок пакетов важен. */
  inbox: Promise<void>;
  sessionProtocol?: number;
  /** Ошибка, после которой переподключение бессмысленно (PIN, ключ, подмена ключа хоста, «только v2»). */
  fatal: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const RPC_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PEERS_SECRET_KEY = 'federation.peers';

class FederationClientService {
  private peers = new Map<string, PeerConnection>();
  private loaded: Promise<void> | null = null;
  /** Идентификатор и имя этой машины как устройства на удалённых хостах. */
  private localHostId = '';
  private localMachineName = 'ProjectHub';

  /** Вызывается из main после инициализации Remote Control: hub представляется своим hostId. */
  public configure(options: { hostId: string; machineName: string }): void {
    this.localHostId = options.hostId || this.localHostId;
    this.localMachineName = options.machineName || this.localMachineName;
  }

  public async init(): Promise<void> {
    await this.ensureLoaded();
    for (const peer of this.peers.values()) {
      if (peer.credentials.autoConnect && peer.credentials.deviceToken) {
        this.openConnection(peer).catch(() => {});
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const blob = await secretStorageService.getSecret(PEERS_SECRET_KEY);
          if (!blob) return;
          const parsed = JSON.parse(blob) as PeerCredentials[];
          for (const credentials of parsed) {
            if (!credentials?.hostId) continue;
            this.peers.set(credentials.hostId, this.emptyConnection(credentials));
          }
        } catch (err) {
          logger.warn(`[Federation] Failed to load peers: ${errorText(err)}`);
        }
      })();
    }
    await this.loaded;
  }

  private emptyConnection(credentials: PeerCredentials): PeerConnection {
    return {
      credentials,
      ws: null,
      status: 'idle',
      lastEventId: 0,
      pending: new Map(),
      reconnectAttempt: 0,
      reconnectTimer: null,
      handshakeWaiters: [],
      manualDisconnect: false,
      session: null,
      pendingHandshake: null,
      inbox: Promise.resolve(),
      fatal: false
    };
  }

  private async persistPeers(): Promise<void> {
    try {
      const list = Array.from(this.peers.values()).map((p) => p.credentials);
      await secretStorageService.setSecret(PEERS_SECRET_KEY, JSON.stringify(list));
    } catch (err) {
      logger.warn(`[Federation] Failed to persist peers: ${errorText(err)}`);
    }
  }

  public async listPeers(): Promise<FederationPeerState[]> {
    await this.ensureLoaded();
    return Array.from(this.peers.values()).map((p) => this.toState(p));
  }

  private peerDeviceId(peer: PeerConnection): string {
    return peer.credentials.deviceId || this.localHostId || 'projecthub-hub';
  }

  private toState(peer: PeerConnection): FederationPeerState {
    return {
      hostId: peer.credentials.hostId,
      machineName: peer.credentials.machineName,
      transport: peer.credentials.transport,
      address: peer.credentials.address,
      status: peer.status,
      error: peer.error,
      rights: peer.rights,
      readOnly: peer.readOnly,
      protocolVersion: peer.protocolVersion,
      lastEventId: peer.lastEventId,
      connectedAt: peer.connectedAt,
      paired: Boolean(peer.credentials.deviceToken),
      autoConnect: Boolean(peer.credentials.autoConnect),
      ...(peer.sessionProtocol ? { sessionProtocol: peer.sessionProtocol } : {}),
      hostKeyPinned: isHostKey(peer.credentials.hostKey)
    };
  }

  /**
   * Добавляет (или обновляет) пира и сразу подключается: при первом сопряжении нужен PIN и
   * E2EE-ключ удалённого хоста, дальше хватает выданного им токена.
   */
  public async addPeer(options: {
    hostId: string;
    machineName?: string;
    transport: PeerTransport;
    address: string;
    secretKey?: string;
    /** Ключ сессий хоста из ссылки сопряжения (`hk`): сразу v2, без первого подключения по общему ключу. */
    hostKey?: string;
    pin?: string;
    /** Готовые `deviceId` и токен, выданные хостом по знакомству (decision-143): PIN и ключ не нужны. */
    deviceId?: string;
    deviceToken?: string;
    autoConnect?: boolean;
  }): Promise<FederationPeerState> {
    await this.ensureLoaded();
    if (!options.hostId?.trim()) throw new Error('hostId удалённого хоста обязателен');
    const hostKey = options.hostKey?.trim();
    if (hostKey && !isHostKey(hostKey)) throw new Error('Ключ хоста (hk) не похож на ключ ProjectHub — скопируйте его из ссылки сопряжения целиком');
    if (options.hostId === this.localHostId) throw new Error('Нельзя добавить самого себя как удалённый хост');

    const existing = this.peers.get(options.hostId);
    const credentials: PeerCredentials = {
      hostId: options.hostId.trim(),
      machineName: options.machineName?.trim() || existing?.credentials.machineName || options.hostId.trim(),
      transport: options.transport,
      address: options.address.trim(),
      secretKey: options.secretKey?.trim() || existing?.credentials.secretKey,
      // Новый ключ хоста — только явно из ссылки: подменить закреплённый ключ молча нельзя.
      hostKey: hostKey || existing?.credentials.hostKey,
      deviceToken: options.deviceToken?.trim() || existing?.credentials.deviceToken,
      ...(options.deviceToken?.trim() && options.deviceId?.trim()
        ? { deviceId: options.deviceId.trim() }
        : existing?.credentials.deviceId
          ? { deviceId: existing.credentials.deviceId }
          : {}),
      autoConnect: options.autoConnect ?? existing?.credentials.autoConnect ?? true,
      addedAt: existing?.credentials.addedAt || Date.now()
    };

    if (existing) {
      this.closeSocket(existing);
      existing.credentials = credentials;
      existing.pendingPin = options.pin;
      existing.manualDisconnect = false;
      existing.fatal = false;
      await this.persistPeers();
      await this.openConnection(existing);
      return this.toState(existing);
    }

    const peer = this.emptyConnection(credentials);
    peer.pendingPin = options.pin;
    this.peers.set(credentials.hostId, peer);
    await this.persistPeers();
    await this.openConnection(peer);
    return this.toState(peer);
  }

  public async removePeer(hostId: string): Promise<void> {
    await this.ensureLoaded();
    const peer = this.peers.get(hostId);
    if (!peer) return;
    peer.manualDisconnect = true;
    this.closeSocket(peer);
    this.peers.delete(hostId);
    await this.persistPeers();
    this.notifyPeersChanged();
  }

  public async connectPeer(hostId: string): Promise<FederationPeerState> {
    await this.ensureLoaded();
    const peer = this.peers.get(hostId);
    if (!peer) throw new Error(`Хост ${hostId} не найден среди удалённых`);
    peer.manualDisconnect = false;
    peer.fatal = false;
    await this.openConnection(peer);
    return this.toState(peer);
  }

  public async disconnectPeer(hostId: string): Promise<FederationPeerState> {
    await this.ensureLoaded();
    const peer = this.peers.get(hostId);
    if (!peer) throw new Error(`Хост ${hostId} не найден среди удалённых`);
    peer.manualDisconnect = true;
    this.closeSocket(peer);
    peer.status = 'idle';
    peer.error = undefined;
    this.notifyPeersChanged();
    return this.toState(peer);
  }

  /** Подключён ли пир прямо сейчас (для маршрутизации назначений между машинами). */
  public isConnected(hostId: string): boolean {
    const peer = this.peers.get(hostId);
    return Boolean(peer && peer.status === 'connected' && peer.ws?.readyState === WebSocket.OPEN);
  }

  /**
   * Выполняет RPC на удалённом хосте. Права проверяет сам хост по токену нашего устройства —
   * hub ничего не обходит, а лишь получает понятную ошибку, если прав не хватает.
   */
  public async call<T = unknown>(hostId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureLoaded();
    const peer = this.peers.get(hostId);
    if (!peer) throw new Error(`Хост ${hostId} не найден среди удалённых`);

    if (peer.status !== 'connected') {
      await this.openConnection(peer);
    }
    if (!peer.ws || peer.ws.readyState !== WebSocket.OPEN) {
      throw new Error(peer.error || `Хост ${peer.credentials.machineName} недоступен (${peer.status})`);
    }

    const id = `rpc_${crypto.randomBytes(8).toString('hex')}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(id);
        reject(new Error(`Таймаут RPC ${method} на хосте ${peer.credentials.machineName}`));
      }, RPC_TIMEOUT_MS);

      peer.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(peer, { type: 'rpc_req', id, method, params });
    });
  }

  /** Пакет в протоколе сокета: v2 — ключом сессии (по очереди `seq`), v1 — общим ключом хоста. */
  private send(peer: PeerConnection, payload: PlainPacket): void {
    const ws = peer.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const session = peer.session;
    if (session) {
      void session
        .seal(payload)
        .then((frame) => {
          if (peer.ws === ws && peer.session === session && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
        })
        .catch(() => undefined);
      return;
    }
    ws.send(JSON.stringify(framePacket(payload, peer.credentials.secretKey)));
  }

  /**
   * Первое сообщение сокета. Ключ хоста закреплён — `client_hello` v2 и дальше `handshake` в сессии с forward secrecy.
   * Нет ключа — `handshake` общим ключом v1: хост пришлёт свой ключ в `handshake_ack`, hub закрепит его и перейдёт на v2.
   */
  private async startHandshake(peer: PeerConnection, ws: WebSocket): Promise<void> {
    if (isHostKey(peer.credentials.hostKey)) {
      try {
        const hs = await createClientHandshake(webcrypto.subtle as unknown as SubtleCrypto);
        if (peer.ws !== ws) return;
        peer.pendingHandshake = hs;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hs.hello));
      } catch (err) {
        this.failPeer(peer, `Не удалось начать рукопожатие v2: ${errorText(err)}`, true);
      }
      return;
    }
    if (!peer.credentials.secretKey) {
      this.failPeer(peer, 'Нужен ключ хоста (hk) или ключ шифрования из ссылки сопряжения этого ПК', true);
      return;
    }
    this.sendHandshake(peer);
  }

  private sendHandshake(peer: PeerConnection): void {
    this.send(peer, {
      type: 'handshake',
      data: peerHandshakeData({
        deviceName: this.localMachineName,
        secretKey: peer.credentials.secretKey,
        pin: peer.pendingPin,
        deviceToken: peer.credentials.deviceToken
      })
    } as PlainPacket);
  }

  /** Ответ хоста на `client_hello`: подпись проверяется закреплённым ключом, дальше — `handshake` уже в сессии. */
  private async onServerHello(peer: PeerConnection, serverHello: unknown): Promise<void> {
    const hs = peer.pendingHandshake;
    if (!hs) return;
    peer.pendingHandshake = null;
    try {
      const result = await hs.finish(serverHello, {
        deviceId: this.peerDeviceId(peer),
        hostId: peer.credentials.hostId,
        hostKey: peer.credentials.hostKey
      });
      peer.session = result.session;
      peer.sessionProtocol = SESSION_PROTOCOL_V2;
      this.sendHandshake(peer);
    } catch (err) {
      const code = err instanceof HandshakeError ? err.code : 'malformed';
      const message =
        code === 'host_key_mismatch' || code === 'bad_signature' || code === 'host_id_mismatch'
          ? `Ключ хоста ${peer.credentials.machineName} не совпал с закреплённым (${code}) — возможна подмена. Если ключ на том ПК перевыпущен, добавьте хост заново по ссылке сопряжения`
          : `Рукопожатие v2 не удалось: ${errorText(err)}`;
      this.failPeer(peer, message, true);
    }
  }

  private failPeer(peer: PeerConnection, message: string, fatal: boolean): void {
    peer.error = message;
    peer.status = 'error';
    peer.fatal = peer.fatal || fatal;
    logger.warn(`[Federation] ${message}`);
    this.rejectHandshakeWaiters(peer, new Error(message));
    this.notifyPeersChanged();
    if (fatal) {
      try {
        peer.ws?.close();
      } catch {
        // уже закрыт
      }
    }
  }

  private closeSocket(peer: PeerConnection): void {
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
      peer.reconnectTimer = null;
    }
    if (peer.ws) {
      try {
        peer.ws.removeAllListeners();
        peer.ws.close();
      } catch {
        // сокет уже мёртв
      }
      peer.ws = null;
    }
    peer.session = null;
    peer.pendingHandshake = null;
    for (const [id, call] of peer.pending.entries()) {
      clearTimeout(call.timer);
      call.reject(new Error('Соединение с хостом закрыто'));
      peer.pending.delete(id);
    }
    this.rejectHandshakeWaiters(peer, new Error('Соединение с хостом закрыто'));
  }

  private rejectHandshakeWaiters(peer: PeerConnection, err: Error): void {
    const waiters = peer.handshakeWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private resolveHandshakeWaiters(peer: PeerConnection): void {
    const waiters = peer.handshakeWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** Открывает соединение и ждёт `handshake_ack` — до него RPC отправлять нельзя. */
  private async openConnection(peer: PeerConnection): Promise<void> {
    if (peer.status === 'connected' && peer.ws?.readyState === WebSocket.OPEN) return;
    this.closeSocket(peer);

    peer.status = 'connecting';
    peer.error = undefined;
    this.notifyPeersChanged();

    const url = buildPeerSocketUrl({
      hostId: peer.credentials.hostId,
      transport: peer.credentials.transport,
      address: peer.credentials.address,
      deviceId: this.peerDeviceId(peer),
      deviceName: this.localMachineName
    });

    const ws = new WebSocket(url);
    peer.ws = ws;
    peer.session = null;
    peer.pendingHandshake = null;
    peer.sessionProtocol = undefined;

    const handshakeDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Таймаут подключения к хосту ${peer.credentials.machineName}`));
      }, HANDSHAKE_TIMEOUT_MS);
      peer.handshakeWaiters.push({ resolve, reject, timer });
    });

    ws.on('open', () => {
      // LAN: рукопожатие сразу. Relay: после `relay_ack` (decision-11 п.3).
      if (peer.credentials.transport === 'lan') void this.startHandshake(peer, ws);
    });

    ws.on('message', (raw: unknown) => {
      const text = String(raw);
      peer.inbox = peer.inbox.then(() => (peer.ws === ws ? this.handlePeerMessage(peer, ws, text) : undefined)).catch(() => undefined);
    });

    ws.on('close', () => {
      const wasConnected = peer.status === 'connected';
      // Отказ хоста без шанса на повтор (ключ, «только v2») остаётся ошибкой, а не «не в сети».
      peer.status = peer.manualDisconnect ? 'idle' : peer.fatal ? 'error' : 'offline';
      peer.connectedAt = undefined;
      this.rejectHandshakeWaiters(peer, new Error(peer.error || 'Соединение с хостом закрыто'));
      for (const [id, call] of peer.pending.entries()) {
        clearTimeout(call.timer);
        call.reject(new Error('Соединение с хостом закрыто'));
        peer.pending.delete(id);
      }
      if (wasConnected) logger.info(`[Federation] Peer disconnected: ${peer.credentials.machineName}`);
      this.notifyPeersChanged();
      this.scheduleReconnect(peer);
    });

    ws.on('error', (err: Error) => {
      // Офлайн-хост — это статус, а не ошибка приложения (AC #5): сообщение кладём в состояние.
      peer.error = err?.message || 'Ошибка соединения';
      if (peer.status !== 'connected') peer.status = 'offline';
      this.notifyPeersChanged();
    });

    await handshakeDone;
  }

  private async handlePeerMessage(peer: PeerConnection, ws: WebSocket, raw: string): Promise<void> {
    let packet: PlainPacket | null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isSessionFrameV2(parsed)) {
      if (!peer.session) return;
      try {
        packet = (await peer.session.open(parsed)) as PlainPacket;
      } catch {
        // Повтор или чужой кадр — отбрасываем, соединение не рвём.
        return;
      }
    } else if ((parsed as { type?: string })?.type === 'server_hello') {
      await this.onServerHello(peer, parsed);
      return;
    } else if (peer.session && (parsed as { e2ee?: unknown })?.e2ee) {
      // Сокет уже на v2: пакет v1 — попытка понизить версию.
      return;
    } else {
      packet = parseIncomingPacket(raw, peer.credentials.secretKey);
    }
    if (!packet || peer.ws !== ws) return;

    const type = String((packet as PlainPacket).type || '');

    // Релей подтвердил маршрут — рукопожатие внутри E2EE.
    if (type === 'relay_ack') {
      await this.startHandshake(peer, ws);
      return;
    }

    if (type === 'handshake_ack') {
      this.onHandshakeAck(peer, ((packet as PlainPacket).result || {}) as Record<string, unknown>);
      return;
    }

    if (type === 'error') {
      const message = String((packet as PlainPacket).error || 'Хост отклонил подключение');
      this.failPeer(peer, message, isFatalPeerError(message));
      return;
    }

    if (type === 'host_disconnected') {
      peer.status = 'offline';
      peer.error = 'Хост отключился от релея';
      this.notifyPeersChanged();
      return;
    }

    if (type === 'rpc_res' || type === 'response') {
      const id = String((packet as PlainPacket).id || '');
      const call = peer.pending.get(id);
      if (!call) return;
      peer.pending.delete(id);
      clearTimeout(call.timer);
      const error = (packet as PlainPacket).error;
      if (error) call.reject(new Error(String(error)));
      else call.resolve((packet as PlainPacket).result);
      return;
    }

    if (type === 'event') {
      const eventId = Number((packet as PlainPacket).eventId) || 0;
      if (eventId > peer.lastEventId) peer.lastEventId = eventId;
      this.forwardPeerEvent(peer, String((packet as PlainPacket).event || ''), (packet as PlainPacket).data);
    }
  }

  private onHandshakeAck(peer: PeerConnection, result: Record<string, unknown>): void {
    const check = checkPeerProtocol(result as { protocolVersion?: number });
    peer.protocolVersion = check.peerVersion;

    if (!check.compatible) {
      peer.status = 'error';
      peer.error = check.error;
      logger.warn(`[Federation] ${check.error} (host ${peer.credentials.machineName})`);
      this.rejectHandshakeWaiters(peer, new Error(check.error || 'Несовместимая версия протокола'));
      this.closeSocket(peer);
      this.notifyPeersChanged();
      return;
    }

    if (result.approved === false) {
      peer.status = 'error';
      peer.error = 'Удалённый хост требует подтверждения устройства — подтвердите его в настройках того ПК';
      this.rejectHandshakeWaiters(peer, new Error(peer.error));
      this.notifyPeersChanged();
      return;
    }

    if (typeof result.deviceToken === 'string' && result.deviceToken) {
      peer.credentials.deviceToken = result.deviceToken;
      // PIN больше не нужен: дальше подключаемся по токену, который можно отозвать на том хосте.
      peer.pendingPin = undefined;
      void this.persistPeers();
    }
    if (!peer.session) peer.sessionProtocol = SESSION_PROTOCOL_V1;

    // Хост v1 → v2 (decision-111): ключ хоста пришёл по сессии под общим ключом — закрепляем его, следующее
    // подключение пойдёт по v2. Переподключаемся сразу, когда текущие запросы этого сокета ответят.
    const upgrade =
      !peer.session &&
      !isHostKey(peer.credentials.hostKey) &&
      Array.isArray(result.protocols) &&
      (result.protocols as unknown[]).includes(SESSION_PROTOCOL_V2) &&
      isHostKey(result.hostKey);
    if (upgrade) {
      peer.credentials.hostKey = String(result.hostKey);
      void this.persistPeers();
      logger.info(`[Federation] Pinned v2 host key of ${peer.credentials.machineName}, switching to protocol v2`);
    }

    peer.rights = (result.rights as DeviceRights) || peer.rights;
    peer.readOnly = Boolean(result.readOnly);
    peer.status = 'connected';
    peer.error = undefined;
    peer.connectedAt = Date.now();
    peer.reconnectAttempt = 0;

    const remoteLastEventId = Number(result.lastEventId) || 0;
    this.resolveHandshakeWaiters(peer);
    this.notifyPeersChanged();
    logger.info(`[Federation] Connected to peer ${peer.credentials.machineName} (${peer.credentials.transport})`);

    if (upgrade) {
      setTimeout(() => {
        if (peer.session || peer.pending.size > 0 || peer.manualDisconnect) return;
        this.closeSocket(peer);
        peer.status = 'connecting';
        this.openConnection(peer).catch(() => undefined);
      }, 0);
      return;
    }

    // Догон событий, пропущенных за время разрыва (decision-11 п.6).
    if (peer.lastEventId > 0 && remoteLastEventId > peer.lastEventId) {
      this.catchUpEvents(peer).catch((err) => {
        logger.warn(`[Federation] Event catch-up failed: ${errorText(err)}`);
      });
    } else if (peer.lastEventId === 0) {
      peer.lastEventId = remoteLastEventId;
    }
  }

  private async catchUpEvents(peer: PeerConnection): Promise<void> {
    const res = (await this.call<{ events?: Array<{ id: number; event: string; data: unknown }>; lastEventId?: number }>(
      peer.credentials.hostId,
      'get_events_since',
      { sinceId: peer.lastEventId }
    )) || {};

    for (const entry of res.events || []) {
      if (entry.id > peer.lastEventId) peer.lastEventId = entry.id;
      this.forwardPeerEvent(peer, entry.event, entry.data);
    }
    if (res.lastEventId && res.lastEventId > peer.lastEventId) peer.lastEventId = res.lastEventId;
  }

  /**
   * Событие удалённого хоста попадает в рендерер с явной пометкой хоста — интерфейс обязан
   * показывать, ЧЬЁ это событие, иначе очередь HITL двух машин сольётся в одну кашу.
   */
  private forwardPeerEvent(peer: PeerConnection, event: string, data: unknown): void {
    if (!event) return;
    const payload = { hostId: peer.credentials.hostId, machineName: peer.credentials.machineName, event, data };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('federation:event', payload);
    }
    appEventBus.publish({
      type: 'federation:peerEvent',
      hostId: peer.credentials.hostId,
      machineName: peer.credentials.machineName,
      event,
      at: Date.now()
    });
  }

  private scheduleReconnect(peer: PeerConnection): void {
    if (peer.manualDisconnect || peer.fatal) return;
    if (!peer.credentials.deviceToken && !peer.pendingPin) return;
    if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);

    const delay = nextBackoffDelay(peer.reconnectAttempt);
    peer.reconnectAttempt++;
    peer.reconnectTimer = setTimeout(() => {
      peer.reconnectTimer = null;
      if (peer.manualDisconnect) return;
      this.openConnection(peer).catch(() => {
        // следующая попытка будет запланирована из обработчика close
      });
    }, delay);
  }

  private notifyPeersChanged(): void {
    const states = Array.from(this.peers.values()).map((p) => this.toState(p));
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('federation:peersChanged', states);
    }
  }

  public shutdown(): void {
    for (const peer of this.peers.values()) {
      peer.manualDisconnect = true;
      this.closeSocket(peer);
    }
  }
}

export const federationClientService = new FederationClientService();
