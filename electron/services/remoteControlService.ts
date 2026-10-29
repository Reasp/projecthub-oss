import http, { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from 'electron';
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
  FederationProject,
  RemoteEnrollment
} from '../../src/types/remote.js';
import type { HitlDecideResult, HitlRequest } from './hitlTypes.js';
import { generateSecretKey, generatePairingPin, encryptPayload, decryptPayload } from '../../src/utils/remoteCryptoNode.js';
import {
  HOST_SESSION_PROTOCOLS,
  HandshakeError,
  SESSION_PROTOCOL_V1,
  SESSION_PROTOCOL_V2,
  bytesToBase64Url,
  isSessionFrameV2,
  type SessionFrameV2
} from '../../src/utils/remoteSessionV2.js';
import { generateSessionSigningKey, hostKeyFingerprintNode, isHostKey, p256RawPublicKey, respondToClientHello, type NodeSessionV2 } from '../../src/utils/remoteSessionV2Node.js';
import { federationClientService } from './federationClientService.js';
import { projectRegistry } from './projectRegistry.js';
import { assertRegisteredProject, assertWorkspaceRoot } from './projectPathGuard.js';
import { studioRemoteBridge } from './studioRemoteBridge.js';
import { aiSessionStore } from './aiSessionStore.js';
import { hitlTitleIn, hostText } from '../i18n/hostText.js';
import { getHostLanguage } from './hostLanguage.js';
import { AppError, appErrorKeyOf, withAppErrorKey, type AppErrorKey, type AppErrorParams } from '../../src/lib/appError.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';
import { llmProfileService } from './llmProfileService.js';
import { llmModelCatalogService } from './llmModelCatalogService.js';
import {
  canWriteStudioSession,
  claudeAccountsForPhone,
  parseStudioMode,
  parseStudioSelection,
  studioReadOnlyError,
  selectionLabel,
  selectionOf,
  studioSessionForPhone,
  studioSessionList,
  STUDIO_MODES,
  usageForPhone
} from '../../src/utils/studioRemote.js';
import { studioQuickPromptList } from '../../src/utils/studioQuickPrompts.js';
import { claudeUsageService } from './claudeUsageService.js';
import { parseProcessId, processManager } from './processManager.js';
import { gitService } from './gitService.js';
import { guardedCommit } from './commitSecretGuard.js';
import { summarizeSecretFindings } from './diffSecretScan.js';
import { claudeBridgeService } from './claudeBridgeService.js';
import { claudeAccountService } from './claudeAccountService.js';
import { agentFleetService, isActiveSwarmStatus } from './agentFleetService.js';
import { editionRegistry, type DeviceNotice, type PairingRedemption, type RemoteDeviceRef } from '../extensions/editionRegistry.js';
import { appendRemoteAudit, auditTarget } from './remoteActionAudit.js';
import { aiAgentService } from './aiAgentService.js';
import { actionConfigService, type ActionDefinition } from './actionConfigService.js';
import { createBacklogTaskFile } from './backlogTaskCreate.js';
import { hitlService } from './hitlService.js';
import { confirmProofPayload, parseConfirmKey, verifyConfirmProof } from './hitlConfirmProof.js';
import { fitsPhoneReview, hitlDetailForPhone } from './remoteHitlDetail.js';
import { listRemoteDocs, readRemoteDoc, REMOTE_DOC_MAX_BYTES } from './remoteDocs.js';
import { diffDocBranch, sanitizeResolutions } from './docBranches.js';
import { closeDocBranchAsHuman, docBranchesOverview, mergeDocBranchAsHuman, remoteDocBranchDiff } from './docBranchActions.js';
import { parsePushAction, parsePushRegistration, verifyPushAction, type PushHostEndpoint, type PushRegistration } from './remotePush.js';
import { RemotePushService, type PushTarget } from './remotePushService.js';
import { RemoteInboxService, type InboxTask, type NoteContext } from './remoteInboxService.js';
import { FleetOverviewService } from './fleetOverviewService.js';
import { terminalSessionTracker } from './terminalSessionTracker.js';
import { overviewActions, scopeOverview, type RemoteOverview } from '../../src/utils/fleetOverview.js';
import {
  minAccess,
  owningProject,
  projectAccessDenied,
  projectAccessFor,
  sanitizeProjectRights,
  type DeviceProjectRights,
  type ProjectAccess
} from '../../src/utils/projectAccess.js';
import { KeepAwakeController } from './keepAwake.js';
import { ProgressThrottle, progressFromSession } from './remoteProgress.js';
import { VoiceUploads, parseVoiceChunk, recognizeVoice, type VoiceLanguage, type VoiceResult } from './remoteVoice.js';
import type { SwarmSession } from './swarmTypes.js';
import { setAgentNotifier } from './agentNotifier.js';
import { updateTaskFile } from './taskSessionNote.js';
import { applyImplementationNote, nowBacklogTimestamp } from './backlogTaskFormat.js';
import { visualArtifactService } from './visualArtifactService.js';
import {
  AttachmentUploads,
  parseAttachmentChunk,
  promptWithAttachments,
  resolvePromptAttachments,
  writeAttachmentFile
} from './studioAttachments.js';
import { parseConfirmMethod } from './hitlRisk.js';
import { agentTaskApproval } from './agentTaskApprovalInstance.js';
import { assignedTaskRunner } from './assignedTaskRunner.js';
import { lanDiscoveryService } from './lanDiscoveryService.js';
import { loadRoles } from './roleService.js';
import { secretStorageService } from './secretStorageService.js';
import { appEventBus } from './eventBus.js';
import { logger } from './logger.js';
import { errorMessage } from './errorMessage.js';
import { getUserDataDir, getDevRepoRoot, getAppRootDir, getStatePath } from './appPaths.js';
import { classifyLanAddresses, rankLanAddresses } from './lanAddresses.js';
import { resolveTunnelCommand } from './tunnelCommand.js';
import treeKill from 'tree-kill';
import { buildHostEndpoints, relayEndpoint, type RemoteEndpoint } from '../../src/utils/remoteEndpoints.js';
import { isPeerIntroduction, peerAddressCandidates } from '../../src/utils/fleetIntroduce.js';
import { buildInvitePairingUrl } from '../../src/utils/remotePairingLink.js';
import { firstReachableAddress, PeerUnreachableError } from './peerReachability.js';
import { profileFromJson, profileSectionList } from './profileFormat.js';
import { profileService } from './profileService.js';
import matter from 'gray-matter';
import {
  MOBILE_CLIENT_DIST,
  mobileClientMissingHtml,
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
  /** Сессия протокола v2 (decision-111): после `client_hello` пакеты этого сокета шифруются её ключами. */
  session?: NodeSessionV2;
}

type ClientTransport = 'local' | 'relay';

const RIGHTS_ORDER: DeviceRights[] = ['readOnly', 'hitl', 'full'];

/** Меньшие из двух прав: делегированное устройство не получает больше, чем у того, кто его привёл. */
export function minDeviceRights(a: DeviceRights, b: DeviceRights): DeviceRights {
  return RIGHTS_ORDER[Math.min(RIGHTS_ORDER.indexOf(a), RIGHTS_ORDER.indexOf(b))] ?? 'readOnly';
}

function parseDeviceRights(value: unknown): DeviceRights | null {
  return value === 'readOnly' || value === 'hitl' || value === 'full' ? value : null;
}

/** Методы RPC, меняющие данные: недоступны устройствам только для чтения и пишутся в журнал действий (decision-126). */
const REMOTE_WRITE_METHODS = new Set([
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
  'approve_agent_tasks',
  'run_action',
  'start_assigned_agent',
  'stop_swarm',
  'studio_send',
  'studio_attach',
  'studio_abort',
  'studio_clear',
  // Выдача токена новому устройству — действие владельца хоста, только с правами full (decision-111).
  'enroll_device',
  // Знакомство ПК через телефон (decision-143): пир hub-режима на этом ПК и отзыв неиспользованного токена.
  'federation_add_peer',
  'revoke_introduced_device',
  // «Входящие» (decision-117 п. 3, 4): разбор ленты и решение по задаче из Review — решения человека, как HITL.
  'inbox_dismiss',
  'review_task',
  // Голосовой промпт — та же запись в агента, что studio_send (decision-121 п. 4).
  'voice_chunk',
  // Разбор голосовой команды телефона зовёт модель пользователя, то есть тратит его деньги (decision-137 п. 3).
  'voice_command',
  // Новый проект на этом ПК (decision-137 п. 9): пишет на диск и в реестр.
  'create_project',
  // Ветки документации (decision-151): принять правки агента в основную или отклонить — решение человека, как HITL.
  'merge_doc_branch',
  'close_doc_branch',
  // Профиль владельца с другого ПК (TASK-225): предпросмотр запоминает чужой документ, применение пишет настройки.
  'profile_preview',
  'profile_apply'
]);

interface DeviceTokenRecord {
  /** Участник общего хоста, которому выдано устройство (приглашение, decision-126). Пусто — владелец хоста. */
  memberId?: string;
  token: string;
  rights: DeviceRights;
  deviceName: string;
  createdAt: number;
  /** Права назначены вручную из UI: пересопряжение по PIN их не сбрасывает (TASK-65). */
  rightsExplicit?: boolean;
  /**
   * Права на отдельные проекты хоста (TASK-180, decision-144): переопределения и право для остальных и новых
   * проектов. Нет поля — права устройства на все проекты, как у сопряжений до TASK-180. Пересопряжение не сбрасывает.
   */
  projectRights?: DeviceProjectRights;
  /**
   * Владелец одобрил устройство на ПК (TASK-140.9). `false` — токен выдан, но одобрения ещё не было:
   * переподключение с таким токеном снова ждёт одобрения. Записи без поля (до TASK-140.9) считаются
   * одобренными — так работали прежние переподключения в LAN.
   */
  approved?: boolean;
  /**
   * Устройство выдано по просьбе другого сопряжённого устройства (`enroll_device`, decision-111): телефон получил
   * доступ к этому хосту через соседний ПК федерации. Отзыв того устройства отзывает и это.
   */
  delegatedBy?: string;
  /**
   * Токен выдан другому ПК владельца по знакомству с телефона (decision-143): `deviceId` телефона, только для журнала.
   * Отзыв телефона знакомство не отзывает — связь ПК ↔ ПК не должна пропасть вместе с потерянным телефоном.
   */
  introducedBy?: string;
  /** hostId ПК, получившего токен по знакомству: повторное знакомство той же пары не плодит записи. */
  peerHostId?: string;
  /**
   * Открытый ключ подтверждения ECDSA P-256 (SPKI, base64url, decision-112 п. 4): устройство подписывает им решения
   * `high` после биометрии. Регистрируется только при сопряжении по ключу или PIN из QR, не по токену.
   */
  confirmKey?: string;
  /**
   * Push на это устройство включён явно для этого ПК (TASK-140.3, decision-115): адрес UnifiedPush или токен FCM/APNs,
   * ключи RFC 8291 и ключ кнопок уведомления. Секреты — потому и лежат в secretStorage вместе с токеном.
   */
  push?: PushRegistration;
}

/**
 * Ответ хоста в режиме «только v2» (decision-116) на любой пакет v1 и на ключ в URL. Клиенты узнают его и не
 * переподключаются: нужен клиент с v2 и ключом хоста из свежего QR.
 */
export const V2_REQUIRED_ERROR = 'This host accepts only protocol v2: update the app or pair again by QR';

/**
 * Параметры, которыми с устройства можно было бы включить обход разрешений или auto-approve (decision-112 п. 6).
 * Ни один RPC их не принимает; запрос с ними отклоняется целиком, а не молча игнорируется.
 */
const FORBIDDEN_REMOTE_PARAMS = ['autoApprove', 'autoApproveRules', 'bypassPermissions', 'permissionMode', 'dangerouslySkipPermissions', 'skipPermissions'];

/** Версия формата `remote-control.json` (decision-104). */
const REMOTE_CONTROL_CONFIG_VERSION = 1;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
const EVENT_LOG_MAX = 200;
const RPC_IDEMPOTENCY_TTL_MS = 60 * 1000;
/** Хвост вывода агента для `get_agent_output` (экран агентов телефона). */
const AGENT_OUTPUT_TAIL_CHARS = 8000;
/** Период heartbeat/метаданных в каталог релея (TASK-66): релей считает хост протухшим через 90с. */
const FEDERATION_HEARTBEAT_MS = 30 * 1000;
/** Проба адресов соседа при знакомстве (TASK-198): вместе с рукопожатием укладывается в тайм-аут RPC телефона (15 с). */
const INTRODUCE_PROBE_TIMEOUT_MS = 4 * 1000;

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

/**
 * Отказ в решении HITL для телефона, push и Telegram: `reason` — код отказа или английская причина `not_owner` для
 * старых клиентов, `reasonKey` — её код, клиент показывает причину на своём языке (decision-165).
 */
function hitlRefusal(result: Extract<HitlDecideResult, { ok: false }>) {
  return {
    ok: false as const,
    reason: result.reason === 'not_owner' ? result.message : result.reason,
    ...(result.reason === 'not_owner' && result.messageKey ? { reasonKey: result.messageKey } : {}),
    ...(result.risk ? { risk: result.risk } : {})
  };
}

/** Стабильный непрозрачный идентификатор пути проекта: наружу уходит хэш, не сам путь. */
export function hashProjectPath(projectPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectPath).toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Методы хоста без проекта (TASK-180): права по проектам к ним не применяются, а списки внутри сужаются до проектов,
 * открытых устройству.
 */
const HOST_WIDE_METHODS = new Set([
  'get_status',
  'get_federation_hosts',
  'federation_enroll',
  'enroll_device',
  'federation_add_peer',
  'revoke_introduced_device',
  'get_projects',
  'get_overview',
  'studio_get_options',
  'get_events_since',
  'push_register',
  'push_unregister',
  'push_status',
  'push_test',
  'get_inbox',
  'inbox_dismiss',
  'voice_chunk',
  'voice_command',
  'create_project',
  'get_pending_approvals',
  'profile_get',
  'profile_preview',
  'profile_apply'
]);

/** Проект у этих методов необязателен: без него — сводка по всем проектам, суженная правами устройства. */
const OPTIONAL_PROJECT_METHODS = new Set(['get_pending_agent_tasks', 'studio_get_usage', 'get_swarms']);

/** Отказ по праву устройства на проект: журнал действий пишет его и для методов чтения (TASK-180). */
class ProjectAccessError extends AppError {
  constructor(code: AppErrorCode, params: AppErrorParams, readonly projectPath: string) {
    super(code, params);
    this.name = 'ProjectAccessError';
  }
}

/** Права по проектам в журнал: имена проектов без каталогов. */
function projectRightsSummary(rights: DeviceProjectRights | undefined): Record<string, string> {
  if (!rights) return { projects: 'all' };
  const list = Object.entries(rights.projects ?? {}).map(([p, a]) => `${path.basename(p)}=${a}`).join(', ');
  return { ...(list ? { projects: list.slice(0, 300) } : {}), ...(rights.defaultAccess ? { defaultAccess: rights.defaultAccess } : {}) };
}

/** Задача Backlog для телефона и «Входящих» (`loadBacklogTasks`): поля frontmatter и критерии из тела. */
interface RemoteBacklogTask extends InboxTask {
  filePath: string;
  assignee?: string[];
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

  /** Шлюз `ph-push` для FCM и APNs (decision-115); пустой — только UnifiedPush. */
  private pushGatewayUrl = '';
  /** Только протокол v2 (decision-116): v1 с общим ключом отклоняется, в том числе ключ в URL и hub старых сборок. */
  private sessionV2Only = false;
  private pushService = new RemotePushService(
    {
      now: () => Date.now(),
      fetch: (url, init) => fetch(url, init),
      targets: () => this.pushTargets(),
      hostId: () => this.hostId,
      machineName: () => this.machineName || os.hostname(),
      endpoints: () => this.pushHostEndpoints(),
      deviceOnline: (deviceId) => Boolean(this.connectedDevices.get(deviceId)?.isApproved),
      seesProject: (deviceId, projectPath) => this.recordSeesProject(deviceId, projectPath),
      pcActivity: () => ({
        windowFocused: Boolean(BrowserWindow.getFocusedWindow()),
        idleSeconds: (() => {
          try {
            return powerMonitor.getSystemIdleTime();
          } catch {
            return Number.MAX_SAFE_INTEGER;
          }
        })()
      }),
      gatewayUrl: () => this.pushGatewayUrl,
      hostSigningKey: async () => {
        try {
          const { privateKeyPem, hostKeyRaw } = await this.ensureSessionKey();
          return { privateKeyPem, hostKeyRaw };
        } catch {
          return null;
        }
      },
      log: (message) => logger.warn(message)
    },
    (deviceId) => this.dropPushRegistration(deviceId)
  );

  /** «Входящие» телефона (TASK-140.5, decision-117): журнал ленты, проверка задач, `projecthub_notify`. */
  private inbox = new RemoteInboxService({
    now: () => Date.now(),
    statePath: () => getStatePath('remote-inbox.json'),
    projects: async () => (await projectRegistry.getProjects()).map((p) => p.path),
    assertProject: (projectPath) => assertRegisteredProject(projectPath),
    tasks: (projectPath) => this.loadBacklogTasks(projectPath),
    pendingApprovals: () => this.pendingApprovals(),
    agentTasks: async () =>
      (await agentTaskApproval.listPending()).map(({ projectPath, id, title, reporter, created }) => ({
        projectPath,
        id,
        title,
        ...(reporter ? { reporter } : {}),
        ...(created ? { created } : {})
      })),
    swarms: (projectPath) => agentFleetService.listSwarms(projectPath),
    startAgent: async (o) => {
      const res = await agentFleetService.startRoleAgent({
        projectPath: o.projectPath,
        taskId: o.taskId,
        taskTitle: o.taskTitle,
        roleSlug: o.roleSlug,
        prompt: o.prompt,
        origin: 'assigned',
        ...(o.doneLoop ? { mode: 'doneLoop' as const } : {}),
        ...(o.memberId ? { memberId: o.memberId } : {})
      });
      // У сессии роя тоже есть необязательное поле `error`: отказ запуска отличаем по отсутствию `agents`.
      if (!('agents' in res)) return { error: res.error };
      this.trackPhoneSwarm(res.id);
      return { swarmId: res.id };
    },
    updateTask: (projectPath, taskId, mutate) => updateTaskFile(projectPath, taskId, mutate),
    applyNote: (content, note) => applyImplementationNote(content, note),
    timestamp: () => nowBacklogTimestamp(),
    resolveVisual: (relPath) => visualArtifactService.resolveExisting(relPath),
    pushNote: (note) => this.pushService.onNote(note),
    changed: (reason) => {
      if (this.enabled) this.broadcastEvent('inbox:changed', { reason });
    },
    log: (message) => logger.warn(message)
  });

  /** Дерево флота (TASK-174, decision-129): все проекты хоста одним снимком и событие изменения. */
  private overview = new FleetOverviewService({
    now: () => Date.now(),
    hostId: () => this.hostId,
    machineName: () => this.machineName || os.hostname(),
    platform: process.platform,
    projects: async () => (await projectRegistry.getProjects()).map((p) => p.path),
    studioDir: (projectPath) => aiSessionStore.projectDir(projectPath),
    studioRunning: (id) => studioRemoteBridge.isRunning(id),
    profileNames: async () => new Map((await llmProfileService.listProfiles()).map((p) => [p.id, p.name])),
    swarms: (projectPath) => agentFleetService.listSwarms(projectPath),
    terminals: (projectPath) => terminalSessionTracker.list(projectPath),
    pending: () => hitlService.listPending(),
    processes: (projectPath) => processManager.listProcessesForProject(projectPath),
    log: (message) => logger.warn(message)
  });
  private overviewSubscribed = false;
  /** Состояния роев, по которым последний раз считалось изменение сводки: вывод агента её не перерисовывает. */
  private swarmOverviewKeys = new Map<string, string>();

  /** Не давать ПК уснуть, пока ждёт человека (decision-117 п. 9); по умолчанию включено. */
  private keepAwake = true;
  private keepAwakeController = new KeepAwakeController(
    // Без `powerSaveBlocker` (заглушка Electron в тестах) запрет сна просто не держится.
    {
      start: () => powerSaveBlocker?.start?.('prevent-app-suspension') ?? -1,
      stop: (id) => powerSaveBlocker?.stop?.(id),
      isStarted: (id) => id >= 0 && Boolean(powerSaveBlocker?.isStarted?.(id))
    },
    (message) => logger.info(message)
  );
  /** Агенты, запущенные с телефона: сессии роя и сессии Studio, пока они работают. */
  private phoneSwarms = new Set<string>();
  private phoneStudioSessions = new Set<string>();
  private keepAwakeTimer: NodeJS.Timeout | null = null;
  /** Ход агентов на экран блокировки телефона (TASK-140.7, decision-121): частота и рои, ждущие решения HITL. */
  private progressThrottle = new ProgressThrottle();
  private swarmsWaitingHitl = new Set<string>();
  private progressSubscribed = false;
  private voiceUploads = new VoiceUploads();

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
  /**
   * Ключ сессий протокола v2 (ECDSA P-256, decision-111): им хост подписывает рукопожатие, его открытая часть едет в
   * QR. Отдельно от Ed25519-identity релея: Ed25519 нет в WebCrypto старых WebView. Приватная часть — только в
   * secretStorageService.
   */
  private sessionKeyPem: string | null = null;
  private sessionKeyRaw: Buffer | null = null;
  private sessionKeyReady: Promise<void> | null = null;
  /** Сессии v2 клиентов, пришедших через релей, по `clientId` (у прямых — в `ClientConnection`). */
  private relaySessions = new Map<string, NodeSessionV2>();

  /** Per-device токены выданные при сопряжении: deviceId -> запись (TASK-65). */
  private deviceTokens = new Map<string, DeviceTokenRecord>();
  /** Вложения в промпт Studio, которые телефон шлёт частями (TASK-140.6, decision-114 п. 5). */
  private attachmentUploads = new AttachmentUploads({ now: () => Date.now(), write: writeAttachmentFile });
  /** Rate-limit подбора PIN/ключа по IP (decision-5 п.5). */
  private pinAttempts = new Map<string, { count: number; lockedUntil: number }>();
  /** Кольцевой буфер последних событий для догона по `lastEventId` (decision-11 п.6). */
  private eventLog: Array<{ id: number; event: string; data: unknown; audience?: (device: RemoteDevice) => boolean }> = [];
  /** Таймеры эскалации HITL участника на старшие роли (TASK-142.3): по `requestId`. */
  private hitlEscalations = new Map<string, ReturnType<typeof setTimeout>>();
  private eventLogNextId = 1;
  /** Идемпотентность RPC по `requestId` (decision-11 п.6): повтор в течение TTL возвращает
   *  закэшированный ответ вместо повторного выполнения. */
  private recentRpcResponses = new Map<string, { result?: unknown; error?: string; errorKey?: AppErrorKey; expiresAt: number }>();
  /** Значения `secretKey`/`pairingPin`/`telegramBotToken`, найденные в legacy-plaintext конфиге при
   *  первом запуске после TASK-65 — переносятся в secretStorageService и никогда больше не
   *  пишутся в `remote-control.json` (decision-5 п.4). */
  private legacySecretsToMigrate: { secretKey?: string; pairingPin?: string; telegramBotToken?: string } = {};

  private connectedDevices = new Map<string, RemoteDevice>();
  private localClients = new Map<string, ClientConnection>();
  /** Проект окна ProjectHub (ph-agent — первый проект реестра): по умолчанию для устройств, не выбравших свой. */
  private activeProjectPath: string | null = null;
  /** Проект, выбранный устройством (`select_project`): у каждого свой, клиенты не перебивают друг друга (decision-129 п. 8). */
  private deviceProjects = new Map<string, string>();
  private knownFederationHosts = new Map<string, FederationHost>();
  private cachedLocalProjects: Array<{ id: string; name: string; path: string }> = [];

  /** Общий секрет федерации: одинаковый на всех машинах пользователя, хранится в safeStorage. */
  private federationSecret = '';
  /** Конверт записи организации, с которым открыт сокет релея (TASK-226): смена — повод переподключиться. */
  private relayTeamCredentialSent = '';
  /** Производный от секрета `ownerId` — именно он уходит релею (TASK-66). */
  private federationOwnerId = '';
  private federationHeartbeatTimer: NodeJS.Timeout | null = null;
  /** Работающие прямо сейчас агенты (ключ — agentId/sessionId), считаются по шине событий. */
  private activeAgentSessions = new Set<string>();
  /** Понятная ошибка несовместимости версии протокола с релеем (AC #5), показывается в UI. */
  private federationProtocolError: AppError | null = null;
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

    // Поток Agents Studio (любой сессии) — сопряжённым телефонам, мимо буфера догона: чанков много, а после
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
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to load persisted secrets: ${errorMessage(err)}`);
    }
  }

  private async persistDeviceTokens(): Promise<void> {
    try {
      const obj: Record<string, DeviceTokenRecord> = {};
      for (const [deviceId, rec] of this.deviceTokens.entries()) obj[deviceId] = rec;
      await secretStorageService.setSecret('remoteControl.deviceTokens', JSON.stringify(obj));
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to persist device tokens: ${errorMessage(err)}`);
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

  /** Ключ сессий v2 (decision-111): создаётся один раз, приватная часть — в secretStorageService. */
  private async ensureSessionKey(): Promise<{ privateKeyPem: string; hostKeyRaw: Buffer }> {
    if (!this.sessionKeyPem || !this.sessionKeyRaw) {
      if (!this.sessionKeyReady) {
        this.sessionKeyReady = (async () => {
          const stored = await secretStorageService.getSecret('remoteControl.sessionSigningKey');
          if (stored) {
            this.sessionKeyPem = stored;
            this.sessionKeyRaw = p256RawPublicKey(crypto.createPublicKey(stored));
            return;
          }
          const fresh = generateSessionSigningKey();
          await secretStorageService.setSecret('remoteControl.sessionSigningKey', fresh.privateKeyPem);
          this.sessionKeyPem = fresh.privateKeyPem;
          this.sessionKeyRaw = fresh.hostKeyRaw;
        })();
        // Сбой хранилища не должен навсегда оставить хост без ключа: следующий вызов попробует снова.
        this.sessionKeyReady.catch(() => {
          this.sessionKeyReady = null;
        });
      }
      await this.sessionKeyReady;
    }
    return { privateKeyPem: this.sessionKeyPem!, hostKeyRaw: this.sessionKeyRaw! };
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
      ...(previous?.rightsExplicit ? { rightsExplicit: true } : {}),
      // Права по проектам — тоже решение владельца: пересопряжение по PIN не открывает закрытые проекты.
      ...(previous?.projectRights ? { projectRights: previous.projectRights } : {})
    };
    this.deviceTokens.set(deviceId, record);
    this.persistDeviceTokens().catch(() => {});
    return record;
  }

  /** Токен устройства, сопряжённого по приглашению участника: права роли, одобрено владельцем (decision-126). */
  private issueMemberDeviceToken(deviceId: string, deviceName: string, invite: PairingRedemption): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      memberId: invite.memberId,
      token: crypto.randomBytes(32).toString('hex'),
      rights: invite.rights,
      deviceName,
      createdAt: Date.now(),
      approved: true,
      rightsExplicit: true
    };
    this.deviceTokens.set(deviceId, record);
    this.persistDeviceTokens().catch(() => {});
    logger.info(`[RemoteControl] Device ${deviceId} paired by invite for member ${invite.memberId}`);
    return record;
  }

  /** Права устройства после сужения точками расширения (роль участника общего хоста). */
  private effectiveDeviceRights(device: { id: string; name?: string; memberId?: string; rights?: DeviceRights }): DeviceRights {
    return editionRegistry.deviceRights({ id: device.id, ...(device.name ? { name: device.name } : {}), ...(device.memberId ? { memberId: device.memberId } : {}), rights: device.rights ?? 'full' });
  }

  /** Корни проектов реестра — для доступа по путям worktree, файлов задач и процессов (TASK-180). */
  private projectRoots: string[] = [];
  private projectRootsAt = 0;

  private async refreshProjectRoots(): Promise<string[]> {
    try {
      this.projectRoots = (await projectRegistry.getProjects()).map((p) => p.path);
      this.projectRootsAt = Date.now();
    } catch {
      // реестр недоступен — остаётся прежний список
    }
    return this.projectRoots;
  }

  /**
   * Доступ устройства к проекту (TASK-180, decision-144): меньшее из прав устройства после сужения ролью, его права
   * на этот проект и потолка модулей редакции. Путь внутри проекта (worktree агента, файл задачи) — доступ проекта.
   */
  private projectAccessOf(device: { id: string; name?: string; memberId?: string; rights?: DeviceRights }, targetPath: string): ProjectAccess {
    const root = owningProject(targetPath, this.projectRoots) ?? targetPath;
    const rights = this.effectiveDeviceRights(device);
    const ref = { id: device.id, ...(device.name ? { name: device.name } : {}), ...(device.memberId ? { memberId: device.memberId } : {}), rights };
    return minAccess(projectAccessFor(rights, this.deviceTokens.get(device.id)?.projectRights, root), editionRegistry.projectAccessLimit(ref, root));
  }

  /** Видит ли устройство из реестра токенов проект (push, HTTP API). */
  private recordSeesProject(deviceId: string, targetPath: string): boolean {
    const record = this.deviceTokens.get(deviceId);
    if (!record) return false;
    return this.projectAccessOf({ id: deviceId, name: record.deviceName, ...(record.memberId ? { memberId: record.memberId } : {}), rights: record.rights }, targetPath) !== 'none';
  }

  /** Проект, которого касается событие: `projectPath` в данных или каталог процесса в `processId`. */
  private eventProject(data: unknown): string | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const d = data as { projectPath?: unknown; processId?: unknown };
    if (typeof d.projectPath === 'string' && d.projectPath) return d.projectPath;
    if (typeof d.processId === 'string') return parseProcessId(d.processId)?.projectPath;
    return undefined;
  }

  /** Переподключение по токену одобрено, если владелец одобрял это устройство или одобрение выключено. */
  private isTokenApproved(record: DeviceTokenRecord): boolean {
    return !this.requireApproval || record.approved !== false;
  }

  private validateDeviceToken(deviceId: string, token: string): DeviceTokenRecord | null {
    const record = this.deviceTokens.get(deviceId);
    if (!record) return null;
    if (!this.constantTimeEqual(record.token, token)) return null;
    if (record.peerHostId) this.retireOlderIntroductions(deviceId, record.peerHostId);
    return record;
  }

  /**
   * ПК вошёл по токену знакомства (decision-143): прежние токены той же пары больше не нужны. Удаляются только сейчас, а
   * не при выдаче нового (ревью TASK-186): ПК мог продолжать работать по старому токену, а новый — отозваться телефоном
   * при ответе `already`, и пара ломалась при следующем разрыве.
   */
  private retireOlderIntroductions(deviceId: string, peerHostId: string): void {
    let changed = false;
    for (const [id, other] of this.deviceTokens.entries()) {
      if (id !== deviceId && other.peerHostId === peerHostId && !this.connectedDevices.has(id)) {
        this.deviceTokens.delete(id);
        changed = true;
      }
    }
    if (changed) this.persistDeviceTokens().catch(() => undefined);
  }

  /** Отзыв токена конкретного устройства (в отличие от `regenerateToken`, не трогает остальных). */
  public revokeDeviceToken(deviceId: string): string[] {
    const removed: string[] = [];
    if (this.deviceTokens.delete(deviceId)) removed.push(deviceId);
    // Устройства, которые это устройство привело с другого ПК федерации (decision-111), отзываются вместе с ним.
    for (const [id, record] of this.deviceTokens.entries()) {
      if (record.delegatedBy === deviceId) {
        this.deviceTokens.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.persistDeviceTokens().catch(() => {});
    for (const id of removed) this.attachmentUploads.dropDevice(id);
    return removed;
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
      device.rights = this.effectiveDeviceRights({ ...device, rights });
      // Клиент обновляет свой индикатор прав тем же пакетом, что и при сопряжении.
      this.sendToDevice(deviceId, {
        type: 'handshake_ack',
        result: {
          approved: device.isApproved,
          readOnly: this.readOnly,
          hostId: this.hostId,
          rights: device.rights,
          lastEventId: this.eventLogNextId - 1,
          ...this.ackProtocolFields(this.hasSession(deviceId))
        }
      });
    }

    this.notifyStatusChanged();
    return this.getStatus();
  }

  /**
   * Права устройства на отдельные проекты (TASK-180): переопределения по проектам и право для остальных и новых.
   * Пусто — снова права устройства на все проекты. Применяется сразу: подключённое устройство получает
   * `overview:changed` и перечитывает сводку. Смена пишется в журнал действий.
   */
  public setDeviceProjectRights(deviceId: string, raw: unknown, actor: 'window' | 'cli' = 'window'): RemoteControlStatus {
    const record = this.deviceTokens.get(deviceId);
    if (!record) throw new AppError('remote.deviceNotFound');
    const rights = sanitizeProjectRights(raw);
    if (rights) record.projectRights = rights;
    else delete record.projectRights;
    this.persistDeviceTokens().catch(() => {});
    void appendRemoteAudit({
      ts: Date.now(),
      method: 'set_device_project_rights',
      ok: true,
      deviceId,
      deviceName: record.deviceName,
      ...(record.memberId ? { memberId: record.memberId } : {}),
      actor,
      target: projectRightsSummary(rights)
    });
    if (this.connectedDevices.has(deviceId)) {
      this.sendToDevice(deviceId, { type: 'event', event: 'overview:changed', data: { at: Date.now() } });
      this.sendToDevice(deviceId, { type: 'event', event: 'projects:changed', data: {} });
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
      connected: this.connectedDevices.has(deviceId),
      ...(record.delegatedBy ? { delegatedBy: record.delegatedBy } : {}),
      ...(record.introducedBy ? { introducedBy: record.introducedBy } : {}),
      ...(record.confirmKey ? { biometricConfirm: true } : {}),
      ...(record.push ? { push: record.push.kind } : {}),
      ...(record.memberId ? { memberId: record.memberId } : {}),
      ...(record.projectRights ? { projectRights: record.projectRights } : {})
    }));
  }

  /** Открытый ключ сессий хоста (ECDSA P-256, несжатая точка) в base64url для QR и `server_hello`; пустой до загрузки. */
  public getHostKey(): string {
    return this.sessionKeyRaw ? bytesToBase64Url(this.sessionKeyRaw) : '';
  }

  /**
   * Поля `handshake_ack` про протокол (decision-111): согласованная версия сессии, версии хоста и его ключ. Клиент
   * v1, увидев здесь v2 и ключ, закрепляет ключ и следующее подключение делает по v2.
   */
  private ackProtocolFields(v2: boolean): { sessionProtocol: number; protocols: number[]; hostKey?: string } {
    const hostKey = this.getHostKey();
    return {
      sessionProtocol: v2 ? SESSION_PROTOCOL_V2 : SESSION_PROTOCOL_V1,
      protocols: this.sessionV2Only ? [SESSION_PROTOCOL_V2] : [...HOST_SESSION_PROTOCOLS],
      ...(hostKey ? { hostKey } : {})
    };
  }

  private sessionOf(deviceId: string, transport: ClientTransport): NodeSessionV2 | undefined {
    return transport === 'local' ? this.localClients.get(deviceId)?.session : this.relaySessions.get(deviceId);
  }

  private hasSession(deviceId: string): boolean {
    return Boolean(this.localClients.get(deviceId)?.session || this.relaySessions.get(deviceId));
  }

  /** Пакет в протоколе клиента: v2 — ключом его сессии, v1 — общим ключом, иначе открытым текстом. */
  private sealForClient(session: NodeSessionV2 | undefined, v1Encrypted: boolean, payload: PlainPacket): RemotePacket | SessionFrameV2 {
    if (session) return session.seal(payload);
    return v1Encrypted ? encryptPayload(payload, this.secretKey) : payload;
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
        delete data.version;
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
        if (typeof data.pushGatewayUrl === 'string') this.pushGatewayUrl = data.pushGatewayUrl;
        if (typeof data.sessionV2Only === 'boolean') this.sessionV2Only = data.sessionV2Only;
        if (typeof data.keepAwake === 'boolean') this.keepAwake = data.keepAwake;
      }
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to load config: ${errorMessage(err)}`);
    }
  }

  private saveConfig() {
    try {
      const cfgPath = this.getConfigFilePath();
      // secretKey/pairingPin/telegramBotToken НЕ пишутся сюда (decision-5 п.4) — только через
      // secretStorageService (loadPersistedSecrets/updateConfig).
      const data = {
        version: REMOTE_CONTROL_CONFIG_VERSION,
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
        telegramMiniAppUrl: this.telegramMiniAppUrl,
        pushGatewayUrl: this.pushGatewayUrl,
        sessionV2Only: this.sessionV2Only,
        keepAwake: this.keepAwake
      };
      writeFileSync(cfgPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to save config: ${errorMessage(err)}`);
    }
  }

  /**
   * Подписка на шину событий (TASK-57): запросы и решения HITL уходят доверенным устройствам как
   * `ai:hitl` / `ai:hitlDecided`, события агентов — как `agent:*`. Без диффов и содержимого файлов.
   */
  private subscribeToEventBus(): void {
    if (this.busUnsubscribe) return;
    this.busUnsubscribe = appEventBus.subscribe((event) => {
      // Журнал ленты ведётся и при выключенном Remote Control: телефон увидит итоги, когда подключится.
      this.inbox.handleBus(event);
      if (event.type === 'hitl:requested' || event.type === 'hitl:decided' || event.type === 'hitl:expired' || event.type === 'hitl:cancelled') {
        this.trackSwarmHitl(event.request.sessionId, event.request.id, event.type === 'hitl:requested');
      }
      if (event.type.startsWith('hitl:') || event.type.startsWith('agent:') || event.type === 'swarm:finished') this.refreshKeepAwake();
      if (event.type.startsWith('hitl:') || event.type.startsWith('agent:') || event.type === 'swarm:finished' || event.type === 'process:crashed') {
        this.overview.markChanged();
      }
      if (!this.enabled) return;
      if (event.type === 'hitl:requested') {
        const r = event.request;
        // Запрос агента участника — его устройствам (TASK-142.3); старшим ролям — после таймаута эскалации.
        this.broadcastEvent('ai:hitl', this.hitlEventPayload(r), { audience: (d) => this.hitlVisibleTo(r, d, r.createdAt) });
        void this.pushService.onHitlRequested(r, (target) => this.hitlVisibleToRecord(r, target.deviceId, r.createdAt)).catch(() => undefined);
        this.armHitlEscalation(r);
      } else if (event.type === 'hitl:decided' || event.type === 'hitl:expired' || event.type === 'hitl:cancelled') {
        this.clearHitlEscalation(event.request.id);
        void this.pushService.onHitlFinished(event.request.id).catch(() => undefined);
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

  /** Что уже объявлено в шину о текущем соединении устройства: доступ или ожидание одобрения (TASK-173). */
  private readonly announcedDevices = new Map<string, 'pending' | 'approved'>();

  /**
   * Устройство прошло проверку PIN/ключа/токена (TASK-173): в шину — подключение или запрос одобрения, по разу на
   * состояние соединения. Открытый сокет без рукопожатия не объявляется: его может открыть кто угодно в сети.
   */
  private announceDevice(device: RemoteDevice): void {
    const state = device.isApproved ? 'approved' : 'pending';
    const previous = this.announcedDevices.get(device.id);
    if (previous === state) return;
    this.announcedDevices.set(device.id, state);
    if (state === 'pending') {
      appEventBus.publish({
        type: 'remote:deviceApprovalRequested',
        deviceId: device.id,
        deviceName: device.name,
        mode: device.mode,
        hostId: this.hostId,
        at: Date.now()
      });
      return;
    }
    if (previous === 'pending') this.publishApprovalResolved(device.id, 'approved');
    this.publishDeviceConnected(device);
  }

  /** Соединение устройства закрыто: ожидавший одобрения запрос снимается с уведомлений. */
  private forgetDevice(deviceId: string, outcome: 'rejected' | 'disconnected'): void {
    const previous = this.announcedDevices.get(deviceId);
    this.announcedDevices.delete(deviceId);
    if (previous === 'pending') this.publishApprovalResolved(deviceId, outcome);
  }

  /** Все соединения закрыты разом: обработчики `close` этого уже не увидят, клиенты сняты раньше. */
  private forgetAllDevices(outcome: 'rejected' | 'disconnected'): void {
    for (const id of [...this.announcedDevices.keys()]) this.forgetDevice(id, outcome);
  }

  private publishApprovalResolved(deviceId: string, outcome: 'approved' | 'rejected' | 'disconnected'): void {
    appEventBus.publish({ type: 'remote:deviceApprovalResolved', deviceId, outcome, hostId: this.hostId, at: Date.now() });
  }

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
    await this.inbox.init();
    setAgentNotifier((ctx, args) => this.notifyFromAgent(ctx, args));
    if (!this.progressSubscribed) {
      this.progressSubscribed = true;
      agentFleetService.on('swarmEvent', (event: { session?: SwarmSession }) => this.pushProgress(event.session));
    }
    this.subscribeOverview();
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
      } catch (err) {
        logger.warn(`[RemoteControl] Failed to auto-start service: ${errorMessage(err)}`);
      }
    }
  }

  public setActiveProject(projectPath: string | null) {
    this.activeProjectPath = projectPath;
  }

  /**
   * Источники изменения сводки флота (decision-129 п. 6): терминалы по хукам, поток Studio, процессы, состояния роев.
   * HITL и агенты приходят через шину в `subscribeToEventBus`. Событие уходит устройствам и окну с дебаунсом.
   */
  private subscribeOverview(): void {
    if (this.overviewSubscribed) return;
    this.overviewSubscribed = true;
    terminalSessionTracker.onChange(() => this.overview.markChanged());
    studioRemoteBridge.onEvent((event) => {
      if (event === 'studio:started' || event === 'studio:complete' || event === 'studio:error') this.overview.markChanged();
    });
    processManager.onStatusChanged(() => this.overview.markChanged());
    agentFleetService.on('swarmEvent', (event: { session?: SwarmSession }) => {
      const s = event.session;
      if (!s) return;
      const key = `${s.status}|${s.agents.map((a) => a.status).join(',')}`;
      if (this.swarmOverviewKeys.get(s.id) === key) return;
      this.swarmOverviewKeys.set(s.id, key);
      if (this.swarmOverviewKeys.size > 500) this.swarmOverviewKeys.delete(this.swarmOverviewKeys.keys().next().value as string);
      this.overview.markChanged();
    });
    this.overview.onChanged(() => {
      if (this.enabled) this.broadcastEvent('overview:changed', { at: Date.now() }, { transient: true });
      this.notifyRenderer('overview:changed', { at: Date.now() });
    });
  }

  /** Сводка этого ПК для окна ProjectHub: человек за ПК может всё (decision-129 п. 10). */
  public getLocalOverview(): Promise<RemoteOverview> {
    return this.overview.getOverview('full');
  }

  /** Проект устройства: свой выбор, иначе проект окна. */
  private deviceProject(deviceId: string): string | null {
    return this.deviceProjects.get(deviceId) ?? this.activeProjectPath;
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
      hostKey: this.getHostKey(),
      hostKeyFingerprint: this.sessionKeyRaw ? hostKeyFingerprintNode(this.sessionKeyRaw) : '',
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
      federationError: this.federationProtocolError?.message ?? null,
      ...(this.federationProtocolError ? { federationErrorKey: this.federationProtocolError.appErrorKey } : {}),
      localAddresses: localIps,
      secretToken: this.secretKey,
      useRelay: this.mode === 'relay' || Boolean(this.relayServerUrl),
      telegramBotToken: this.telegramBotToken,
      telegramChatId: this.telegramChatId,
      telegramBotUsername: this.telegramBotUsername,
      telegramMiniAppUrl: this.telegramMiniAppUrl || (this.tunnelUrl ? `${this.tunnelUrl}/telegram` : ''),
      endpoints: this.getPhoneEndpoints(),
      pushGatewayUrl: this.pushGatewayUrl,
      sessionV2Only: this.sessionV2Only,
      keepAwake: this.keepAwake,
      keepAwakeActive: this.keepAwakeController.active
    };
  }

  // ── «Входящие» и запрет сна (TASK-140.5, decision-117) ──

  /** Сообщение агента `projecthub_notify` из встроенного MCP или tool-loop API-агента. */
  public async notifyFromAgent(ctx: NoteContext, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    // Агент Swarm работает в worktree: в ленте нужен проект, к которому он относится.
    let projectPath = ctx.projectPath;
    if (projectPath) {
      const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
      const own = (await projectRegistry.getProjects().catch(() => [])).find((p) => {
        const rel = path.relative(norm(p.path), norm(projectPath!));
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      const swarm = !own && ctx.sessionId.startsWith('swarm-')
        ? agentFleetService.listSwarms().find((s) => s.agents.some((a) => `swarm-${a.id}` === ctx.sessionId))
        : undefined;
      projectPath = own?.path ?? swarm?.projectPath ?? projectPath;
    }
    return this.inbox.notify({ ...ctx, ...(projectPath ? { projectPath } : {}) }, args);
  }

  /**
   * Видит ли устройство запрос HITL (TASK-142.3, decision-84 п. 5): запрос агента участника — его устройствам, а после
   * таймаута — старшим ролям. Без модуля Team — все одобренные устройства, как раньше.
   */
  private hitlVisibleTo(request: HitlRequest | undefined, device: { id: string; name?: string; memberId?: string; rights?: DeviceRights }, now = Date.now()): boolean {
    if (!request) return false;
    const ref = { id: device.id, ...(device.name ? { name: device.name } : {}), ...(device.memberId ? { memberId: device.memberId } : {}), rights: this.effectiveDeviceRights(device) };
    // Запрос проекта, закрытого устройству, ему не виден (TASK-180).
    if (request.projectPath && this.projectAccessOf(device, request.projectPath) === 'none') return false;
    return editionRegistry.hitlVisible(
      { ...(request.memberId ? { memberId: request.memberId } : {}), createdAt: request.createdAt, ...(request.projectPath ? { projectPath: request.projectPath } : {}) },
      ref,
      now
    );
  }

  /** Видит ли запрос устройство из реестра токенов (push, HTTP API). */
  private hitlVisibleToRecord(request: HitlRequest, deviceId: string, now = Date.now()): boolean {
    const record = this.deviceTokens.get(deviceId);
    if (!record) return false;
    return this.hitlVisibleTo(request, { id: deviceId, name: record.deviceName, ...(record.memberId ? { memberId: record.memberId } : {}), rights: record.rights }, now);
  }

  /** Карточка запроса HITL для телефона и hub-клиента — без диффов и содержимого файлов. */
  private hitlEventPayload(r: HitlRequest) {
    return {
      requestId: r.id,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      origin: r.origin,
      agentName: r.agentName,
      role: r.role,
      tool: r.tool || r.type,
      type: r.type,
      risk: r.risk,
      riskReason: r.riskReason,
      riskReasonKey: r.riskReasonKey,
      description: r.title,
      details: r.details,
      ...(r.textKey ? { textKey: r.textKey } : {}),
      command: r.command,
      filePath: r.filePath,
      expiresAt: r.expiresAt,
      ...(r.memberId ? { memberId: r.memberId } : {})
    };
  }

  /**
   * Эскалация запроса участника (decision-84 п. 5): не ответил за таймаут — запрос получают старшие роли. Уходит только
   * тем устройствам, которые не видели его раньше.
   */
  private armHitlEscalation(r: HitlRequest): void {
    const at = editionRegistry.hitlEscalateAt({ ...(r.memberId ? { memberId: r.memberId } : {}), createdAt: r.createdAt });
    if (at === undefined || (r.expiresAt !== undefined && at >= r.expiresAt)) return;
    const timer = setTimeout(() => {
      this.hitlEscalations.delete(r.id);
      const pending = hitlService.getPending(r.id);
      if (!pending || !this.enabled) return;
      const now = Date.now();
      const isNew = (visibleNow: boolean, visibleBefore: boolean) => visibleNow && !visibleBefore;
      this.broadcastEvent('ai:hitl', { ...this.hitlEventPayload(pending), escalated: true }, {
        audience: (d) => isNew(this.hitlVisibleTo(pending, d, now), this.hitlVisibleTo(pending, d, pending.createdAt))
      });
      void this.pushService
        .onHitlRequested(pending, (target) => isNew(this.hitlVisibleToRecord(pending, target.deviceId, now), this.hitlVisibleToRecord(pending, target.deviceId, pending.createdAt)))
        .catch(() => undefined);
      logger.info(`[RemoteControl] HITL ${r.id} участника ${r.memberId ?? 'owner'} передан старшим ролям по таймауту`);
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.hitlEscalations.set(r.id, timer);
  }

  /** Событие и push только адресатам (модули ee/, TASK-142.4). Права устройства — после сужения ролью. */
  public notifyDevices(notice: DeviceNotice, audience: (device: RemoteDeviceRef) => boolean): void {
    const refOf = (d: { id: string; name?: string; memberId?: string; rights?: DeviceRights }): RemoteDeviceRef => ({
      id: d.id,
      ...(d.name ? { name: d.name } : {}),
      ...(d.memberId ? { memberId: d.memberId } : {}),
      rights: this.effectiveDeviceRights(d)
    });
    this.broadcastEvent(notice.event, notice.payload, { audience: (d) => audience(refOf(d)) });
    if (!notice.text) return;
    // ПК в hub-режиме показывает системное уведомление по общему `host:notice` (decision-138, ограничение «уведомления
    // очереди — только обновлением окна»): он не знает событий модулей редакции, а вид уведомления знает.
    if (notice.kind) {
      this.broadcastEvent(
        'host:notice',
        { id: notice.id, kind: notice.kind, title: notice.title ?? notice.text, text: notice.body ?? notice.text, level: notice.level ?? 'info', ...(notice.projectPath ? { projectPath: notice.projectPath } : {}) },
        { audience: (d) => audience(refOf(d)) }
      );
    }
    void this.pushService
      .onNote({ id: notice.id, text: notice.text, level: notice.level ?? 'info', ...(notice.projectPath ? { projectPath: notice.projectPath } : {}) }, (target) => {
        const record = this.deviceTokens.get(target.deviceId);
        return Boolean(record) && audience(refOf({ id: target.deviceId, name: record!.deviceName, ...(record!.memberId ? { memberId: record!.memberId } : {}), rights: record!.rights }));
      })
      .catch(() => undefined);
  }

  private clearHitlEscalation(requestId: string): void {
    const timer = this.hitlEscalations.get(requestId);
    if (timer) clearTimeout(timer);
    this.hitlEscalations.delete(requestId);
  }

  /**
   * Писать в сессию Studio может только её владелец (decision-84 п. 5). Остановить чужой ответ может и старшая роль.
   * Сессии ещё нет на диске — проверяет окно.
   */
  private async assertStudioWriter(projectPath: string, sessionIdRaw: unknown, device: RemoteDevice, action: 'write' | 'abort' = 'write'): Promise<void> {
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw : '';
    if (!sessionId) return;
    const session = await aiSessionStore.get(projectPath, sessionId).catch(() => null);
    if (!session || canWriteStudioSession(session, device.memberId)) return;
    if (action === 'abort' && !editionRegistry.checkOwnership(session.memberId, device.memberId, 'session')) return;
    throw studioReadOnlyError();
  }

  private pendingApprovals(filter: { projectPath?: string } = {}, device?: RemoteDevice) {
    return hitlService.listPending(filter).filter((r) => !device || this.hitlVisibleTo(r, device)).map((r) => ({
      requestId: r.id,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      origin: r.origin,
      agentName: r.agentName,
      role: r.role,
      tool: r.tool,
      type: r.type,
      risk: r.risk,
      riskReason: r.riskReason,
      riskReasonKey: r.riskReasonKey,
      title: r.title,
      details: r.details,
      ...(r.textKey ? { textKey: r.textKey } : {}),
      command: r.command,
      filePath: r.filePath,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      orphaned: r.orphaned
    }));
  }

  /** Запрос HITL агента роя: рой «ждёт решения» на экране блокировки телефона, пока запрос не решён. */
  private trackSwarmHitl(sessionId: string, requestId: string, waiting: boolean): void {
    if (!sessionId.startsWith('swarm-')) return;
    const agentId = sessionId.slice('swarm-'.length);
    const swarm = agentFleetService.listSwarms().find((s) => s.agents.some((a) => a.id === agentId));
    if (!swarm) return;
    const sessions = new Set(swarm.agents.map((a) => `swarm-${a.id}`));
    if (waiting) this.swarmsWaitingHitl.add(swarm.id);
    else if (!hitlService.listPending({}).some((r) => r.id !== requestId && sessions.has(r.sessionId))) this.swarmsWaitingHitl.delete(swarm.id);
    this.pushProgress(swarm);
  }

  /** Push хода роя устройствам с push (decision-121 п. 1): смена состояния — сразу, остальное — не чаще раза в 20 с. */
  private pushProgress(session: SwarmSession | undefined): void {
    if (!session || !this.enabled || this.pushTargets().length === 0) return;
    const progress = progressFromSession(session, this.swarmsWaitingHitl.has(session.id), hostText(getHostLanguage()).progress);
    if (progress.state !== 'waiting' && progress.state !== 'running') this.swarmsWaitingHitl.delete(session.id);
    if (!this.progressThrottle.shouldSend(progress)) return;
    void this.pushService.onProgress(progress).catch(() => undefined);
  }

  /** Движки голоса грузятся при первом голосовом промпте: ph-agent и хост без голоса их не тянут (decision-121 п. 4). */
  private async transcribePhoneVoice(samples: Float32Array, language: VoiceLanguage): Promise<VoiceResult> {
    const [{ localWhisperService }, { speechPrepService }, { getInstalledAsrModel }, { isLikelyHallucination }] = await Promise.all([
      import('./localWhisperService.js'),
      import('./speechPrepService.js'),
      import('./asrModelStore.js'),
      import('../../src/services/whisperHallucination.js')
    ]);
    return recognizeVoice(samples, language, {
      sherpa: async (s) => {
        const asr = await getInstalledAsrModel('gigaam-v3-ru');
        if (!asr) return null;
        const res = await speechPrepService.recognize({ samples: s, gate: true, denoise: 'off', asr });
        if (!res.ok) return null;
        return res.speech ? { text: res.text ?? '' } : { noSpeech: true };
      },
      whisper: (s, lang) => localWhisperService.transcribe(s, lang, 'ru'),
      isHallucination: (text) => isLikelyHallucination(text)
    });
  }

  private trackPhoneSwarm(swarmId: string): void {
    this.phoneSwarms.add(swarmId);
    this.refreshKeepAwake();
  }

  /**
   * Пересчитать запрет сна: на событиях HITL и агентов, при смене настроек и раз в минуту, пока запрет держится
   * (агент Studio мог закончить без события шины).
   */
  private refreshKeepAwake(): void {
    for (const id of [...this.phoneSwarms]) {
      const status = agentFleetService.getSwarm(id)?.status;
      if (!status || !isActiveSwarmStatus(status)) this.phoneSwarms.delete(id);
    }
    for (const id of [...this.phoneStudioSessions]) if (!studioRemoteBridge.isRunning(id)) this.phoneStudioSessions.delete(id);
    const active = this.keepAwakeController.apply({
      enabled: this.keepAwake,
      remoteEnabled: this.enabled,
      pairedDevices: [...this.deviceTokens.values()].filter((r) => this.isTokenApproved(r)).length,
      pendingHitl: hitlService.pendingCount(),
      phoneAgents: this.phoneSwarms.size + this.phoneStudioSessions.size
    });
    if (active && !this.keepAwakeTimer) {
      this.keepAwakeTimer = setInterval(() => this.refreshKeepAwake(), 60_000);
      this.keepAwakeTimer.unref?.();
    } else if (!active && this.keepAwakeTimer) {
      clearInterval(this.keepAwakeTimer);
      this.keepAwakeTimer = null;
    }
  }

  /** Режим «только v2» включили: устройства на v1 отключаются с понятной ошибкой. */
  private dropV1Sessions(): void {
    for (const [deviceId, device] of this.connectedDevices.entries()) {
      if (device.protocol === SESSION_PROTOCOL_V2) continue;
      const conn = this.localClients.get(deviceId);
      if (conn) {
        try {
          conn.ws.send(JSON.stringify({ type: 'error', error: V2_REQUIRED_ERROR }));
          conn.ws.close(1008, 'v2 required');
        } catch {
          // сокет уже закрыт
        }
      }
    }
  }

  // ── push (TASK-140.3, decision-115) ──

  /** Устройства с включённым push: одобренные, решать могут только с правом hitl/full и не на хосте «только чтение». */
  private pushTargets(): PushTarget[] {
    const out: PushTarget[] = [];
    for (const [deviceId, record] of this.deviceTokens.entries()) {
      if (!record.push || !this.isTokenApproved(record)) continue;
      out.push({ deviceId, registration: record.push, canDecide: !this.readOnly && record.rights !== 'readOnly', ...(record.memberId ? { memberId: record.memberId } : {}) });
    }
    return out;
  }

  /** Адреса для кнопок уведомления: телефон шлёт решение по HTTP туда же, куда ходит сокетом (без релея). */
  private pushHostEndpoints(): PushHostEndpoint[] {
    return this.getPhoneEndpoints()
      .filter((e) => e.kind !== 'relay')
      .map((e) => ({ kind: e.kind, url: e.url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:') }));
  }

  private dropPushRegistration(deviceId: string): void {
    const record = this.deviceTokens.get(deviceId);
    if (!record?.push) return;
    delete record.push;
    this.persistDeviceTokens().catch(() => {});
    logger.info(`[RemoteControl] Push registration of ${deviceId} is gone at the provider — removed`);
  }

  /**
   * Кнопка уведомления (`POST /api/remote/push-action`): решение, подписанное ключом кнопок устройства. Способ
   * `notification`/`unlocked` хост сверяет с классом риска так же, как для решения из приложения (decision-112 п. 3).
   */
  private async handlePushAction(body: unknown): Promise<{ status: number; result: Record<string, unknown> }> {
    const action = parsePushAction(body);
    if (!action) return { status: 400, result: { ok: false, reason: 'bad_request' } };
    const record = this.deviceTokens.get(action.deviceId);
    if (!record?.push || !this.isTokenApproved(record) || !verifyPushAction(record.push.actionKey, this.hostId, action, Date.now())) {
      return { status: 403, result: { ok: false, reason: 'forbidden' } };
    }
    const pushRights = this.effectiveDeviceRights({ id: action.deviceId, name: record.deviceName, ...(record.memberId ? { memberId: record.memberId } : {}), rights: record.rights });
    if (this.readOnly || pushRights === 'readOnly') return { status: 403, result: { ok: false, reason: 'read_only' } };
    const pending = hitlService.getPending(action.requestId);
    if (pending && !this.hitlVisibleToRecord(pending, action.deviceId)) return { status: 404, result: { ok: false, reason: 'not_found' } };
    const result = hitlService.decide(
      action.requestId,
      { approved: action.decision === 'allow' },
      { kind: 'remote', deviceId: action.deviceId, deviceName: record.deviceName, ...(record.memberId ? { memberId: record.memberId } : {}), confirm: action.confirm }
    );
    if (!result.ok) return { status: 409, result: hitlRefusal(result) };
    this.notifyRenderer('remote:hitlDecisionMade', {
      requestId: action.requestId,
      sessionId: result.request.sessionId,
      approved: action.decision === 'allow',
      byDevice: record.deviceName
    });
    return { status: 200, result: { ok: true } };
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
      const data = (await res.json()) as { ok?: unknown } | null;
      return Boolean(data?.ok);
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to send Telegram notification: ${errorMessage(err)}`);
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
    if (patch.sessionV2Only !== undefined) {
      this.sessionV2Only = patch.sessionV2Only;
      // Уже открытые сессии v1 закрываются сразу: режим действует не со следующего подключения, а сейчас.
      if (this.sessionV2Only) this.dropV1Sessions();
    }
    if (patch.keepAwake !== undefined) {
      this.keepAwake = patch.keepAwake;
      this.refreshKeepAwake();
    }
    if (patch.pushGatewayUrl !== undefined) {
      const url = patch.pushGatewayUrl.trim();
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new AppError('remote.pushGatewayUrlInvalid');
      this.pushGatewayUrl = url;
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
    this.forgetAllDevices('rejected');
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
    for (const id of this.revokeDeviceToken(deviceId)) {
      if (id === deviceId) continue;
      // Делегированное устройство на связи — рвём и его сессию.
      const delegated = this.localClients.get(id);
      if (delegated) {
        try {
          delegated.ws.close(1000, 'Disconnected by host');
        } catch {
          // уже закрыт
        }
        this.localClients.delete(id);
      }
      this.relaySessions.delete(id);
      this.connectedDevices.delete(id);
      this.forgetDevice(id, 'rejected');
    }
    this.forgetDevice(deviceId, 'rejected');
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
      this.announceDevice(dev);
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
          lastEventId: this.eventLogNextId - 1,
          ...this.ackProtocolFields(this.hasSession(deviceId))
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
      const data = (await res.json()) as { ok?: unknown; description?: string } | null;
      if (data?.ok) {
        logger.info(`[RemoteControl] Telegram Menu Button registered successfully with URL: ${webAppUrl}`);
        return true;
      } else {
        logger.warn(`[RemoteControl] Telegram setChatMenuButton error: ${data?.description || 'unknown'}`);
        return false;
      }
    } catch (err) {
      logger.warn(`[RemoteControl] Failed to set Telegram Menu Button: ${errorMessage(err)}`);
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
              this.tunnelError = 'Cloudflare tunnel connection timed out (30 s)';
              this.notifyStatusChanged();
            }
            resolve(this.tunnelUrl);
          }
        }, 30000);
      } catch (err) {
        this.tunnelStatus = 'error';
        this.tunnelError = errorMessage(err);
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
      // Ключ сессий нужен QR и рукопожатию v2 с первого подключения (decision-111).
      await this.ensureSessionKey().catch((err) => logger.warn(`[RemoteControl] Session key unavailable: ${err instanceof Error ? err.message : String(err)}`));
      await this.refreshLocalProjects();
      await this.refreshProjectRoots();
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
          logger.warn(`[RemoteControl] Tunnel background startup failed: ${errorMessage(err)}`);
        });
      }

      this.refreshKeepAwake();
      logger.info(`[RemoteControl] Service started on port ${this.port} (mode: ${this.mode})`);
    } catch (err) {
      this.lastError = errorMessage(err);
      logger.error(`[RemoteControl] Failed to start: ${this.lastError}`);
      await this.stop();
      throw err;
    }
  }

  public async stop(): Promise<void> {
    this.enabled = false;
    this.refreshKeepAwake();
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
    this.forgetAllDevices('disconnected');

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

      server.on('error', (err: Error) => {
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
    return this.apiPrincipal(req, url) !== null;
  }

  /**
   * Кто вызвал HTTP API: ключ хоста (бот Telegram, сам хост) или токен устройства — с его правами после сужения ролью
   * участника (decision-126). `null` — токена нет или он неизвестен.
   */
  private apiPrincipal(req: IncomingMessage, url: URL): { kind: 'master' } | { kind: 'device'; deviceId: string; record: DeviceTokenRecord; rights: DeviceRights } | null {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const presented = bearer || url.searchParams.get('token') || '';
    if (!presented) return null;
    if (this.constantTimeEqual(presented, this.secretKey)) return { kind: 'master' };
    for (const [deviceId, record] of this.deviceTokens.entries()) {
      if (this.constantTimeEqual(presented, record.token)) {
        const rights = this.effectiveDeviceRights({ id: deviceId, name: record.deviceName, ...(record.memberId ? { memberId: record.memberId } : {}), rights: record.rights });
        return { kind: 'device', deviceId, record, rights };
      }
    }
    return null;
  }

  /** Решение человека по HTTP (HITL, задачи агента): ключ хоста или устройство с правами не ниже `hitl`. */
  private apiCanDecide(principal: ReturnType<RemoteControlService['apiPrincipal']>): boolean {
    if (!principal) return false;
    if (principal.kind === 'master') return true;
    return !this.readOnly && principal.rights !== 'readOnly';
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

    // Кнопка push-уведомления (TASK-140.3): решение подписано ключом кнопок устройства, без сокета и сессии.
    if (url.pathname === '/api/remote/push-action' && req.method === 'POST') {
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          // ниже — 400
        }
        void this.handlePushAction(parsed).then(({ status, result }) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      });
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
                    `Federation protocol version of host "${peer.machineName || peer.hostId}" (${peer.protocolVersion ?? 1}) `
                    + `is incompatible with the local one (${REMOTE_FEDERATION_PROTOCOL_VERSION}). Update ProjectHub on both machines.`,
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
        // Без диффов и содержимого файлов — наружу уходит только то, что нужно для решения. Устройству участника —
        // только адресованные ему запросы (TASK-142.3).
        const listPrincipal = this.apiPrincipal(req, url);
        // `lang` — заголовок на языке читателя по коду запроса (бот Telegram, decision-164); без него — запасной `title`.
        const lang = url.searchParams.get('lang');
        const pending = hitlService
          .listPending()
          .filter((r) => listPrincipal?.kind !== 'device' || this.hitlVisibleToRecord(r, listPrincipal.deviceId))
          .map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          projectPath: r.projectPath,
          type: r.type,
          title: hitlTitleIn(r, lang),
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
            const principal = this.apiPrincipal(req, url);
            if (!this.apiCanDecide(principal)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, reason: 'read_only' }));
              return;
            }
            const byDevice = principal?.kind === 'device' ? principal : null;
            // Устройство решает только видимый ему запрос: свой участник и открытый ему проект (TASK-180).
            const target = hitlService.getPending(payload.requestId);
            if (byDevice && target && !this.hitlVisibleToRecord(target, byDevice.deviceId)) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, reason: 'not_found' }));
              return;
            }
            const result = hitlService.decide(
              payload.requestId,
              { approved: Boolean(payload.approved), text: typeof payload.comment === 'string' ? payload.comment : undefined },
              // Кнопка в мессенджере: телефон разблокирован, но присутствие владельца не доказано — до `moderate`.
              {
                kind: 'remote',
                deviceName: byDevice ? byDevice.record.deviceName : typeof payload.deviceName === 'string' ? payload.deviceName : 'Telegram',
                ...(byDevice ? { deviceId: byDevice.deviceId } : {}),
                ...(byDevice?.record.memberId ? { memberId: byDevice.record.memberId } : {}),
                confirm: 'chat'
              }
            );
            res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify(
                result.ok ? { ok: true, requestId: payload.requestId } : hitlRefusal(result)
              )
            );
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

    // Подтверждение задач агента кнопкой Telegram (TASK-155, decision-89 п. 11): по билету из уведомления,
    // тем же путём, что окно и телефон. Токен обязателен, как и для HITL.
    if (url.pathname === '/api/agent-tasks/approve' && req.method === 'POST') {
      const principal = this.apiPrincipal(req, url);
      if (!principal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (!this.apiCanDecide(principal)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'read_only' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16 * 1024) req.destroy();
      });
      req.on('end', () => {
        void (async () => {
          try {
            const payload = JSON.parse(body || '{}') as { ticket?: unknown; deviceName?: unknown };
            const result = await agentTaskApproval.approveTicket(payload.ticket, {
              kind: 'remote',
              deviceName: typeof payload.deviceName === 'string' && payload.deviceName ? payload.deviceName.slice(0, 120) : 'Telegram'
            });
            if (result.ok && result.approved.length > 0) this.broadcastEvent('backlog:changed', { projectPath: result.projectPath });
            res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.ok ? { ok: true, approved: result.approved, notPending: result.notPending } : result));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          }
        })();
      });
      return;
    }

    // Маршруты модулей редакции (TASK-228: `/sso/` — вход участника через IdP компании). Без токена: проверку
    // делает сам модуль.
    const editionRoute = editionRegistry.httpRoute(url.pathname);
    if (editionRoute) {
      try {
        await editionRoute(req, res, url);
      } catch (err) {
        logger.warn(`[RemoteControl] Edition HTTP route ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Error' }));
        }
      }
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
      res.end(mobileClientMissingHtml(req.headers['accept-language']));
      return;
    }

    if (route.kind === 'page') {
      try {
        const html = await fs.readFile(path.join(root, route.file), 'utf8');
        res.writeHead(200, pageHeaders(route.target));
        res.end(req.method === 'HEAD' ? undefined : injectHostDefaults(html, { hostId: this.hostId, relayUrl: this.relayServerUrl, mode: this.mode }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(mobileClientMissingHtml(req.headers['accept-language']));
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

      // Ключ в URL — путь v1 (старые клиенты и hub прежних сборок): в режиме «только v2» не принимается.
      if (this.sessionV2Only) {
        ws.send(JSON.stringify({ type: 'error', error: V2_REQUIRED_ERROR }));
        ws.close(1008, 'v2 required');
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
        rights: this.effectiveDeviceRights({ id: deviceId, name: deviceName, ...(existingRecord?.memberId ? { memberId: existingRecord.memberId } : {}), rights }),
        // Ключ в URL — прежний путь v1 (старые клиенты и hub-режим).
        protocol: SESSION_PROTOCOL_V1,
        ...(existingRecord?.memberId ? { memberId: existingRecord.memberId } : {})
      };

      const clientConn: ClientConnection = {
        id: deviceId,
        ws,
        device,
        isEncrypted: isKeyValid
      };

      this.connectedDevices.set(deviceId, device);
      this.localClients.set(deviceId, clientConn);
      // Новое соединение объявляется заново: прежнее могло закрыться без события.
      this.announcedDevices.delete(deviceId);
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
            ...(issuedToken ? { deviceToken: issuedToken } : {}),
            ...this.ackProtocolFields(false)
          }
        })
      );

      // Уведомление в десктоп. Путь v1 проверил PIN/ключ/токен ещё до апгрейда сокета.
      this.notifyRenderer('remote:deviceConnected', device);
      this.announceDevice(device);

      ws.on('message', async (raw: WebSocket.RawData) => {
        device.lastSeenAt = Date.now();
        await this.handleIncomingClientMessage(
          deviceId,
          raw,
          (resp) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(typeof resp === 'string' ? resp : JSON.stringify(resp));
            }
          },
          `ip:${ip}`,
          'local'
        );
      });

      ws.on('close', () => {
        this.localClients.delete(deviceId);
        this.connectedDevices.delete(deviceId);
        this.forgetDevice(deviceId, 'disconnected');
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
    // В шину — только после `handshake`: до него устройство ничего не доказало (TASK-173).
    this.announcedDevices.delete(deviceId);
    this.notifyStatusChanged();
    this.notifyRenderer('remote:deviceConnected', device);

    ws.on('message', async (raw: WebSocket.RawData) => {
      device.lastSeenAt = Date.now();
      await this.handleIncomingClientMessage(
        deviceId,
        raw,
        (resp) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(typeof resp === 'string' ? resp : JSON.stringify(resp));
        },
        `ip:${ip}`,
        'local'
      );
    });

    ws.on('close', () => {
      // Сокет мог быть уже вытеснен новым подключением того же устройства — его запись не трогаем.
      if (this.localClients.get(deviceId)?.ws !== ws) return;
      this.localClients.delete(deviceId);
      this.connectedDevices.delete(deviceId);
      this.forgetDevice(deviceId, 'disconnected');
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
      // Каталог организации (TASK-226): запись членства, подписанная хостом команды; релей проверит её нашим ключом.
      const team = editionRegistry.relayTeamCredential();
      if (team) relayUrl.searchParams.set('team', team);
      this.relayTeamCredentialSent = team ?? '';

      const ws = new WebSocket(relayUrl.toString());
      this.relayWs = ws;

      ws.on('open', () => {
        logger.info(`[RemoteControl] Relay TCP connected, awaiting auth challenge: ${this.relayServerUrl}`);
      });

      ws.on('message', async (raw: WebSocket.RawData) => {
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
              this.federationProtocolError = new AppError('federation.relayProtocolMismatch', {
                relay: relayProtocol,
                local: REMOTE_FEDERATION_PROTOCOL_VERSION
              });
              logger.warn(`[RemoteControl] ${this.federationProtocolError.message}`);
            } else {
              this.federationProtocolError = null;
            }

            if (msg.team && typeof msg.team === 'object') {
              editionRegistry.emitRelayTeamStatus({ accepted: msg.team.accepted === true, ...(typeof msg.team.teamId === 'string' ? { teamId: msg.team.teamId } : {}), ...(typeof msg.team.reason === 'string' ? { reason: msg.team.reason } : {}), at: Date.now() });
            } else if (this.relayTeamCredentialSent) {
              // Релей без поддержки организаций молча игнорирует запись — это тоже «не принято».
              editionRegistry.emitRelayTeamStatus({ accepted: false, reason: 'relay_unsupported', at: Date.now() });
            }
            this.sendRelayTeamRevocations(ws);
            this.startFederationHeartbeat();
            this.notifyStatusChanged();
            return;
          }

          // Членство в организации изменилось на релее: хост отозван или запись истекла (TASK-226).
          if (msg.type === 'team_status') {
            editionRegistry.emitRelayTeamStatus({ accepted: msg.accepted === true, ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}), at: Date.now() });
            return;
          }
          if (msg.type === 'team_revocations_ack') {
            if (msg.ok !== true && msg.reason !== 'stale') logger.warn(`[RemoteControl] Relay rejected team revocations: ${String(msg.reason)}`);
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
            // Новый сокет клиента — прежняя сессия v2 ему не принадлежит.
            this.relaySessions.delete(msg.clientId);
            // В шину — только после `handshake` (TASK-173).
            this.announcedDevices.delete(msg.clientId);
            this.notifyStatusChanged();
            this.notifyRenderer('remote:deviceConnected', dev);
            return;
          }

          if (msg.type === 'client_disconnected') {
            this.relaySessions.delete(msg.clientId);
            this.connectedDevices.delete(msg.clientId);
            this.forgetDevice(msg.clientId, 'disconnected');
            this.notifyStatusChanged();
            this.notifyRenderer('remote:deviceDisconnected', { deviceId: msg.clientId });
            return;
          }

          // Входящее сообщение от клиента через релей
          const fromClientId = msg.fromClientId;
          if (fromClientId) {
            await this.handleIncomingClientMessage(
              fromClientId,
              raw,
              (resp) => {
                if (ws.readyState === WebSocket.OPEN) {
                  const packet = typeof resp === 'string' ? JSON.parse(resp) : resp;
                  packet.targetClientId = fromClientId;
                  ws.send(JSON.stringify(packet));
                }
              },
              `relay:${fromClientId}`,
              'relay'
            );
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
    } catch (err) {
      logger.error(`[RemoteControl] Failed to connect to relay: ${errorMessage(err)}`);
      this.scheduleRelayReconnect();
    }
  }

  /** Список отзыва организации — релею, если этот хост — хост команды (TASK-226). */
  private sendRelayTeamRevocations(ws: WebSocket): void {
    const envelope = editionRegistry.relayTeamRevocations();
    if (!envelope || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'team_revocations', envelope }));
  }

  /**
   * Запись организации или список отзыва изменились (TASK-226): новая запись — переподключение к релею (она идёт в
   * регистрации), новый список — отправка по открытому сокету.
   */
  public refreshRelayTeam(): void {
    if (!this.enabled || !(this.mode === 'relay' || this.relayServerUrl)) return;
    const credential = editionRegistry.relayTeamCredential() ?? '';
    if (credential !== this.relayTeamCredentialSent || !this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) {
      void this.connectToRelay();
      return;
    }
    this.sendRelayTeamRevocations(this.relayWs);
  }

  /** Ed25519-ключ хоста для модулей редакции: подпись записей организации (TASK-226). */
  public async hostIdentity(): Promise<{ hostId: string; machineName: string; publicKeyPem: string; sign(data: string): Promise<string> }> {
    const { privateKeyPem, publicKeyPem } = await this.ensureIdentity();
    return {
      hostId: this.hostId,
      machineName: this.machineName || os.hostname(),
      publicKeyPem,
      sign: async (data: string) => crypto.sign(null, Buffer.from(data, 'utf8'), privateKeyPem).toString('base64url')
    };
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
        // Хост организации пропал из каталога — отозван или вышел (TASK-226): его адреса и проекты не держим.
        if (host.team) this.knownFederationHosts.delete(hostId);
        else this.knownFederationHosts.set(hostId, { ...host, isOnline: false });
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
    this.relaySessions.clear();
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

  /**
   * `client_hello` протокола v2 (decision-111): эфемерный X25519 хоста, подпись транскрипта ключом identity и новая
   * сессия соединения. Новое рукопожатие начинает сессию заново — устройство снова проходит `handshake`.
   */
  private async acceptClientHello(deviceId: string, hello: unknown, reply: (resp: unknown) => void, transport: ClientTransport): Promise<void> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      reply({ type: 'error', error: 'Device not approved by host' });
      return;
    }
    try {
      const { privateKeyPem, hostKeyRaw } = await this.ensureSessionKey();
      const { serverHello, session } = respondToClientHello(hello, deviceId, { hostId: this.hostId, privateKeyPem, hostKeyRaw });
      device.isApproved = false;
      device.protocol = SESSION_PROTOCOL_V2;
      if (transport === 'local') {
        const conn = this.localClients.get(deviceId);
        if (!conn) throw new Error('no connection');
        conn.session = session;
      } else {
        this.relaySessions.set(deviceId, session);
      }
      reply(serverHello);
    } catch (err) {
      logger.warn(`[RemoteControl] v2 client_hello rejected for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      reply({ type: 'error', error: 'Malformed or decrypt failure' });
    }
  }

  /**
   * Обработка сообщения от клиента (распаковка E2EE при наличии и диспетчеризация RPC).
   */
  private async handleIncomingClientMessage(
    deviceId: string,
    raw: unknown,
    reply: (resp: unknown) => void,
    /** Ключ лимита подбора PIN: адрес клиента для прямых подключений; через релей адреса нет. */
    pinRateKey = `relay:${deviceId}`,
    transport: ClientTransport = 'relay'
  ): Promise<void> {
    let packet: PlainPacket;
    let isEncrypted = false;
    let session: NodeSessionV2 | undefined;

    try {
      // Сокет (и кадр релея) отдаёт Buffer: текст пакета — toString в utf8, как раньше.
      const parsed = JSON.parse(String(raw));
      if (parsed?.type === 'client_hello') {
        await this.acceptClientHello(deviceId, parsed, reply, transport);
        return;
      }
      if (isSessionFrameV2(parsed)) {
        session = this.sessionOf(deviceId, transport);
        if (!session) {
          reply({ type: 'error', error: 'No v2 session: send client_hello first' });
          return;
        }
        packet = session.open(parsed) as PlainPacket;
        isEncrypted = true;
      } else if (this.sessionOf(deviceId, transport)) {
        // Сокет уже договорился о v2: пакет v1 на нём — попытка понизить версию, а не старый клиент.
        reply({ type: 'error', error: 'Protocol downgrade rejected' });
        return;
      } else if (this.sessionV2Only) {
        // Режим «только v2» (decision-116): пакет общим ключом или открытым текстом не принимается.
        reply({ type: 'error', error: V2_REQUIRED_ERROR });
        return;
      } else if ('e2ee' in parsed && parsed.e2ee) {
        isEncrypted = true;
        packet = decryptPayload(parsed as EncryptedPacket, this.secretKey);
      } else {
        packet = parsed as PlainPacket;
      }
    } catch (err) {
      if (err instanceof HandshakeError && err.code === 'replay') {
        // Повтор пакета v2 молча отбрасываем: настоящий клиент его не шлёт, отвечать посреднику незачем.
        logger.warn(`[RemoteControl] Replayed v2 packet from ${deviceId} dropped`);
        return;
      }
      reply({ type: 'error', error: 'Malformed or decrypt failure' });
      return;
    }

    // Ответ в протоколе запроса: v2 — ключом сессии, v1 — общим ключом, открытый — открытым текстом.
    const seal = (payload: PlainPacket) => this.sealForClient(session, isEncrypted, payload);

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
      const data = (packet.data || {}) as { pin?: string; key?: string; token?: string; name?: string; confirmKey?: string };
      const rateKey = pinRateKey;
      const existingRecord = data.token ? this.validateDeviceToken(deviceId, data.token) : null;
      // Имя устройства едет внутри шифра: через туннель и релей посредник его не видит (TASK-140.9).
      if (typeof data.name === 'string' && data.name.trim()) device.name = data.name.trim().slice(0, 80);
      // Адреса хоста — только в зашифрованном ответе: открытым текстом через посредника они не идут.
      const endpointsInfo = isEncrypted ? this.endpointsAnnouncement() : {};
      const protocolInfo = this.ackProtocolFields(Boolean(session));
      if (!session) device.protocol = SESSION_PROTOCOL_V1;

      if (existingRecord) {
        // Переподключение одобренного устройства не ждёт нового одобрения — и через релей тоже: раньше
        // через релей каждое переподключение снова ждало кнопки на ПК.
        device.isApproved = device.isApproved || this.isTokenApproved(existingRecord);
        if (existingRecord.memberId) device.memberId = existingRecord.memberId;
        device.rights = this.effectiveDeviceRights({ ...device, rights: existingRecord.rights });
        if (existingRecord.delegatedBy) device.name = existingRecord.deviceName;
        reply(
          seal({
            type: 'handshake_ack',
            result: {
              approved: device.isApproved,
              readOnly: this.readOnly,
              hostId: this.hostId,
              protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
              rights: device.rights,
              lastEventId: this.eventLogNextId - 1,
              ...(existingRecord.confirmKey ? { biometricConfirm: true } : {}),
              ...endpointsInfo,
              ...protocolInfo
            }
          })
        );
        this.announceDevice(device);
        this.notifyStatusChanged();
        return;
      }

      const rateLimit = this.checkPinRateLimit(rateKey);
      if (!rateLimit.allowed) {
        reply({ type: 'error', error: 'Too many failed attempts, try again later' });
        return;
      }
      let invited: PairingRedemption | null = null;
      if (!this.isValidPairingCredentials(data.pin, data.key)) {
        // Приглашение участника (decision-126): одноразовый код вместо PIN. Только в сессии v2 — в v1 пакеты шифрует
        // ключ хоста, а его приглашённый не получает. Чужой deviceId код не погасит: устройство занято другим.
        const taken = this.deviceTokens.has(deviceId);
        invited = session && typeof data.pin === 'string' && !taken
          ? await editionRegistry.redeemPairingCode({ code: data.pin, deviceId, deviceName: device.name })
          : null;
        if (!invited) {
          this.recordPinFailure(rateKey);
          reply({ type: 'error', error: 'Invalid pairing PIN or secret key' });
          return;
        }
      }
      this.recordPinSuccess(rateKey);

      const issued = invited ? this.issueMemberDeviceToken(deviceId, device.name, invited) : this.issueDeviceToken(deviceId, device.name);
      if (issued.memberId) device.memberId = issued.memberId;
      // Ключ подтверждения биометрией — только при сопряжении по QR: украденный токен его не заменит (decision-112).
      if (parseConfirmKey(data.confirmKey)) {
        issued.confirmKey = data.confirmKey;
        this.persistDeviceTokens().catch(() => {});
      }
      // Приглашённого устройства уже одобрил владелец, выдав код.
      device.isApproved = invited ? true : !this.requireApproval;
      device.rights = this.effectiveDeviceRights({ ...device, rights: issued.rights });
      // Ответ шифруется тем же ключом, что и запрос: через релей `deviceToken` иначе уехал бы
      // открытым текстом через чужой сервер (decision-11 п.3 — релей не видит содержимого).
      reply(
        seal({
          type: 'handshake_ack',
          result: {
            approved: device.isApproved,
            readOnly: this.readOnly,
            hostId: this.hostId,
            protocolVersion: REMOTE_FEDERATION_PROTOCOL_VERSION,
            rights: device.rights,
            deviceToken: issued.token,
            lastEventId: this.eventLogNextId - 1,
            ...(issued.confirmKey ? { biometricConfirm: true } : {}),
            ...endpointsInfo,
            ...protocolInfo
          }
        })
      );
      this.announceDevice(device);
      this.notifyStatusChanged();
      return;
    }

    if (!device.isApproved) {
      reply({ type: 'error', error: 'Device not approved by host' });
      return;
    }

    // Ping / Pong. В v2 и pong зашифрован: открытых пакетов после рукопожатия на сокете нет.
    if (packet.type === 'ping') {
      reply(session ? seal({ type: 'pong', id: packet.id }) : { type: 'pong', id: packet.id });
      return;
    }

    // RPC Request (поддержка rpc_req и request из Telegram Mini App)
    if (packet.type === 'rpc_req' || packet.type === 'request') {
      const req = packet as PlainPacket;
      const isReqType = packet.type === 'request';
      const idemKey = req.id ? `${deviceId}:${req.id}` : null;
      const cached = idemKey ? this.recentRpcResponses.get(idemKey) : undefined;

      if (cached && cached.expiresAt > Date.now()) {
        const resPayload: PlainPacket = { type: isReqType ? 'response' : 'rpc_res', id: req.id, result: cached.result, error: cached.error, errorKey: cached.errorKey };
        reply(seal(resPayload));
        return;
      }

      try {
        const result = await this.dispatchRpc(req.method || '', req.params, device);
        if (idemKey) this.recentRpcResponses.set(idemKey, { result, expiresAt: Date.now() + RPC_IDEMPOTENCY_TTL_MS });
        const resPayload: PlainPacket = {
          type: isReqType ? 'response' : 'rpc_res',
          id: req.id,
          result
        };
        reply(seal(resPayload));
      } catch (err) {
        // Код ошибки — телефону, он соберёт текст на своём языке; `error` — английский запасной (decision-165).
        const errorKey = appErrorKeyOf(err);
        if (idemKey) {
          this.recentRpcResponses.set(idemKey, { error: errorMessage(err), errorKey, expiresAt: Date.now() + RPC_IDEMPOTENCY_TTL_MS });
        }
        const errPayload: PlainPacket = {
          type: isReqType ? 'response' : 'rpc_res',
          id: req.id,
          error: errorMessage(err),
          ...(errorKey ? { errorKey } : {})
        };
        reply(seal(errPayload));
      }
    }
  }

  /**
   * Токен для устройства, которое привёл сопряжённый ПК федерации (decision-111, `enroll_device`). `deviceId` выдаёт
   * хост, а не просящий: иначе можно было бы перезаписать токен уже сопряжённого устройства. Права — не больше, чем
   * у приведшего; одобрение не требуется: приведший сам устройство с полными правами на этом хосте.
   */
  private async enrollDelegatedDevice(params: Record<string, unknown>, caller: RemoteDevice): Promise<RemoteEnrollment> {
    await this.ensureSessionKey();
    if (typeof params.peerHostId === 'string') return this.enrollIntroducedPeer(params, caller);
    const requested = parseDeviceRights(params.rights) ?? 'full';
    const rights = minDeviceRights(this.effectiveDeviceRights(caller), requested);
    const baseName = (typeof params.deviceName === 'string' && params.deviceName.trim() ? params.deviceName.trim() : hostText(getHostLanguage()).remote.phoneName).slice(0, 60);
    const deviceId = `fed_${crypto.randomBytes(8).toString('hex')}`;
    const record: DeviceTokenRecord = {
      token: crypto.randomBytes(32).toString('hex'),
      rights,
      deviceName: hostText(getHostLanguage()).remote.viaPeer(baseName, caller.name).slice(0, 120),
      createdAt: Date.now(),
      rightsExplicit: true,
      approved: true,
      delegatedBy: caller.id,
      ...(caller.memberId ? { memberId: caller.memberId } : {})
    };
    this.deviceTokens.set(deviceId, record);
    await this.persistDeviceTokens();
    logger.info(`[RemoteControl] Delegated device ${deviceId} (${rights}) enrolled by ${caller.id}`);
    this.notifyStatusChanged();
    return {
      hostId: this.hostId,
      machineName: this.machineName || os.hostname(),
      hostKey: this.getHostKey(),
      deviceId,
      deviceToken: record.token,
      rights,
      ...this.endpointsAnnouncement()
    };
  }

  /**
   * Профиль хоста — настройки владельца (TASK-225): участник общего хоста и устройство без права full его не читают
   * и не пишут.
   */
  private assertProfileOwner(caller: RemoteDevice): void {
    if (caller.memberId || this.effectiveDeviceRights(caller) !== 'full') {
      throw new AppError('remote.profileOwnerOnly');
    }
  }

  /** Знакомить ПК и принимать знакомство может только устройство владельца с полными правами (decision-143 п. 2, 3). */
  private assertOwnerFullDevice(caller: RemoteDevice): void {
    if (caller.memberId || this.effectiveDeviceRights(caller) !== 'full') {
      throw new AppError('remote.introduceOwnerOnly');
    }
  }

  /**
   * Токен для другого ПК владельца по знакомству с телефона (decision-143 п. 2): права `full`, одобрено, `introducedBy` —
   * телефон. Прежний токен той же пары заменяется: повторное знакомство не плодит записи.
   */
  private async enrollIntroducedPeer(params: Record<string, unknown>, caller: RemoteDevice): Promise<RemoteEnrollment> {
    this.assertOwnerFullDevice(caller);
    const peerHostId = String(params.peerHostId).trim();
    if (!/^[A-Za-z0-9_.-]{3,128}$/.test(peerHostId)) throw new AppError('remote.peerHostIdInvalid');
    if (peerHostId === this.hostId) throw new AppError('remote.sameComputer');
    const name = (typeof params.deviceName === 'string' && params.deviceName.trim() ? params.deviceName.trim() : peerHostId).slice(0, 120);
    // Прежние токены пары не удаляются здесь: ими ПК может пользоваться сейчас. Их снимет первое рукопожатие нового.
    const deviceId = `fed_${crypto.randomBytes(8).toString('hex')}`;
    const record: DeviceTokenRecord = {
      token: crypto.randomBytes(32).toString('hex'),
      rights: 'full',
      deviceName: name,
      createdAt: Date.now(),
      rightsExplicit: true,
      approved: true,
      introducedBy: caller.id,
      peerHostId
    };
    this.deviceTokens.set(deviceId, record);
    await this.persistDeviceTokens();
    logger.info(`[RemoteControl] Peer host ${peerHostId} introduced as ${deviceId} by ${caller.id}`);
    this.notifyStatusChanged();
    return {
      hostId: this.hostId,
      machineName: this.machineName || os.hostname(),
      hostKey: this.getHostKey(),
      deviceId,
      deviceToken: record.token,
      rights: 'full',
      ...this.endpointsAnnouncement()
    };
  }

  /** Отзыв токена знакомства, который другой ПК не принял (decision-143 п. 1). Чужие токены так не отозвать. */
  private async revokeIntroducedDevice(deviceId: string, caller: RemoteDevice): Promise<{ ok: boolean }> {
    this.assertOwnerFullDevice(caller);
    const record = this.deviceTokens.get(deviceId);
    if (!record?.peerHostId || this.connectedDevices.has(deviceId)) return { ok: false };
    this.deviceTokens.delete(deviceId);
    await this.persistDeviceTokens();
    this.notifyStatusChanged();
    return { ok: true };
  }

  /**
   * Пир hub-режима по знакомству с телефона (decision-143 п. 3): соседа выдал `enroll_device` с `peerHostId`. Подключённый
   * пир не перезаписывается — `already`, телефон отзовёт лишний токен. Сохранённый пир без связи получает адрес, ключ и
   * токен знакомства (TASK-190).
   */
  private async addIntroducedPeer(params: Record<string, unknown>, caller: RemoteDevice): Promise<{ status: 'added' | 'already'; connected: boolean }> {
    this.assertOwnerFullDevice(caller);
    const intro = params.introduction as { hostId?: unknown } | null;
    const peerHostId = typeof intro?.hostId === 'string' ? intro.hostId : '';
    if (!isPeerIntroduction(intro, peerHostId)) throw new AppError('remote.introductionIncomplete');
    if (intro.hostId === this.hostId) throw new AppError('remote.sameComputer');
    const peers = await federationClientService.listPeers();
    if (peers.some((p) => p.hostId === intro.hostId && p.paired && p.status === 'connected')) return { status: 'already', connected: true };
    const candidates = peerAddressCandidates(intro, getLocalIpAddresses());
    if (!candidates.length) throw new AppError('remote.peerNoAddress', { name: intro.machineName });
    const address = await firstReachableAddress(candidates, INTRODUCE_PROBE_TIMEOUT_MS).catch((err: unknown) => {
      const blocked = err instanceof PeerUnreachableError && err.localNetworkBlocked;
      throw new AppError(blocked ? 'remote.peerLocalNetworkBlocked' : 'remote.peerUnreachable', {
        name: intro.machineName,
        detail: err instanceof Error ? err.message : String(err)
      });
    });
    const state = await federationClientService.addPeer({
      hostId: intro.hostId,
      machineName: intro.machineName,
      transport: address.transport,
      address: address.address,
      hostKey: intro.hostKey,
      deviceId: intro.deviceId,
      deviceToken: intro.deviceToken
    });
    logger.info(`[RemoteControl] Peer ${intro.hostId} added by introduction from ${caller.id} (${state.status})`);
    appEventBus.publish({
      type: 'federation:peerIntroduced',
      peerHostId: intro.hostId,
      peerName: intro.machineName,
      byDevice: caller.name || caller.id,
      hostId: this.hostId,
      at: Date.now()
    });
    return { status: 'added', connected: state.status === 'connected' };
  }

  /**
   * Телефон просит доступ к соседнему ПК федерации (decision-111): этот ПК, сопряжённый с соседом в hub-режиме,
   * получает у него отдельный токен для телефона. Ключ соседа приходит по уже проверенной сессии с этим ПК.
   */
  private async enrollDeviceOnPeer(hostId: string, phone: RemoteDevice): Promise<RemoteEnrollment> {
    if (!hostId) throw new Error('hostId is required');
    if (hostId === this.hostId) throw new AppError('remote.sameComputer');
    const peers = await federationClientService.listPeers();
    const peer = peers.find((p) => p.hostId === hostId && p.paired);
    if (!peer) {
      const name = this.knownFederationHosts.get(hostId)?.machineName || hostId;
      throw new AppError('remote.peerNotPaired', { name, machine: this.machineName });
    }
    const res = await federationClientService.call<RemoteEnrollment>(hostId, 'enroll_device', {
      deviceName: phone.name,
      rights: phone.rights ?? 'full'
    });
    if (!res || res.hostId !== hostId || !isHostKey(res.hostKey) || typeof res.deviceId !== 'string' || typeof res.deviceToken !== 'string') {
      throw new AppError('remote.peerNoKey', { name: peer.machineName });
    }
    logger.info(`[RemoteControl] Device ${phone.id} enrolled on federation host ${hostId}`);
    return {
      hostId: res.hostId,
      machineName: res.machineName || peer.machineName,
      hostKey: res.hostKey,
      deviceId: res.deviceId,
      deviceToken: res.deviceToken,
      rights: parseDeviceRights(res.rights) ?? 'readOnly',
      endpoints: Array.isArray(res.endpoints) ? res.endpoints : [],
      ...(typeof res.relayUrl === 'string' && res.relayUrl ? { relayUrl: res.relayUrl } : {})
    };
  }

  /**
   * Диспетчер RPC методов.
   */
  /**
   * Вызов RPC с журналом действий: записывающие методы (свои и модулей `ee/`) пишутся с устройством и участником,
   * успехом или ошибкой (decision-126 п. 6).
   */
  /**
   * Проект, которого касается вызов (TASK-180): процесс — по `processId`, файл задачи — по пути, запрос HITL и рой —
   * по своему проекту, метод модуля редакции — по `projectOf`, остальное — `projectPath` или выбранный устройством.
   * `null` — метод хоста без проекта (`HOST_WIDE_METHODS`) или списочный метод без проекта.
   */
  private async rpcTargetProject(method: string, params: Record<string, unknown>, device: RemoteDevice): Promise<string | null> {
    if (HOST_WIDE_METHODS.has(method)) return null;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : '');
    switch (method) {
      case 'stop_process':
      case 'restart_process':
        return parseProcessId(str(params.processId))?.projectPath || str(params.projectPath) || this.deviceProject(device.id) || null;
      case 'update_task_status':
      case 'toggle_task_criterion':
      case 'get_task':
        // Путь нормализуется до проверки прав: `open/../secret/…` проверялся бы по `open`, а читался в `secret`.
        return str(params.filePath) ? path.resolve(str(params.filePath)) : null;
      case 'hitl_decision':
      case 'get_hitl_detail':
        return hitlService.getPending(str(params.requestId))?.projectPath || null;
      case 'stop_swarm':
      case 'get_agent_output':
        return agentFleetService.getSwarm(str(params.swarmId))?.projectPath || null;
    }
    const extra = editionRegistry.remoteMethod(method);
    if (extra?.projectOf) {
      const own = await extra.projectOf(params);
      if (own) return own;
    }
    if (OPTIONAL_PROJECT_METHODS.has(method) && !str(params.projectPath)) return null;
    return str(params.projectPath) || this.deviceProject(device.id) || null;
  }

  private async dispatchRpc(method: string, params: unknown = {}, device: RemoteDevice): Promise<unknown> {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    // Части загрузки (голос, вложение) — по записи на кусок: в журнал идёт только итоговое действие.
    const audited = (REMOTE_WRITE_METHODS.has(method) && method !== 'voice_chunk' && method !== 'voice_command' && method !== 'studio_attach') || editionRegistry.remoteMethod(method)?.write === true;
    if (!audited) {
      try {
        return await this.dispatchRpcUnaudited(method, params, device);
      } catch (err) {
        // Отказ по праву на проект пишется и для чтения: попытка заглянуть в закрытый проект — событие (TASK-180).
        if (err instanceof ProjectAccessError) {
          void appendRemoteAudit({
            ts: Date.now(),
            method,
            ok: false,
            error: err.message.slice(0, 300),
            deviceId: device.id,
            ...(device.name ? { deviceName: device.name } : {}),
            ...(device.memberId ? { memberId: device.memberId } : {}),
            projectPath: err.projectPath,
            denied: 'project'
          });
        }
        throw err;
      }
    }
    const base = {
      ts: Date.now(),
      method,
      deviceId: device.id,
      ...(device.name ? { deviceName: device.name } : {}),
      ...(device.memberId ? { memberId: device.memberId } : {}),
      ...(typeof (p.projectPath ?? this.deviceProject(device.id)) === 'string' ? { projectPath: String(p.projectPath ?? this.deviceProject(device.id)) } : {}),
      ...(auditTarget(p) ? { target: auditTarget(p) } : {})
    };
    try {
      const result = await this.dispatchRpcUnaudited(method, params, device);
      void appendRemoteAudit({ ...base, ok: true });
      return result;
    } catch (err) {
      void appendRemoteAudit({
        ...base,
        ok: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        ...(err instanceof ProjectAccessError ? { projectPath: err.projectPath, denied: 'project' as const } : {})
      });
      throw err;
    }
  }

  /**
   * Диспетчер RPC методов.
   */
  private async dispatchRpcUnaudited(method: string, params: any = {}, device: RemoteDevice): Promise<any> {
    // Проверка прав на модификацию в Read-Only режиме
    const writeMethods = REMOTE_WRITE_METHODS;
    const hitlRightsMethods = new Set(['hitl_decision', 'approve_agent_tasks', 'inbox_dismiss', 'review_task', 'merge_doc_branch', 'close_doc_branch']);

    if (this.readOnly && writeMethods.has(method)) {
      throw new Error(`Method ${method} is forbidden in Read-Only mode`);
    }

    if (params && typeof params === 'object' && FORBIDDEN_REMOTE_PARAMS.some((k) => k in params)) {
      throw new AppError('remote.permissionBypassForbidden');
    }

    // Права per-device токена (TASK-65, decision-11 п.1): readOnly — только чтение, hitl — чтение
    // и решения HITL, full — без ограничений сверх глобального readOnly выше. Роль участника общего хоста
    // сужает их на каждом вызове (decision-126): владелец мог сменить роль, пока устройство подключено.
    const rights = this.effectiveDeviceRights(device);
    const extraMethod = editionRegistry.remoteMethod(method);
    if (extraMethod?.write && this.readOnly) throw new Error(`Method ${method} is forbidden in Read-Only mode`);
    if (writeMethods.has(method) || extraMethod?.write) {
      if (rights === 'readOnly') {
        throw new Error(`Method ${method} is forbidden for this device (readOnly rights)`);
      }
      // Подтверждение задачи агента — такое же решение человека, как HITL (decision-89 п. 11).
      if (rights === 'hitl' && !hitlRightsMethods.has(method)) {
        throw new Error(`Method ${method} is forbidden for this device (hitl-only rights)`);
      }
    }
    // Дифф запроса — код проекта: его видит только тот, кто может решать (decision-114 п. 3).
    if (method === 'get_hitl_detail' && rights === 'readOnly') {
      throw new Error(`Method ${method} is forbidden for this device (readOnly rights)`);
    }
    const deviceRef = { id: device.id, ...(device.name ? { name: device.name } : {}), ...(device.memberId ? { memberId: device.memberId } : {}), rights };
    const denied = editionRegistry.checkRpc(method, deviceRef);
    if (denied) throw denied;

    // Права устройства на проект вызова (TASK-180, decision-144): `none` — проекта для устройства нет, `readOnly` и
    // `hitl` сужают запись так же, как права устройства на хост.
    await this.refreshProjectRoots();
    const target = await this.rpcTargetProject(method, params, device);
    // Роль в проекте вызова (ревью TASK-227): терминал, процессы и git основного дерева — по роли участника в этом
    // проекте, а не по наибольшей роли на хосте.
    const deniedInProject = editionRegistry.checkProjectRpc(method, deviceRef, target);
    if (deniedInProject) throw deniedInProject;
    if (target) {
      const reason = projectAccessDenied(this.projectAccessOf(device, target), writeMethods.has(method) || extraMethod?.write === true, hitlRightsMethods.has(method));
      if (reason) {
        const owner = owningProject(target, this.projectRoots) ?? target;
        throw new ProjectAccessError(reason, { method, project: path.basename(owner) }, owner);
      }
    }
    const sees = (projectPath: string | undefined) => !projectPath || this.projectAccessOf(device, projectPath) !== 'none';

    const activePath = params.projectPath || this.deviceProject(device.id);

    switch (method) {
      case 'get_status': {
        const projects = await projectRegistry.getProjects();
        return {
          hostId: this.hostId,
          machineName: this.machineName || os.hostname(),
          platform: process.platform,
          tunnelUrl: this.tunnelUrl,
          activeProjectPath: sees(this.deviceProject(device.id) ?? undefined) ? this.deviceProject(device.id) : null,
          projectsCount: projects.filter((p) => sees(p.path)).length,
          runningProcesses: processManager.getActiveProcessCount(),
          readOnly: this.readOnly
        };
      }

      case 'get_federation_hosts': {
        // `enrollable` — этот ПК сопряжён с соседом и может попросить у него токен для телефона (`federation_enroll`).
        // `peerConnected` — связь с ним сейчас есть: сломанную пару телефон предложит познакомить заново (TASK-190).
        const peers = await federationClientService.listPeers().catch(() => []);
        const paired = new Map(peers.filter((p) => p.paired).map((p) => [p.hostId, p.status === 'connected']));
        const hosts = this.getFederationHostsList().map((h) =>
          paired.has(h.hostId) ? { ...h, enrollable: true, peerConnected: paired.get(h.hostId) === true } : h
        );
        // ПК, сопряжённый вручную в hub-режиме без общего секрета федерации, в каталоге релея и LAN нет — но телефону
        // доступ к нему выдать можно, поэтому он тоже в списке (decision-111 п. 7).
        for (const peer of peers) {
          if (!peer.paired || hosts.some((h) => h.hostId === peer.hostId)) continue;
          hosts.push({
            hostId: peer.hostId,
            machineName: peer.machineName,
            // Платформу пира hub-соединение не сообщает; телефон по ней выбирает только значок.
            platform: 'win32',
            isOnline: peer.status === 'connected',
            projectsCount: 0,
            activeProcessesCount: 0,
            lastSeen: peer.connectedAt ?? 0,
            source: 'manual',
            enrollable: true,
            peerConnected: peer.status === 'connected'
          });
        }
        return { hosts };
      }

      case 'federation_enroll': {
        return await this.enrollDeviceOnPeer(String(params.hostId || ''), device);
      }

      case 'enroll_device': {
        return this.enrollDelegatedDevice(params, device);
      }

      case 'federation_add_peer': {
        return await this.addIntroducedPeer(params, device);
      }

      case 'revoke_introduced_device': {
        return await this.revokeIntroducedDevice(String(params.deviceId || ''), device);
      }

      // Профиль ProjectHub с домашнего хоста (TASK-225, decision-175 п. 5): формат и слияние те же, что у файла
      // профиля; секреты вырезаются на выходе и на входе. Только устройство владельца с правом full.
      case 'profile_get': {
        this.assertProfileOwner(device);
        return await profileService.collect(profileSectionList(params.sections));
      }

      case 'profile_preview': {
        this.assertProfileOwner(device);
        return await profileService.preview(profileFromJson(params.profile));
      }

      case 'profile_apply': {
        this.assertProfileOwner(device);
        return await profileService.apply(String(params.token || ''), profileSectionList(params.sections));
      }

      case 'get_projects': {
        const projects = await projectRegistry.getProjects();
        this.cachedLocalProjects = projects.map((p) => ({
          id: p.path,
          name: path.basename(p.path),
          path: p.path
        }));
        // В реестре имени проекта нет — без него клиенты показывали пустые строки (TASK-140.1).
        // Проекты, закрытые устройству, в список не попадают (TASK-180).
        return projects.filter((p) => sees(p.path)).map((p) => ({ ...p, name: path.basename(p.path) }));
      }

      case 'select_project': {
        // Проект только этого устройства: hub-ПК, Telegram и телефон не перебивают друг другу выбор (decision-129 п. 8).
        const selected = await assertRegisteredProject(String(params.projectPath || ''));
        this.deviceProjects.set(device.id, selected);
        const projects = await projectRegistry.getProjects();
        const project = projects.find((p) => path.resolve(p.path) === selected);
        return { activeProject: project || null };
      }

      // Дерево флота (TASK-174, decision-129): все проекты одним снимком, действия — по правам устройства.
      case 'get_overview':
        // Проекты без доступа — ни имени, ни пути, ни счётчиков (TASK-180).
        return scopeOverview(await this.overview.getOverview(overviewActions(rights, this.readOnly)), (p) => this.projectAccessOf(device, p), this.readOnly);

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

      // Документация на телефоне (TASK-140.17): только чтение, проект — из реестра, путь — внутри его backlog.
      case 'get_docs': {
        if (!activePath) return { docs: [] };
        return { docs: await listRemoteDocs(await assertRegisteredProject(String(activePath))) };
      }

      case 'get_doc': {
        if (!activePath) throw new Error('No active project specified');
        return await readRemoteDoc(await assertRegisteredProject(String(activePath)), params.path, params.knownHash);
      }

      // Ветки документации (TASK-194, decision-151): список, итог принятия по документам, решение человека.
      case 'get_doc_branches': {
        if (!activePath) return { available: false, branches: [] };
        return await docBranchesOverview(await assertRegisteredProject(String(activePath)));
      }

      case 'get_doc_branch_diff': {
        if (!activePath) throw new Error('No active project specified');
        return remoteDocBranchDiff(await diffDocBranch(await assertRegisteredProject(String(activePath)), String(params.branchId || '')));
      }

      case 'merge_doc_branch': {
        const projectPath = await assertRegisteredProject(String(params.projectPath || activePath || ''));
        const docs = Array.isArray(params.docs) ? params.docs.filter((d: unknown): d is string => typeof d === 'string').slice(0, 200) : undefined;
        const result = await mergeDocBranchAsHuman(
          projectPath,
          String(params.branchId || ''),
          { ...(docs?.length ? { docs } : {}), resolutions: sanitizeResolutions(params.resolutions) },
          { kind: 'remote', deviceId: device.id, deviceName: device.name, ...(device.memberId ? { memberId: device.memberId } : {}) }
        );
        return { ...result, branch: { id: result.branch.id, title: result.branch.title, status: result.branch.status } };
      }

      case 'close_doc_branch': {
        const projectPath = await assertRegisteredProject(String(params.projectPath || activePath || ''));
        const meta = await closeDocBranchAsHuman(projectPath, String(params.branchId || ''), {
          kind: 'remote',
          deviceId: device.id,
          deviceName: device.name,
          ...(device.memberId ? { memberId: device.memberId } : {})
        });
        return { id: meta.id, status: meta.status };
      }

      case 'update_task_status': {
        if (!params.filePath || !params.newStatus) throw new Error('filePath and newStatus are required');
        await this.updateTaskStatusInFile(await this.assertTaskFile(params.filePath), String(params.newStatus));
        this.broadcastEvent('backlog:changed', { projectPath: activePath });
        return { ok: true };
      }

      case 'toggle_task_criterion': {
        if (!params.filePath || params.index === undefined) throw new Error('filePath and index are required');
        await this.toggleCriterionInFile(await this.assertTaskFile(params.filePath), params.index, params.completed);
        this.broadcastEvent('backlog:changed', { projectPath: activePath });
        return { ok: true };
      }

      // Карточка задачи на ПК-клиенте (TASK-229): файл целиком, только из backlog/tasks проекта реестра.
      case 'get_task': {
        const filePath = await this.assertTaskFile(params.filePath);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new AppError('remote.docNotFound', { path: path.basename(filePath) });
        if (stat.size > REMOTE_DOC_MAX_BYTES) throw new AppError('remote.docTooLarge', { mb: REMOTE_DOC_MAX_BYTES / 1024 / 1024 });
        return { filePath, content: await fs.readFile(filePath, 'utf8') };
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
          source: { kind: 'remote', deviceId: device.id, deviceName: device.name, ...(device.memberId ? { memberId: device.memberId } : {}) }
        });
        if (res.ok) return true;
        if (res.reason === 'secrets') {
          throw new AppError('remote.commitSecrets', { findings: summarizeSecretFindings(res.findings) });
        }
        throw new Error(res.error);
      }

      case 'hitl_decision': {
        // Решение Human-in-the-Loop с удалённого устройства: строго по requestId через единый
        // hitlService.decide (TASK-57). Одобрение «верхнего в очереди» не поддерживается.
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!requestId) throw new Error('requestId is required');
        const approved = params.decision === 'allow' || params.decision === 'approve' || params.approved === true;
        // Способ подтверждения сообщает клиент, но `biometric` засчитывается только с подписью ключом подтверждения,
        // зарегистрированным при сопряжении (decision-112 п. 4). Класс риска хост берёт у себя, не из запроса.
        const confirm = parseConfirmMethod(params.confirm) ?? 'app';
        let confirmVerified = false;
        if (confirm === 'biometric') {
          const pendingRequest = hitlService.getPending(requestId);
          const record = this.deviceTokens.get(device.id);
          // Усечённый на телефоне дифф биометрией не одобряется: человек подтвердил бы то, чего не видел.
          confirmVerified = Boolean(
            pendingRequest?.risk &&
              (!approved || fitsPhoneReview(pendingRequest)) &&
              record?.confirmKey &&
              verifyConfirmProof(record.confirmKey, confirmProofPayload(this.hostId, requestId, approved ? 'allow' : 'deny', pendingRequest.risk), params.proof)
          );
        }
        const result = hitlService.decide(
          requestId,
          { approved, text: typeof params.reason === 'string' ? params.reason : undefined },
          { kind: 'remote', deviceId: device.id, deviceName: device.name, ...(device.memberId ? { memberId: device.memberId } : {}), confirm, confirmVerified }
        );
        if (!result.ok) {
          return { decision: approved, ...hitlRefusal(result) };
        }
        this.notifyRenderer('remote:hitlDecisionMade', {
          requestId,
          sessionId: result.request.sessionId,
          approved,
          byDevice: device.name
        });
        return { ok: true, decision: approved, sessionId: result.request.sessionId };
      }

      // Задачи агентов, ждущие подтверждения (TASK-155): все проекты хоста — «Входящие» телефона не привязаны к проекту.
      case 'get_pending_agent_tasks': {
        const projectPath = typeof params.projectPath === 'string' && params.projectPath ? await assertRegisteredProject(params.projectPath) : undefined;
        return (await agentTaskApproval.listPending(projectPath)).filter((t) => sees(t.projectPath)).map(({ projectPath: p, id, title, reporter, created }) => ({
          projectPath: p,
          id,
          title,
          ...(reporter ? { reporter } : {}),
          ...(created ? { created } : {})
        }));
      }

      // Подтверждение с телефона: по id задач или всех задач автора в проекте, тем же путём, что окно.
      case 'approve_agent_tasks': {
        const projectPath = await assertRegisteredProject(String(params.projectPath || ''));
        const ids = Array.isArray(params.taskIds) ? params.taskIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 200) : undefined;
        const reporter = typeof params.reporter === 'string' && params.reporter ? params.reporter : undefined;
        if (!ids && !reporter) throw new Error('taskIds or reporter is required');
        const result = await agentTaskApproval.approveInProject(
          projectPath,
          { ...(ids ? { ids } : {}), ...(reporter ? { reporter } : {}) },
          { kind: 'remote', deviceId: device.id, deviceName: device.name, ...(device.memberId ? { memberId: device.memberId } : {}) },
          'phone'
        );
        if (result.approved.length > 0) this.broadcastEvent('backlog:changed', { projectPath });
        return result;
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

      // ── Agents Studio с телефона (TASK-140.10, decision-83): те же сессии, что во вкладках на ПК ──

      case 'studio_get_options': {
        const config = await aiAgentService.getConfig();
        const profiles = await llmProfileService.listProfiles().catch(() => []);
        // Аккаунты Claude Code этого ПК для выбора при открытии сессии (TASK-221): только id и имя.
        const optionsProject = typeof params.projectPath === 'string' && params.projectPath ? params.projectPath : undefined;
        const [claudeAccounts, projectAccountId] = await Promise.all([
          claudeAccountService.listAccounts().catch(() => []),
          claudeAccountService.projectAccountId(optionsProject).catch(() => undefined)
        ]);
        // Каталог профиля может идти в сеть (локальный сервер моделей) — не дольше 4 с на профиль.
        const withModels = await Promise.all(
          profiles.map(async (p) => {
            try {
              const res = await Promise.race([
                llmModelCatalogService.listModels(p.id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new AppError('remote.modelListTimeout')), 4000))
              ]);
              return {
                id: p.id,
                name: p.name,
                local: p.local,
                models: res.models.slice(0, 200),
                ...(res.error ? { modelsError: res.error } : {}),
                ...(res.errorKey ? { modelsErrorKey: res.errorKey } : {})
              };
            } catch (err) {
              const modelsErrorKey = appErrorKeyOf(err);
              return { id: p.id, name: p.name, local: p.local, models: [], modelsError: errorMessage(err), ...(modelsErrorKey ? { modelsErrorKey } : {}) };
            }
          })
        );
        const current = selectionOf(config);
        return {
          current,
          currentLabel: selectionLabel(current, new Map(profiles.map((p) => [p.id, p.name])), hostText(getHostLanguage()).remote.studioProfile) || config.model,
          modes: STUDIO_MODES,
          claudeModels: claudeBridgeService.getAvailableModels().map((m) => ({ id: m.id, name: m.name, description: m.description })),
          ...claudeAccountsForPhone(claudeAccounts, projectAccountId),
          // Наружу — только id, имя и признак локального сервера: ни ключей, ни адресов, ни заголовков.
          profiles: withModels,
          quickPrompts: studioQuickPromptList(getHostLanguage())
        };
      }

      case 'studio_get_usage': {
        // Кэш сервиса — 45 с; принудительное обновление запускает `claude -p /usage` (до 20 с).
        // Аккаунт — проекта, если телефон его передал (TASK-152.5), иначе профиль по умолчанию.
        const usageProject = typeof params.projectPath === 'string' && params.projectPath ? params.projectPath : undefined;
        return usageForPhone(await claudeUsageService.getUsageForProject(usageProject, params.forceRefresh === true));
      }

      case 'studio_clear': {
        const projectPath = String(params.projectPath || '');
        await assertRegisteredProject(projectPath);
        await this.assertStudioWriter(projectPath, params.sessionId, device);
        const reply = await studioRemoteBridge.request({ kind: 'clear', projectPath, sessionId: String(params.sessionId || '') });
        if (!reply.ok) throw reply.error ? withAppErrorKey(new Error(reply.error), reply.errorKey) : new AppError('remote.sessionClearFailed');
        return { ok: true };
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
        if (!session) throw new AppError('remote.sessionNotFound');
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
        // Вложения — файлы, уже сохранённые в проект через `studio_attach`: агент получает их пути.
        const attachments = await resolvePromptAttachments(projectPath, params.attachments);
        const text = promptWithAttachments(typeof params.prompt === 'string' ? params.prompt : '', attachments);
        if (!text) throw new Error('prompt is required');
        if (text.length > 100_000) throw new AppError('remote.promptTooLong');
        const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : undefined;
        if (sessionId) await this.assertStudioWriter(projectPath, sessionId, device);
        const selection = parseStudioSelection(params.selection);
        // Аккаунт выбирается при открытии сессии (TASK-221): несуществующий профиль не подменяется молча аккаунтом проекта.
        if (!sessionId && selection?.claudeAccountId && !(await claudeAccountService.getAccount(selection.claudeAccountId))) {
          throw new AppError('accounts.profileNotFound');
        }
        const reply = await studioRemoteBridge.request({
          kind: 'send',
          projectPath,
          ...(sessionId ? { sessionId } : {}),
          text,
          ...(selection ? { selection } : {}),
          ...(parseStudioMode(params.mode) ? { mode: parseStudioMode(params.mode) } : {}),
          deviceName: device.name,
          // Новая сессия участника общего хоста — его (TASK-142.3): worktree, HITL и стоимость по нему.
          ...(device.memberId ? { memberId: device.memberId } : {})
        });
        if (!reply.ok || !reply.sessionId) throw reply.error ? withAppErrorKey(new Error(reply.error), reply.errorKey) : new AppError('remote.studioPromptRejected');
        this.phoneStudioSessions.add(reply.sessionId);
        this.refreshKeepAwake();
        return { sessionId: reply.sessionId, accepted: true };
      }

      // Часть вложения к промпту (TASK-140.6): файл пишется в `.projecthub/attachments/` проекта, когда пришёл целиком.
      case 'studio_attach': {
        const projectPath = await assertRegisteredProject(String(params.projectPath || activePath || ''));
        return await this.attachmentUploads.put(device.id, projectPath, parseAttachmentChunk(params));
      }

      case 'studio_abort': {
        const projectPath = String(params.projectPath || '');
        await assertRegisteredProject(projectPath);
        await this.assertStudioWriter(projectPath, params.sessionId, device, 'abort');
        const reply = await studioRemoteBridge.request({ kind: 'abort', projectPath, sessionId: String(params.sessionId || '') });
        if (!reply.ok) throw reply.error ? withAppErrorKey(new Error(reply.error), reply.errorKey) : new AppError('remote.studioStopFailed');
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
        return agentFleetService.listSwarms(activePath || undefined).filter((s) => sees(s.projectPath)).map((s) => ({
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
            error: a.error,
            ...(a.errorKey ? { errorKey: a.errorKey } : {}),
            ...(a.providerError ? { providerError: a.providerError } : {})
          }))
        }));
      }

      // Ограничения запуска до нажатия «Запустить» (бюджеты Team, decision-124): в открытой редакции — пусто.
      case 'check_agent_launch': {
        if (!activePath) return { allowed: true, notices: [] };
        const roleSlug = typeof params.roleSlug === 'string' ? params.roleSlug.trim() : '';
        const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
        const role = roleSlug ? (await loadRoles(activePath)).roles.find((r) => r.slug === roleSlug) : undefined;
        return editionRegistry.checkAgentLaunch({
          projectPath: activePath,
          ...(taskId ? { taskId } : {}),
          ...(roleSlug ? { roleSlug } : {}),
          ...(role?.name ? { roleName: role.name } : {}),
          engine: role?.engine || 'claude-cli',
          ...(role?.model ? { model: role.model } : {}),
          origin: 'swarm',
          ...(device.memberId ? { memberId: device.memberId } : {}),
          slots: 1
        });
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
          throw new AppError('remote.wrongHost', { target: targetHostId, self: this.hostId });
        }

        const result = await agentFleetService.startAssignedAgent({
          projectPath: activePath,
          taskId,
          taskTitle: typeof params.taskTitle === 'string' ? params.taskTitle : undefined,
          prompt: typeof params.prompt === 'string' && params.prompt.trim() ? params.prompt : `Do task ${taskId}.`,
          roleSlug,
          useWorktrees: params.useWorktrees !== false,
          // Агент участника — в его worktree, с HITL ему и стоимостью на него (TASK-142.3).
          ...(device.memberId ? { memberId: device.memberId } : {})
        });
        if ('error' in result) throw withAppErrorKey(new Error(result.error), result.errorKey);
        this.trackPhoneSwarm(result.id);
        return { swarmId: result.id, status: result.status, hostId: this.hostId };
      }

      case 'stop_swarm': {
        const swarmId = typeof params.swarmId === 'string' ? params.swarmId : '';
        if (!swarmId) throw new Error('swarmId is required');
        // Чужой рой участника останавливает только он сам или старшая роль (TASK-142.3).
        const swarm = agentFleetService.getSwarm(swarmId);
        const denied = swarm ? editionRegistry.checkOwnership(swarm.memberId, device.memberId, 'session') : null;
        if (denied) throw denied;
        return { stopped: agentFleetService.stopSwarm(swarmId) };
      }

      case 'get_agent_output': {
        // Экран агентов телефона (TASK-140.1, decision-79 п. 8): только хвост вывода, не транскрипт
        // и не логи слота — с телефона читают «что агент сейчас пишет», а не всю историю.
        const swarmId = typeof params.swarmId === 'string' ? params.swarmId : '';
        const agentId = typeof params.agentId === 'string' ? params.agentId : '';
        if (!swarmId || !agentId) throw new Error('swarmId and agentId are required');
        const agent = agentFleetService.getSwarm(swarmId)?.agents.find((a) => a.id === agentId);
        if (!agent) throw new AppError('remote.agentNotFound');
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
        // Адресные события (HITL участника) догоняет только тот, кому они адресованы.
        const events = this.eventLog
          .filter((e) => e.id > sinceId && (!e.audience || e.audience(device)))
          .map(({ id, event, data }) => ({ id, event, data }));
        return { events, lastEventId: this.eventLogNextId - 1 };
      }

      // Push на это устройство с этого ПК (TASK-140.3, decision-115): включается явно и отдельно для каждого ПК.
      case 'push_register': {
        const record = this.deviceTokens.get(device.id);
        if (!record) throw new AppError('remote.deviceNotPaired');
        record.push = parsePushRegistration(params, Date.now());
        await this.persistDeviceTokens();
        return { ok: true, kind: record.push.kind, regId: record.push.regId };
      }

      case 'push_unregister': {
        const record = this.deviceTokens.get(device.id);
        if (record?.push) {
          delete record.push;
          await this.persistDeviceTokens();
        }
        return { ok: true };
      }

      case 'push_status': {
        const push = this.deviceTokens.get(device.id)?.push;
        return { enabled: Boolean(push), ...(push ? { kind: push.kind } : {}), gateway: Boolean(this.pushGatewayUrl) };
      }

      case 'push_test': {
        const record = this.deviceTokens.get(device.id);
        if (!record?.push) throw new AppError('remote.pushNotEnabled');
        const res = await this.pushService.sendTest({ deviceId: device.id, registration: record.push, canDecide: false });
        if (!res.ok) throw new AppError('remote.pushNotDelivered', { detail: res.error ?? '' });
        return { ok: true };
      }

      // Полный запрос перед одобрением с телефона (TASK-140.6): команда целиком и дифф, только пока запрос ждёт.
      case 'get_hitl_detail': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!requestId) throw new Error('requestId is required');
        const pendingRequest = hitlService.getPending(requestId);
        if (!pendingRequest || !this.hitlVisibleTo(pendingRequest, device)) throw new AppError('remote.hitlRequestNotFound');
        return hitlDetailForPhone(pendingRequest);
      }

      case 'get_pending_approvals': {
        return this.pendingApprovals(params.projectPath ? { projectPath: String(params.projectPath) } : {}, device);
      }

      // «Входящие» (TASK-140.5, decision-117): всё, что ждёт человека, по всем проектам этого ПК.
      case 'get_inbox': {
        const inbox = await this.inbox.getInbox({ hostId: this.hostId, machineName: this.machineName || os.hostname() });
        // Лента — только проекты, открытые устройству (TASK-180); HITL — ещё и по адресату запроса (TASK-142.3).
        return {
          ...inbox,
          hitl: inbox.hitl.filter((h) => this.hitlVisibleTo(hitlService.getPending(h.requestId), device)),
          agentTasks: inbox.agentTasks.filter((t) => sees(t.projectPath)),
          review: inbox.review.filter((r) => sees(r.projectPath)),
          events: inbox.events.filter((e) => sees(e.projectPath))
        };
      }

      case 'inbox_dismiss':
        return this.inbox.dismiss(params.ids);

      case 'review_task': {
        const res = await this.inbox.reviewTask(params, { name: device.name, rights: device.rights ?? 'full', ...(device.memberId ? { memberId: device.memberId } : {}) });
        this.broadcastEvent('backlog:changed', { projectPath: String(params.projectPath || '') });
        return res;
      }

      case 'get_review_screenshot':
        return this.inbox.screenshotChunk(params);

      // Голосовой промпт с телефона (TASK-140.7, decision-121 п. 4): PCM частями, распознавание движком окна на этом ПК.
      case 'voice_chunk': {
        const res = this.voiceUploads.put(device.id, parseVoiceChunk(params));
        if (!res.done) return { received: res.received };
        return this.transcribePhoneVoice(res.samples, res.language);
      }

      // Голосовая команда телефона (TASK-179.1, decision-137 п. 3): ПК только разбирает фразу, исполняет телефон.
      case 'voice_command': {
        const [{ parsePhoneVoiceRequest, buildPhoneVoicePrompt, parsePhoneVoiceResponse }, { modelCallService }] = await Promise.all([
          import('./phoneVoiceCommand.js'),
          import('./modelCallService.js')
        ]);
        const req = parsePhoneVoiceRequest(params);
        const completion = await modelCallService.complete({
          purpose: 'voice.classify',
          prompt: buildPhoneVoicePrompt(req),
          ...(activePath ? { projectPath: activePath } : {}),
          maxTokens: 400,
          temperature: 0,
          timeoutMs: 30_000
        });
        return parsePhoneVoiceResponse(completion.text, req);
      }

      // Новый проект с телефона (TASK-179.4, decision-137 п. 9): основа ProjectHub без стекового шаблона.
      case 'create_project': {
        const [{ projectFolderName, projectsRoot }, { applyInit }, os] = await Promise.all([
          import('./remoteProjectCreate.js'),
          import('./projectInitService.js'),
          import('node:os')
        ]);
        const name = typeof params.name === 'string' ? params.name.trim().slice(0, 120) : '';
        if (!name) throw new Error('name is required');
        const root = projectsRoot((await projectRegistry.getProjects()).map((p) => p.path), os.homedir());
        const target = path.join(root, projectFolderName(name));
        if (existsSync(target)) throw new AppError('remote.projectFolderExists', { path: target });
        const report = await applyInit({
          targetDir: target,
          projectName: name,
          locale: params.language === 'en' ? 'en' : 'ru',
          rulesMode: 'append',
          templateId: null,
          choices: {}
        });
        this.broadcastEvent('projects:changed', {});
        this.overview.markChanged();
        return { projectPath: report.projectPath, name };
      }

      default: {
        if (extraMethod) {
          return extraMethod.handler(params ?? {}, {
            device: deviceRef,
            ...(activePath ? { projectPath: activePath } : {}),
            broadcast: (event, payload) => this.broadcastEvent(event, payload)
          });
        }
        throw new Error(`Unknown RPC method: ${method}`);
      }
    }
  }

  /**
   * Загрузка списка задач Backlog.md из файловой системы.
   */
  private async loadBacklogTasks(projectPath: string): Promise<RemoteBacklogTask[]> {
    const tasksDir = path.join(projectPath, 'backlog', 'tasks');
    if (!existsSync(tasksDir)) return [];

    const files = await fs.readdir(tasksDir);
    const tasks: RemoteBacklogTask[] = [];

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

        const rawAssignee: unknown[] = Array.isArray(data.assignee) ? data.assignee : data.assignee ? [data.assignee] : [];
        const assignee = rawAssignee.map((a) => String(a ?? '').trim()).filter(Boolean);
        // Поля frontmatter — строками (правило 16): число или дата в `status` уронили бы «Входящие» на `trim()`.
        tasks.push({
          id: String(data.id || file.replace(/\.md$/, '')),
          title: String(data.title || file),
          status: String(data.status || 'To Do'),
          priority: String(data.priority || 'medium'),
          filePath,
          criteria,
          ...(data.updated_date ? { updated: String(data.updated_date) } : {}),
          // Назначение `agent:<роль>[@hostId]`: по нему «Удалённые хосты» показывают кнопку запуска агента (TASK-130).
          ...(assignee.length > 0 ? { assignee } : {})
        });
      } catch (err) {
        // ignore single corrupt file
      }
    }

    return tasks;
  }

  /**
   * Путь из RPC — файл задачи `backlog/tasks/*.md` внутри зарегистрированного проекта (decision-117 п. 6): с
   * телефона нельзя переписать произвольный файл, подсунув путь.
   */
  /**
   * Файл задачи для RPC: ровно `<проект>/backlog/tasks/<имя>.md` зарегистрированного проекта (самого глубокого, как
   * при проверке прав), без символьных ссылок наружу. `node_modules/…/backlog/tasks` и `.worktrees/…` не проходят.
   */
  private async assertTaskFile(raw: unknown): Promise<string> {
    const filePath = path.resolve(String(raw || ''));
    const projects = (await projectRegistry.getProjects()).map((p) => path.resolve(p.path));
    const owner = owningProject(filePath, projects);
    const parts = owner ? path.relative(owner, filePath).split(/[\\/]/) : [];
    const inTasks = parts.length === 3 && parts[0].toLowerCase() === 'backlog' && parts[1].toLowerCase() === 'tasks' && /\.md$/i.test(parts[2]);
    if (!owner || !inTasks) throw new AppError('remote.taskFileOutside');
    const tasksDir = path.join(owner, 'backlog', 'tasks');
    const real = async (p: string) => {
      const r = await fs.realpath(p).catch(() => null);
      return r && process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const realDir = await real(tasksDir);
    if (!realDir || (await real(path.dirname(filePath))) !== realDir) throw new AppError('remote.taskFileOutside');
    const stat = await fs.lstat(filePath).catch(() => null);
    if (stat?.isSymbolicLink()) throw new AppError('remote.taskFileOutside');
    return filePath;
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
  public broadcastEvent(event: string, data: unknown, opts: { transient?: boolean; audience?: (device: RemoteDevice) => boolean } = {}) {
    // Событие проекта — только устройствам с доступом к нему (TASK-180), поверх адресатов вызывающего.
    if (event === 'projects:changed' || Date.now() - this.projectRootsAt > 30_000) void this.refreshProjectRoots();
    const project = this.eventProject(data);
    const audience = project
      ? (device: RemoteDevice) => (!opts.audience || opts.audience(device)) && this.projectAccessOf(device, project) !== 'none'
      : opts.audience;
    const reaches = (device: RemoteDevice) => !audience || audience(device);
    // Задачи поменяли с устройства: счётчики In Progress и Review в сводке флота устарели.
    if (event === 'backlog:changed') this.overview.markChanged();
    if (!this.enabled) return;

    // Транзитные события (поток Agents Studio) не занимают буфер догона и идут без eventId: иначе один ответ агента
    // вытеснил бы из буфера запросы HITL, которые телефон должен догнать после разрыва.
    if (opts.transient) {
      const packet: PlainPacket = { type: 'event', event, data };
      for (const client of this.localClients.values()) {
        if (client.ws.readyState === WebSocket.OPEN && client.device.isApproved && client.isEncrypted && reaches(client.device)) {
          try {
            client.ws.send(JSON.stringify(this.sealForClient(client.session, true, packet)));
          } catch {
            // ignore
          }
        }
      }
      this.sendToRelayClients(packet, reaches);
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

    this.eventLog.push({ id: eventId, event, data, ...(audience ? { audience } : {}) });
    if (this.eventLog.length > EVENT_LOG_MAX) this.eventLog.shift();

    // Отправка локальным клиентам
    for (const client of this.localClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN && client.device.isApproved && reaches(client.device)) {
        try {
          client.ws.send(JSON.stringify(this.sealForClient(client.session, client.isEncrypted, payload)));
        } catch {
          // ignore
        }
      }
    }

    this.sendToRelayClients(payload, reaches);
  }

  /**
   * События клиентам релея — адресно, каждому в его протоколе (decision-111). Раньше один пакет общим ключом
   * уходил всем клиентам хоста на релее, включая ещё не прошедших `handshake`; у сессий v2 ключи свои.
   */
  private sendToRelayClients(payload: PlainPacket, reaches: (device: RemoteDevice) => boolean = () => true): void {
    if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return;
    for (const device of this.connectedDevices.values()) {
      if (device.mode !== 'relay' || !device.isApproved || !reaches(device)) continue;
      try {
        const frame = this.sealForClient(this.relaySessions.get(device.id), true, payload);
        this.relayWs.send(JSON.stringify({ ...frame, targetClientId: device.id }));
      } catch {
        // ignore
      }
    }
  }

  private sendToDevice(deviceId: string, payload: PlainPacket) {
    const client = this.localClients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(this.sealForClient(client.session, client.isEncrypted, payload)));
      } catch {
        // ignore
      }
      return;
    }

    if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
      const frame = this.sealForClient(this.relaySessions.get(deviceId), true, payload);
      this.relayWs.send(JSON.stringify({ ...frame, targetClientId: deviceId }));
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

  private notifyRenderer(channel: string, data: unknown) {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w.isDestroyed()) {
        w.webContents.send(channel, data);
      }
    }
  }
}

export const remoteControlService = new RemoteControlService();
// Адресные уведомления модулей ee/ (очередь слияния, TASK-142.4): событие и push только адресатам.
editionRegistry.setDeviceNotifier((notice, audience) => remoteControlService.notifyDevices(notice, audience));
// Справочник устройств для модулей ee/ (участники общего хоста, decision-126): отзыв закрывает и живую сессию.
editionRegistry.setDeviceDirectory({
  list: () => remoteControlService.getPairedDevices(),
  revoke: (deviceId) => {
    remoteControlService.disconnectDevice(deviceId);
  }
});
// Ключ хоста, адрес его страницы и переподключение к релею для модуля организации (TASK-226).
editionRegistry.setHostServices({
  identity: () => remoteControlService.hostIdentity(),
  origin: () => {
    const status = remoteControlService.getStatus();
    if (!status.enabled) return null;
    if (status.tunnelStatus === 'active' && status.tunnelUrl) return status.tunnelUrl.replace(/\/+$/, '');
    return `http://${status.localAddresses?.[0] || 'localhost'}:${status.port}`;
  },
  refreshRelayTeam: () => remoteControlService.refreshRelayTeam()
});
// Ссылка сопряжения по коду участника из main (TASK-228: после входа через IdP): та же, что строит окно «Команда».
editionRegistry.setInvitePairingUrlProvider((code) => {
  const status = remoteControlService.getStatus();
  if (!status.enabled || !status.hostId) return null;
  return buildInvitePairingUrl(
    {
      hostId: status.hostId,
      key: '',
      relayServerUrl: status.relayServerUrl,
      mode: status.mode,
      port: status.port,
      ...(status.localAddresses?.[0] ? { localIp: status.localAddresses[0] } : {}),
      ...(status.tunnelStatus === 'active' && status.tunnelUrl ? { tunnelUrl: status.tunnelUrl } : {}),
      ...(status.endpoints ? { endpoints: status.endpoints } : {}),
      ...(status.hostKey ? { hostKey: status.hostKey } : {}),
      ...(status.hostKeyFingerprint ? { hostKeyFingerprint: status.hostKeyFingerprint } : {})
    },
    code
  );
});
