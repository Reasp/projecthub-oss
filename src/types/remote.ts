import type { RemoteEndpoint } from '../utils/remoteEndpoints';

/** LAN Direct и Relay (decision-11 п.2) — WebRTC выведен из scope, `RTCPeerConnection` в коде не было. */
export type RemoteConnectionMode = 'lan' | 'relay';

/** Права per-device токена (TASK-65, decision-11 п.1). */
export type DeviceRights = 'readOnly' | 'hitl' | 'full';

export interface RemoteDevice {
  id: string;
  name: string;
  ip: string;
  mode: RemoteConnectionMode;
  connectedAt: number;
  lastSeenAt: number;
  userAgent: string;
  isApproved: boolean;
  /** Права выданного при сопряжении токена; отсутствует, пока устройство не прошло сопряжение. */
  rights?: DeviceRights;
  /** Версия сессии Remote Control: 2 — рукопожатие X25519 с forward secrecy, 1 — общий ключ (decision-111). */
  protocol?: number;
}

/**
 * Спаренное устройство (per-device токен) — видно в UI даже когда устройство офлайн: права
 * назначаются и отзываются между сессиями, а не только у подключённых прямо сейчас (TASK-65).
 */
export interface PairedDevice {
  deviceId: string;
  name: string;
  rights: DeviceRights;
  createdAt: number;
  /** Права заданы вручную из UI — пересопряжение по PIN их не перетирает глобальным `readOnly`. */
  rightsExplicit?: boolean;
  connected: boolean;
  /** Устройство привёл другой сопряжённый ПК федерации (`enroll_device`, decision-111) — его `deviceId`. */
  delegatedBy?: string;
  /** Устройство зарегистрировало ключ подтверждения биометрией (decision-112): может одобрять `high`. */
  biometricConfirm?: boolean;
  /** Push на устройство включён с этого ПК (TASK-140.3): вид доставки. */
  push?: 'unifiedpush' | 'fcm' | 'apns';
}

export interface RemoteControlConfig {
  enabled: boolean;
  port: number;
  mode: RemoteConnectionMode;
  relayServerUrl: string;
  requireApproval: boolean;
  readOnly: boolean;
  /** Производное поле статуса (не часть конфига): `mode === 'relay'`. */
  useRelay?: boolean;
  machineName?: string;
  autoStart?: boolean;
  tunnelUrl?: string;
  /** Шлюз `ph-push` для FCM и APNs (TASK-140.3, decision-115). */
  pushGatewayUrl?: string;
  /** Только протокол v2: клиенты v1 и ключ в URL отклоняются (decision-116). */
  sessionV2Only?: boolean;
  /** Не давать ПК уснуть, пока ждёт решения HITL или работает агент с телефона (decision-117 п. 9). */
  keepAwake?: boolean;
  /**
   * Общий секрет федерации (TASK-66): задаётся одинаковым на всех машинах пользователя, из него
   * выводится `ownerId` каталога на релее. Хранится в safeStorage, не в plaintext-конфиге.
   */
  federationSecret?: string;
  /**
   * Автозапуск задач, назначенных на этот хост (`agent:<role>@<hostId>`), когда их файл приехал
   * через git (TASK-66). Выключено по умолчанию: агент стартует сам, без нажатия человека.
   */
  autoStartAssignedTasks?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramBotUsername?: string;
  telegramMiniAppUrl?: string;
}

/**
 * Проект удалённого хоста в каталоге федерации (TASK-66). Наружу уходит имя и хэш пути
 * (`pathHash`), а не сам путь: каталог проходит через чужой релей. `path` заполняется только
 * для локального хоста, где он и так известен.
 */
export interface FederationProject {
  id: string;
  name: string;
  path?: string;
  pathHash?: string;
}

/** Откуда узнали о хосте: сам себя, каталог релея, LAN-обнаружение (TASK-66). */
export type FederationHostSource = 'self' | 'relay' | 'lan' | 'manual';

export interface FederationHost {
  hostId: string;
  machineName: string;
  platform: 'win32' | 'darwin' | 'linux';
  tunnelUrl?: string;
  localIps?: string[];
  /** Порт локального HTTP/WS-сервера хоста — нужен для прямого LAN-подключения без релея. */
  port?: number;
  isOnline: boolean;
  projectsCount: number;
  activeProcessesCount: number;
  projects?: FederationProject[];
  lastSeen: number;
  /** Версия приложения на хосте (для диагностики несовместимостей). */
  appVersion?: string;
  /** Сколько агентов сейчас работает на хосте (fan-out + Agents Studio). */
  activeAgentsCount?: number;
  /** Длина очереди HITL — видно, что хост чего-то ждёт от человека. */
  hitlPendingCount?: number;
  /** Источник записи: сам хост, каталог релея или LAN-обнаружение. */
  source?: FederationHostSource;
  /**
   * Версия протокола федерации (TASK-58, задел для TASK-66). Хосты со старой/новой несовместимой
   * версией отклоняются при регистрации с понятной ошибкой вместо молчаливой порчи данных.
   */
  protocolVersion?: number;
  /** Заполняется на принимающей стороне, если версия хоста несовместима с локальной. */
  protocolIncompatible?: boolean;
  /**
   * Только в ответе `get_federation_hosts` телефону: этот ПК сопряжён с хостом и может выдать телефону доступ к нему
   * (`federation_enroll`, decision-111).
   */
  enrollable?: boolean;
}

/** Транспорт подключения к удалённому ProjectHub в hub-режиме (TASK-66). */
export type FederationTransport = 'lan' | 'relay';

export type FederationPeerStatus = 'idle' | 'connecting' | 'connected' | 'offline' | 'error';

/**
 * Состояние подключения к удалённому хосту в hub-режиме (TASK-66, decision-11 п.4).
 * Секреты (E2EE-ключ, per-device токен) сюда не попадают — только факт сопряжения.
 */
export interface FederationPeerState {
  hostId: string;
  machineName: string;
  transport: FederationTransport;
  address: string;
  status: FederationPeerStatus;
  /** Понятная причина ошибки, включая несовместимость версии протокола. */
  error?: string;
  /** Права, выданные нам удалённым хостом (его per-device токен). */
  rights?: DeviceRights;
  readOnly?: boolean;
  protocolVersion?: number;
  lastEventId: number;
  connectedAt?: number;
  /** Токен получен — переподключение больше не требует PIN. */
  paired: boolean;
  autoConnect: boolean;
  /** Протокол текущей сессии: 2 — forward secrecy, 1 — общий ключ (TASK-166, decision-116). */
  sessionProtocol?: number;
  /** Ключ сессий хоста закреплён: подключения идут по v2. */
  hostKeyPinned?: boolean;
}

export interface RemoteControlStatus {
  enabled: boolean;
  port: number;
  mode: RemoteConnectionMode;
  relayServerUrl: string;
  relayConnected: boolean;
  hostId: string;
  machineName: string;
  pairingPin: string;
  secretKey: string;
  /** Открытый ключ сессий хоста (ECDSA P-256) в base64url: QR несёт его для проверки подписи рукопожатия v2 (decision-111). */
  hostKey?: string;
  /** Первые 96 бит SHA-256 ключа хоста — для ссылки Telegram, где полный ключ не помещается. */
  hostKeyFingerprint?: string;
  localIps: string[];
  connectedDevices: RemoteDevice[];
  /** Все устройства с выданным per-device токеном (включая офлайн), с правами и временем выдачи. */
  pairedDevices: PairedDevice[];
  requireApproval: boolean;
  readOnly: boolean;
  lastError: string | null;
  autoStart: boolean;
  tunnelUrl: string;
  tunnelStatus: 'idle' | 'starting' | 'active' | 'error';
  tunnelError: string | null;
  federationHosts: FederationHost[];
  /** Задан общий федеративный секрет — хост участвует в каталоге пользователя (TASK-66). */
  federationEnabled?: boolean;
  /** Включён автозапуск задач, назначенных на этот хост. */
  autoStartAssignedTasks?: boolean;
  /** Производный от секрета идентификатор владельца каталога (сам секрет из него не выводится). */
  federationOwnerId?: string;
  /** Секрет федерации — показывается в настройках, чтобы перенести его на другую машину. */
  federationSecret?: string;
  /** Понятная ошибка федерации (например, несовместимая версия протокола релея). */
  federationError?: string | null;
  useRelay?: boolean;
  localAddresses?: string[];
  secretToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramBotUsername?: string;
  telegramMiniAppUrl?: string;
  /** Адреса хоста для телефона: LAN, VPN, туннель (TASK-140.9). Релей — в `relayServerUrl`. */
  endpoints?: RemoteEndpoint[];
  /** Шлюз `ph-push` для FCM и APNs (TASK-140.3); пустой — push только через UnifiedPush. */
  pushGatewayUrl?: string;
  /** Хост принимает только протокол v2 (decision-116). */
  sessionV2Only?: boolean;
  /** Выключатель запрета сна (decision-117 п. 9) и держится ли запрет прямо сейчас. */
  keepAwake?: boolean;
  keepAwakeActive?: boolean;
}

/** Пакет протокола v1: AES-256-GCM общим ключом хоста. Пакеты v2 — `SessionFrameV2` из `remoteSessionV2.ts`. */
export interface EncryptedPacket {
  e2ee: true;
  iv: string; // hex
  tag: string; // hex
  data: string; // hex
}

export interface PlainPacket {
  e2ee?: false;
  type: 'rpc_req' | 'rpc_res' | 'event' | 'handshake' | 'handshake_ack' | 'ping' | 'pong';
  id?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
  event?: string;
  data?: any;
  /**
   * Монотонный id события (только для `type:'event'`): клиент запоминает последний увиденный и
   * после переподключения догоняет пропущенное через RPC `get_events_since` (decision-11 п.6).
   */
  eventId?: number;
}

export type RemotePacket = PlainPacket | EncryptedPacket;

export type RemoteRpcMethod =
  | 'get_status'
  | 'get_projects'
  | 'select_project'
  | 'get_processes'
  | 'start_process'
  | 'stop_process'
  | 'restart_process'
  | 'get_process_logs'
  | 'get_tasks'
  | 'update_task_status'
  | 'toggle_task_criterion'
  | 'create_task'
  | 'get_git_status'
  | 'git_commit'
  | 'git_pull'
  | 'git_push'
  | 'send_ai_prompt'
  | 'hitl_decision'
  | 'get_pending_approvals'
  // Полный запрос HITL с диффом перед одобрением биометрией (TASK-140.6, decision-114)
  | 'get_hitl_detail'
  | 'run_action'
  | 'get_federation_hosts'
  | 'get_events_since'
  // Hub-режим федерации (TASK-66, decision-11 п.4): ПК как клиент другого ПК
  | 'get_roles'
  | 'get_swarms'
  | 'start_assigned_agent'
  | 'stop_swarm'
  // Мобильный клиент (TASK-140.1, decision-79 п. 8): хвост вывода агента роя
  | 'get_agent_output'
  // Agents Studio с телефона (TASK-140.10, decision-83): сессии те же, что во вкладках ПК
  | 'studio_get_options'
  | 'studio_list_sessions'
  | 'studio_get_session'
  | 'studio_send'
  // Вложение в промпт частями: файл сохраняется в проект на хосте (TASK-140.6, decision-114)
  | 'studio_attach'
  | 'studio_abort'
  | 'studio_clear'
  | 'studio_get_usage'
  // Задачи агентов, ждущие подтверждения человека (TASK-155, decision-89 п. 11)
  | 'get_pending_agent_tasks'
  | 'approve_agent_tasks'
  // Несколько хостов в телефоне (TASK-140.2, decision-111): доступ к соседу по федерации через этот ПК
  | 'federation_enroll'
  | 'enroll_device'
  // Зашифрованные push с этого ПК (TASK-140.3, decision-115): включаются отдельно для каждого ПК
  | 'push_register'
  | 'push_unregister'
  | 'push_status'
  | 'push_test'
  // «Входящие» телефона (TASK-140.5, decision-117): лента со всех проектов хоста и проверка задач из Review
  | 'get_inbox'
  | 'inbox_dismiss'
  | 'review_task'
  | 'get_review_screenshot';

/** Ответ `federation_enroll` / `enroll_device`: всё, что нужно телефону для отдельного профиля соседнего хоста. */
export interface RemoteEnrollment {
  hostId: string;
  machineName: string;
  /** Ключ сессий соседа в base64url — телефон закрепляет его и говорит с соседом только по v2. */
  hostKey: string;
  /** `deviceId`, выданный соседом: свой у каждого хоста, токены не переиспользуются. */
  deviceId: string;
  deviceToken: string;
  rights: DeviceRights;
  endpoints: RemoteEndpoint[];
  relayUrl?: string;
}

/**
 * Ответы RPC в том виде, в каком их отдаёт `dispatchRpc` хоста. Общие для хоста и мобильного
 * клиента (`mobile/`, TASK-140.1): клиент не держит своих копий форм.
 */
export interface RemoteHostStatus {
  hostId: string;
  machineName: string;
  platform: string;
  tunnelUrl?: string;
  activeProjectPath: string | null;
  projectsCount: number;
  runningProcesses: number;
  readOnly: boolean;
}

export interface RemoteProjectSummary {
  path: string;
  name: string;
  [key: string]: unknown;
}

export interface RemoteTaskCriterion {
  text: string;
  completed: boolean;
}

export interface RemoteTaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  filePath: string;
  criteria: RemoteTaskCriterion[];
  /** Исполнители задачи, например `agent:implementer@ph_host_…` (TASK-130). */
  assignee?: string[];
}

export interface RemoteProcessSummary {
  id: string;
  name: string;
  command: string;
  status: 'running' | 'stopped' | 'failed' | 'unknown';
  pid?: number;
  port?: number;
  source?: 'hub' | 'env-tools';
  startedAt?: string;
  exitCode?: number;
}

export interface RemoteSwarmAgentSummary {
  id: string;
  name: string;
  roleSlug?: string;
  engine?: string;
  status: string;
  error?: string;
}

export interface RemoteSwarmSummary {
  id: string;
  mode: string;
  status: string;
  projectPath: string;
  taskId?: string;
  taskTitle?: string;
  origin?: string;
  createdAt?: number | string;
  completedAt?: number | string;
  agents: RemoteSwarmAgentSummary[];
}

export interface RemoteRoleSummary {
  slug: string;
  name: string;
  engine?: string;
  model?: string;
  source?: string;
}

/** Хвост вывода агента (`get_agent_output`): только конец, полный транскрипт с телефона не читается. */
export interface RemoteAgentOutput {
  swarmId: string;
  agentId: string;
  status: string;
  text: string;
  truncated: boolean;
}

// ── Agents Studio с телефона (TASK-140.10, decision-83) ──

export type StudioMode = 'agent' | 'chat' | 'architect';

/** Выбор модели — та же форма, что у `ModelSelectorDropdown` Agents Studio на ПК. */
export interface StudioModelSelection {
  provider: string;
  profileId?: string;
  model: string;
}

/** Что можно выбрать на телефоне: модели Claude Code и профили LLM без ключей и заголовков. */
export interface RemoteStudioOptions {
  /** Текущий выбор Agents Studio на ПК — по умолчанию для новой сессии. */
  current: StudioModelSelection;
  currentLabel: string;
  modes: StudioMode[];
  claudeModels: Array<{ id: string; name: string; description: string }>;
  profiles: Array<{ id: string; name: string; local: boolean; models: string[]; modelsError?: string }>;
  /** Быстрые промпты Agents Studio («Следующая задача», «Коммит», «Деплой»). */
  quickPrompts?: Array<{ id: string; label: string; prompt: string }>;
}

/** Окно лимита Claude Code: процент и когда сбросится (текст CLI или ISO). */
export interface RemoteUsageWindow {
  percent: number;
  resetsAt?: string;
}

/** Лимиты и расход Claude Code с ПК — то же, что окно Usage в ProjectHub (без сырого вывода CLI). */
export interface RemoteStudioUsage {
  planType: string;
  sessionLimit?: RemoteUsageWindow;
  weeklyLimit?: RemoteUsageWindow;
  fableLimit?: RemoteUsageWindow;
  last24h?: { requests?: number; sessions?: number };
  last7d?: { requests?: number; sessions?: number };
  totalSessions?: number;
  totalMessages?: number;
  models: Array<{ model: string; inputTokens: number; outputTokens: number; costUSD?: number }>;
  updatedAt: number;
  /** Лимиты не прочитаны из CLI: показаны данные из статистики. */
  isFallback?: boolean;
  error?: { kind: string; message: string };
}

/** Расход токенов в одной сессии Agents Studio (сумма по ответам). */
export interface RemoteStudioSessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Часть ответов без точного расхода — оценка. */
  estimated?: boolean;
}

export interface RemoteStudioSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  /** Время последнего сообщения. */
  updatedAt: number;
  messageCount: number;
  /** Вкладка закрыта на ПК — сессия в истории. */
  archived: boolean;
  /** Сессию начали с телефона. */
  origin?: 'desktop' | 'phone';
  originDevice?: string;
  modelLabel?: string;
  /** Агент сейчас отвечает в этой сессии. */
  running: boolean;
  /** Начало последнего промпта пользователя. */
  preview: string;
}

export interface RemoteStudioToolCall {
  id: string;
  name: string;
  status?: string;
  /** Короткая подпись: команда или путь файла, без содержимого и диффов. */
  summary?: string;
}

export interface RemoteStudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  tools?: RemoteStudioToolCall[];
  /** Текст обрезан для телефона. */
  truncated?: boolean;
}

export interface RemoteStudioSession extends RemoteStudioSessionSummary {
  messages: RemoteStudioMessage[];
  /** Ранние сообщения не переданы: на телефон уходит хвост истории. */
  olderOmitted: number;
  /** Выбор модели последнего промпта — по умолчанию для продолжения. */
  lastSelection?: StudioModelSelection;
  lastMode?: StudioMode;
  usage?: RemoteStudioSessionUsage;
}

/** Класс риска запроса HITL (decision-112): считает хост, телефон только показывает. */
export type RemoteHitlRisk = 'low' | 'moderate' | 'high';

export interface RemotePendingApproval {
  requestId: string;
  sessionId: string;
  projectPath: string;
  origin?: string;
  agentName?: string;
  role?: string;
  tool?: string;
  type?: string;
  risk?: RemoteHitlRisk;
  riskReason?: string;
  title?: string;
  details?: string;
  command?: string;
  filePath?: string;
  createdAt?: number;
  expiresAt?: number;
  orphaned?: boolean;
}

/** Ответ `get_hitl_detail` (TASK-140.6, decision-114): запрос целиком — то, что человек одобряет биометрией. */
export interface RemoteHitlDetail {
  requestId: string;
  title: string;
  tool?: string;
  risk?: RemoteHitlRisk;
  riskReason?: string;
  /** Команда целиком, без усечения. */
  command?: string;
  filePath?: string;
  details?: string;
  detailsTruncated?: boolean;
  /** Унифицированный дифф; у нового файла — его строки с `+`. `truncated` — на телефоне не одобряется. */
  diff?: { filePath: string; patch: string; truncated: boolean };
}

/** Задача агента, ждущая подтверждения человека (`get_pending_agent_tasks`, TASK-155). */
export interface RemotePendingAgentTask {
  projectPath: string;
  id: string;
  title: string;
  /** Автор: `agent:<роль>`. */
  reporter?: string;
  created?: string;
}

/** Ответ `approve_agent_tasks`. */
export interface RemoteAgentTaskApproval {
  approved: string[];
  notPending: string[];
}

// ── «Входящие» (TASK-140.5, decision-117) ──

/** Запись журнала ленты: итог агента, сбой Automations, сообщение агента `projecthub_notify`. */
export type RemoteInboxEventKind = 'agent_done' | 'agent_failed' | 'automation_failed' | 'automation_suspended' | 'agent_note';

export type RemoteNoteLevel = 'info' | 'success' | 'warning' | 'error';

export interface RemoteInboxEvent {
  id: string;
  kind: RemoteInboxEventKind;
  at: number;
  title: string;
  /** Ошибка, причина сбоя или текст сообщения агента. */
  body?: string;
  level?: RemoteNoteLevel;
  projectPath?: string;
  agentName?: string;
  role?: string;
  taskId?: string;
  swarmId?: string;
  agentId?: string;
}

export interface RemoteReviewCheck {
  name: string;
  kind: string;
  status: string;
  blocking: boolean;
  passedTests?: number;
  failedTests?: number;
  errorCount?: number;
  /** Причина `skipped`/`error` или последние строки вывода упавшей проверки. */
  detail?: string;
}

export interface RemoteReviewScreenshot {
  /** Путь внутри `<userData>/visual`: по нему `get_review_screenshot` отдаёт файл. */
  relPath: string;
  name: string;
  checkName?: string;
  bytes?: number;
}

export interface RemoteReviewCriterion {
  index: number;
  text: string;
  /** Отмечен в файле задачи. */
  completed: boolean;
  /** Вердикт цикла: засчитан ProjectHub, что заявил агент, его evidence. */
  accepted?: boolean;
  reported?: string;
  evidence?: string;
  reason?: string;
  ui?: boolean;
  screenshots?: RemoteReviewScreenshot[];
}

/** Последний отчёт цикла «до готовности» по задаче (decision-28, decision-55). */
export interface RemoteReviewReport {
  swarmId: string;
  outcome?: string;
  reason?: string;
  finishedAt?: number;
  iterations: number;
  summary?: string;
  costUsd?: number;
  checks: RemoteReviewCheck[];
  screenshots: RemoteReviewScreenshot[];
  /** Роль агента — её можно перезапустить при возврате задачи. */
  roleSlug?: string;
  agentName?: string;
}

export interface RemoteReviewItem {
  projectPath: string;
  id: string;
  title: string;
  priority?: string;
  updated?: string;
  criteria: RemoteReviewCriterion[];
  report?: RemoteReviewReport;
  /** Роль, которая работала по задаче: при возврате её можно перезапустить. Нет — только вернуть с комментарием. */
  roleSlug?: string;
}

/** Ответ `get_inbox`: всё, что ждёт человека на этом ПК, по всем проектам. */
export interface RemoteInbox {
  hostId: string;
  machineName: string;
  generatedAt: number;
  hitl: RemotePendingApproval[];
  agentTasks: RemotePendingAgentTask[];
  review: RemoteReviewItem[];
  events: RemoteInboxEvent[];
}

/** Ответ `review_task`. */
export interface RemoteReviewResult {
  ok: true;
  status: string;
  /** Агент перезапущен: id новой сессии роя. */
  swarmId?: string;
}

/** Часть скриншота (`get_review_screenshot`): base64 и сколько всего байт. */
export interface RemoteScreenshotChunk {
  mime: string;
  total: number;
  offset: number;
  data: string;
}

/** Ответ хоста на сопряжение/переподключение (`handshake_ack`). */
export interface RemoteHandshakeAck {
  approved: boolean;
  readOnly: boolean;
  hostId: string;
  protocolVersion: number;
  rights?: DeviceRights;
  lastEventId?: number;
  deviceToken?: string;
  /** Текущие адреса хоста (TASK-140.9): телефон обновляет по ним профиль без нового QR. */
  endpoints?: RemoteEndpoint[];
  /** Релей хоста, если он достижим с телефона. */
  relayUrl?: string;
  /** Согласованная версия сессии (decision-111): 2 — рукопожатие X25519, 1 — общий ключ. */
  sessionProtocol?: number;
  /** Версии сессии, которые понимает хост. */
  protocols?: number[];
  /** Ключ сессий хоста в base64url: клиент v1 закрепляет его и переходит на v2. */
  hostKey?: string;
  /** У устройства зарегистрирован ключ подтверждения (decision-112 п. 4): решение `high` подписывается биометрией. */
  biometricConfirm?: boolean;
}

export interface RemoteEventPayloads {
  'process:logChunk': { processId: string; text: string };
  'process:statusChanged': any;
  'ai:chunk': { sessionId: string; text?: string };
  'ai:complete': { sessionId: string; message: unknown };
  /** `errorKind` — вид ошибки провайдера (decision-43), если она классифицирована. */
  'ai:error': { sessionId: string; error: string; errorKind?: string };
  /** Запрос HITL (TASK-57): решение отправляется RPC `hitl_decision` строго с `requestId`. */
  'ai:hitl': {
    requestId: string;
    sessionId: string;
    projectPath: string;
    origin?: string;
    agentName?: string;
    role?: string;
    tool: string;
    type?: string;
    risk?: RemoteHitlRisk;
    riskReason?: string;
    description: string;
    details?: string;
    command?: string;
    filePath?: string;
    expiresAt?: number;
  };
  'ai:hitlDecided': { requestId: string; sessionId: string; approved: boolean; by: string };
  'projects:changed': void;
  'backlog:changed': { projectPath: string };
}
