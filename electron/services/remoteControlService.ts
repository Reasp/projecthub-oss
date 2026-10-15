import http, { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  RemoteConnectionMode,
  RemoteControlConfig,
  RemoteControlStatus,
  RemoteDevice,
  PairedDevice,
  DeviceRights,
  RemotePacket,
  EncryptedPacket,
  PlainPacket,
  FederationHost,
  FederationProject
} from '../../src/types/remote.js';
import { generateSecretKey, generatePairingPin, encryptPayload, decryptPayload } from '../../src/utils/remoteCryptoNode.js';
import { projectRegistry } from './projectRegistry.js';
import { assertRegisteredProject, assertWorkspaceRoot } from './projectPathGuard.js';
import { studioRemoteBridge } from './studioRemoteBridge.js';
import { aiSessionStore } from './aiSessionStore.js';
import { llmProfileService } from './llmProfileService.js';
import { llmModelCatalogService } from './llmModelCatalogService.js';
import {
  parseStudioMode,
  parseStudioSelection,
  selectionLabel,
  selectionOf,
  studioSessionForPhone,
  studioSessionList,
  STUDIO_MODES
} from '../../src/utils/studioRemote.js';
import { processManager } from './processManager.js';
import { gitService } from './gitService.js';
import { guardedCommit } from './commitSecretGuard.js';
import { summarizeSecretFindings } from './diffSecretScan.js';
import { claudeBridgeService } from './claudeBridgeService.js';
import { agentFleetService } from './agentFleetService.js';
import { aiAgentService } from './aiAgentService.js';
import { actionConfigService, type ActionDefinition } from './actionConfigService.js';
import { createBacklogTaskFile } from './backlogTaskCreate.js';
import { hitlService } from './hitlService.js';
import { assignedTaskRunner } from './assignedTaskRunner.js';
import { lanDiscoveryService } from './lanDiscoveryService.js';
import { loadRoles } from './roleService.js';
import { secretStorageService } from './secretStorageService.js';
import { appEventBus } from './eventBus.js';
import { logger } from './logger.js';
import { getUserDataDir, getDevRepoRoot, getAppRootDir } from './appPaths.js';
import { classifyLanAddresses, rankLanAddresses } from './lanAddresses.js';
import { resolveTunnelCommand } from './tunnelCommand.js';
import treeKill from 'tree-kill';
import { buildHostEndpoints, relayEndpoint, type RemoteEndpoint } from '../../src/utils/remoteEndpoints.js';
import matter from 'gray-matter';
import {
  MOBILE_CLIENT_DIST,
  MOBILE_CLIENT_MISSING_HTML,
  MOBILE_PAGE_FILES,
  assetHeaders,
  injectHostDefaults,
  pageHeaders,
  resolveInside,
  resolveMobileClientRoute,
  type MobileClientRoute
} from './remoteStaticClient.js';

/**
 * Локальные IPv4-адреса машины для прямого подключения (LAN), лучший — первым: QR и hub-режим
 * берут `[0]`. Link-local и виртуальные адаптеры уходят в конец или отбрасываются (TASK-140.8).
 */
export function getLocalIpAddresses(): string[] {
  return rankLanAddresses(os.networkInterfaces());
}

/**
 * Версия протокола федерации/Remote Control (TASK-58, задел для TASK-66). Увеличивается при
 * несовместимом изменении формата `FederationHost`/RPC. Хосты сверяют версию при регистрации
 * (`/api/federation/register`) и получают понятную ошибку вместо тихой порчи данных при рассинхроне.
 */
export const REMOTE_FEDERATION_PROTOCOL_VERSION = 1;

/**
 * Адрес клиента для лимита попыток PIN и списка устройств. За туннелем cloudflared подключение приходит
 * с loopback, настоящий адрес — в `CF-Connecting-IP`. Заголовку верим только с loopback: из LAN его
 * подделал бы кто угодно.
 */
function clientIpOf(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress || '127.0.0.1';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['cf-connecting-ip'];
  if (loopback && typeof forwarded === 'string' && forwarded.trim()) return forwarded.trim().slice(0, 64);
  return remote;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  device: RemoteDevice;
  isEncrypted: boolean;
}

interface DeviceTokenRecord {
  token: string;
  rights: DeviceRights;
  deviceName: string;
  createdAt: number;
  /** Права назначены вручную из UI: пересопряжение по PIN их не сбрасывает (TASK-65). */
  rightsExplicit?: boolean;
  /**
   * Владелец одобрил устройство на ПК (TASK-140.9). `false` — токен выдан, но одобрения ещё не было:
   * переподключение с таким токеном снова ждёт одобрения. Записи без поля (до TASK-140.9) считаются
   * одобренными — так работали прежние переподключения в LAN.
   */
  approved?: boolean;
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
const EVENT_LOG_MAX = 200;
const RPC_IDEMPOTENCY_TTL_MS = 60 * 1000;
/** Хвост вывода агента для `get_agent_output` (экран агентов телефона). */
const AGENT_OUTPUT_TAIL_CHARS = 8000;
/** Период heartbeat/метаданных в каталог релея (TASK-66): релей считает хост протухшим через 90с. */
const FEDERATION_HEARTBEAT_MS = 30 * 1000;

/**
 * `ownerId` каталога федерации (TASK-66, decision-11 п.2) — хэш общего федеративного секрета
 * пользователя. Сам секрет релею не передаётся; по `ownerId` релей лишь группирует машины
 * одного пользователя, не имея возможности его восстановить.
 */
export function deriveFederationOwnerId(secret: string): string {
  const value = String(secret || '').trim();
  if (!value) return '';
  return crypto.createHash('sha256').update(`projecthub-federation-owner:${value}`, 'utf8').digest('hex');
}

/** Стабильный непрозрачный идентификатор пути проекта: наружу уходит хэш, не сам путь. */
export function hashProjectPath(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath).toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

class RemoteControlService {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private relayWs: WebSocket | null = null;
  private relayConnected = false;
  private relayReconnectTimer: NodeJS.Timeout | null = null;
  private relayReconnectAttempt = 0;

  private enabled = false;
  private port = 42050;
  private mode: RemoteConnectionMode = 'lan';
  private relayServerUrl = 'ws://127.0.0.1:42055';
  private requireApproval = true;
  private readOnly = false;
  private machineName = os.hostname();
  private autoStart = false;
  /** Автозапуск назначенных на этот хост задач (TASK-66), по умолчанию выключен. */
  private autoStartAssignedTasks = false;

  private telegramBotToken = '';
  private telegramChatId = '';
  private telegramBotUsername = '';
  private telegramMiniAppUrl = '';

  private tunnelProcess: ChildProcess | null = null;
  /** Туннель запущен через shell (`npx`): останавливать деревом процессов. */
  private tunnelViaShell = false;
  private tunnelUrl = '';
  private tunnelStatus: 'idle' | 'starting' | 'active' | 'error' = 'idle';
  private tunnelError: string | null = null;

  private hostId: string;
  private pairingPin: string;
  private secretKey: string;
  private lastError: string | null = null;

  /** Ed25519-identity хоста (decision-11 п.1); приватный ключ — только через secretStorageService. */
  private identityPrivateKeyPem: string | null = null;
  private identityPublicKeyPem: string | null = null;
  private identityReady: Promise<void> | null = null;

  /** Per-device токены выданные при сопряжении: deviceId -> запись (TASK-65). */
  private deviceTokens = new Map<string, DeviceTokenRecord>();
  /** Rate-limit подбора PIN/ключа по IP (decision-5 п.5). */
  private pinAttempts = new Map<string, { count: number; lockedUntil: number }>();
  /** Кольцевой буфер последних событий для догона по `lastEventId` (decision-11 п.6). */
  private eventLog: Array<{ id: number; event: string; data: any }> = [];
  private eventLogNextId = 1;
  /** Идемпотентность RPC по `requestId` (decision-11 п.6): повтор в течение TTL возвращает
   *  закэшированный ответ вместо повторного выполнения. */
  private recentRpcResponses = new Map<string, { result?: any; error?: string; expiresAt: number }>();
  /** Значения `secretKey`/`pairingPin`/`telegramBotToken`, найденные в legacy-plaintext конфиге при
   *  первом запуске после TASK-65 — переносятся в secretStorageService и никогда больше не
   *  пишутся в `remote-control.json` (decision-5 п.4). */
  private legacySecretsToMigrate: { secretKey?: string; pairingPin?: string; telegramBotToken?: string } = {};

  private connectedDevices = new Map<string, RemoteDevice>();
  private localClients = new Map<string, ClientConnection>();
  private activeProjectPath: string | null = null;
  private knownFederationHosts = new Map<string, FederationHost>();
  private cachedLocalProjects: Array<{ id: string; name: string; path: string }> = [];

  /** Общий секрет федерации: одинаковый на всех машинах пользователя, хранится в safeStorage. */
  private federationSecret = '';
  /** Производный от секрета `ownerId` — именно он уходит релею (TASK-66). */
  private federationOwnerId = '';
  private federationHeartbeatTimer: NodeJS.Timeout | null = null;
  /** Работающие прямо сейчас агенты (ключ — agentId/sessionId), считаются по шине событий. */
  private activeAgentSessions = new Set<string>();
  /** Понятная ошибка несовместимости версии протокола с релеем (AC #5), показывается в UI. */
  private federationProtocolError: string | null = null;
  /** Последние адреса, о которых узнали телефоны (`host:endpoints`), — чтобы слать событие только при смене. */
  private announcedEndpointsKey = '';

  constructor() {
    this.hostId = `ph_host_${crypto.randomBytes(6).toString('hex')}`;
    this.pairingPin = generatePairingPin();
    this.secretKey = generateSecretKey();

    // Загрузка сохраненной конфигурации (постоянный hostId, machineName, telegramBotToken)
    this.loadConfig();

    // Инициализация локальных проектов для федерации
    this.refreshLocalProjects().catch(() => {});

    // Подписка на стриминг логов фоновых процессов
    this.setupProcessLogStreaming();

    // Поток AI Studio (любой сессии) — сопряжённым телефонам, мимо буфера догона: чанков много, а после
    // разрыва телефон всё равно перечитывает сессию целиком (TASK-140.10, decision-83).
    studioRemoteBridge.onEvent((event, data) => this.broadcastEvent(event, data, { transient: true }));
  }

  /**
   * Секреты (`secretKey`, `pairingPin`, `telegramBotToken`, приватный ключ identity, per-device
   * токены) — только через `secretStorageService` (safeStorage/DPAPI), никогда plaintext-JSON
   * (decision-5 п.4). Разово переносит значения, найденные в старом `remote-control.json`.
   * Вызывается из `initOnStartup()`; при отсутствии вызова (юнит-тесты) сервис остаётся на
   * значениях по умолчанию из конструктора — функционально корректно, просто не персистентно.
   */
  private async loadPersistedSecrets(): Promise<void> {
    try {
      const [storedKey, storedPin, storedBotToken, storedTokens, storedFederationSecret] = await Promise.all([
        secretStorageService.getSecret('remoteControl.secretKey'),
        secretStorageService.getSecret('remoteControl.pairingPin'),
        secretStorageService.getSecret('remoteControl.telegramBotToken'),
        secretStorageService.getSecret('remoteControl.deviceTokens'),
        secretStorageService.getSecret('remoteControl.federationSecret')
      ]);

      // Федеративный секрет не генерируется автоматически: пока пользователь не задал один и тот
      // же секрет на своих машинах, каталог схлопнут до этого хоста (TASK-66, decision-11 п.2).
      this.federationSecret = storedFederationSecret || '';
      this.federationOwnerId = deriveFederationOwnerId(this.federationSecret);

      this.secretKey = storedKey || this.legacySecretsToMigrate.secretKey || this.secretKey;
      this.pairingPin = storedPin || this.legacySecretsToMigrate.pairingPin || this.pairingPin;
      this.telegramBotToken = storedBotToken || this.legacySecretsToMigrate.telegramBotToken || this.telegramBotToken;

      if (!storedKey) await secretStorageService.setSecret('remoteControl.secretKey', this.secretKey);
      if (!storedPin) await secretStorageService.setSecret('remoteControl.pairingPin', this.pairingPin);
      if (!storedBotToken && this.telegramBotToken) {
        await secretStorageService.setSecret('remoteControl.telegramBotToken', this.telegramBotToken);
      }

      if (storedTokens) {
        try {
          const parsed = JSON.parse(storedTokens) as Record<string, DeviceTokenRecord>;
          for (const [deviceId, rec] of Object.entries(parsed)) this.deviceTokens.set(deviceId, rec);
        } catch {
          // ignore corrupt device-tokens blob
        }
      }

      this.legacySecretsToMigrate = {};
      // Legacy-поля больше не пишутся saveConfig() — следующий вызов очистит их из JSON на диске.
      this.saveConfig();
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to load persisted secrets: ${err?.message || err}`);
    }
  }

  private async persistDeviceTokens(): Promise<void> {
    try {
      const obj: Record<string, DeviceTokenRecord> = {};
      for (const [deviceId, rec] of this.deviceTokens.entries()) obj[deviceId] = rec;
      await secretStorageService.setSecret('remoteControl.deviceTokens', JSON.stringify(obj));
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to persist device tokens: ${err?.message || err}`);
    }
  }

  /** Ed25519-keypair хоста (decision-11 п.1), генерируется один раз, приватный ключ — в secretStorageService. */
  private async ensureIdentity(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
    if (this.identityPrivateKeyPem && this.identityPublicKeyPem) {
      return { privateKeyPem: this.identityPrivateKeyPem, publicKeyPem: this.identityPublicKeyPem };
    }
    if (!this.identityReady) {
      this.identityReady = (async () => {
        const stored = await secretStorageService.getSecret('remoteControl.identityPrivateKey');
        if (stored) {
          this.identityPrivateKeyPem = stored;
          this.identityPublicKeyPem = crypto.createPublicKey(stored).export({ type: 'spki', format: 'pem' }).toString();
          return;
        }
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        this.identityPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        this.identityPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        await secretStorageService.setSecret('remoteControl.identityPrivateKey', this.identityPrivateKeyPem);
      })();
    }
    await this.identityReady;
    return { privateKeyPem: this.identityPrivateKeyPem!, publicKeyPem: this.identityPublicKeyPem! };
  }

  /** Публичный ключ identity хоста (base64 SPKI) — для предъявления релею/пирам при регистрации. */
  public async getIdentityPublicKey(): Promise<string> {
    const { publicKeyPem } = await this.ensureIdentity();
    return publicKeyPem;
  }

  /** Подпись произвольных данных приватным ключом identity хоста (hex) — challenge-response релея. */
  public async signWithIdentity(data: string): Promise<string> {
    const { privateKeyPem } = await this.ensureIdentity();
    const key = crypto.createPrivateKey(privateKeyPem);
    return crypto.sign(null, Buffer.from(data, 'utf8'), key).toString('hex');
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /** Rate-limit подбора PIN/ключа (decision-5 п.5): 5 неудачных попыток -> блокировка на 5 минут. */
  private checkPinRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
    const entry = this.pinAttempts.get(ip);
    if (!entry) return { allowed: true };
    if (entry.lockedUntil > Date.now()) return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
    return { allowed: true };
  }

  private recordPinFailure(ip: string): void {
    const entry = this.pinAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= PIN_MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
      entry.count = 0;
    }
    this.pinAttempts.set(ip, entry);
  }

  private recordPinSuccess(ip: string): void {
    this.pinAttempts.delete(ip);
  }

  /**
   * Новый per-device токен при первом сопряжении (PIN/ключ); переподключения — уже по токену.
   * Права, назначенные вручную из UI (`setDeviceRights`), переживают пересопряжение — иначе
   * достаточно было бы переподключиться с PIN, чтобы вернуть себе полный доступ.
   */
  private issueDeviceToken(deviceId: string, deviceName: string): DeviceTokenRecord {
    const previous = this.deviceTokens.get(deviceId);
    const rights: DeviceRights = previous?.rightsExplicit ? previous.rights : this.readOnly ? 'readOnly' : 'full';
    const record: DeviceTokenRecord = {
      token: crypto.randomBytes(32).toString('hex'),
      rights,
      deviceName,
      createdAt: Date.now(),
      // Новый токен не наследует одобрение: `deviceId` выбирает клиент, и знающий ключ мог бы назваться
      // уже одобренным устройством.
      approved: !this.requireApproval,
      ...(previous?.rightsExplicit ? { rightsExplicit: true } : {})
    };
    this.deviceTokens.set(deviceId, record);
    this.persistDeviceTokens().catch(() => {});
    return record;
  }

  /** Переподключение по токену одобрено, если владелец одобрял это устройство или одобрение выключено. */
  private isTokenApproved(record: DeviceTokenRecord): boolean {
    return !this.requireApproval || record.approved !== false;
  }

  private validateDeviceToken(deviceId: string, token: string): DeviceTokenRecord | null {
    const record = this.deviceTokens.get(deviceId);
    if (!record) return null;
    return this.constantTimeEqual(record.token, token) ? record : null;
  }

  /** Отзыв токена конкретного устройства (в отличие от `regenerateToken`, не трогает остальных). */
  public revokeDeviceToken(deviceId: string): void {
    if (this.deviceTokens.delete(deviceId)) {
      this.persistDeviceTokens().catch(() => {});
    }
  }

  /**
   * Назначение прав конкретному устройству (TASK-65, decision-11 п.1): раньше права выводились
   * только из глобального `readOnly` в момент выдачи токена, то есть одному устройству нельзя было
   * дать более узкий доступ (например, только решения HITL), чем у хоста в целом.
   * Права применяются сразу и к уже открытой сессии устройства, и к его сохранённому токену.
   */
  public setDeviceRights(deviceId: string, rights: DeviceRights): RemoteControlStatus {
    const record = this.deviceTokens.get(deviceId);
    if (record) {
      record.rights = rights;
      record.rightsExplicit = true;
      this.persistDeviceTokens().catch(() => {});
    }

    const device = this.connectedDevices.get(deviceId);
    if (device) {
      device.rights = rights;
      // Клиент обновляет свой индикатор прав тем же пакетом, что и при сопряжении.
      this.sendToDevice(deviceId, {
        type: 'handshake_ack',
        result: { approved: device.isApproved, readOnly: this.readOnly, hostId: this.hostId, rights, lastEventId: this.eventLogNextId - 1 }
      });
    }

    this.notifyStatusChanged();
    return this.getStatus();
  }

  /** Спаренные устройства (по выданным токенам), включая офлайн — для UI управления правами. */
  public getPairedDevices(): PairedDevice[] {
    return Array.from(this.deviceTokens.entries()).map(([deviceId, record]) => ({
      deviceId,
      name: record.deviceName,
      rights: record.rights,
      createdAt: record.createdAt,
      rightsExplicit: record.rightsExplicit,
      connected: this.connectedDevices.has(deviceId)
    }));
  }

  public async refreshLocalProjects(): Promise<void> {
    try {
      const list = await projectRegistry.getProjects();
      this.cachedLocalProjects = list.map((p) => ({
        id: p.path,
        name: path.basename(p.path),
        path: p.path
      }));
    } catch {
      // ignore
    }
  }

  private getConfigFilePath(): string {
    return path.join(getUserDataDir(), 'remote-control.json');
  }

  private loadConfig() {
    try {
      const cfgPath = this.getConfigFilePath();
      if (existsSync(cfgPath)) {
        const raw = readFileSync(cfgPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.hostId) this.hostId = data.hostId;
        if (data.machineName) this.machineName = data.machineName;
        // Legacy plaintext secretKey/pairingPin/telegramBotToken (до TASK-65) — переносятся в
        // secretStorageService в loadPersistedSecrets(), больше не читаются/пишутся отсюда напрямую.
        if (data.pairingPin) this.legacySecretsToMigrate.pairingPin = data.pairingPin;
        if (data.secretKey) this.legacySecretsToMigrate.secretKey = data.secretKey;
        if (data.telegramBotToken) this.legacySecretsToMigrate.telegramBotToken = data.telegramBotToken;
        if (typeof data.port === 'number') this.port = data.port;
        if (data.mode) this.mode = data.mode;
        if (data.relayServerUrl) this.relayServerUrl = data.relayServerUrl;
        if (typeof data.requireApproval === 'boolean') this.requireApproval = data.requireApproval;
        if (typeof data.readOnly === 'boolean') this.readOnly = data.readOnly;
        if (typeof data.autoStart === 'boolean') this.autoStart = data.autoStart;
        if (typeof data.autoStartAssignedTasks === 'boolean') this.autoStartAssignedTasks = data.autoStartAssignedTasks;
        if (data.telegramChatId) this.telegramChatId = data.telegramChatId;
        if (data.telegramBotUsername) this.telegramBotUsername = data.telegramBotUsername;
        if (data.telegramMiniAppUrl) this.telegramMiniAppUrl = data.telegramMiniAppUrl;
      }
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to load config: ${err?.message || err}`);
    }
  }

  private saveConfig() {
    try {
      const cfgPath = this.getConfigFilePath();
      // secretKey/pairingPin/telegramBotToken НЕ пишутся сюда (decision-5 п.4) — только через
      // secretStorageService (loadPersistedSecrets/updateConfig).
      const data = {
        hostId: this.hostId,
        machineName: this.machineName,
        port: this.port,
        mode: this.mode,
        relayServerUrl: this.relayServerUrl,
        requireApproval: this.requireApproval,
        readOnly: this.readOnly,
        autoStart: this.autoStart,
        autoStartAssignedTasks: this.autoStartAssignedTasks,
        telegramChatId: this.telegramChatId,
        telegramBotUsername: this.telegramBotUsername,
        telegramMiniAppUrl: this.telegramMiniAppUrl
      };
      writeFileSync(cfgPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to save config: ${err?.message || err}`);
    }
  }

  /**
   * Подписка на шину событий (TASK-57): запросы и решения HITL уходят доверенным устройствам как
   * `ai:hitl` / `ai:hitlDecided`, события агентов — как `agent:*`. Без диффов и содержимого файлов.
   */
  private subscribeToEventBus(): void {
    if (this.busUnsubscribe) return;
    this.busUnsubscribe = appEventBus.subscribe((event) => {
      if (!this.enabled) return;
      if (event.type === 'hitl:requested') {
        const r = event.request;
        this.broadcastEvent('ai:hitl', {
          requestId: r.id,
          sessionId: r.sessionId,
          projectPath: r.projectPath,
          origin: r.origin,
          agentName: r.agentName,
          role: r.role,
          tool: r.tool || r.type,
          type: r.type,
          description: r.title,
          details: r.details,
          command: r.command,
          filePath: r.filePath,
          expiresAt: r.expiresAt
        });
      } else if (event.type === 'hitl:decided' || event.type === 'hitl:expired' || event.type === 'hitl:cancelled') {
        this.broadcastEvent('ai:hitlDecided', {
          requestId: event.request.id,
          sessionId: event.request.sessionId,
          approved: event.type === 'hitl:decided' ? event.approved : false,
          by: event.type === 'hitl:decided' ? event.source.kind : event.type.replace('hitl:', '')
        });
      } else if (event.type.startsWith('agent:')) {
        this.trackAgentActivity(event);
        this.broadcastEvent(event.type, event);
      }
    });
  }

  /**
   * Учёт работающих агентов для каталога федерации (TASK-66): ключ — `agentId` слота роя или
   * `sessionId` сессии Studio, чтобы несколько агентов одной сессии считались раздельно.
   */
  private trackAgentActivity(event: { type: string; sessionId?: string; agentId?: string }): void {
    const key = event.agentId || event.sessionId;
    if (!key) return;
    if (event.type === 'agent:started') {
      this.activeAgentSessions.add(key);
    } else if (event.type === 'agent:finished' || event.type === 'agent:failed') {
      this.activeAgentSessions.delete(key);
    }
  }

  private busUnsubscribe: (() => void) | null = null;

  /** Подключение устройства в шину (TASK-63): трей и журнал уведомлений показывают его как событие. */
  private publishDeviceConnected(device: RemoteDevice): void {
    appEventBus.publish({
      type: 'remote:deviceConnected',
      deviceId: device.id,
      deviceName: device.name,
      mode: device.mode,
      isApproved: Boolean(device.isApproved),
      hostId: this.hostId,
      at: Date.now()
    });
  }

  public async initOnStartup(): Promise<void> {
    this.subscribeToEventBus();
    await this.loadPersistedSecrets();
    // Автозапуск назначенных задач живёт в backlog-вотчере и не зависит от того, включён ли
    // сам Remote Control: назначение приезжает через git, а не через сеть (TASK-66).
    assignedTaskRunner.setEnabled(this.autoStartAssignedTasks);
    // Если включен autoStart или задан Telegram Bot Token, сервис и туннель стартуют автоматически
    if (this.autoStart || Boolean(this.telegramBotToken)) {
      try {
        await this.start();
        logger.info('[RemoteControl] Service auto-started successfully on application launch');
      } catch (err: any) {
        logger.warn(`[RemoteControl] Failed to auto-start service: ${err?.message || err}`);
      }
    }
  }

  public setActiveProject(projectPath: string | null) {
    this.activeProjectPath = projectPath;
  }

  /** Постоянный идентификатор этого хоста (decision-11); используется очередью HITL и аудитом. */
  public getHostId(): string {
    return this.hostId;
  }

  /** PIN или секретный ключ подходят для сопряжения нового устройства (TASK-58: вынесено для unit-тестов). */
  public isValidPairingCredentials(pin: string | null | undefined, key: string | null | undefined): boolean {
    return (
      (Boolean(pin) && this.constantTimeEqual(pin as string, this.pairingPin)) ||
      (Boolean(key) && this.constantTimeEqual(key as string, this.secretKey))
    );
  }

  /**
   * Адреса хоста для телефона (TASK-140.9, decision-82): LAN и VPN этого ПК, постоянный публичный адрес,
   * заданный владельцем (поле «Публичный URL» — именованный туннель или свой прокси), и работающий туннель.
   */
  public getPhoneEndpoints(): RemoteEndpoint[] {
    const publicUrl = this.telegramMiniAppUrl.startsWith('https://') ? this.telegramMiniAppUrl.replace(/\/telegram\/?$/, '') : '';
    return buildHostEndpoints({
      addresses: classifyLanAddresses(os.networkInterfaces()),
      port: this.port,
      publicUrl,
      tunnelUrl: this.tunnelStatus === 'active' ? this.tunnelUrl : ''
    });
  }

  /** Адреса для `handshake_ack` и события `host:endpoints`; релей — только если он достижим с телефона. */
  private endpointsAnnouncement(): { endpoints: RemoteEndpoint[]; relayUrl?: string } {
    const relayUrl = relayEndpoint(this.relayServerUrl) ? this.relayServerUrl : '';
    return { endpoints: this.getPhoneEndpoints(), ...(relayUrl ? { relayUrl } : {}) };
  }

  public getStatus(): RemoteControlStatus {
    const localIps = getLocalIpAddresses();
    return {
      enabled: this.enabled,
      port: this.port,
      mode: this.mode,
      relayServerUrl: this.relayServerUrl,
      relayConnected: this.relayConnected,
      hostId: this.hostId,
      machineName: this.machineName,
      pairingPin: this.pairingPin,
      secretKey: this.secretKey,
      localIps,
      connectedDevices: Array.from(this.connectedDevices.values()),
      pairedDevices: this.getPairedDevices(),
      requireApproval: this.requireApproval,
      readOnly: this.readOnly,
      lastError: this.lastError,
      autoStart: this.autoStart,
      tunnelUrl: this.tunnelUrl,
      tunnelStatus: this.tunnelStatus,
      tunnelError: this.tunnelError,
      federationHosts: this.getFederationHostsList(),
      federationEnabled: Boolean(this.federationOwnerId),
      autoStartAssignedTasks: this.autoStartAssignedTasks,
      federationOwnerId: this.federationOwnerId,
      federationSecret: this.federationSecret,
      federationError: this.federationProtocolError,
      localAddresses: localIps,
      secretToken: this.secretKey,
      useRelay: this.mode === 'relay' || Boolean(this.relayServerUrl),
      telegramBotToken: this.telegramBotToken,
      telegramChatId: this.telegramChatId,
      telegramBotUsername: this.telegramBotUsername,
      telegramMiniAppUrl: this.telegramMiniAppUrl || (this.tunnelUrl ? `${this.tunnelUrl}/telegram` : ''),
      endpoints: this.getPhoneEndpoints()
    };
  }

  public async sendTelegramNotification(text: string): Promise<boolean> {
    if (!this.telegramBotToken || !this.telegramChatId) return false;
    try {
      const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          text,
          parse_mode: 'Markdown'
        })
      });
      const data = await res.json() as any;
      return Boolean(data?.ok);
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to send Telegram notification: ${err?.message || err}`);
      return false;
    }
  }

  public async toggle(targetState?: boolean): Promise<RemoteControlStatus> {
    const next = targetState !== undefined ? targetState : !this.enabled;
    if (next) {
      await this.start();
    } else {
      await this.stop();
    }
    this.notifyStatusChanged();
    return this.getStatus();
  }

  public async updateConfig(patch: Partial<RemoteControlConfig>): Promise<RemoteControlStatus> {
    let restartRequired = false;

    if (patch.port !== undefined && patch.port !== this.port) {
      this.port = patch.port;
      restartRequired = true;
    }
    if (patch.mode !== undefined && patch.mode !== this.mode) {
      this.mode = patch.mode;
      restartRequired = true;
    }
    if (patch.relayServerUrl !== undefined && patch.relayServerUrl !== this.relayServerUrl) {
      this.relayServerUrl = patch.relayServerUrl;
      restartRequired = true;
    }
    if (patch.requireApproval !== undefined) {
      this.requireApproval = patch.requireApproval;
    }
    if (patch.readOnly !== undefined) {
      this.readOnly = patch.readOnly;
    }
    if (patch.machineName !== undefined && patch.machineName.trim()) {
      this.machineName = patch.machineName.trim();
    }
    if (patch.autoStart !== undefined) {
      this.autoStart = patch.autoStart;
    }
    if (patch.autoStartAssignedTasks !== undefined) {
      this.autoStartAssignedTasks = patch.autoStartAssignedTasks;
      assignedTaskRunner.setEnabled(this.autoStartAssignedTasks);
    }
    if (patch.tunnelUrl !== undefined) {
      this.tunnelUrl = patch.tunnelUrl;
    }
    if (patch.telegramBotToken !== undefined) {
      this.telegramBotToken = patch.telegramBotToken;
      await secretStorageService.setSecret('remoteControl.telegramBotToken', patch.telegramBotToken);
    }
    if (patch.telegramChatId !== undefined) {
      this.telegramChatId = patch.telegramChatId;
    }
    if (patch.telegramBotUsername !== undefined) {
      this.telegramBotUsername = patch.telegramBotUsername;
    }
    if (patch.telegramMiniAppUrl !== undefined) {
      this.telegramMiniAppUrl = patch.telegramMiniAppUrl;
    }
    // Общий секрет федерации (TASK-66): один и тот же на всех машинах пользователя. Меняется
    // редко, но при смене хост обязан перерегистрироваться — иначе останется в старом каталоге.
    if (patch.federationSecret !== undefined && patch.federationSecret.trim() !== this.federationSecret) {
      this.federationSecret = patch.federationSecret.trim();
      this.federationOwnerId = deriveFederationOwnerId(this.federationSecret);
      await secretStorageService.setSecret('remoteControl.federationSecret', this.federationSecret);
      // Анонсы уходят с новым ownerId — старую группу слушать больше незачем.
      lanDiscoveryService.stop();
      if (this.enabled) this.startLanDiscovery();
      // Соседи из прежнего каталога больше не наши — иначе в списке остались бы чужие машины.
      for (const [hostId, host] of this.knownFederationHosts.entries()) {
        if (host.source === 'relay') this.knownFederationHosts.delete(hostId);
      }
      if (this.enabled && this.mode === 'relay') restartRequired = true;
    }

    // Сохраняем обновленные настройки на диск
    this.saveConfig();

    if (this.enabled && restartRequired) {
      await this.stop();
      await this.start();
    } else if (this.enabled && patch.telegramBotToken && this.tunnelUrl) {
      this.registerTelegramMenuButton(`${this.tunnelUrl}/telegram`).catch(() => {});
    }

    this.notifyStatusChanged();
    return this.getStatus();
  }

  public async regenerateToken(): Promise<RemoteControlStatus> {
    this.pairingPin = generatePairingPin();
    this.secretKey = generateSecretKey();
    await Promise.all([
      secretStorageService.setSecret('remoteControl.secretKey', this.secretKey),
      secretStorageService.setSecret('remoteControl.pairingPin', this.pairingPin)
    ]);

    // Отключаем все текущие устройства и отзываем их токены при смене мастер-ключа
    for (const client of this.localClients.values()) {
      try {
        client.ws.close(1008, 'Token regenerated');
      } catch {
        // ignore
      }
    }
    this.localClients.clear();
    this.connectedDevices.clear();
    this.deviceTokens.clear();
    await this.persistDeviceTokens();

    this.notifyStatusChanged();
    return this.getStatus();
  }

  public disconnectDevice(deviceId: string): RemoteControlStatus {
    const client = this.localClients.get(deviceId);
    if (client) {
      try {
        client.ws.close(1000, 'Disconnected by host');
      } catch {
        // ignore
      }
      this.localClients.delete(deviceId);
    }
    this.connectedDevices.delete(deviceId);
    this.revokeDeviceToken(deviceId);
    this.notifyStatusChanged();
    return this.getStatus();
  }

  public approveDevice(deviceId: string): RemoteControlStatus {
    const record = this.deviceTokens.get(deviceId);
    if (record && record.approved === false) {
      record.approved = true;
      this.persistDeviceTokens().catch(() => {});
    }
    const dev = this.connectedDevices.get(deviceId);
    if (dev) {
      dev.isApproved = true;
      this.notifyStatusChanged();

      // Оповещаем клиента о разрешении доступа
      this.sendToDevice(deviceId, {
        type: 'handshake_ack',
        result: {
          approved: true,
          readOnly: this.readOnly,
          hostId: this.hostId,
          protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
          rights: dev.rights,
          lastEventId: this.eventLogNextId - 1
        }
      });
    }
    return this.getStatus();
  }

  public getHostFederationInfo(): FederationHost {
    const projects = this.cachedLocalProjects;
    const running = processManager.getAllRunningProcesses();
    const localIps = getLocalIpAddresses();
    return {
      hostId: this.hostId,
      machineName: this.machineName || os.hostname(),
      platform: process.platform as 'win32' | 'darwin' | 'linux',
      tunnelUrl: this.tunnelUrl || (this.telegramMiniAppUrl ? this.telegramMiniAppUrl.replace(/\/telegram\/?$/, '') : ''),
      localIps,
      isOnline: true,
      projectsCount: projects.length,
      activeProcessesCount: running.length,
      projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
      lastSeen: Date.now(),
      protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION
    };
  }

  /**
   * Метаданные хоста для публикации в каталог релея (TASK-66). В отличие от
   * `getHostFederationInfo()` (локальный UI) наружу уходят имена проектов и ХЭШИ путей, а не
   * сами пути: каталог проходит через релей, который может быть чужим.
   */
  public getFederationMetaForRelay(): FederationHost {
    const local = this.getHostFederationInfo();
    const projects: FederationProject[] = (local.projects || []).map((p) => ({
      id: hashProjectPath(p.path || p.id),
      name: p.name,
      pathHash: hashProjectPath(p.path || p.id)
    }));

    return {
      ...local,
      projects,
      port: this.port,
      appVersion: app?.getVersion?.() || '',
      activeAgentsCount: this.countActiveAgents(),
      hitlPendingCount: hitlService.listPending().length,
      source: 'self'
    };
  }

  /**
   * Сколько агентов сейчас работает на хосте. Считается по шине событий (`agent:started` /
   * `agent:finished` / `agent:failed`), а не прямым обращением к реестрам движков: иначе
   * `remoteControlService` пришлось бы статически связать с `agentFleetService` и тянуть его
   * зависимости в каждый импорт.
   */
  private countActiveAgents(): number {
    return this.activeAgentSessions.size;
  }

  /** Идентификатор владельца каталога; пустой — федерация не настроена на этой машине. */
  public getFederationOwnerId(): string {
    return this.federationOwnerId;
  }

  /** Совместима ли версия протокола удалённого хоста с локальной (TASK-58, задел для TASK-66). */
  public isProtocolCompatible(peer: Pick<FederationHost, 'protocolVersion'>): boolean {
    return (peer.protocolVersion ?? 1) === REMOTE_FEDERATION_PROTOCOL_VERSION;
  }

  public getFederationHostsList(): FederationHost[] {
    const current: FederationHost = { ...this.getHostFederationInfo(), source: 'self' };
    const list: FederationHost[] = [current];
    const now = Date.now();

    for (const [id, host] of this.knownFederationHosts.entries()) {
      if (id !== this.hostId) {
        // Хост онлайн, только если его heartbeat свеж И каталог не сообщил о его уходе.
        const isOnline = host.isOnline !== false && now - host.lastSeen < 90000;
        list.push({ ...host, isOnline });
      }
    }
    return list;
  }

  public registerPeerHost(peer: FederationHost) {
    if (peer.hostId && peer.hostId !== this.hostId) {
      peer.lastSeen = Date.now();
      peer.isOnline = true;
      peer.protocolIncompatible = !this.isProtocolCompatible(peer);
      this.knownFederationHosts.set(peer.hostId, peer);
      this.notifyStatusChanged();
    }
  }

  public async registerTelegramMenuButton(webAppUrl: string): Promise<boolean> {
    if (!this.telegramBotToken) return false;
    try {
      const url = `https://api.telegram.org/bot${this.telegramBotToken}/setChatMenuButton`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menu_button: {
            type: 'web_app',
            text: 'ProjectHub',
            web_app: { url: webAppUrl }
          }
        })
      });
      const data = (await res.json()) as any;
      if (data?.ok) {
        logger.info(`[RemoteControl] Telegram Menu Button registered successfully with URL: ${webAppUrl}`);
        return true;
      } else {
        logger.warn(`[RemoteControl] Telegram setChatMenuButton error: ${data?.description || 'unknown'}`);
        return false;
      }
    } catch (err: any) {
      logger.warn(`[RemoteControl] Failed to set Telegram Menu Button: ${err?.message || err}`);
      return false;
    }
  }

  public async startTunnel(): Promise<string> {
    if (this.tunnelUrl && this.tunnelStatus === 'active') {
      return this.tunnelUrl;
    }

    // Если в настройках вручную задан готовый https URL mini app, используем его
    if (this.telegramMiniAppUrl && this.telegramMiniAppUrl.startsWith('https://')) {
      this.tunnelUrl = this.telegramMiniAppUrl.replace(/\/telegram\/?$/, '');
      this.tunnelStatus = 'active';
      this.tunnelError = null;
      logger.info(`[RemoteControl] Using configured custom HTTPS tunnel: ${this.tunnelUrl}`);
      if (this.telegramBotToken) {
        await this.registerTelegramMenuButton(`${this.tunnelUrl}/telegram`);
      }
      this.notifyStatusChanged();
      return this.tunnelUrl;
    }

    this.stopTunnel();
    this.tunnelStatus = 'starting';
    this.tunnelError = null;
    this.notifyStatusChanged();

    logger.info(`[RemoteControl] Starting automatic Cloudflare Quick Tunnel for port ${this.port}...`);

    return new Promise((resolve) => {
      let resolved = false;
      // Установленный cloudflared — напрямую; npx — через shell: Node запрещает запуск .cmd без shell (TASK-140.9).
      const tunnel = resolveTunnelCommand(this.port, {
        platform: process.platform,
        pathEnv: process.env.PATH || process.env.Path || '',
        programFiles: [process.env['ProgramFiles(x86)'] || '', process.env.ProgramFiles || ''],
        exists: (file) => existsSync(file),
        delimiter: path.delimiter,
        join: path.join
      });
      logger.info(`[RemoteControl] Tunnel command: ${tunnel.shell ? 'npx cloudflared (shell)' : tunnel.command}`);

      try {
        const child = spawn(tunnel.command, tunnel.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: tunnel.shell
        });

        this.tunnelProcess = child;
        this.tunnelViaShell = tunnel.shell;

        const onOutput = (data: Buffer) => {
          const text = data.toString();
          // Ищем URL вида https://[...].trycloudflare.com
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match && !resolved) {
            resolved = true;
            this.tunnelUrl = match[0];
            this.tunnelStatus = 'active';
            this.tunnelError = null;
            logger.info(`[RemoteControl] Cloudflare Quick Tunnel established: ${this.tunnelUrl}`);

            if (this.telegramBotToken) {
              this.registerTelegramMenuButton(`${this.tunnelUrl}/telegram`).catch(() => {});
            }
            this.notifyStatusChanged();
            resolve(this.tunnelUrl);
          }
        };

        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);

        child.on('error', (err) => {
          logger.warn(`[RemoteControl] Cloudflare tunnel process error: ${err.message}`);
          this.tunnelStatus = 'error';
          this.tunnelError = err.message;
          this.notifyStatusChanged();
          if (!resolved) {
            resolved = true;
            resolve('');
          }
        });

        child.on('exit', (code) => {
          logger.info(`[RemoteControl] Cloudflare tunnel process exited with code ${code}`);
          if (this.tunnelStatus === 'active') {
            this.tunnelStatus = 'idle';
            this.tunnelUrl = '';
            this.notifyStatusChanged();
          }
        });

        // Таймаут ожидания инициализации туннеля (30с)
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            if (this.tunnelStatus === 'starting') {
              this.tunnelStatus = 'error';
              this.tunnelError = 'Таймаут подключения туннеля Cloudflare (30s)';
              this.notifyStatusChanged();
            }
            resolve(this.tunnelUrl);
          }
        }, 30000);
      } catch (err: any) {
        this.tunnelStatus = 'error';
        this.tunnelError = err?.message || String(err);
        logger.warn(`[RemoteControl] Failed to start Cloudflare tunnel: ${this.tunnelError}`);
        this.notifyStatusChanged();
        if (!resolved) {
          resolved = true;
          resolve('');
        }
      }
    });
  }

  public stopTunnel() {
    if (this.tunnelProcess) {
      try {
        // Через shell убить нужно всё дерево, иначе cloudflared останется жить без родителя.
        if (this.tunnelViaShell && this.tunnelProcess.pid) treeKill(this.tunnelProcess.pid);
        else this.tunnelProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.tunnelProcess = null;
    }
    this.tunnelUrl = '';
    this.tunnelStatus = 'idle';
    this.tunnelError = null;
  }

  public async start(): Promise<void> {
    if (this.server && this.server.listening) {
      return;
    }

    this.lastError = null;

    try {
      await this.refreshLocalProjects();
      await this.startLocalHttpAndWsServer();
      this.enabled = true;

      if (this.mode === 'relay' || this.relayServerUrl) {
        this.connectToRelay();
      }

      // LAN-обнаружение соседних ProjectHub без релея (TASK-66, AC #1). Работает только при
      // заданном общем секрете: иначе нечем отличить свои машины от чужих в общей сети.
      this.startLanDiscovery();

      // Если задан Telegram Bot Token или включен autoStart, автоматически поднимаем HTTPS-туннель
      if (this.telegramBotToken || this.autoStart) {
        this.startTunnel().catch((err) => {
          logger.warn(`[RemoteControl] Tunnel background startup failed: ${err?.message || err}`);
        });
      }

      logger.info(`[RemoteControl] Service started on port ${this.port} (mode: ${this.mode})`);
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      logger.error(`[RemoteControl] Failed to start: ${this.lastError}`);
      await this.stop();
      throw err;
    }
  }

  public async stop(): Promise<void> {
    this.enabled = false;
    this.disconnectFromRelay();
    this.stopTunnel();
    lanDiscoveryService.stop();

    // Закрываем локальные клиенты
    for (const client of this.localClients.values()) {
      try {
        client.ws.close(1001, 'Remote server stopped');
      } catch {
        // ignore
      }
    }
    this.localClients.clear();
    this.connectedDevices.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    logger.info('[RemoteControl] Service stopped');
    this.notifyStatusChanged();
  }

  /**
   * Запуск локального HTTP сервера и WebSocket сервера.
   */
  private async startLocalHttpAndWsServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleHttpRequest(req, res);
      });

      server.on('error', (err: any) => {
        reject(err);
      });

      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        this.wss = new WebSocketServer({ server });
        this.setupLocalWebSocketServer(this.wss);
        resolve();
      });
    });
  }

  /**
   * Аутентификация `/api/*` (decision-5 п.5): Bearer-токен (заголовок или `?token=`) должен
   * совпадать с мастер-ключом хоста либо с одним из выданных per-device токенов. `/api/qr`
   * удалён (отдавал секрет без всякой проверки — единственный потребитель, встроенный клиент,
   * уже получает пейринг-данные через IPC/QR на стороне рендерера).
   */
  private isAuthorizedApiRequest(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const presented = bearer || url.searchParams.get('token') || '';
    if (!presented) return false;
    if (this.constantTimeEqual(presented, this.secretKey)) return true;
    for (const record of this.deviceTokens.values()) {
      if (this.constantTimeEqual(presented, record.token)) return true;
    }
    return false;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // GET /api/status - минимальная публичная информация для обнаружения хоста (без имени
    // машины и локальных IP — см. decision-5 п.5, "не раскрывать... без токена").
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'ProjectHub-Remote',
          hostId: this.hostId,
          mode: this.mode,
          requireApproval: this.requireApproval,
          port: this.port
        })
      );
      return;
    }

    // GET /api/federation/info, /api/federation/hosts, POST /api/federation/register —
    // раскрывают пути проектов/имя машины/список хостов, требуют токен (decision-5 п.5).
    if (url.pathname.startsWith('/api/federation/')) {
      if (!this.isAuthorizedApiRequest(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (url.pathname === '/api/federation/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getHostFederationInfo()));
        return;
      }

      if (url.pathname === '/api/federation/hosts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hosts: this.getFederationHostsList() }));
        return;
      }

      if (url.pathname === '/api/federation/register' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const peer = JSON.parse(body) as FederationHost;
            if (!this.isProtocolCompatible(peer)) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'protocol_version_mismatch',
                  message:
                    `Версия протокола федерации хоста "${peer.machineName || peer.hostId}" (${peer.protocolVersion ?? 1}) `
                    + `несовместима с локальной (${REMOTE_FEDERATION_PROTOCOL_VERSION}). Обновите ProjectHub на обеих машинах.`,
                  localProtocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
                  peerProtocolVersion: peer.protocolVersion ?? 1
                })
              );
              return;
            }
            this.registerPeerHost(peer);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, hosts: this.getFederationHostsList() }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // HITL по HTTP (TASK-63): демон Telegram-бота живёт отдельным процессом и применяет нажатия
    // inline-кнопок здесь, строго по `requestId` — через тот же `hitlService.decide`, что и окно
    // приложения (decision-10 п.5: первый ответ выигрывает). Токен обязателен, как и для федерации.
    if (url.pathname.startsWith('/api/hitl/')) {
      if (!this.isAuthorizedApiRequest(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (url.pathname === '/api/hitl/pending' && req.method === 'GET') {
        // Без диффов и содержимого файлов — наружу уходит только то, что нужно для решения.
        const pending = hitlService.listPending().map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          projectPath: r.projectPath,
          type: r.type,
          title: r.title,
          details: r.details,
          command: r.command,
          filePath: r.filePath,
          agentName: r.agentName,
          role: r.role,
          origin: r.origin,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending }));
        return;
      }

      if (url.pathname === '/api/hitl/decide' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) req.destroy();
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}') as {
              requestId?: string;
              approved?: boolean;
              comment?: string;
              deviceName?: string;
            };
            if (typeof payload.requestId !== 'string' || !payload.requestId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'requestId required' }));
              return;
            }
            const result = hitlService.decide(
              payload.requestId,
              { approved: Boolean(payload.approved), text: typeof payload.comment === 'string' ? payload.comment : undefined },
              { kind: 'remote', deviceName: typeof payload.deviceName === 'string' ? payload.deviceName : 'Telegram' }
            );
            res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.ok ? { ok: true, requestId: payload.requestId } : { ok: false, reason: result.reason }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    // Встроенный клиент (`/`, `/remote`), Telegram Mini App (`/telegram`) и их ассеты (`/m/…`) —
    // одна сборка `mobile/` (TASK-140.1, decision-79 п. 1).
    const route = resolveMobileClientRoute(url.pathname);
    if (route && (req.method === 'GET' || req.method === 'HEAD')) {
      await this.serveMobileClient(route, req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /**
   * Каталог сборки мобильного клиента `dist/mobile`: в dev — в репозитории, в packaged — внутри
   * app.asar (`dist/**` в `build.files`).
   */
  private mobileClientRoot(): string | null {
    const roots = [getDevRepoRoot(), getAppRootDir()].filter((r): r is string => Boolean(r));
    for (const root of roots) {
      const dir = path.join(root, MOBILE_CLIENT_DIST);
      if (existsSync(path.join(dir, MOBILE_PAGE_FILES.embedded))) return dir;
    }
    return null;
  }

  private async serveMobileClient(route: MobileClientRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (route.kind === 'forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const root = this.mobileClientRoot();
    if (!root) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(MOBILE_CLIENT_MISSING_HTML);
      return;
    }

    if (route.kind === 'page') {
      try {
        const html = await fs.readFile(path.join(root, route.file), 'utf8');
        res.writeHead(200, pageHeaders(route.target));
        res.end(req.method === 'HEAD' ? undefined : injectHostDefaults(html, { hostId: this.hostId, relayUrl: this.relayServerUrl, mode: this.mode }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(MOBILE_CLIENT_MISSING_HTML);
      }
      return;
    }

    const file = resolveInside(root, route.relPath);
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, assetHeaders(file));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  }

  /**
   * Настройка локального WebSocket сервера.
   */
  private setupLocalWebSocketServer(wss: WebSocketServer) {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      // Проверка доступности адреса телефоном (TASK-140.9): сокет открылся — адрес рабочий. Ни устройства, ни
      // попытки PIN — сразу закрываем, как публичный `/api/status`.
      if (url.searchParams.get('probe') === '1') {
        ws.close(1000, 'probe');
        return;
      }
      const pin = url.searchParams.get('pin');
      const key = url.searchParams.get('key');
      const token = url.searchParams.get('token');
      const deviceId = url.searchParams.get('deviceId') || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const deviceName = url.searchParams.get('name') || 'Mobile Client';
      const userAgent = req.headers['user-agent'] || 'Unknown Device';
      const ip = clientIpOf(req);

      // Запечатанное подключение (TASK-140.9, decision-82): в URL только `deviceId`, а ключ, PIN и токен
      // приходят первым E2EE-пакетом `handshake`, как через релей. Через туннель TLS заканчивается у
      // посредника (Cloudflare), и query-строка с ключом и `handshake_ack` с токеном были бы ему видны.
      if (url.searchParams.get('auth') === 'e2ee') {
        this.acceptSealedClient(ws, deviceId, deviceName, userAgent, ip);
        return;
      }

      // Переподключение уже спаренного устройства — по его собственному токену, без PIN/ключа
      // (decision-5 п.5: per-device токены с отзывом вместо одного общего секрета навсегда).
      let issuedToken: string | null = null;
      let rights: DeviceRights;
      const existingRecord = token ? this.validateDeviceToken(deviceId, token) : null;

      if (existingRecord) {
        rights = existingRecord.rights;
      } else {
        const rateLimit = this.checkPinRateLimit(ip);
        if (!rateLimit.allowed) {
          ws.send(JSON.stringify({ type: 'error', error: 'Too many failed attempts, try again later' }));
          ws.close(1008, 'Rate limited');
          return;
        }

        if (!this.isValidPairingCredentials(pin, key)) {
          this.recordPinFailure(ip);
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid pairing PIN or secret key' }));
          ws.close(1008, 'Authentication failed');
          return;
        }
        this.recordPinSuccess(ip);

        const issued = this.issueDeviceToken(deviceId, deviceName);
        issuedToken = issued.token;
        rights = issued.rights;
      }

      // Пакет шифруется ключом E2EE (`key`), общим для всех устройств (см. remoteCryptoNode/Web);
      // per-device токен — отдельный фактор аутентификации/прав, не участвует в шифровании.
      const isKeyValid = key === this.secretKey;

      const isApproved = !this.requireApproval || Boolean(existingRecord && this.isTokenApproved(existingRecord));
      const device: RemoteDevice = {
        id: deviceId,
        name: deviceName,
        ip,
        mode: 'lan',
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        userAgent,
        isApproved,
        rights
      };

      const clientConn: ClientConnection = {
        id: deviceId,
        ws,
        device,
        isEncrypted: isKeyValid
      };

      this.connectedDevices.set(deviceId, device);
      this.localClients.set(deviceId, clientConn);
      this.notifyStatusChanged();

      // Подтверждение клиенту — новый токен выдаётся только при первом сопряжении.
      ws.send(
        JSON.stringify({
          type: 'handshake_ack',
          result: {
            approved: isApproved,
            readOnly: this.readOnly,
            hostId: this.hostId,
            protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
            rights,
            // Клиент запоминает точку в потоке событий, чтобы после разрыва догнать с неё, а не
            // проигрывать заново весь кольцевой буфер (decision-11 п.6).
            lastEventId: this.eventLogNextId - 1,
            ...(issuedToken ? { deviceToken: issuedToken } : {})
          }
        })
      );

      // Уведомление в десктоп
      this.notifyRenderer('remote:deviceConnected', device);
      this.publishDeviceConnected(device);

      ws.on('message', async (raw: any) => {
        device.lastSeenAt = Date.now();
        await this.handleIncomingClientMessage(deviceId, raw, (resp) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(typeof resp === 'string' ? resp : JSON.stringify(resp));
          }
        });
      });

      ws.on('close', () => {
        this.localClients.delete(deviceId);
        this.connectedDevices.delete(deviceId);
        this.notifyStatusChanged();
        this.notifyRenderer('remote:deviceDisconnected', { deviceId });
      });
    });
  }

  /**
   * Прямое подключение без секретов в URL (TASK-140.9): устройство ждёт E2EE-пакета `handshake`, всё,
   * что хост ему отвечает, зашифровано. Подбор PIN ограничивается по адресу клиента, а не по `deviceId`,
   * который выбирает сам клиент.
   */
  private acceptSealedClient(ws: WebSocket, deviceId: string, deviceName: string, userAgent: string, ip: string): void {
    const device: RemoteDevice = {
      id: deviceId,
      name: deviceName,
      ip,
      mode: 'lan',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      userAgent,
      isApproved: false
    };
    // Повторное подключение того же устройства вытесняет прежний сокет, иначе события ушли бы в мёртвый.
    const previous = this.localClients.get(deviceId);
    if (previous && previous.ws !== ws) {
      try {
        previous.ws.close(4001, 'Replaced by a new connection');
      } catch {
        // уже закрыт
      }
    }
    this.connectedDevices.set(deviceId, device);
    this.localClients.set(deviceId, { id: deviceId, ws, device, isEncrypted: true });
    this.notifyStatusChanged();
    this.notifyRenderer('remote:deviceConnected', device);
    this.publishDeviceConnected(device);

    ws.on('message', async (raw: WebSocket.RawData) => {
      device.lastSeenAt = Date.now();
      await this.handleIncomingClientMessage(
        deviceId,
        raw,
        (resp) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(typeof resp === 'string' ? resp : JSON.stringify(resp));
        },
        `ip:${ip}`
      );
    });

    ws.on('close', () => {
      // Сокет мог быть уже вытеснен новым подключением того же устройства — его запись не трогаем.
      if (this.localClients.get(deviceId)?.ws !== ws) return;
      this.localClients.delete(deviceId);
      this.connectedDevices.delete(deviceId);
      this.notifyStatusChanged();
      this.notifyRenderer('remote:deviceDisconnected', { deviceId });
    });
  }

  /**
   * Подключение к внешнему Relay серверу. Хост доказывает владение `hostId` подписью
   * challenge-nonce своим Ed25519-identity ключом (TASK-65, decision-11 п.2) — без этого релей
   * не зарегистрирует соединение (см. `remote-relay-server.mjs`).
   */
  private async connectToRelay() {
    this.disconnectFromRelay();

    try {
      const { publicKeyPem } = await this.ensureIdentity();
      const relayUrl = new URL(this.relayServerUrl);
      relayUrl.searchParams.set('role', 'host');
      relayUrl.searchParams.set('hostId', this.hostId);
      relayUrl.searchParams.set('machineName', this.machineName || os.hostname());
      relayUrl.searchParams.set('platform', process.platform);
      relayUrl.searchParams.set('pubkey', Buffer.from(publicKeyPem).toString('base64url'));
      relayUrl.searchParams.set('protocolVersion', String(REMOTE_FEDERATION_PROTOCOL_VERSION));
      if (app?.getVersion) relayUrl.searchParams.set('appVersion', app.getVersion());
      // Каталог федерации включается только если задан общий секрет: без него релей видит хост
      // как одиночку и не показывает его чужим машинам (TASK-66, decision-11 п.2).
      if (this.federationOwnerId) relayUrl.searchParams.set('ownerId', this.federationOwnerId);

      const ws = new WebSocket(relayUrl.toString());
      this.relayWs = ws;

      ws.on('open', () => {
        logger.info(`[RemoteControl] Relay TCP connected, awaiting auth challenge: ${this.relayServerUrl}`);
      });

      ws.on('message', async (raw: any) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Challenge-response при регистрации (см. remote-relay-server.mjs)
          if (msg.type === 'auth_challenge') {
            const signature = await this.signWithIdentity(msg.nonce);
            ws.send(JSON.stringify({ type: 'auth_response', signature }));
            return;
          }

          if (msg.type === 'relay_ack' && msg.role === 'host') {
            this.relayConnected = true;
            this.relayReconnectAttempt = 0;
            logger.info(`[RemoteControl] Authenticated with Relay Server: ${this.relayServerUrl}`);

            // Несовместимая версия протокола релея — понятная ошибка в UI, а не молча пустой
            // каталог (AC #5). Соединение не рвём: транспорт для телефона продолжает работать.
            const relayProtocol = Number(msg.protocolVersion ?? REMOTE_FEDERATION_PROTOCOL_VERSION);
            if (relayProtocol !== REMOTE_FEDERATION_PROTOCOL_VERSION) {
              this.federationProtocolError =
                `Версия протокола релея (${relayProtocol}) несовместима с версией приложения `
                + `(${REMOTE_FEDERATION_PROTOCOL_VERSION}). Каталог хостов недоступен — обновите релей и ProjectHub.`;
              logger.warn(`[RemoteControl] ${this.federationProtocolError}`);
            } else {
              this.federationProtocolError = null;
            }

            this.startFederationHeartbeat();
            this.notifyStatusChanged();
            return;
          }

          // Каталог хостов того же владельца (TASK-66): полный список приходит при регистрации,
          // при изменениях у соседей и в ответ на `catalog_request` из heartbeat.
          if (msg.type === 'catalog' && Array.isArray(msg.hosts)) {
            this.applyRelayCatalog(msg.hosts as FederationHost[]);
            return;
          }

          // Обработка системных сообщений от релея. Клиент, пришедший через релей, ещё НЕ
          // аутентифицирован — в отличие от LAN (проверка PIN/ключа в query до апгрейда сокета),
          // релей лишь транспорт, поэтому isApproved всегда false, пока клиент не пройдёт
          // `handshake` внутри E2EE-пакета (decision-5 п.5: аутентификация на каждом интерфейсе).
          if (msg.type === 'client_connected') {
            const dev: RemoteDevice = {
              id: msg.clientId,
              name: msg.name || 'Remote Client (Relay)',
              ip: msg.ip || 'relay',
              mode: 'relay',
              connectedAt: Date.now(),
              lastSeenAt: Date.now(),
              userAgent: msg.userAgent || 'Web/Mobile',
              isApproved: false
            };
            this.connectedDevices.set(msg.clientId, dev);
            this.notifyStatusChanged();
            this.notifyRenderer('remote:deviceConnected', dev);
            this.publishDeviceConnected(dev);
            return;
          }

          if (msg.type === 'client_disconnected') {
            this.connectedDevices.delete(msg.clientId);
            this.notifyStatusChanged();
            this.notifyRenderer('remote:deviceDisconnected', { deviceId: msg.clientId });
            return;
          }

          // Входящее сообщение от клиента через релей
          const fromClientId = msg.fromClientId;
          if (fromClientId) {
            await this.handleIncomingClientMessage(fromClientId, raw, (resp) => {
              if (ws.readyState === WebSocket.OPEN) {
                const packet = typeof resp === 'string' ? JSON.parse(resp) : resp;
                packet.targetClientId = fromClientId;
                ws.send(JSON.stringify(packet));
              }
            });
          }
        } catch (err) {
          logger.error('[RemoteControl] Relay message error:', err);
        }
      });

      ws.on('close', () => {
        this.relayConnected = false;
        this.notifyStatusChanged();
        this.scheduleRelayReconnect();
      });

      ws.on('error', (err) => {
        logger.warn(`[RemoteControl] Relay error: ${err.message}`);
        this.relayConnected = false;
        this.notifyStatusChanged();
      });
    } catch (err: any) {
      logger.error(`[RemoteControl] Failed to connect to relay: ${err?.message}`);
      this.scheduleRelayReconnect();
    }
  }

  /** Запуск LAN-обнаружения: анонсируем себя и принимаем анонсы машин того же владельца. */
  private startLanDiscovery(): void {
    if (!this.federationOwnerId) return;
    lanDiscoveryService.configure({
      getPayload: () => {
        if (!this.federationOwnerId) return null;
        const meta = this.getFederationMetaForRelay();
        return {
          hostId: this.hostId,
          ownerId: this.federationOwnerId,
          machineName: meta.machineName,
          platform: meta.platform,
          port: this.port,
          appVersion: meta.appVersion,
          protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
          projectsCount: meta.projectsCount,
          activeAgentsCount: meta.activeAgentsCount,
          hitlPendingCount: meta.hitlPendingCount
        };
      },
      onHost: (host) => {
        const previous = this.knownFederationHosts.get(host.hostId);
        // Запись от релея информативнее (в ней есть список проектов) — LAN лишь освежает
        // heartbeat и добавляет прямой адрес для подключения без релея.
        this.knownFederationHosts.set(host.hostId, {
          ...previous,
          ...host,
          projects: previous?.projects || host.projects,
          source: previous?.source === 'relay' ? 'relay' : 'lan',
          protocolIncompatible: !this.isProtocolCompatible(host)
        });
        this.notifyStatusChanged();
      }
    });
    lanDiscoveryService.start();
  }

  /**
   * Heartbeat в каталог релея (TASK-66): публикует метаданные хоста и запрашивает свежий каталог.
   * Релей считает хост офлайн через 90с без heartbeat, поэтому период — 30с.
   */
  private startFederationHeartbeat(): void {
    this.stopFederationHeartbeat();
    const tick = () => {
      if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return;
      try {
        this.relayWs.send(JSON.stringify({ type: 'host_meta_update', meta: this.getFederationMetaForRelay() }));
        if (this.federationOwnerId) this.relayWs.send(JSON.stringify({ type: 'catalog_request' }));
      } catch (err) {
        logger.warn(`[RemoteControl] Federation heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    tick();
    this.federationHeartbeatTimer = setInterval(tick, FEDERATION_HEARTBEAT_MS);
  }

  private stopFederationHeartbeat(): void {
    if (this.federationHeartbeatTimer) {
      clearInterval(this.federationHeartbeatTimer);
      this.federationHeartbeatTimer = null;
    }
  }

  /**
   * Применяет каталог, пришедший от релея: хосты, пропавшие из каталога, помечаются офлайн,
   * а не удаляются молча — «офлайн» это статус, а не ошибка (decision-11 п.6, AC #5).
   */
  private applyRelayCatalog(hosts: FederationHost[]): void {
    const seen = new Set<string>();

    for (const raw of hosts) {
      if (!raw?.hostId || raw.hostId === this.hostId) continue;
      seen.add(raw.hostId);
      const previous = this.knownFederationHosts.get(raw.hostId);
      this.knownFederationHosts.set(raw.hostId, {
        ...previous,
        ...raw,
        source: 'relay',
        isOnline: true,
        lastSeen: Number(raw.lastSeen) || Date.now(),
        protocolIncompatible: !this.isProtocolCompatible(raw)
      });
    }

    for (const [hostId, host] of this.knownFederationHosts.entries()) {
      if (host.source === 'relay' && !seen.has(hostId)) {
        this.knownFederationHosts.set(hostId, { ...host, isOnline: false });
      }
    }

    this.notifyStatusChanged();
  }

  private scheduleRelayReconnect() {
    if (!this.enabled || this.mode !== 'relay') return;
    if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);

    // Экспоненциальный backoff (TASK-65, decision-11 п.6), максимум 30с между попытками.
    const delay = Math.min(30000, 1000 * Math.pow(2, this.relayReconnectAttempt));
    this.relayReconnectAttempt++;
    this.relayReconnectTimer = setTimeout(() => {
      if (this.enabled && this.mode === 'relay' && !this.relayConnected) {
        this.connectToRelay();
      }
    }, delay);
  }

  private disconnectFromRelay() {
    this.stopFederationHeartbeat();
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.relayWs) {
      try {
        this.relayWs.close();
      } catch {
        // ignore
      }
      this.relayWs = null;
    }
    this.relayConnected = false;
  }

  /** Ответ клиенту в том же виде, в каком пришёл запрос: зашифрованным, если запрос был зашифрован. */
  private replyMaybeEncrypted(reply: (resp: RemotePacket) => void, isEncrypted: boolean, payload: PlainPacket): void {
    reply(isEncrypted ? encryptPayload(payload, this.secretKey) : payload);
  }

  /**
   * Обработка сообщения от клиента (распаковка E2EE при наличии и диспетчеризация RPC).
   */
  private async handleIncomingClientMessage(
    deviceId: string,
    raw: any,
    reply: (resp: any) => void,
    /** Ключ лимита подбора PIN: адрес клиента для прямых подключений; через релей адреса нет. */
    pinRateKey = `relay:${deviceId}`
  ): Promise<void> {
    let packet: PlainPacket;
    let isEncrypted = false;

    try {
      const parsed = JSON.parse(raw.toString());
      if ('e2ee' in parsed && parsed.e2ee) {
        isEncrypted = true;
        packet = decryptPayload(parsed as EncryptedPacket, this.secretKey);
      } else {
        packet = parsed as PlainPacket;
      }
    } catch (err) {
      reply({ type: 'error', error: 'Malformed or decrypt failure' });
      return;
    }

    const device = this.connectedDevices.get(deviceId);
    if (!device || (!device.isApproved && packet.type !== 'handshake')) {
      reply({ type: 'error', error: 'Device not approved by host' });
      return;
    }

    // Handshake внутри E2EE-пакета (TASK-65, decision-5 п.5): единственный способ клиенту,
    // подключённому через релей, доказать PIN/ключ/токен — релей сам не проверяет ничего, кроме
    // identity хоста. LAN-клиенты уже прошли этот же контроль в query-параметрах при апгрейде
    // сокета (`setupLocalWebSocketServer`), но повторный handshake через пакет здесь тоже
    // поддерживается им (идемпотентно выдаёт новый токен).
    if (packet.type === 'handshake') {
      const data = (packet.data || {}) as { pin?: string; key?: string; token?: string; name?: string };
      const rateKey = pinRateKey;
      const existingRecord = data.token ? this.validateDeviceToken(deviceId, data.token) : null;
      // Имя устройства едет внутри шифра: через туннель и релей посредник его не видит (TASK-140.9).
      if (typeof data.name === 'string' && data.name.trim()) device.name = data.name.trim().slice(0, 80);
      // Адреса хоста — только в зашифрованном ответе: открытым текстом через посредника они не идут.
      const endpointsInfo = isEncrypted ? this.endpointsAnnouncement() : {};

      if (existingRecord) {
        // Переподключение одобренного устройства не ждёт нового одобрения — и через релей тоже: раньше
        // через релей каждое переподключение снова ждало кнопки на ПК.
        device.isApproved = device.isApproved || this.isTokenApproved(existingRecord);
        device.rights = existingRecord.rights;
        this.replyMaybeEncrypted(reply, isEncrypted, {
          type: 'handshake_ack',
          result: {
            approved: device.isApproved,
            readOnly: this.readOnly,
            hostId: this.hostId,
            protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
            rights: device.rights,
            lastEventId: this.eventLogNextId - 1,
            ...endpointsInfo
          }
        });
        this.notifyStatusChanged();
        return;
      }

      const rateLimit = this.checkPinRateLimit(rateKey);
      if (!rateLimit.allowed) {
        reply({ type: 'error', error: 'Too many failed attempts, try again later' });
        return;
      }
      if (!this.isValidPairingCredentials(data.pin, data.key)) {
        this.recordPinFailure(rateKey);
        reply({ type: 'error', error: 'Invalid pairing PIN or secret key' });
        return;
      }
      this.recordPinSuccess(rateKey);

      const issued = this.issueDeviceToken(deviceId, device.name);
      device.isApproved = !this.requireApproval;
      device.rights = issued.rights;
      // Ответ шифруется тем же ключом, что и запрос: через релей `deviceToken` иначе уехал бы
      // открытым текстом через чужой сервер (decision-11 п.3 — релей не видит содержимого).
      this.replyMaybeEncrypted(reply, isEncrypted, {
        type: 'handshake_ack',
        result: {
          approved: device.isApproved,
          readOnly: this.readOnly,
          hostId: this.hostId,
          protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
          rights: issued.rights,
          deviceToken: issued.token,
          lastEventId: this.eventLogNextId - 1,
          ...endpointsInfo
        }
      });
      this.notifyStatusChanged();
      return;
    }

    if (!device.isApproved) {
      reply({ type: 'error', error: 'Device not approved by host' });
      return;
    }

    // Ping / Pong
    if (packet.type === 'ping') {
      reply({ type: 'pong', id: packet.id });
      return;
    }

    // RPC Request (поддержка rpc_req и request из Telegram Mini App)
    if (packet.type === 'rpc_req' || (packet as any).type === 'request') {
      const req = packet as PlainPacket;
      const isReqType = (packet as any).type === 'request';
      const idemKey = req.id ? `${deviceId}:${req.id}` : null;
      const cached = idemKey ? this.recentRpcResponses.get(idemKey) : undefined;

      if (cached && cached.expiresAt > Date.now()) {
        const resPayload: any = { type: isReqType ? 'response' : 'rpc_res', id: req.id, result: cached.result, error: cached.error };
        reply(isEncrypted ? encryptPayload(resPayload, this.secretKey) : resPayload);
        return;
      }

      try {
        const result = await this.dispatchRpc(req.method || '', req.params, device);
        if (idemKey) this.recentRpcResponses.set(idemKey, { result, expiresAt: Date.now() + RPC_IDEMPOTENCY_TTL_MS });
        const resPayload: any = {
          type: isReqType ? 'response' : 'rpc_res',
          id: req.id,
          result
        };

        if (isEncrypted) {
          reply(encryptPayload(resPayload, this.secretKey));
        } else {
          reply(resPayload);
        }
      } catch (err: any) {
        if (idemKey) {
          this.recentRpcResponses.set(idemKey, { error: err?.message || String(err), expiresAt: Date.now() + RPC_IDEMPOTENCY_TTL_MS });
        }
        const errPayload: any = {
          type: isReqType ? 'response' : 'rpc_res',
          id: req.id,
          error: err?.message || String(err)
        };
        if (isEncrypted) {
          reply(encryptPayload(errPayload, this.secretKey));
        } else {
          reply(errPayload);
        }
      }
    }
  }

  /**
   * Диспетчер RPC методов.
   */
  private async dispatchRpc(method: string, params: any = {}, device: RemoteDevice): Promise<any> {
    // Проверка прав на модификацию в Read-Only режиме
    const writeMethods = new Set([
      'start_process',
      'stop_process',
      'restart_process',
      'update_task_status',
      'toggle_task_criterion',
      'create_task',
      'git_commit',
      'git_pull',
      'git_push',
      'send_ai_prompt',
      'hitl_decision',
      'run_action',
      'start_assigned_agent',
      'stop_swarm',
      'studio_send',
      'studio_abort'
    ]);

    if (this.readOnly && writeMethods.has(method)) {
      throw new Error(`Method ${method} is forbidden in Read-Only mode`);
    }

    // Права per-device токена (TASK-65, decision-11 п.1): readOnly — только чтение, hitl — чтение
    // и решения HITL, full — без ограничений сверх глобального readOnly выше.
    if (writeMethods.has(method)) {
      const rights = device.rights ?? 'full';
      if (rights === 'readOnly') {
        throw new Error(`Method ${method} is forbidden for this device (readOnly rights)`);
      }
      if (rights === 'hitl' && method !== 'hitl_decision') {
        throw new Error(`Method ${method} is forbidden for this device (hitl-only rights)`);
      }
    }

    const activePath = params.projectPath || this.activeProjectPath;

    switch (method) {
      case 'get_status': {
        const projects = await projectRegistry.getProjects();
        return {
          hostId: this.hostId,
          machineName: this.machineName || os.hostname(),
          platform: process.platform,
          tunnelUrl: this.tunnelUrl,
          activeProjectPath: this.activeProjectPath,
          projectsCount: projects.length,
          runningProcesses: processManager.getActiveProcessCount(),
          readOnly: this.readOnly
        };
      }

      case 'get_federation_hosts': {
        return { hosts: this.getFederationHostsList() };
      }

      case 'get_projects': {
        const projects = await projectRegistry.getProjects();
        this.cachedLocalProjects = projects.map((p) => ({
          id: p.path,
          name: path.basename(p.path),
          path: p.path
        }));
        // В реестре имени проекта нет — без него клиенты показывали пустые строки (TASK-140.1).
        return projects.map((p) => ({ ...p, name: path.basename(p.path) }));
      }

      case 'select_project': {
        this.activeProjectPath = params.projectPath;
        const projects = await projectRegistry.getProjects();
        const project = projects.find((p: any) => p.path === params.projectPath);
        return { activeProject: project || null };
      }

      case 'get_processes': {
        if (!activePath) return [];
        return await processManager.listProcessesForProject(activePath);
      }

      case 'start_process': {
        if (!activePath) throw new Error('No active project specified');
        // Рабочее дерево из удалённого запроса проверяем гардом: клиент не должен
        // запускать процессы в произвольном каталоге (TASK-62).
        const options = { ...(params.options ?? {}) };
        if (options.workspaceRoot) {
          options.workspaceRoot = await assertWorkspaceRoot(String(options.workspaceRoot));
        }
        const proc = await processManager.startProcess(activePath, params.command, params.name, options);
        return proc;
      }

      case 'stop_process': {
        const stopped = await processManager.stopProcess(params.processId);
        return { stopped };
      }

      case 'restart_process': {
        const restarted = await processManager.restartProcess(params.processId);
        return restarted;
      }

      case 'get_process_logs': {
        if (!activePath) return '';
        return await processManager.tailProjectLog(activePath, params.processName, params.lines || 100);
      }

      case 'get_tasks': {
        if (!activePath) return [];
        return await this.loadBacklogTasks(activePath);
      }

      case 'update_task_status': {
        if (!params.filePath || !params.newStatus) throw new Error('filePath and newStatus are required');
        await this.updateTaskStatusInFile(params.filePath, params.newStatus);
        this.broadcastEvent('backlog:changed', { projectPath: activePath });
        return { ok: true };
      }

      case 'toggle_task_criterion': {
        if (!params.filePath || params.index === undefined) throw new Error('filePath and index are required');
        await this.toggleCriterionInFile(params.filePath, params.index, params.completed);
        this.broadcastEvent('backlog:changed', { projectPath: activePath });
        return { ok: true };
      }

      case 'get_git_status': {
        if (!activePath) return null;
        return await gitService.getRepoDetails(activePath);
      }

      case 'git_commit': {
        if (!activePath || !params.message) throw new Error('message and projectPath are required');
        // Сканер секретов (decision-56 п. 4): с телефона дифф не виден, поэтому «закоммитить всё равно» только из окна.
        const res = await guardedCommit(activePath, params.message, {
          stageAll: Boolean(params.stageAll),
          allowOverride: false,
          source: { kind: 'remote', deviceId: device.id, deviceName: device.name }
        });
        if (res.ok) return true;
        if (res.reason === 'secrets') {
          throw new Error(`Коммит отклонён: похоже на секреты — ${summarizeSecretFindings(res.findings)}. Проверьте изменения и закоммитьте из окна ProjectHub.`);
        }
        throw new Error(res.error);
      }

      case 'hitl_decision': {
        // Решение Human-in-the-Loop с удалённого устройства: строго по requestId через единый
        // hitlService.decide (TASK-57). Одобрение «верхнего в очереди» не поддерживается.
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!requestId) throw new Error('requestId is required');
        const approved = params.decision === 'allow' || params.decision === 'approve' || params.approved === true;
        const result = hitlService.decide(
          requestId,
          { approved, text: typeof params.reason === 'string' ? params.reason : undefined },
          { kind: 'remote', deviceId: device.id, deviceName: device.name }
        );
        if (!result.ok) {
          return { ok: false, decision: approved, reason: result.reason };
        }
        this.notifyRenderer('remote:hitlDecisionMade', {
          requestId,
          sessionId: result.request.sessionId,
          approved,
          byDevice: device.name
        });
        return { ok: true, decision: approved, sessionId: result.request.sessionId };
      }

      case 'create_task': {
        if (!activePath) throw new Error('No active project specified');
        if (!params.title) throw new Error('title is required');
        const created = await createBacklogTaskFile(activePath, {
          title: String(params.title),
          description: typeof params.description === 'string' ? params.description : '',
          labels: Array.isArray(params.labels) ? params.labels.map(String) : [],
          type: params.type ? String(params.type) : undefined,
          priority: params.priority ? String(params.priority) : undefined,
          milestone: params.milestone ? String(params.milestone) : undefined
        });
        if (!created) throw new Error('Failed to create task');
        this.broadcastEvent('backlog:changed', { projectPath: activePath });
        return created;
      }

      case 'git_pull': {
        if (!activePath) throw new Error('No active project specified');
        return await gitService.pullRemote(activePath);
      }

      case 'git_push': {
        if (!activePath) throw new Error('No active project specified');
        return await gitService.pushRemote(activePath);
      }

      case 'run_action': {
        if (!activePath) throw new Error('No active project specified');
        const actionId: string = typeof params.action === 'string' ? params.action : 'run';
        const config = await actionConfigService.getConfig(activePath);
        const builtin: Record<'run' | 'deploy' | 'test', ActionDefinition> = {
          run: config.run,
          deploy: config.deploy,
          test: config.test
        };
        const def: ActionDefinition | undefined =
          actionId in builtin ? builtin[actionId as 'run' | 'deploy' | 'test'] : config.customActions?.find((a) => a.id === actionId);
        if (!def) throw new Error(`Unknown action: ${actionId}`);
        return await processManager.startProcess(activePath, def.command, def.name, {
          cwd: def.cwd,
          env: def.env,
          portStrategy: def.portStrategy,
          port: def.port
        });
      }

      // ── AI Studio с телефона (TASK-140.10, decision-83): те же сессии, что во вкладках на ПК ──

      case 'studio_get_options': {
        const config = await aiAgentService.getConfig();
        const profiles = await llmProfileService.listProfiles().catch(() => []);
        // Каталог профиля может идти в сеть (локальный сервер моделей) — не дольше 4 с на профиль.
        const withModels = await Promise.all(
          profiles.map(async (p) => {
            try {
              const res = await Promise.race([
                llmModelCatalogService.listModels(p.id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Список моделей не загрузился за 4 с')), 4000))
              ]);
              return { id: p.id, name: p.name, local: p.local, models: res.models.slice(0, 200), ...(res.error ? { modelsError: res.error } : {}) };
            } catch (err: any) {
              return { id: p.id, name: p.name, local: p.local, models: [], modelsError: err?.message || String(err) };
            }
          })
        );
        const current = selectionOf(config);
        return {
          current,
          currentLabel: selectionLabel(current, new Map(profiles.map((p) => [p.id, p.name]))) || config.model,
          modes: STUDIO_MODES,
          claudeModels: claudeBridgeService.getAvailableModels().map((m) => ({ id: m.id, name: m.name, description: m.description })),
          // Наружу — только id, имя и признак локального сервера: ни ключей, ни адресов, ни заголовков.
          profiles: withModels
        };
      }

      case 'studio_list_sessions': {
        const projectPath = String(params.projectPath || '');
        await assertRegisteredProject(projectPath);
        const [sessions, profiles] = await Promise.all([aiSessionStore.list(projectPath), llmProfileService.listProfiles().catch(() => [])]);
        return studioSessionList(sessions, (id) => studioRemoteBridge.isRunning(id), new Map(profiles.map((p) => [p.id, p.name])));
      }

      case 'studio_get_session': {
        const projectPath = String(params.projectPath || '');
        await assertRegisteredProject(projectPath);
        const session = await aiSessionStore.get(projectPath, String(params.sessionId || ''));
        if (!session) throw new Error('Сессия не найдена');
        const profiles = await llmProfileService.listProfiles().catch(() => []);
        return studioSessionForPhone(session, {
          running: studioRemoteBridge.isRunning(session.id),
          profileNames: new Map(profiles.map((p) => [p.id, p.name]))
        });
      }

      case 'send_ai_prompt': // прежнее имя — для приложений до TASK-140.10
      case 'studio_send': {
        const projectPath = String(params.projectPath || activePath || '');
        await assertRegisteredProject(projectPath);
        const text = typeof params.prompt === 'string' ? params.prompt.trim() : '';
        if (!text) throw new Error('prompt is required');
        if (text.length > 100_000) throw new Error('Промпт слишком длинный');
        const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined;
        const reply = await studioRemoteBridge.request({
          kind: 'send',
          projectPath,
          ...(sessionId ? { sessionId } : {}),
          text,
          ...(parseStudioSelection(params.selection) ? { selection: parseStudioSelection(params.selection) } : {}),
          ...(parseStudioMode(params.mode) ? { mode: parseStudioMode(params.mode) } : {}),
          deviceName: device.name
        });
        if (!reply.ok || !reply.sessionId) throw new Error(reply.error || 'AI Studio не приняла промпт');
        return { sessionId: reply.sessionId, accepted: true };
      }

      case 'studio_abort': {
        const projectPath = String(params.projectPath || '');
        await assertRegisteredProject(projectPath);
        const reply = await studioRemoteBridge.request({ kind: 'abort', projectPath, sessionId: String(params.sessionId || '') });
        if (!reply.ok) throw new Error(reply.error || 'Не удалось остановить');
        return { ok: true };
      }

      // ── Hub-режим федерации (TASK-66, decision-11 п.4): те же RPC, что и у телефона ──

      case 'get_roles': {
        const { roles } = await loadRoles(activePath || undefined);
        return roles.map((r) => ({
          slug: r.slug,
          name: r.name,
          engine: r.engine,
          model: r.model,
          source: r.source
        }));
      }

      case 'get_swarms': {
        // Только сводка: полные логи агентов наружу не отдаём (они могут содержать код и секреты).
        return agentFleetService.listSwarms(activePath || undefined).map((s) => ({
          id: s.id,
          mode: s.mode,
          status: s.status,
          projectPath: s.projectPath,
          taskId: s.taskId,
          taskTitle: s.taskTitle,
          origin: s.origin,
          createdAt: s.createdAt,
          completedAt: s.completedAt,
          agents: s.agents.map((a) => ({
            id: a.id,
            name: a.config.name,
            roleSlug: a.config.roleSlug,
            engine: a.config.engine,
            status: a.status,
            error: a.error
          }))
        }));
      }

      case 'start_assigned_agent': {
        if (!activePath) throw new Error('No active project specified');
        const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
        const roleSlug = typeof params.roleSlug === 'string' ? params.roleSlug.trim() : '';
        if (!taskId || !roleSlug) throw new Error('taskId and roleSlug are required');

        // Хост запускает агента только у себя: чужой hostId в запросе — ошибка маршрутизации,
        // а не повод исполнять чужую работу (decision-11 п.5).
        const targetHostId = typeof params.hostId === 'string' && params.hostId ? params.hostId : this.hostId;
        if (targetHostId !== this.hostId) {
          throw new Error(`Запрос адресован хосту ${targetHostId}, а это ${this.hostId}`);
        }

        const result = await agentFleetService.startAssignedAgent({
          projectPath: activePath,
          taskId,
          taskTitle: typeof params.taskTitle === 'string' ? params.taskTitle : undefined,
          prompt: typeof params.prompt === 'string' && params.prompt.trim() ? params.prompt : `Выполни задачу ${taskId}.`,
          roleSlug,
          useWorktrees: params.useWorktrees !== false
        });
        if ('error' in result) throw new Error(result.error);
        return { swarmId: result.id, status: result.status, hostId: this.hostId };
      }

      case 'stop_swarm': {
        const swarmId = typeof params.swarmId === 'string' ? params.swarmId : '';
        if (!swarmId) throw new Error('swarmId is required');
        return { stopped: agentFleetService.stopSwarm(swarmId) };
      }

      case 'get_agent_output': {
        // Экран агентов телефона (TASK-140.1, decision-79 п. 8): только хвост вывода, не транскрипт
        // и не логи слота — с телефона читают «что агент сейчас пишет», а не всю историю.
        const swarmId = typeof params.swarmId === 'string' ? params.swarmId : '';
        const agentId = typeof params.agentId === 'string' ? params.agentId : '';
        if (!swarmId || !agentId) throw new Error('swarmId and agentId are required');
        const agent = agentFleetService.getSwarm(swarmId)?.agents.find((a) => a.id === agentId);
        if (!agent) throw new Error('Агент не найден');
        const full = agent.finalOutput || agent.liveOutput || '';
        const text = full.length > AGENT_OUTPUT_TAIL_CHARS ? full.slice(full.length - AGENT_OUTPUT_TAIL_CHARS) : full;
        return {
          swarmId,
          agentId,
          status: agent.status,
          text,
          truncated: full.length > text.length || Boolean(agent.liveOutputTruncated)
        };
      }

      case 'get_events_since': {
        const sinceId = Number(params.sinceId) || 0;
        return { events: this.eventLog.filter((e) => e.id > sinceId), lastEventId: this.eventLogNextId - 1 };
      }

      case 'get_pending_approvals': {
        return hitlService.listPending(params.projectPath ? { projectPath: String(params.projectPath) } : {}).map((r) => ({
          requestId: r.id,
          sessionId: r.sessionId,
          projectPath: r.projectPath,
          origin: r.origin,
          agentName: r.agentName,
          role: r.role,
          tool: r.tool,
          type: r.type,
          title: r.title,
          details: r.details,
          command: r.command,
          filePath: r.filePath,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          orphaned: r.orphaned
        }));
      }

      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  /**
   * Загрузка списка задач Backlog.md из файловой системы.
   */
  private async loadBacklogTasks(projectPath: string): Promise<any[]> {
    const tasksDir = path.join(projectPath, 'backlog', 'tasks');
    if (!existsSync(tasksDir)) return [];

    const files = await fs.readdir(tasksDir);
    const tasks: any[] = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(tasksDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const { data, content } = matter(raw);

        // Парсинг Acceptance Criteria
        const criteria: Array<{ text: string; completed: boolean }> = [];
        const lines = content.split(/\r?\n/);
        let inAc = false;
        for (const line of lines) {
          if (/^## Acceptance Criteria/i.test(line.trim())) {
            inAc = true;
            continue;
          }
          if (inAc && /^##\s+/.test(line.trim())) {
            break;
          }
          if (inAc) {
            const m = line.match(/^-\s*\[([ xX])\]\s*(.*)$/);
            if (m) {
              criteria.push({
                completed: m[1].toLowerCase() === 'x',
                text: m[2].trim()
              });
            }
          }
        }

        tasks.push({
          id: data.id || file.replace(/\.md$/, ''),
          title: data.title || file,
          status: data.status || 'To Do',
          priority: data.priority || 'medium',
          filePath,
          criteria
        });
      } catch (err) {
        // ignore single corrupt file
      }
    }

    return tasks;
  }

  private async updateTaskStatusInFile(filePath: string, newStatus: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf8');
    const { data, content } = matter(raw);
    data.status = newStatus;
    data.updated = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const updated = matter.stringify(content, data);
    await fs.writeFile(filePath, updated, 'utf8');
  }

  private async toggleCriterionInFile(filePath: string, index: number, completed: boolean): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let acIdx = 0;
    let inAc = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^## Acceptance Criteria/i.test(line.trim())) {
        inAc = true;
        continue;
      }
      if (inAc && /^##\s+/.test(line.trim())) break;
      if (inAc) {
        const m = line.match(/^(-\s*\[)([ xX])(\]\s*.*)$/);
        if (m) {
          if (acIdx === index) {
            lines[i] = `${m[1]}${completed ? 'x' : ' '}${m[3]}`;
            break;
          }
          acIdx++;
        }
      }
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  }

  /**
   * Стриминг логов процессов клиентам.
   */
  private setupProcessLogStreaming() {
    processManager.onLog((data: { processId: string; text: string }) => {
      this.broadcastEvent('process:logChunk', data);
    });
    processManager.onStatusChanged((proc) => {
      this.broadcastEvent('process:statusChanged', proc);
      // Уведомление о падении процесса больше не отправляется отсюда: `processManager` публикует
      // `process:crashed` в шину, а доставкой (трей, ОС, звук, Telegram) заведует
      // `notificationService` по настраиваемой матрице каналов (TASK-63, decision-13).
    });
  }

  /**
   * Отправка push-события всем подключенным клиентам.
   */
  public broadcastEvent(event: string, data: any, opts: { transient?: boolean } = {}) {
    if (!this.enabled) return;

    // Транзитные события (поток AI Studio) не занимают буфер догона и идут без eventId: иначе один ответ агента
    // вытеснил бы из буфера запросы HITL, которые телефон должен догнать после разрыва.
    if (opts.transient) {
      const packet: PlainPacket = { type: 'event', event, data };
      for (const client of this.localClients.values()) {
        if (client.ws.readyState === WebSocket.OPEN && client.device.isApproved && client.isEncrypted) {
          try {
            client.ws.send(JSON.stringify(encryptPayload(packet, this.secretKey)));
          } catch {
            // ignore
          }
        }
      }
      if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
        try {
          this.relayWs.send(JSON.stringify(encryptPayload(packet, this.secretKey)));
        } catch {
          // ignore
        }
      }
      return;
    }

    // Догон пропущенных во время разрыва событий (TASK-65, decision-11 п.6): кольцевой буфер,
    // клиент запоминает `eventId` последнего полученного события и после переподключения
    // запрашивает `get_events_since` с ним — поэтому id едет и в самом live-пакете.
    const eventId = this.eventLogNextId++;
    const payload: PlainPacket = {
      type: 'event',
      event,
      data,
      eventId
    };

    this.eventLog.push({ id: eventId, event, data });
    if (this.eventLog.length > EVENT_LOG_MAX) this.eventLog.shift();

    // Отправка локальным клиентам
    for (const client of this.localClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN && client.device.isApproved) {
        try {
          if (client.isEncrypted) {
            client.ws.send(JSON.stringify(encryptPayload(payload, this.secretKey)));
          } else {
            client.ws.send(JSON.stringify(payload));
          }
        } catch {
          // ignore
        }
      }
    }

    // Отправка через Relay
    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      try {
        const encrypted = encryptPayload(payload, this.secretKey);
        this.relayWs.send(JSON.stringify(encrypted));
      } catch {
        // ignore
      }
    }
  }

  private sendToDevice(deviceId: string, payload: PlainPacket) {
    const client = this.localClients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try {
        if (client.isEncrypted) {
          client.ws.send(JSON.stringify(encryptPayload(payload, this.secretKey)));
        } else {
          client.ws.send(JSON.stringify(payload));
        }
      } catch {
        // ignore
      }
      return;
    }

    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      const encrypted = encryptPayload(payload, this.secretKey);
      (encrypted as any).targetClientId = deviceId;
      this.relayWs.send(JSON.stringify(encrypted));
    }
  }

  private notifyStatusChanged() {
    this.notifyRenderer('remote:statusChanged', this.getStatus());
    this.announceEndpointsIfChanged();
  }

  /**
   * Новый адрес туннеля (или смена сети ПК) доходит до сопряжённых телефонов без нового QR (TASK-140.9):
   * событие идёт зашифрованным, как любое другое, и попадает в буфер догона — телефон, который был
   * не на связи, получит его через `get_events_since`, а при новом подключении — в `handshake_ack`.
   */
  private announceEndpointsIfChanged(): void {
    if (!this.enabled) return;
    const announcement = this.endpointsAnnouncement();
    const key = JSON.stringify(announcement);
    if (key === this.announcedEndpointsKey) return;
    this.announcedEndpointsKey = key;
    this.broadcastEvent('host:endpoints', announcement);
  }

  private notifyRenderer(channel: string, data: any) {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w.isDestroyed()) {
        w.webContents.send(channel, data);
      }
    }
  }
}

export const remoteControlService = new RemoteControlService();
