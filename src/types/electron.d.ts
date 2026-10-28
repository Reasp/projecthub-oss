import type { BacklogProjectConfig } from '../utils/taskStatus';

export interface ActionDefinition {
  name: string;
  command: string;
  autoOpenUrl?: string;
  /** Задержка автооткрытия URL (мс), если сервер не напечатал адрес в лог; 0 — только по логу. */
  autoOpenDelayMs?: number;
  requiresConfirmation?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Стратегия порта (TASK-62): `fixed` — как записано в команде; `auto` — ProjectHub
   * подбирает свободный порт, кладёт в `PORT` и подставляет вместо `${port}` в команде
   * и `autoOpenUrl`. Позволяет держать dev-серверы нескольких worktree одновременно.
   */
  portStrategy?: 'fixed' | 'auto';
  /** Порт, с которого начинать поиск при `portStrategy: 'auto'` (по умолчанию 5173). */
  port?: number;
}

/** Политика инициализации нового worktree (`.projecthub.json`, TASK-62). */
export interface WorktreeInitPolicy {
  /** Команды, выполняемые в новом worktree после его создания (например `npm ci`). */
  commands?: string[];
  /** Связать `node_modules` worktree с основным деревом (symlink/junction) вместо установки. */
  linkNodeModules?: boolean;
}

export interface ProjectActionConfig {
  run: ActionDefinition;
  deploy: ActionDefinition;
  test: ActionDefinition;
  customActions?: Array<ActionDefinition & { id: string }>;
  /** Что выполнить в новом worktree после создания (TASK-62). */
  worktreeInit?: WorktreeInitPolicy;
}

/** Стандартные действия из .projecthub.json. */
export type ProjectActionKind = 'run' | 'deploy' | 'test';

/** Параметры запуска процесса, берутся из `ActionDefinition` (env, cwd). */
export interface StartProcessOptions {
  env?: Record<string, string>;
  cwd?: string;
  autoOpenUrl?: string;
  autoOpenDelayMs?: number;
  /** Активное рабочее дерево (worktree или корень проекта) — входит в id процесса (TASK-62). */
  workspaceRoot?: string;
  portStrategy?: 'fixed' | 'auto';
  port?: number;
}

export interface RagStatus {
  ready: boolean;
  chunksCount?: number;
  filesCount?: number;
  builtAt?: string;
  model?: string;
}

export interface RunningProcess {
  name: string;
  pid: number;
  command?: string;
  startedAt?: string;
}

export interface ProcessStatus {
  runningCount: number;
  processes: RunningProcess[];
}

export interface GitLastCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  description?: string;
  version?: string;
  favorite?: boolean;
  addedAt?: string;
  lastScannedAt?: string;
  hasBacklog: boolean;
  hasInfraConfig: boolean;
  hasGit: boolean;
  gitBranch?: string;
  gitClean?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  uncommittedCount?: number;
  lastCommit?: GitLastCommit;
  voiceAlias?: string;
  taskCounts?: {
    total: number;
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    /** Задачи со статусом вне четырёх стандартных (TASK-68): считаются в `total`. */
    other: number;
  };
  ragStatus?: RagStatus;
  processStatus?: ProcessStatus;
  features?: {
    docsRag?: boolean;
    envTools?: boolean;
    backlogMcp?: boolean;
    bootstrap?: boolean;
    lightrag?: boolean;
  };
  /** Чего не хватает из основы инициализации (decision-78, п. 2): пустой список — основа на месте. */
  foundationMissing?: Array<'git' | 'tasks' | 'docs' | 'rules'>;
}

export interface TaskCriterion {
  text: string;
  completed: boolean;
}

export interface Milestone {
  id: string;
  title: string;
  description?: string;
  targetDate?: string;
  status: 'Planning' | 'In Progress' | 'Completed' | 'Deferred';
  filePath: string;
  taskCounts?: {
    total: number;
    done: number;
    inProgress: number;
    review: number;
    todo: number;
  };
}

export interface CreateMilestoneParams {
  title: string;
  description?: string;
  targetDate?: string;
  status?: 'Planning' | 'In Progress' | 'Completed' | 'Deferred';
}

export interface BacklogTask {
  id: string;
  title: string;
  /**
   * Статус задачи как есть из frontmatter. Состав допустимых значений задаётся
   * `statuses` в `backlog/config.yml` проекта (TASK-68, decision-24), поэтому тип —
   * произвольная строка; стандартные значения Backlog.md оставлены подсказками.
   */
  status: 'To Do' | 'In Progress' | 'Review' | 'Done' | (string & {});
  labels: string[];
  milestone?: string;
  /** Человек (свободный текст) или агент/роль: `agent:<roleSlug>` / `agent:<roleSlug>@<hostId>` (TASK-60). */
  assignee?: string[];
  /** Автор задачи (`reporter` Backlog.md); у задач агентов — `agent:<роль>` (decision-89). */
  reporter?: string;
  created?: string;
  filePath: string;
  /** Сырой markdown-текст файла. В списке задач НЕ заполняется (TASK-38) — грузится по требованию через getTaskContent. */
  content?: string;
  description?: string;
  acceptanceCriteria?: TaskCriterion[];
  /** Ветка/worktree/PR, записанные автоматически при создании worktree и PR (TASK-64). */
  branch?: string;
  worktree?: string;
  pr?: string;
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author_name: string;
  author_email: string;
}

export interface ScanOptions {
  roots?: string[];
  depth?: number;
}

export interface RegistrySettings {
  autoScanOnStartup: boolean;
  scanDepth: number;
  /** Путь к шаблону ProjectTemplate для мастера создания проектов. */
  templatePath?: string;
}

export type TemplateSource = 'custom' | 'registry' | 'env' | 'builtin' | 'none';

export interface TemplateAvailability {
  available: boolean;
  path: string;
  source: TemplateSource;
}


// ─────────────── Управление компьютером через MCP-прокси (TASK-82), зеркало computerPolicy/computerUseService ───────────────

export interface ComputerAllowlistEntry {
  app?: string;
  title?: string;
}

export interface ComputerPolicySettings {
  allowlist: ComputerAllowlistEntry[];
  outsideAllowlist: 'ask' | 'deny';
  onlyAllowlistedWindows: boolean;
  fileDialogTitles: string[];
}

export interface ComputerUseSettings {
  enabled: boolean;
  policy: ComputerPolicySettings;
  killSwitchHotkey: string;
  takeoverDetection: boolean;
  takeoverThresholdPx: number;
  auditScreenshots: boolean;
}

export type ComputerRuntimeState = 'stopped' | 'starting' | 'ready' | 'error';
export type ComputerKillSwitchReason = 'hotkey' | 'human-takeover' | 'overlay' | 'manual';

export interface ComputerUseStatus {
  enabled: boolean;
  runtimeState: ComputerRuntimeState;
  runtimeError: string | null;
  /** Та же причина кодом словаря (decision-165): текст — по словарю `appErrors`. */
  runtimeErrorKey?: import('../lib/appError').AppErrorKey;
  runtimePackage: string;
  tools: { exported: number; hidden: number; unknown: string[]; missing: string[] } | null;
  killSwitch: { engaged: boolean; reason?: ComputerKillSwitchReason; at?: number };
  hotkey: { accelerator: string; registered: boolean };
  activeSession: { sessionId: string; label: string; since: number; lastActionAt: number } | null;
}

export interface ComputerOverlayState {
  active: boolean;
  label?: string;
  killSwitch: boolean;
  hotkey: string;
}

export interface ComputerUseDiagnostics {
  ok: boolean;
  runtime: {
    ok?: boolean;
    summary?: { passed: number; warned: number; failed: number; skipped: number };
    checks?: Array<{ id: string; status: string; summary: string; remediation?: string }>;
  } | null;
  status: ComputerUseStatus;
  error?: string;
  errorKey?: unknown;
}

/** Статус встроенного MCP HTTP/SSE-сервера (main → renderer через getMcpStatus/onMcpStatusChanged). */
export interface McpServerStatus {
  isRunning: boolean;
  port: number;
  activeSessions: number;
  token: string;
  url: string;
  lastError: string | null;
  lastErrorKey?: import('../lib/appError').AppErrorKey | null;
}

/** Сведения экрана «Диагностика» (TASK-58): версии, пути, уровень логирования. */
export interface DiagnosticsInfo {
  appVersion: string;
  /** Отметка сборки (TASK-158) — зеркало electron/services/buildInfo.ts. */
  build: { commit: string; commitDate: string | null; dirtyFiles: number; builtAt: string } | null;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  userDataDir: string;
  logsDir: string;
  crashDumpsDir: string;
  logLevel: string;
}

export type UpdaterState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

/** Статус проверки обновлений (TASK-58, decision-14 п.2): push из main через onUpdaterStatusChanged. */
export interface UpdaterStatus {
  state: UpdaterState;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  releaseUrl?: string;
  error?: string;
  /** Код ошибки (decision-165). */
  errorKey?: unknown;
  supportsAutoInstall: boolean;
}

// Remote Control (TASK-51, TASK-65): единственный источник истины для этих типов — `./remote`
// (используется и рендерером, и main-процессом/remoteControlService). Раньше здесь были
// собственные, разошедшиеся с рантаймом определения (`relayUrl`, `qrPayload`, `clientType`,
// `connectionMode`, ...) — IPC фактически всегда отдавал форму из `./remote`, из-за чего
// `RemoteControlBadge.tsx` читал несуществующие поля (decision-11, TASK-65 п.7).
export type { FederationHost, RemoteDevice, RemoteControlStatus, PairedDevice, DeviceRights } from './remote';
export type { RemoteControlConfig as RemoteConfig } from './remote';

export interface ManagedProcess {
  id: string;
  name: string;
  command: string;
  /** Корень проекта, к которому привязан процесс (ключ для поиска в UI). */
  cwd: string;
  /** Рабочее дерево процесса (worktree), если он запущен не в основном дереве проекта. */
  workspaceRoot?: string;
  /** Фактический рабочий каталог, если `ActionDefinition.cwd` отличается от рабочего дерева. */
  workingDir?: string;
  /** Порт, выданный процессу при `portStrategy: 'auto'` (или заданный явно). */
  port?: number;
  pid?: number;
  startedAt: string;
  /**
   * `unknown` — только env-tools: pid из реестра занят, но идентичность процесса не подтверждена
   * (запись до сверки времени старта, decision-60). Остановка лишь удаляет запись.
   */
  status: 'running' | 'stopped' | 'failed' | 'unknown';
  exitCode?: number;
  source: 'hub' | 'env-tools';
  /** URL, который открывается после старта (только для hub-процессов из ActionDefinition). */
  autoOpenUrl?: string;
}

/** Результат политики `worktreeInit` для только что созданного worktree (TASK-62). */
export interface WorktreeInitOutcome {
  ran: boolean;
  linkedNodeModules?: boolean;
  commands?: string[];
  process?: ManagedProcess;
  error?: string;
}

/** Владелец порта (TASK-62). */
export interface PortOwner {
  pid: number;
  processId?: string;
  name?: string;
  workspaceRoot?: string;
}

export interface RagSearchOptions {
  projectPath?: string;
  query: string;
  mode?: 'vector' | 'text' | 'all';
  limit?: number;
  global?: boolean;
}

export interface RagSearchResult {
  projectName: string;
  projectPath: string;
  filePath: string;
  fileRelative: string;
  heading?: string;
  snippet: string;
  score: number;
  type: 'vector' | 'text';
  /** `memory` — факт памяти проекта из backlog/memory (TASK-76). */
  category: 'doc' | 'decision' | 'task' | 'memory';
}

export interface LocalWhisperStatusInfo {
  status: 'unloaded' | 'loading' | 'ready' | 'error';
  model: string;
  cacheDir?: string;
  workerActive?: boolean;
  queueLength?: number;
  error?: string;
  loadTimeMs?: number;
  respawnAttempts?: number;
}

// ─── Подготовка звука перед распознаванием (TASK-164.2), зеркало speechPrepService ───

export type NoiseReduction = 'off' | 'gtcrn' | 'dpdfnet';

export type SpeechPrepResult =
  | { ok: true; speech: false; vadMs: number; denoiseMs: number }
  | { ok: true; speech: true; samples: Float32Array; speechSec: number; vadMs: number; denoiseMs: number }
  | { ok: false; error: string };

export type SpeechRecognizeResult =
  | { ok: true; speech: false; vadMs: number; denoiseMs: number }
  | { ok: true; speech: true; text: string; speechSec: number; vadMs: number; denoiseMs: number; asrMs: number }
  | { ok: false; error: string };

/** Локальные модели распознавания на sherpa (TASK-164.4), зеркало asrModelStore. */
export type AsrModelId = 'gigaam-v3-ru';

export interface AsrModelStatus {
  id: AsrModelId;
  label: string;
  installed: boolean;
  downloading: boolean;
  archiveBytes: number;
}

export interface AsrDownloadProgress {
  modelId: AsrModelId;
  phase: 'download' | 'verify' | 'extract' | 'done';
  receivedBytes: number;
  totalBytes: number;
}

export interface SpeechPrepStatusInfo {
  status: 'idle' | 'ready' | 'unavailable';
  workerActive: boolean;
  models: { vad: boolean; gtcrn: boolean; dpdfnet: boolean };
  respawnAttempts: number;
  error?: string;
}

// ─── Push-to-talk и LLM-классификатор голосовых команд (TASK-83), зеркало pushToTalkPolicy/voiceCommandClassifier ───

export type PushToTalkMode = 'hold' | 'toggle';

export interface PushToTalkSettings {
  enabled: boolean;
  /** Accelerator Electron либо клавиша-модификатор нативного хука: `RightControl`, `RightCommand`. */
  accelerator: string;
  mode: PushToTalkMode;
  trayIndicator: boolean;
  firstRepeatMs: number;
  repeatGraceMs: number;
}

export type PushToTalkSource = 'hook' | 'shortcut';

/** `taken` — сочетание занято другим приложением; `hook-*` — почему не заработал нативный хук. */
export type PushToTalkProblem = 'taken' | 'hook-module' | 'hook-permission' | 'hook-start';

export interface PushToTalkStatus {
  settings: PushToTalkSettings;
  /** Работает именно выбранная клавиша; `false` — она занята или заменена запасным сочетанием. */
  registered: boolean;
  recording: boolean;
  /** Удержание: у клавиши-модификатора везде, у сочетания `globalShortcut` — только в Windows. */
  supportsHold: boolean;
  /** Клавиша, которая работает на самом деле; `null` — не работает никакая. */
  activeKey: string | null;
  source: PushToTalkSource | null;
  activeMode: PushToTalkMode;
  problem: PushToTalkProblem | null;
  /** Клавиши-модификаторы, которые можно назначить на этой платформе. */
  nativeKeys: string[];
}

export interface PushToTalkEvent {
  active: boolean;
  mode: PushToTalkMode;
  durationMs: number;
  /** Нажатие оказалось сочетанием клавиш: записанное выбрасывается, а не распознаётся. */
  cancelled?: boolean;
}

/**
 * Размер системного оверлея голоса (TASK-83): полоса внизу экрана, широкая полоса на время записи
 * по горячей клавише и крупное окно по центру в режиме диктовки. Геометрию применяет main.
 */
export type VoiceOverlayMode = 'compact' | 'wide' | 'full';

/** Действия из системного оверлея; `dismiss-result` закрывает карточку результата (TASK-115). */
export type VoiceOverlayAction = 'toggle-pause' | 'stop' | 'dismiss-result';

/** Карточка результата push-to-talk, зеркало `src/utils/voiceResultCard.ts`. */
export interface VoiceOverlayResultCard {
  id: number;
  transcript: string;
  feedback: string | null;
  status: 'classifying' | 'done';
}

export interface VoiceOverlayPayload {
  isListening: boolean;
  isPaused: boolean;
  state: string;
  transcript: string;
  audioLevel: number;
  mode?: VoiceOverlayMode;
  /** Итог последней команды: «Открываю доску задач», «Напечатано: …». */
  feedback?: string;
  /** Закреплённая карточка результата push-to-talk; `null` — карточки нет (TASK-115). */
  resultCard?: VoiceOverlayResultCard | null;
}

export type VoiceIntentType = 'navigation' | 'action' | 'ai_control' | 'computer' | 'dictation' | 'unknown';

export interface VoiceClassification {
  intent: string;
  type: VoiceIntentType;
  payload?: Record<string, unknown>;
  /** 0..1; ниже порога команда не выполняется, а переспрашивается голосом. */
  confidence: number;
  source: 'json' | 'bare' | 'none';
  error?: string;
}

export interface VoiceClassifyRequest {
  transcript: string;
  language?: 'ru' | 'en';
  /** Открытые проекты — подсказка модели для «переключись на …». */
  projectNames?: string[];
  hasPendingApproval?: boolean;
  /** Активный проект: по нему Claude Code берёт аккаунт (decision-87). */
  projectPath?: string;
}

export interface VoiceClassifyResponse {
  ok: boolean;
  /** Ответ взят из кэша частых фраз, модель не опрашивалась. */
  cached?: boolean;
  result: VoiceClassification | null;
  /** Уверенности достаточно, чтобы выполнять команду без голосового переспроса. */
  confident?: boolean;
  model?: string;
  provider?: string;
  error?: string;
  /** Код ошибки (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
  /** Цель назначения «Голос: разбор команды» непригодна: `error` называет назначение (TASK-134.4). */
  modelProblem?: boolean;
}

/** Голосовая команда управления компьютером: один ход агента с инструментами computer_* (TASK-83). */
export interface VoiceComputerTaskRequest {
  task: string;
  projectPath: string;
}

export interface VoiceComputerTaskResponse {
  ok: boolean;
  /** Короткий итог для озвучки. */
  text?: string;
  /** Код причины (`computer_use_disabled`, `timeout`, …) либо сообщение об ошибке. */
  error?: string;
  /** Код ошибки (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
  /** Цель назначения «Голос: команда компьютеру» непригодна: `error` называет назначение (TASK-134.4). */
  modelProblem?: boolean;
}

/** Системная диктовка: распознанный текст печатается в активное окно (TASK-83). */
export interface VoiceDictateRequest {
  text: string;
  projectPath: string;
  /** Расставить знаки препинания настроенной моделью перед печатью. */
  punctuate?: boolean;
}

export interface VoiceDictateResponse {
  ok: boolean;
  /** Что было напечатано с учётом пунктуации. */
  typed?: string;
  detail?: string;
  error?: string;
  /** Код причины отказа (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
}

// ─── Локальный TTS на голосах Piper (TASK-69, decision-25) ───
export type TtsVoiceLanguage = 'ru' | 'en';
export type TtsVoiceSource = 'builtin' | 'imported';

/** Движок, которым звучит голос: Piper в utilityProcess или Qwen3-TTS в сайдкаре (TASK-104). */
export type TtsVoiceEngine = 'piper' | 'qwen';

export interface TtsVoiceListItem {
  id: string;
  label: string;
  engine: TtsVoiceEngine;
  language: TtsVoiceLanguage;
  source: TtsVoiceSource;
  installed: boolean;
  downloading: boolean;
  /** Размер архива для ещё не скачанного голоса. */
  archiveBytes?: number;
  /** Размер установленного голоса на диске. */
  sizeBytes?: number;
  sampleRate?: number;
}

/** Память проекта (TASK-76, decision-51): факт из backlog/memory. */
export type MemoryFactType = 'project' | 'feedback' | 'reference';

export interface MemoryFactInfo {
  id: string;
  title: string;
  description: string;
  type: MemoryFactType;
  created: string;
  updated?: string;
  source?: string;
  author?: string;
  body: string;
  fileName: string;
}

export interface MemoryIssueInfo {
  code: string;
  field?: string;
}

export interface MemoryDraftInput {
  title: string;
  description: string;
  body: string;
  type: MemoryFactType;
  source?: string;
  author?: string;
}

export interface MemoryFailure {
  ok: false;
  error: string;
  /** Код ошибки хранилища, формата или `invalid_project` — переводится в рендерере. */
  errorCode?: string;
  details?: { issues?: MemoryIssueInfo[]; secretKinds?: string[]; duplicateOf?: string; duplicateTitle?: string };
}

export type MemoryListResult =
  | { ok: true; facts: MemoryFactInfo[]; invalid: Array<{ fileName: string; issues: MemoryIssueInfo[] }> }
  | MemoryFailure;

export type MemoryWriteResult = { ok: true; fact: MemoryFactInfo; replaced: boolean } | MemoryFailure;

export type MemoryOperationResult = { ok: true } | MemoryFailure;

export interface TtsStatusInfo {
  status: 'unloaded' | 'loading' | 'ready' | 'error' | 'unavailable';
  voiceId: string | null;
  sampleRate: number | null;
  workerActive: boolean;
  queueLength: number;
  loadTimeMs?: number;
  respawnAttempts: number;
  error?: string;
  /** Код причины недоступности — рендерер переводит его через i18n. */
  errorCode?: string;
  available: boolean;
  espeakDataInstalled: boolean;
}

export interface TtsDownloadProgress {
  voiceId: string;
  phase: 'download' | 'verify' | 'extract' | 'done';
  receivedBytes: number;
  totalBytes: number;
}

export interface TtsChunkPayload {
  jobId: string;
  samples: Float32Array;
  sampleRate: number;
  index: number;
}

export interface TtsDonePayload {
  jobId: string;
  timeMs: number;
  audioSec: number;
  chunks: number;
}

export interface TtsErrorPayload {
  jobId: string;
  error: string;
  /** Код причины от движка Qwen3-TTS — переводится через `ttsErrors`. */
  errorCode?: string;
}

export interface TtsSpeakRequest {
  jobId: string;
  text: string;
  /** Идентификатор голоса; по нему main выбирает движок (`qwen:` — Qwen3-TTS, иначе Piper). */
  voiceId: string;
  speed?: number;
  speakerId?: number;
  /** Язык текста — нужен Qwen3-TTS, у Piper язык задан голосом. */
  language?: 'ru' | 'en';
  /** Инструкция подачи для пресет-голоса Qwen3-TTS. */
  instruct?: string;
  /** Рецепт несохранённого голоса — проба; текст пробы задаёт main (текст эталонной записи). */
  draft?: { instruct: string; seed: number };
}

// ─── Второй движок озвучки: Qwen3-TTS в сайдкаре Python (TASK-104, decision-64) ───
/** Вид голоса — то, что выбирает пользователь. */
export type QwenVoiceKind = 'custom' | 'design';
/**
 * Вид модели в сайдкаре: `custom` — пресет-голоса, `design` — создание голоса по описанию,
 * `base` — озвучка голосом эталонной записи (ею звучат сохранённые голоса по описанию).
 */
export type QwenModelKind = 'custom' | 'design' | 'base';

export interface QwenVoiceListItem {
  id: string;
  label: string;
  engine: 'qwen';
  kind: QwenVoiceKind;
  installed: boolean;
  /** Родной язык диктора-пресета: русского среди них нет. */
  native?: string;
  gender?: string;
  /** Рецепт голоса по описанию: по нему один раз создана эталонная запись. */
  instruct?: string;
  seed?: number;
  createdAt?: string;
}

export interface QwenInstallStatusInfo {
  installed: boolean;
  runtimeReady: boolean;
  models: Record<QwenModelKind, boolean>;
  python: string | null;
  torch: string | null;
  gpu: string | null;
}

export interface QwenInstallProgressInfo {
  state: 'idle' | 'running' | 'done' | 'error';
  phase: string | null;
  lastLine: string;
  file: string;
  receivedBytes: number;
  totalBytes: number;
  overallReceived: number;
  overallTotal: number;
  errorCode?: string;
  error?: string;
}

export interface QwenTtsStatusInfo {
  status: 'unloaded' | 'starting' | 'loading' | 'ready' | 'error' | 'unavailable';
  modelKind: QwenModelKind | null;
  sampleRate: number | null;
  processActive: boolean;
  queueLength: number;
  loadTimeMs?: number;
  vramMb?: number;
  gpu?: string;
  respawnAttempts: number;
  chunkSize: number;
  idleUnloadMs: number;
  /** Модель держится в памяти без выгрузки по простою (TASK-119). */
  keepLoaded: boolean;
  error?: string;
  errorCode?: string;
  install: QwenInstallStatusInfo;
  installProgress: QwenInstallProgressInfo;
}

export interface QwenVoiceOperationResult {
  ok: boolean;
  error?: string;
  errorCode?: string;
  detail?: string;
  voice?: QwenVoiceListItem;
}

export interface TtsOperationResult {
  ok: boolean;
  error?: string;
  errorCode?: string;
  detail?: string;
  canceled?: boolean;
  voice?: TtsVoiceListItem;
}

export interface GitFileStatus {
  path: string;
  index: string; // 'M', 'A', 'D', '?'
  working_dir: string;
  staged: boolean;
}

export interface GitRepoDetails {
  currentBranch: string;
  branches: string[];
  remoteBranches: string[];
  commits: GitCommit[];
  files: GitFileStatus[];
  stashes: string[];
  tags: string[];
  isClean: boolean;
  /** Незавершённое слияние (есть MERGE_HEAD): файлы в конфликте, в том числе сгенерированные (TASK-139.3). */
  merging?: { conflicted: string[] };
}

export type {
  ConflictChoice,
  ConflictFileContent,
  ConflictFileKind,
  ConflictFileState,
  ConflictResolution,
  ConflictSegment,
  FinishMergeResult,
  MergeActionResult,
  MergeConflictFile,
  MergeFailure,
  MergeState
} from '../../electron/services/mergeConflicts';
import type { ConflictFileContent, ConflictResolution, FinishMergeResult, MergeActionResult, MergeState } from '../../electron/services/mergeConflicts';
export type { BaseSyncResult as PullBaseResult } from '../../electron/services/baseSync';
import type { BaseSyncResult as PullBaseResult } from '../../electron/services/baseSync';
import type { ProfileSectionId } from '../lib/profileSections';
import type { ProfilePreview } from '../../electron/services/profileService';

export interface PullRequest {
  id: number | string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  sourceBranch: string;
  targetBranch: string;
  body: string;
  labels: string[];
  checksStatus?: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'NONE';
  provider: PRHostingId | 'custom';
  commentsCount?: number;
  draft?: boolean;
  /** Голова PR; у Bitbucket — короткий хэш. */
  headSha?: string;
  /** Решение ревью (GitHub). */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  /** PR из форка: голову у Bitbucket не получить веткой. */
  fromFork?: boolean;
}

export type PRHostingId = 'github' | 'gitlab' | 'gitea' | 'bitbucket';

export interface PRCreateOptions {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch?: string;
  draft?: boolean;
}

export interface PRProviderInfo {
  provider: PRHostingId | 'none';
  repo?: string;
  remoteUrl?: string;
  /** Установлен GitHub CLI. */
  hasCli: boolean;
  /** PR можно читать и создавать: есть подключение или вход `gh`. */
  authenticated: boolean;
  /** Чем ходит ProjectHub (TASK-138.2, decision-105): подключение decision-102, GitHub CLI или ничем. */
  via: 'connection' | 'cli' | 'none';
  connectionId?: string;
  connectionLabel?: string;
  /** Подключение, выбранное для проекта вручную; без него подключение выбирается автоматически. */
  pinnedConnectionId?: string;
  /** Подключения к хостингу этого remote — для выбора в окне PR. */
  connections: Array<{ id: string; label: string; status: ConnectionStatus }>;
  /** Вход CLI, токен которого можно перенести в подключение без повторного ввода. */
  importableCli?: 'gh' | 'glab';
  /** Слияние PR переводит задачу из Review в этот статус (TASK-138.5); нет — не переводит. */
  mergeStatus?: string;
}

// ─────────────────── Рабочие чаты (TASK-138.4) — зеркало electron/services/chatSubscriptions.ts ───────────────────

export type ChatKind = 'slack' | 'mattermost' | 'telegram' | 'teams';

export interface ChatSubscription {
  id: string;
  enabled: boolean;
  kind: ChatKind;
  connectionId?: string;
  /** Id канала Slack или Mattermost, id чата Telegram. */
  channel: string;
  channelLabel?: string;
  kinds: NotificationKind[];
  /** Пусто — все проекты. */
  projects: string[];
  /** Текст события целиком (команда HITL, путь файла). */
  details: boolean;
  /** Кто решает HITL кнопками (TASK-138.6): id пользователей Slack или Mattermost; пусто — никто. */
  deciders: string[];
  /** Slack: подключение приложения (Socket Mode) для кнопок. */
  appConnectionId?: string;
}

// ─────────────────── CI/CD (TASK-138.3) — зеркало electron/services/ciProviders.ts и ciService.ts ───────────────────

export type CiProviderId = 'github-actions' | 'gitlab-ci' | 'jenkins';
export type CiStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'manual';

export interface CiRun {
  id: string;
  provider: CiProviderId;
  name: string;
  number?: number;
  status: CiStatus;
  branch: string;
  sha: string;
  url: string;
  event?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CiJob {
  id: string;
  name: string;
  stage?: string;
  status: CiStatus;
  url: string;
  startedAt?: string;
  finishedAt?: string;
  failedStep?: string;
}

export interface CiRunDetail extends CiRun {
  jobs: CiJob[];
}

export interface CiProviderInfo {
  id: CiProviderId;
  label: string;
  via: string;
}

export interface CiRunsResult {
  ok: boolean;
  runs: CiRun[];
  providers: CiProviderInfo[];
  summary: CiStatus | null;
  errors: string[];
}

export interface CiJobLog {
  job: CiJob;
  text: string;
  truncated: boolean;
  totalLines: number;
}

export interface JenkinsSetting {
  connectionId: string;
  /** Путь задания: `folder/app`, у multibranch — `app/{branch}`. */
  job: string;
}

/** PR, связанный с задачей (TASK-138.2): по ссылке в `references` или по номеру задачи в ветке и заголовке. */
export interface TaskPullRequestsResult {
  ok: boolean;
  prs: PullRequest[];
  /** Ветка задачи из поля `branch` — для статуса CI без PR (TASK-138.3). */
  branch?: string;
  /** Ссылки на PR из задачи, статус которых получить не удалось (нет подключения, сеть). */
  unresolved: string[];
  error?: string;
  /** Код ошибки (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
}

export interface DocItem {
  id: string;
  title: string;
  category: 'doc' | 'decision';
  filePath: string;
  fileRelative: string;
  tags: string[];
  /** Раздел дерева документации через `/`: поле `section` frontmatter или вложенная папка (decision-68). */
  section?: string;
  status?: string;
  date?: string;
  updatedAt?: string;
  size: number;
}

/** Объект, в тексте которого есть ссылка на документ (TASK-122, decision-69). */
export interface DocBacklink {
  /** Идентификатор как в источнике: `decision-46`, `doc-5`, `TASK-103`, `mem-3`. */
  id: string;
  kind: 'decision' | 'doc' | 'task' | 'mem';
  title: string;
  status?: string;
}

/** Связи документации проекта: обратные ссылки и заголовки документов (decision-69). */
export interface DocLinkIndex {
  /** id документа в нижнем регистре → кто на него ссылается. */
  backlinks: Record<string, DocBacklink[]>;
  /** id документа в нижнем регистре → ключи его заголовков (`headingAnchorKey`). */
  headings: Record<string, string[]>;
}

/** Итог «Открыть в Obsidian» (decision-133): `written` — созданные или обновлённые файлы `.obsidian/`. */
export type ObsidianOpenResult =
  | { status: 'opened'; vaultPath: string; written: string[]; registered: boolean }
  | { status: 'needs-manual'; vaultPath: string; written: string[] }
  | { status: 'not-installed'; vaultPath: string; written: string[] }
  | { status: 'no-backlog' };

/** Тип документа во frontmatter Backlog.md (`type:`), правило 13 CLAUDE.md. */
export type DocFileType = 'guide' | 'readme' | 'specification' | 'other';
/** Статус ADR во frontmatter Backlog.md (`status:`), правило 13 CLAUDE.md. */
export type DecisionStatus = 'accepted' | 'proposed' | 'rejected' | 'deprecated';

export interface CreateDocParams {
  type: 'doc' | 'decision';
  title: string;
  /** Для decision: accepted | proposed | rejected | deprecated (регистр не важен). */
  status?: string;
  /** Для doc: guide | readme | specification | other. По умолчанию other. */
  docType?: DocFileType;
  tags?: string[];
  /** Раздел дерева документации через `/` (decision-68); пишется в поле `section` frontmatter. */
  section?: string;
  /** Тело документа. Если содержит свой frontmatter — берётся только тело, frontmatter генерируется по стандарту. */
  content?: string;
}

// ── Ветки документации (TASK-194, decision-151) — зеркало electron/services/docBranches.ts ──

export type DocResolution = 'ours' | 'theirs' | 'both' | { text: string };
export type DocBranchResolutions = Record<string, Record<string, DocResolution>>;

export interface DocBranchMeta {
  id: string;
  title: string;
  status: 'open' | 'proposed' | 'merged' | 'closed';
  prefix: string;
  base: string;
  author?: string;
  sessionId?: string;
  task?: string;
  createdAt: string;
  updatedAt: string;
  proposal?: string;
  proposedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  closedAt?: string;
}

export interface DocConflict {
  key: string;
  label: string;
  scope: 'frontmatter' | 'section';
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface DocBranchFile {
  path: string;
  branchPath: string;
  docId: string;
  title: string;
  change: 'added' | 'modified' | 'removed';
  parts: Array<{ key: string; label: string; scope: 'frontmatter' | 'section'; change: 'added' | 'removed' | 'modified' }>;
  mainChanged: boolean;
  conflicts: DocConflict[];
  renumberedFrom?: string;
  base: string | null;
  branch: string | null;
  main: string | null;
  merged: string | null;
}

export interface DocBranchDiff {
  branch: DocBranchMeta;
  files: DocBranchFile[];
  renumbered: Array<{ kind: string; from: string; to: string }>;
}

export interface DocBranchSummary extends DocBranchMeta {
  docs: Array<{ docId: string; title: string; path: string; change: 'added' | 'modified' | 'removed'; conflicts: number }>;
  conflicts: number;
}

export interface DocBranchesOverview {
  available: boolean;
  branches: DocBranchSummary[];
}

export interface DocBranchMergeResult {
  status: 'merged' | 'partial' | 'conflict' | 'nothing';
  written: string[];
  removed: string[];
  renumbered: Array<{ kind: string; from: string; to: string }>;
  conflicts: Array<DocConflict & { doc: string; path: string }>;
  branch: DocBranchMeta;
}

export interface IElectronAPI {
  // Projects & Registry
  listProjects: () => Promise<ProjectInfo[]>;
  scanProjects: (options?: ScanOptions) => Promise<ProjectInfo[]>;
  addProject: (folderPath: string) => Promise<ProjectInfo | null>;
  removeProject: (projectPath: string) => Promise<boolean>;
  refreshProject: (projectPath: string) => Promise<ProjectInfo | null>;
  toggleFavorite: (projectPath: string) => Promise<boolean>;
  getScanRoots: () => Promise<string[]>;
  setScanRoots: (roots: string[]) => Promise<boolean>;
  getProjectDetails: (projectPath: string) => Promise<ProjectInfo | null>;
  setProjectVoiceAlias: (projectPath: string, alias: string) => Promise<boolean>;

  // Documentation & ADR Decisions
  listDocs: (projectPath: string) => Promise<DocItem[]>;
  getDocLinkIndex: (projectPath: string) => Promise<DocLinkIndex>;
  /** Граф ссылок решений, документов, задач и памяти (TASK-175, decision-134). */
  getDocLinkGraph: (projectPath: string) => Promise<ProjectGraph>;
  /** Готовит `backlog/` как хранилище Obsidian и открывает его (TASK-178, decision-133). */
  openDocsInObsidian: (projectPath: string) => Promise<ObsidianOpenResult>;
  readDoc: (filePath: string) => Promise<string>;
  saveDoc: (filePath: string, content: string) => Promise<boolean>;
  createDoc: (projectPath: string, params: CreateDocParams) => Promise<DocItem>;
  /** Ветки документации (TASK-194, decision-151): открытые и предложенные с изменёнными документами. */
  listDocBranches: (projectPath: string) => Promise<DocBranchesOverview>;
  diffDocBranch: (projectPath: string, branchId: string) => Promise<DocBranchDiff>;
  /** Принять ветку целиком или документы `docs`; конфликт без `resolutions` — ничего не пишется. */
  mergeDocBranch: (
    projectPath: string,
    branchId: string,
    options?: { docs?: string[]; resolutions?: DocBranchResolutions }
  ) => Promise<DocBranchMergeResult>;
  closeDocBranch: (projectPath: string, branchId: string) => Promise<DocBranchMeta>;

  // Project Template Wizard
  checkTemplateAvailable: (customSource?: string) => Promise<TemplateAvailability>;
  setTemplatePath: (templatePath: string | null) => Promise<boolean>;

  // Инициализация проекта и каталог шаблонов (TASK-136, decision-78)
  initSelectFolder: () => Promise<string | null>;
  initPreview: (request: import('./projectInit').InitRequest) => Promise<import('./projectInit').IpcResult<import('./projectInit').InitPreview>>;
  initApply: (request: import('./projectInit').InitApplyRequest) => Promise<import('./projectInit').IpcResult<import('./projectInit').InitReport>>;
  initFoundationStatus: (projectPath: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').FoundationPart[]>>;
  initTemplateStatus: (projectPath: string, locale: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateUpdateStatus>>;
  onInitProgress: (callback: (event: import('./projectInit').InitProgressEvent) => void) => () => void;
  templatesList: (locale: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry[]>>;
  templatesAddFolder: () => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry | null>>;
  templatesAddZip: () => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry | null>>;
  templatesAddGit: (url: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry>>;
  templatesUpdate: (id: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry>>;
  templatesDuplicate: (id: string, name?: string) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry>>;
  templatesRemove: (id: string) => Promise<import('./projectInit').IpcResult<void>>;
  templatesSetTrusted: (id: string, trusted: boolean) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry>>;
  templatesOpenFolder: (id: string) => Promise<import('./projectInit').IpcResult<boolean>>;
  templatesPreviewSaveProject: (
    projectPath: string,
    options: { name: string; description?: string; exclude?: string[] }
  ) => Promise<import('./projectInit').IpcResult<import('./projectInit').SaveTemplatePreview>>;
  templatesSaveProject: (
    projectPath: string,
    options: { name: string; description?: string; exclude?: string[] }
  ) => Promise<import('./projectInit').IpcResult<import('./projectInit').TemplateEntry>>;

  // Background Processes & Terminal
  startProcess: (
    projectPath: string,
    command: string,
    name: string,
    options?: StartProcessOptions
  ) => Promise<ManagedProcess>;
  stopProcess: (processId: string) => Promise<boolean>;
  /** Кто слушает порт: pid и, если это процесс Hub, его id/имя/рабочее дерево (TASK-62). */
  listPortOwners: (port: number) => Promise<PortOwner[]>;
  /** Освободить порт: hub-процессы останавливаются штатно, посторонние pid'ы снимаются. */
  releasePort: (port: number) => Promise<{ killed: number[]; failed: number[] }>;
  restartProcess: (processId: string) => Promise<ManagedProcess>;
  listProcesses: (projectPath: string) => Promise<ManagedProcess[]>;
  tailProcessLog: (projectPath: string, processName: string, lines?: number) => Promise<string>;
  onProcessLogChunk: (callback: (data: { processId: string; text: string }) => void) => () => void;
  onProcessStatusChanged: (callback: (process: ManagedProcess) => void) => () => void;

  // Action Runner & Script Config (.projecthub.json)
  getActionConfig: (projectPath: string) => Promise<ProjectActionConfig>;
  saveActionConfig: (projectPath: string, config: ProjectActionConfig) => Promise<boolean>;

  // Vector RAG & Knowledge Search
  searchDocs: (options: RagSearchOptions) => Promise<RagSearchResult[]>;
  getRagStats: (projectPath: string) => Promise<{ hasIndex: boolean; chunksCount: number; lastModified?: string }>;

  // System Dialogs & Launchers
  selectDirectory: () => Promise<string | null>;
  openInExplorer: (targetPath: string) => Promise<void>;
  /** `ok: false` — VS Code не найден или не запустился (decision-73) */
  openInCode: (targetPath: string) => Promise<{ ok: boolean; error?: string } | void>;
  openTerminal: (targetPath: string) => Promise<void>;

  // Backlog Tasks & Real-time Watcher
  getTasks: (projectPath: string) => Promise<BacklogTask[]>;
  /** Статусы и прочие настройки из `backlog/config.yml` проекта (TASK-68). */
  getBacklogConfig: (projectPath: string) => Promise<BacklogProjectConfig>;
  /** Сырой markdown задачи (frontmatter + тело) по абсолютному пути файла; null, если файл не прочитан. */
  getTaskContent: (filePath: string) => Promise<string | null>;
  updateTaskStatus: (filePath: string, newStatus: string) => Promise<boolean>;
  /** Подтвердить задачу, заведённую агентом: снять метку `agent-created` (decision-89). */
  approveAgentTask: (filePath: string) => Promise<boolean>;
  /** Подтвердить все неподтверждённые задачи этого автора (`reporter`) в проекте; id подтверждённых. */
  approveAgentTasksByReporter: (projectPath: string, reporter: string) => Promise<{ approved: string[] }>;
  saveTask: (filePath: string, content: string) => Promise<boolean>;
  saveFullTask: (
    filePath: string,
    data: {
      title: string;
      status: BacklogTask['status'];
      labels: string[];
      milestone?: string;
      assignee?: string[];
      description: string;
      criteria?: TaskCriterion[];
    }
  ) => Promise<boolean>;
  toggleCriterion: (filePath: string, index: number, completed: boolean) => Promise<boolean>;
  createTask: (projectPath: string, task: { title: string; description: string; labels: string[]; type?: string; priority?: string; milestone?: string }) => Promise<BacklogTask | null>;
  deleteTask: (filePath: string) => Promise<boolean>;
  watchProjectTasks: (projectPath: string) => Promise<void>;
  onTasksChanged: (callback: (data: { projectPath: string; event: string; filePath: string }) => void) => () => void;

  // Milestones & Roadmap
  listMilestones: (projectPath: string) => Promise<Milestone[]>;
  createMilestone: (projectPath: string, params: CreateMilestoneParams) => Promise<Milestone | null>;
  saveMilestone: (filePath: string, params: Partial<CreateMilestoneParams>) => Promise<boolean>;
  deleteMilestone: (filePath: string) => Promise<boolean>;

  // Реестр ролей агентов (decision-9, TASK-60)
  listRoles: (projectPath?: string) => Promise<{ roles: RoleDefinition[]; errors: { error: string; filePath: string }[] }>;
  /** Лимиты задач, заведённых агентами (TASK-155, decision-89 п. 6). */
  getAgentTaskSettings: () => Promise<AgentTaskSettings>;
  saveAgentTaskSettings: (settings: AgentTaskSettings) => Promise<AgentTaskSettings>;
  saveRole: (scope: 'global' | 'project', role: RoleDefinition, projectPath?: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  deleteRole: (scope: 'global' | 'project', slug: string, projectPath?: string) => Promise<boolean>;
  copyRoleToProject: (slug: string, projectPath: string) => Promise<RoleDefinition | null>;
  planRoleSync: (projectPath: string, options: RoleSyncOptionsInput) => Promise<RoleSyncPlan>;
  applyRoleSync: (
    projectPath: string,
    options: RoleSyncOptionsInput,
    choices: { overwrite?: string[]; deleteOrphans?: string[] }
  ) => Promise<{ success: true; result: RoleSyncResult } | { success: false; error: string }>;
  getTerminalHookSettings: () => Promise<TerminalHookSettings>;
  saveTerminalHookSettings: (settings: TerminalHookSettings) => Promise<TerminalHookSettings>;
  getTerminalHookConnection: () => Promise<{ url: string | null; token: string; failMode: 'open' | 'closed' }>;
  regenerateTerminalHookToken: () => Promise<boolean>;
  listProjectSkills: (projectPath: string) => Promise<ProjectSkillListing>;
  listSkillSources: (projectPath: string) => Promise<SkillSourceInfo[]>;
  listSourceSkills: (
    projectPath: string,
    source: SkillSourceRef
  ) => Promise<{ success: true; listing: SkillSourceListing } | { success: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  copySkill: (
    projectPath: string,
    request: SkillCopyRequest
  ) => Promise<{ success: true; result: SkillCopyResult } | { success: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;

  // Git Advanced
  getGitRepoDetails: (projectPath: string) => Promise<GitRepoDetails | null>;
  unwatchGit: (projectPath: string) => Promise<boolean>;
  checkoutBranch: (projectPath: string, branchName: string, createNew?: boolean) => Promise<boolean>;
  createBranch: (projectPath: string, branchName: string) => Promise<boolean>;
  deleteBranch: (projectPath: string, branchName: string, force?: boolean) => Promise<boolean>;
  /** Совпали номера backlog — `renumberRequired`, повтор с `renumber: true` после согласия человека (decision-76). */
  mergeBranch: (projectPath: string, branchName: string, options?: MergeOptions) => Promise<MergeWorktreeResult>;
  fetchRemote: (projectPath: string) => Promise<boolean>;
  pullRemote: (projectPath: string) => Promise<{ success: boolean; error?: string }>;
  getMergeState: (projectPath: string) => Promise<MergeState>;
  getConflictFile: (projectPath: string, filePath: string) => Promise<ConflictFileContent>;
  resolveConflict: (projectPath: string, filePath: string, resolution: ConflictResolution) => Promise<MergeActionResult>;
  finishMerge: (projectPath: string) => Promise<FinishMergeResult>;
  abortMerge: (projectPath: string) => Promise<MergeActionResult>;
  pushRemote: (projectPath: string) => Promise<{ success: boolean; error?: string }>;
  discardFileChanges: (projectPath: string, filePath: string) => Promise<boolean>;
  getDiffBetween: (projectPath: string, targetA: string, targetB?: string, filePath?: string) => Promise<string>;
  stageFile: (projectPath: string, filePath: string) => Promise<boolean>;
  unstageFile: (projectPath: string, filePath: string) => Promise<boolean>;
  stageAll: (projectPath: string) => Promise<boolean>;
  /** Коммит проверяется сканером секретов (decision-56 п. 4); `acknowledgeSecrets` — хэш индекса из отказа. */
  commitChanges: (projectPath: string, message: string, stageAll?: boolean, acknowledgeSecrets?: string) => Promise<GitCommitResult>;
  getFileDiff: (projectPath: string, filePath: string, staged?: boolean) => Promise<string>;
  onGitChanged: (callback: (data: { projectPath: string }) => void) => () => void;
  getGitLog: (projectPath: string, maxCount?: number) => Promise<GitCommit[]>;
  getGitStatus: (projectPath: string) => Promise<any>;

  // Git Worktrees (TASK-53, TASK-55)
  listWorktrees: (projectPath: string) => Promise<GitWorktreeInfo[]>;
  addWorktree: (projectPath: string, options: AddWorktreeOptions) => Promise<GitWorktreeInfo>;
  removeWorktree: (projectPath: string, worktreePath: string, force?: boolean) => Promise<boolean>;
  pruneWorktrees: (projectPath: string) => Promise<boolean>;
  getWorktreeDiff: (projectPath: string, worktreeBranch: string, baseBranch: string, worktreePath?: string) => Promise<string>;
  mergeWorktree: (projectPath: string, worktreeBranch: string, targetBranch: string, options?: MergeOptions) => Promise<MergeWorktreeResult>;
  /** Слить `targetBranch` в ветку worktree внутри worktree; при конфликте слияние остаётся незавершённым (TASK-139.6). */
  pullBaseIntoWorktree: (projectPath: string, worktreePath: string, targetBranch: string) => Promise<PullBaseResult>;
  checkoutWorktreeFiles: (projectPath: string, branch: string, filePaths: string[]) => Promise<{ success: boolean; error?: string; files?: string[] }>;
  findOrphanedWorktrees: (projectPath: string, activeTaskIds: string[], activeSwarmIds: string[]) => Promise<OrphanedWorktreeScan>;
  cleanOrphanedWorktrees: (projectPath: string, worktreePaths: string[], branches: string[]) => Promise<CleanOrphanedResult>;

  // Pull & Merge Requests
  getPRProviderInfo: (projectPath: string) => Promise<PRProviderInfo>;
  listPullRequests: (projectPath: string, state?: 'all' | 'open' | 'closed' | 'merged') => Promise<PullRequest[]>;
  createPullRequest: (projectPath: string, options: PRCreateOptions) => Promise<PullRequest | null>;
  getPRDiff: (projectPath: string, prNumber: number) => Promise<string>;
  /** Подключение для PR проекта (TASK-138.2); `null` — выбирать автоматически. */
  setPRConnection: (projectPath: string, connectionId: string | null) => Promise<PRProviderInfo>;
  /** Перенести вход gh/glab в подключение без повторного ввода токена. */
  importPRCliLogin: (projectPath: string) => Promise<{ id: string; label: string }>;
  /** Статус, в который слияние PR переводит задачу из Review (TASK-138.5); `null` — не переводить. */
  setPRMergeStatus: (projectPath: string, status: string | null) => Promise<PRProviderInfo>;
  getTaskPullRequests: (projectPath: string, taskId: string) => Promise<TaskPullRequestsResult>;
  // Ревью PR (TASK-81, decision-53)
  listPrReviews: (projectPath: string, prNumber?: number) => Promise<{ ok: boolean; reviews: PrReviewRecord[]; error?: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  startPrReview: (projectPath: string, prNumber: number, options: PrReviewStartOptions) => Promise<{ ok: true; reviewId: string } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  publishPrReview: (projectPath: string, reviewId: string) => Promise<{ ok: true; url: string } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  onPrReviewChanged: (callback: () => void) => () => void;

  // Interactive PTY Terminals (Claude Code & Multi-tab Shell)
  createPtySession: (options: CreatePtyOptions) => Promise<PtySession>;
  writePty: (sessionId: string, data: string) => Promise<boolean>;
  resizePty: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
  killPty: (sessionId: string) => Promise<boolean>;
  listPtySessions: () => Promise<PtySession[]>;
  onPtyData: (callback: (data: { sessionId: string; data: string }) => void) => () => void;
  onPtyExit: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void;
  /** Завершившаяся PTY-сессия удалена автоматически по TTL (TASK-50). */
  onPtyRemoved: (callback: (data: { sessionId: string; title: string; reason: 'ttl' }) => void) => () => void;

  // Agents Studio & Claude Bridge Engine
  getAIConfig: () => Promise<AIProviderConfig>;
  saveAIConfig: (config: AIProviderConfig) => Promise<void>;
  getLlmProviderPresets: () => Promise<LlmProviderPreset[]>;
  listLlmProfiles: () => Promise<LlmProfileView[]>;
  /** `apiKey`: `undefined` — оставить прежний, пустая строка или `null` — удалить. */
  saveLlmProfile: (profile: LlmProfile, apiKey?: string | null) => Promise<LlmProfileView>;
  deleteLlmProfile: (id: string) => Promise<boolean>;
  listLlmProfileModels: (id: string, refresh?: boolean) => Promise<ModelCatalogResult>;
  /** Перенос сохранённого прежнего провайдера Agents Studio в профиль (decision-40); конфиг не меняет. */
  importLegacyLlmProfile: (provider: string) => Promise<LlmProfileView>;
  /** Таблица цен агентов: встроенная и переопределения `agent-pricing.json` (TASK-70.4, decision-42). */
  getAgentPricing: () => Promise<AgentPricingState>;
  saveAgentPricing: (overrides: PriceOverrides) => Promise<AgentPricingState>;
  /** Цены OpenRouter (`GET /api/v1/models`, без ключа); ничего не сохраняет. */
  fetchOpenRouterPrices: () => Promise<OpenRouterImportResult>;
  /** Тиры моделей `<userData>/model-tiers.json` (TASK-79, decision-44); при первом чтении — заполнение из настроенного. */
  getModelTiers: () => Promise<ModelTierState>;
  saveModelTiers: (settings: ModelTierSettings) => Promise<ModelTierState>;
  /** «Заполнить из настроенного» поверх черновика; ничего не сохраняет. */
  seedModelTiers: (draft?: ModelTierSettings) => Promise<ModelTierSeedResult>;
  /** Назначения моделей (TASK-134.3, decision-74 п. 5). */
  getModelAssignments: () => Promise<ModelAssignmentState>;
  saveModelAssignments: (settings: ModelAssignments) => Promise<ModelAssignmentState>;
  /** «Сейчас» для каждого назначения на черновике окна: ничего не сохраняет. */
  previewModelAssignments: (draft?: { assignments?: ModelAssignments; main?: Partial<AIProviderConfig> }) => Promise<Record<ModelPurpose, ModelRouteView>>;
  /** Черновик описания и критериев задачи моделью назначения `task.draft` (TASK-134.4). */
  generateTaskDraft: (request: TaskDraftRequest) => Promise<TaskDraftResponse>;
  getClaudeAuthStatus: (query?: { projectPath?: string; accountId?: string; force?: boolean }) => Promise<ClaudeAuthStatus>;
  claudeLogout: (query?: { projectPath?: string; accountId?: string }) => Promise<boolean>;
  /** Сессии Claude Code рабочей папки под аккаунтом вкладки Studio (TASK-230, `/resume`). */
  listCliSessions: (query: { projectPath: string; cwd?: string; claudeAccountId?: string }) => Promise<CliSessionSummary[]>;
  /** Профили аккаунтов Claude Code (TASK-152, decision-87). */
  claudeAccounts: {
    overview: () => Promise<ClaudeAccountsOverview>;
    statuses: (force?: boolean) => Promise<{ statuses: Record<string, ClaudeAccountAuthStatus>; sharedLogin: string[][] }>;
    status: (id: string, force?: boolean) => Promise<ClaudeAccountAuthStatus>;
    create: (name: string, engine?: CliAccountEngine) => Promise<ClaudeAccountProfile>;
    /** Каталог выбирается в системном диалоге или берётся из CLAUDE_CONFIG_DIR процесса; `null` — диалог отменён. */
    connectExternal: (input: { name: string; source: 'dialog' | 'processEnv'; engine?: CliAccountEngine }) => Promise<ClaudeAccountProfile | null>;
    rename: (id: string, name: string) => Promise<void>;
    remove: (id: string) => Promise<{ removed: ClaudeAccountProfile; unboundProjects: number }>;
    logout: (id: string) => Promise<ClaudeAccountAuthStatus>;
    forProject: (projectPath: string) => Promise<{ account: ClaudeAccountProfile; source: ClaudeAccountSource }>;
    setProject: (projectPath: string, accountId: string | null) => Promise<boolean>;
    /** Аккаунты Codex CLI и Gemini CLI проекта на этой машине (decision-163); `null` — обычный каталог CLI. */
    projectEngines: (projectPath: string) => Promise<Record<OtherCliAccountEngine, string | null>>;
    setProjectEngine: (projectPath: string, engine: OtherCliAccountEngine, accountId: string | null) => Promise<boolean>;
    setRole: (roleSlug: string, accountId: string | null) => Promise<void>;
  };
  /** Синхронизация задач с внешним трекером (TASK-128, decision-103). */
  trackerSync: {
    status: (projectPath: string) => Promise<TrackerSyncStatusView>;
    save: (
      projectPath: string,
      patch: { config?: Partial<TrackerSyncConfig>; connectionId?: string | null; intervalMinutes?: number }
    ) => Promise<TrackerSyncStatusView>;
    targets: (projectPath: string) => Promise<TrackerTargetGroup[]>;
    describeTarget: (projectPath: string) => Promise<{ localStatuses: string[]; remoteStatuses: RemoteStatus[]; suggested: Record<string, string> }>;
    preview: (projectPath: string) => Promise<TrackerRunSummary>;
    run: (projectPath: string) => Promise<TrackerRunSummary>;
  };
  /** Рабочие чаты: подписки «события × проекты × канал» (TASK-138.4, decision-110). */
  chat: {
    list: () => Promise<ChatSubscription[]>;
    save: (subscription: Omit<ChatSubscription, 'id'> & { id?: string }) => Promise<ChatSubscription>;
    remove: (id: string) => Promise<boolean>;
    targets: (kind: ChatKind, connectionId: string) => Promise<Array<{ id: string; name: string }>>;
    test: (id: string) => Promise<{ ok: boolean; error?: string }>;
  };
  /** CI/CD проекта (TASK-138.3, decision-109): GitHub Actions, GitLab CI, Jenkins. */
  ci: {
    providers: (projectPath: string) => Promise<CiProviderInfo[]>;
    runs: (projectPath: string, filter?: { branch?: string; sha?: string; limit?: number }) => Promise<CiRunsResult>;
    run: (projectPath: string, provider: CiProviderId, runId: string) => Promise<CiRunDetail>;
    logs: (projectPath: string, provider: CiProviderId, runId: string, jobId?: string) => Promise<CiJobLog[]>;
    /** Перезапуск упавших заданий или запуск ручного задания (`jobId`); человек подтвердил в окне. */
    retry: (projectPath: string, provider: CiProviderId, runId: string, jobId?: string) => Promise<{ ok: true }>;
    getJenkins: (projectPath: string) => Promise<JenkinsSetting | null>;
    setJenkins: (projectPath: string, value: JenkinsSetting | null) => Promise<JenkinsSetting | null>;
  };
  /** Подключения к внешним сервисам (TASK-138.1, decision-102): без секретов. */
  connections: {
    services: () => Promise<ConnectionServiceInfo[]>;
    list: () => Promise<ConnectionView[]>;
    addToken: (input: ConnectionInput, reconnectId?: string) => Promise<ConnectionView>;
    startOAuth: (input: ConnectionInput, reconnectId?: string) => Promise<ConnectionFlowView>;
    getFlow: (flowId: string) => Promise<ConnectionFlowView | null>;
    cancelFlow: (flowId: string) => Promise<ConnectionFlowView | null>;
    openFlowPage: (flowId: string) => Promise<boolean>;
    check: (id: string) => Promise<ConnectionView>;
    rename: (id: string, label: string) => Promise<ConnectionView>;
    remove: (id: string) => Promise<ConnectionRemoveResult>;
    onChanged: (callback: (list: ConnectionView[]) => void) => () => void;
    onFlowChanged: (callback: (flow: ConnectionFlowView) => void) => () => void;
  };
  streamAIChat: (request: AIStreamRequest) => Promise<boolean>;
  /** Предпросмотр контекста агента для карточки в Agents Studio (TASK-64), без запуска стрима. */
  previewAgentContext: (
    projectPath: string,
    taskId: string,
    contextParts?: Partial<Record<ContextPartKey, boolean>>
  ) => Promise<AgentContextPreview>;
  abortAIStream: (sessionId: string) => Promise<boolean>;
  /** Полная очистка сессии в main: одобрения, процессы, resume-id Claude CLI, подагенты (TASK-33). */
  clearAISession: (sessionId: string) => Promise<boolean>;
  applyAIDiff: (projectPath: string, relativePath: string, newContent: string) => Promise<boolean>;
  /** История диалогов Agents Studio в файлах через main (TASK-35). */
  listAISessions: (projectPath: string) => Promise<AISession[]>;
  saveAISession: (projectPath: string, session: AISession) => Promise<boolean>;
  deleteAISession: (projectPath: string, sessionId: string) => Promise<boolean>;
  /** Одноразовая миграция сессий из localStorage; возвращает число импортированных. */
  importAISessions: (sessionsByProject: Record<string, AISession[]>) => Promise<number>;
  /** Запросы телефона к Agents Studio (TASK-140.10, decision-83): промпт или остановка в сессии стора. */
  onStudioRemoteRequest: (callback: (req: StudioRemoteRequestPayload) => void) => () => void;
  replyStudioRemote: (requestId: string, reply: { ok: boolean; sessionId?: string; error?: string }) => Promise<boolean>;

  // Claude Bridge Approvals & Statuses
  getAllProjectStatuses: () => Promise<ProjectAgentStatus[]>;
  getProjectAgentStatus: (projectPath: string) => Promise<ProjectAgentStatus>;
  sendApprovalResponse: (requestId: string, response: { approved: boolean; text?: string }) => Promise<boolean>;
  getSubagents: (projectPath: string) => Promise<SubagentInfo[]>;
  getAvailableModels: () => Promise<ClaudeModelOption[]>;
  getClaudeUsage: (forceRefresh?: boolean, query?: { accountId?: string; projectPath?: string }) => Promise<ClaudeUsageData>;
  onProjectAgentStatusChanged: (callback: (status: ProjectAgentStatus) => void) => () => void;
  onSubagentUpdated: (callback: (subagent: SubagentInfo) => void) => () => void;

  onAIChunk: (
    sessionId: string,
    callback: (chunk: {
      text?: string;
      thought?: string;
      toolCall?: AIToolCall;
      approvalRequest?: ApprovalRequest;
      subagent?: SubagentInfo;
      status?: AgentStatusType;
      claudeCliSessionId?: string;
      rateLimitWarning?: RateLimitWarning;
    }) => void
  ) => () => void;
  onAIComplete: (sessionId: string, callback: (message: AIMessage) => void) => () => void;
  onAIError: (sessionId: string, callback: (error: string, info?: ProviderErrorInfo) => void) => () => void;

  // Multi-Agent Swarm & Fleet Orchestration (TASK-54)
  startSwarmFanOut: (options: StartFanOutOptions) => Promise<SwarmSession>;
  startSwarmHandoff: (options: StartHandoffOptions) => Promise<SwarmSession>;
  /** Цикл «до готовности» (TASK-75). */
  startSwarmDoneLoop: (options: StartDoneLoopOptions) => Promise<SwarmSession | { error: string }>;
  getDoneLoopConfig: (projectPath: string) => Promise<DoneLoopSettings>;
  // Планировщик подзадач (TASK-80, decision-49)
  generatePlan: (options: GeneratePlanOptions) => Promise<PlanState | { error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  listPlans: (projectPath?: string) => Promise<PlanState[]>;
  getPlanForTask: (projectPath: string, taskId: string) => Promise<PlanState | null>;
  /** Чем план будет построен и исполнен сейчас (decision-75). */
  getPlanModels: (projectPath: string) => Promise<PlanModelsPreview | { error: string }>;
  approvePlan: (planId: string) => Promise<{ success: boolean; error?: string }>;
  stopPlan: (planId: string) => Promise<{ success: boolean; error?: string }>;
  skipPlanNode: (planId: string, taskId: string, skipped: boolean) => Promise<{ success: boolean; error?: string }>;
  resolvePlanConflict: (
    planId: string,
    taskId: string,
    action: 'retry' | 'skip' | 'stop' | 'renumber'
  ) => Promise<{ success: boolean; error?: string }>;
  discardPlan: (planId: string) => Promise<{ success: boolean; error?: string }>;
  onPlanEvent: (callback: (event: PlanEventPayload) => void) => () => void;
  runAssignedAgent: (options: {
    projectPath: string;
    taskId: string;
    taskTitle?: string;
    prompt: string;
    roleSlug: string;
    hostId?: string;
  }) => Promise<SwarmSession | { error: string }>;
  stopSwarm: (swarmId: string) => Promise<boolean>;
  pickSwarmWinner: (swarmId: string, winnerAgentId: string, mergeIntoBase?: boolean) => Promise<{ success: boolean; error?: string; mergedBranch?: string }>;
  getSwarm: (swarmId: string) => Promise<SwarmSession | undefined>;
  /** Автосудья арены (TASK-61). */
  runSwarmJudge: (
    swarmId: string,
    options?: { rerunChecks?: boolean; skipReview?: boolean }
  ) => Promise<{ success: boolean; error?: string; state?: JudgeState }>;
  cancelSwarmJudge: (swarmId: string) => Promise<boolean>;
  composeSwarmResult: (swarmId: string, selections: ComposeSelection[]) => Promise<ComposeResult>;
  getArenaConfig: (projectPath: string) => Promise<ArenaConfig>;
  /** Скриншот проверки ui-smoke как data URL (только из <userData>/visual). */
  readVisualArtifact: (relPath: string) => Promise<{ dataUrl: string; bytes: number } | { error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  /** Показать артефакт (скриншот, trace) в папке. */
  revealVisualArtifact: (relPath: string) => Promise<boolean>;
  saveArenaConfig: (
    projectPath: string,
    patch: { checks?: CheckDefinition[]; arena?: ArenaSettings }
  ) => Promise<{ success: boolean; config?: ArenaConfig }>;
  listSwarms: (projectPath?: string) => Promise<SwarmSession[]>;
  onSwarmEvent: (callback: (event: SwarmEventPayload) => void) => () => void;
  // Персистентность, транскрипты и экспорт swarm-сессий (TASK-56)
  resumeSwarm: (swarmId: string) => Promise<{ success: boolean; error?: string }>;
  discardSwarm: (swarmId: string, cleanupWorktrees?: boolean) => Promise<{ success: boolean; error?: string }>;
  getSwarmTranscript: (swarmId: string, agentId: string) => Promise<SwarmTranscript | null>;
  exportSwarm: (swarmId: string, format: SwarmExportFormat) => Promise<string | null>;
  exportSwarmToFile: (swarmId: string, format: SwarmExportFormat) => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
  /** Таймлайн агента, чекпоинты и доступность отката (TASK-72, decision-45). */
  getAgentTimeline: (swarmId: string, agentId: string) => Promise<AgentTimelineView | null>;
  rewindAgent: (swarmId: string, agentId: string, checkpoint: number) => Promise<AgentRewindResult>;
  continueAgent: (
    swarmId: string,
    agentId: string,
    instruction?: string
  ) => Promise<{ success: boolean; error?: string; mode?: ContinueMode }>;
  exportAgentTrace: (swarmId: string, agentId?: string) => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;

  // File Explorer & Helpers
  readDirectoryTree: (projectPath: string, subDir?: string, maxDepth?: number) => Promise<FileTreeNode[]>;
  readFileContent: (projectPath: string, relativePath: string) => Promise<string>;
  saveFileContent: (projectPath: string, relativePath: string, content: string) => Promise<boolean>;
  createFileOrFolder: (projectPath: string, relativePath: string, isDirectory?: boolean) => Promise<boolean>;
  deleteFileOrFolder: (projectPath: string, relativePath: string) => Promise<boolean>;

  // Local Whisper STT Engine
  transcribeLocalWhisper: (
    audioData: number[] | Float32Array,
    language?: 'ru' | 'en' | 'auto',
    fallbackLanguage?: 'ru' | 'en'
  ) => Promise<{ text: string; timeMs: number; language?: 'ru' | 'en' }>;
  getLocalWhisperStatus: () => Promise<LocalWhisperStatusInfo>;
  warmupLocalWhisper: () => Promise<LocalWhisperStatusInfo>;
  prepareSpeech: (samples: Float32Array, options: { gate: boolean; denoise: NoiseReduction }) => Promise<SpeechPrepResult>;
  getSpeechPrepStatus: () => Promise<SpeechPrepStatusInfo>;
  recognizeSherpa: (
    samples: Float32Array,
    options: { gate: boolean; denoise: NoiseReduction; modelId: AsrModelId }
  ) => Promise<SpeechRecognizeResult>;
  listAsrModels: () => Promise<AsrModelStatus[]>;
  downloadAsrModel: (modelId: AsrModelId) => Promise<{ ok: boolean; error?: string }>;
  cancelAsrDownload: (modelId: AsrModelId) => Promise<boolean>;
  deleteAsrModel: (modelId: AsrModelId) => Promise<boolean>;
  onAsrDownloadProgress: (callback: (progress: AsrDownloadProgress) => void) => () => void;

  // Глобальный push-to-talk и классификатор свободных команд (TASK-83)
  getPushToTalkStatus: () => Promise<PushToTalkStatus>;
  savePushToTalkSettings: (patch: Partial<PushToTalkSettings>) => Promise<PushToTalkStatus>;
  requestPushToTalkPermission: () => Promise<PushToTalkStatus>;
  classifyVoiceCommand: (request: VoiceClassifyRequest) => Promise<VoiceClassifyResponse>;
  runVoiceComputerTask: (request: VoiceComputerTaskRequest) => Promise<VoiceComputerTaskResponse>;
  dictateVoiceText: (request: VoiceDictateRequest) => Promise<VoiceDictateResponse>;
  onPushToTalk: (callback: (event: PushToTalkEvent) => void) => () => void;
  onPushToTalkStatus: (callback: (status: PushToTalkStatus) => void) => () => void;

  // Automations (TASK-74, decision-52): правила, доверие к проектным, журнал, запуск сейчас
  listAutomations: () => Promise<AutomationListResult>;
  saveAutomationRule: (rule: AutomationRuleInput) => Promise<{ ok: true; rule: AutomationRule } | { ok: false; error: string; errorKey?: unknown }>;
  deleteAutomationRule: (id: string) => Promise<boolean>;
  setAutomationEnabled: (key: string, enabled: boolean, hash?: string) => Promise<{ ok: true } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  runAutomationNow: (key: string) => Promise<AutomationRunNowResult>;
  resumeAutomation: (key: string) => Promise<boolean>;
  getAutomationLog: (limit?: number) => Promise<AutomationLogEntry[]>;
  updateAutomationSettings: (patch: Partial<AutomationsSettings>) => Promise<AutomationsSettings>;
  onAutomationsChanged: (callback: () => void) => () => void;

  // Security Health (TASK-73, decision-56)
  getSecurityReport: (projectPath: string) => Promise<{ ok: boolean; report: SecurityReport | null; running: boolean; error?: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  runSecurityAudit: (projectPath: string) => Promise<{ ok: true; report: SecurityReport; newFindings: number } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  createSecurityTask: (
    projectPath: string,
    ecosystem: AuditEcosystem,
    pkg: string
  ) => Promise<{ ok: true; taskId: string; existed: boolean } | { ok: false; error: string; errorKey?: import('../lib/appError').AppErrorKey }>;
  getSecuritySettings: () => Promise<SecuritySettings>;
  saveSecuritySettings: (patch: Partial<SecuritySettings>) => Promise<SecuritySettings>;
  onSecurityReportUpdated: (callback: (projectPath: string) => void) => () => void;

  // Графы кода (GitNexus) и документации (LightRAG) — TASK-167, decision-118
  getCodeGraph: (projectPath: string, force?: boolean) => Promise<ProjectGraphResult>;
  getDocsGraph: (projectPath: string) => Promise<ProjectGraphResult>;

  // Настройка индексации GitNexus и переиндексация — TASK-176, decision-131
  codeIndexState: (projectPath: string) => Promise<import('./projectInit').IpcResult<import('./codeIndex').CodeIndexState>>;
  codeIndexPreview: (
    projectPath: string,
    settings: import('./codeIndex').CodeIndexSettings,
    locale: string
  ) => Promise<import('./projectInit').IpcResult<import('./codeIndex').IndexScanResult>>;
  codeIndexSave: (
    projectPath: string,
    settings: import('./codeIndex').CodeIndexSettings,
    locale: string
  ) => Promise<import('./projectInit').IpcResult<{ changed: boolean }>>;
  codeIndexReindex: (projectPath: string, force: boolean) => Promise<import('./projectInit').IpcResult<ManagedProcess>>;
  /** Каталог со скриптом index-docs относительно корня проекта ('' — корень); `null` — скрипта нет. */
  indexDocsDir: (projectPath: string) => Promise<string | null>;

  // Память проекта (TASK-76, decision-51)
  listMemory: (projectPath: string) => Promise<MemoryListResult>;
  writeMemory: (projectPath: string, draft: MemoryDraftInput, replace?: string) => Promise<MemoryWriteResult>;
  deleteMemory: (projectPath: string, id: string) => Promise<MemoryOperationResult>;

  // Локальный TTS на голосах Piper (TASK-69)
  getTtsStatus: () => Promise<TtsStatusInfo>;
  listTtsVoices: () => Promise<TtsVoiceListItem[]>;
  downloadTtsVoice: (voiceId: string) => Promise<TtsOperationResult>;
  cancelTtsVoiceDownload: (voiceId: string) => Promise<boolean>;
  deleteTtsVoice: (voiceId: string) => Promise<TtsOperationResult>;
  importTtsVoice: () => Promise<TtsOperationResult>;
  /**
   * Прогрев голоса. `auto` — прогрев не по действию пользователя (реплика, старт приложения): он не
   * снимает признак недоступности движка после серии падений (TASK-119).
   */
  warmupTts: (voiceId: string, opts?: { auto?: boolean }) => Promise<TtsStatusInfo & { modelKind?: QwenModelKind | null }>;
  speakTts: (req: TtsSpeakRequest) => Promise<{ ok: boolean; error?: string; errorCode?: string }>;
  cancelTts: (jobId: string) => Promise<boolean>;
  cancelAllTts: () => Promise<boolean>;
  onTtsChunk: (callback: (chunk: TtsChunkPayload) => void) => () => void;
  onTtsDone: (callback: (info: TtsDonePayload) => void) => () => void;
  onTtsError: (callback: (info: TtsErrorPayload) => void) => () => void;
  onTtsDownloadProgress: (callback: (progress: TtsDownloadProgress) => void) => () => void;

  // Второй движок озвучки: Qwen3-TTS в сайдкаре Python (TASK-104, decision-64)
  getQwenTtsStatus: () => Promise<QwenTtsStatusInfo>;
  listQwenTtsVoices: () => Promise<QwenVoiceListItem[]>;
  installQwenTts: (req: { models: QwenModelKind[]; hfEndpoint?: string }) => Promise<TtsOperationResult>;
  cancelQwenTtsInstall: () => Promise<boolean>;
  unloadQwenTts: () => Promise<QwenTtsStatusInfo>;
  /** Не выгружать модель Qwen3-TTS по простою, пока Qwen выбран движком реплик (TASK-119). */
  setQwenTtsKeepLoaded: (keep: boolean) => Promise<QwenTtsStatusInfo>;
  saveQwenTtsVoice: (input: { label: string; instruct: string; seed: number }) => Promise<QwenVoiceOperationResult>;
  deleteQwenTtsVoice: (voiceId: string) => Promise<QwenVoiceOperationResult>;
  onQwenTtsInstallProgress: (callback: (progress: QwenInstallProgressInfo) => void) => () => void;

  // System
  getPlatform: () => Promise<string>;

  // SafeStorage & Secret Encryption
  isEncryptionAvailable: () => Promise<boolean>;
  encryptSecret: (text: string) => Promise<string>;
  decryptSecret: (cipherText: string) => Promise<string>;
  saveEncryptedSecret: (key: string, value: string) => Promise<boolean>;
  getEncryptedSecret: (key: string) => Promise<string | null>;
  deleteEncryptedSecret: (key: string) => Promise<boolean>;
  getSecretIssues: () => Promise<SecretIssuesState>;
  acknowledgeSecretIssues: () => Promise<SecretIssuesState>;
  showSecretBackup: () => Promise<boolean>;
  getSecretBackupPreview: () => Promise<SecretBackupPreview>;
  restoreSecretsFromBackup: (ids: string[]) => Promise<SecretRestoreResult>;
  deleteSecretBackupEntries: (ids: string[]) => Promise<SecretBackupDeleteResult>;
  onSecretIssuesChanged: (callback: (state: SecretIssuesState) => void) => () => void;

  // Remote MCP Server
  getMcpStatus: () => Promise<McpServerStatus>;
  toggleMcpServer: (enable: boolean) => Promise<McpServerStatus>;
  regenerateMcpToken: () => Promise<string>;
  setMcpAppState: (state: { activeProject?: any; activeTab?: string }) => Promise<boolean>;
  /** Push-статус MCP-сервера из main (старт/стоп, токен, SSE-сессии) — вместо опроса по таймеру. */
  onMcpStatusChanged: (callback: (status: McpServerStatus) => void) => () => void;
  // Управление компьютером через MCP-прокси (TASK-82)
  getComputerUseStatus: () => Promise<ComputerUseStatus>;
  getComputerUseSettings: () => Promise<ComputerUseSettings>;
  saveComputerUseSettings: (patch: Partial<ComputerUseSettings>) => Promise<ComputerUseSettings>;
  engageComputerKillSwitch: (reason?: 'overlay' | 'manual') => Promise<ComputerUseStatus>;
  releaseComputerKillSwitch: () => Promise<ComputerUseStatus>;
  startComputerUseRuntime: () => Promise<ComputerUseStatus>;
  runComputerUseDiagnostics: () => Promise<ComputerUseDiagnostics>;
  takeComputerTestScreenshot: () => Promise<{
    ok: boolean;
    dataUrl?: string;
    text?: string;
    size?: { imageWidth: number; imageHeight: number; screenWidth: number; screenHeight: number; exact: boolean };
    error?: string;
    errorKey?: unknown;
  }>;
  onComputerUseStatusChanged: (callback: (status: ComputerUseStatus) => void) => () => void;
  onComputerOverlayState: (callback: (state: ComputerOverlayState) => void) => () => void;
  onRemoteAction: (callback: (action: { type: string; payload: any }) => void) => () => void;

  // System Voice Overlay
  syncVoiceOverlay: (state: VoiceOverlayPayload) => void;
  onVoiceOverlayUpdate: (callback: (state: VoiceOverlayPayload) => void) => () => void;
  sendVoiceOverlayAction: (action: VoiceOverlayAction) => void;
  onVoiceResultCardDismissed: (callback: (event: { id: number }) => void) => () => void;
  onVoiceExternalControl: (callback: (action: 'toggle-pause' | 'stop') => void) => () => void;

  // Внешние ссылки (http/https/mailto) — открываются в системном браузере, а не в окне Electron
  openExternal: (url: string) => Promise<boolean>;

  // Remote Control (TASK-51)
  getRemoteStatus: () => Promise<RemoteControlStatus>;
  toggleRemoteControl: (enable?: boolean) => Promise<RemoteControlStatus>;
  updateRemoteConfig: (config: Partial<RemoteConfig>) => Promise<RemoteControlStatus>;
  regenerateRemoteToken: () => Promise<RemoteControlStatus>;
  disconnectRemoteDevice: (deviceId: string) => Promise<boolean>;
  approveRemoteDevice: (deviceId: string) => Promise<boolean>;
  setRemoteDeviceRights: (deviceId: string, rights: DeviceRights) => Promise<RemoteControlStatus>;
  /** Права устройства по проектам (TASK-180); `null` — снова права устройства на все проекты. */
  setRemoteDeviceProjectRights: (deviceId: string, rights: import('../utils/projectAccess').DeviceProjectRights | null) => Promise<RemoteControlStatus>;
  revokeRemoteDevice: (deviceId: string) => Promise<RemoteControlStatus>;
  testTelegramNotification: (text?: string) => Promise<boolean>;
  startRemoteTunnel: () => Promise<string>;
  stopRemoteTunnel: () => Promise<RemoteControlStatus>;
  onRemoteControlStatusChanged: (callback: (status: RemoteControlStatus) => void) => () => void;
  onRemoteHitlDecisionMade: (callback: (data: { requestId: string; sessionId: string; approved: boolean; byDevice: string }) => void) => () => void;

  // Федерация компьютеров: hub-режим, ПК как клиент другого ПК (TASK-66, decision-11 п.4)
  listFederationPeers: () => Promise<FederationPeerState[]>;
  addFederationPeer: (options: {
    hostId: string;
    machineName?: string;
    transport: FederationTransport;
    address: string;
    secretKey?: string;
    /** Ключ сессий хоста (`hk` из ссылки сопряжения), TASK-166. */
    hostKey?: string;
    pin?: string;
    autoConnect?: boolean;
  }) => Promise<FederationPeerState>;
  removeFederationPeer: (hostId: string) => Promise<FederationPeerState[]>;
  connectFederationPeer: (hostId: string) => Promise<FederationPeerState>;
  disconnectFederationPeer: (hostId: string) => Promise<FederationPeerState>;
  federationCall: <T = unknown>(hostId: string, method: RemoteRpcMethod | string, params?: Record<string, unknown>) => Promise<T>;
  getFederationHosts: () => Promise<FederationHost[]>;
  takeDeepLinks: () => Promise<string[]>;
  onDeepLinkAvailable: (callback: () => void) => () => void;
  /** Сводка флота этого ПК (TASK-174, decision-129) и событие её изменения с дебаунсом. */
  getLocalOverview: () => Promise<import('../utils/fleetOverview').RemoteOverview>;
  onLocalOverviewChanged: (callback: () => void) => () => void;
  onFederationPeersChanged: (callback: (peers: FederationPeerState[]) => void) => () => void;
  onFederationEvent: (
    callback: (payload: { hostId: string; machineName: string; event: string; data: unknown }) => void
  ) => () => void;

  // Единый HITL-контур: очередь, решения по requestId, аудит, шина событий (TASK-57)
  listPendingApprovals: (filter?: { projectPath?: string; sessionId?: string }) => Promise<ApprovalRequest[]>;
  decideApproval: (requestId: string, response: { approved: boolean; text?: string }) => Promise<HitlDecideResult>;
  listHitlAudit: (query?: HitlAuditQuery) => Promise<HitlAuditEntry[]>;
  listHitlAuditMonths: () => Promise<string[]>;
  getHitlInfo: () => Promise<{ auditDir: string | null; queueDir: string | null; hostId: string }>;
  exportHitlAudit: (query?: HitlAuditQuery, format?: 'jsonl' | 'json' | 'csv') => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
  // Перенос профиля (TASK-224, decision-175)
  profileExport: (password: string, sections?: ProfileSectionId[]) => Promise<{ canceled: boolean; filePath?: string; sections?: ProfileSectionId[] }>;
  profileChooseFile: () => Promise<string | null>;
  profilePreview: (filePath: string, password: string) => Promise<ProfilePreview | null>;
  profileApply: (token: string, sections: ProfileSectionId[]) => Promise<{ applied: ProfileSectionId[] }>;
  profileCloneProject: (remote: string, name: string) => Promise<string | null>;
  profilePreviewFromHost: (hostId: string, sections: ProfileSectionId[]) => Promise<ProfilePreview | null>;
  profilePreviewOnHost: (hostId: string, sections: ProfileSectionId[]) => Promise<ProfilePreview | null>;
  profileApplyOnHost: (hostId: string, token: string, sections: ProfileSectionId[]) => Promise<{ applied: ProfileSectionId[] }>;
  profileRelaunch: () => Promise<void>;
  // База знаний компании (TASK-223)
  knowledgeBaseIndex: (projectPath: string) => Promise<{ name: string; docs: Array<{ id: string; title: string; category: 'doc' | 'decision' }> } | null>;
  knowledgeBaseRead: (projectPath: string, id: string) => Promise<{ id: string; title: string; content: string; kbName: string } | null>;
  onBusEvent: (callback: (event: AppBusEvent) => void) => () => void;

  // Уведомления: трей, ОС, звук, Telegram (TASK-63)
  getNotificationSettings: () => Promise<NotificationSettingsState>;
  updateNotificationSettings: (patch: Partial<NotificationSettings>) => Promise<NotificationSettings>;
  testNotification: () => Promise<NotificationDelivery>;
  /** Язык окна для текстов хоста: уведомления, Telegram, трей (TASK-205). */
  setHostLanguage?: (language: 'en' | 'ru') => Promise<'en' | 'ru'>;
  notificationNavigate: (action: NotificationAction) => Promise<boolean>;
  startTelegramBot: () => Promise<{ ok: boolean; error?: string; running: boolean; processId: string | null }>;
  stopTelegramBot: () => Promise<{ ok: boolean; running: boolean; processId: string | null }>;
  listServiceProcesses: () => Promise<ManagedProcess[]>;
  onNotificationDelivered: (callback: (delivery: NotificationDelivery) => void) => () => void;
  onNotificationSound: (callback: (data: { severity: NotificationSeverity; volume: number }) => void) => () => void;
  onNotificationNavigate: (callback: (action: NotificationAction) => void) => () => void;

  // Диагностика и автообновление (TASK-58)
  getDiagnosticsInfo: () => Promise<DiagnosticsInfo>;
  collectDiagnosticsArchive: () => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
  getUpdaterStatus: () => Promise<UpdaterStatus>;
  checkForUpdates: () => Promise<UpdaterStatus>;
  installUpdateNow: () => Promise<boolean>;
  onUpdaterStatusChanged: (callback: (status: UpdaterStatus) => void) => () => void;

  // Редакция сборки и платные модули (TASK-151, decision-123 п. 4)
  /** `active: false` — шлюз модулей редакции отключил их до перезапуска (TASK-200). */
  getEditionInfo: () => Promise<{ edition: 'open' | 'team'; active: boolean }>;
  /** Ограничения запуска агента (бюджеты Team): показать до запуска; в открытой редакции — пусто. */
  checkAgentLaunch: (ctx: AgentLaunchCheckInput) => Promise<AgentLaunchVerdictView>;
  /** Канал модуля `ee/` (только `ee:*`). */
  editionInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

export interface AgentLaunchCheckInput {
  projectPath: string;
  taskId?: string;
  roleSlug?: string;
  engine?: string;
  model?: string;
  origin?: 'swarm' | 'assigned' | 'automation' | 'studio';
  slots?: number;
}

export interface AgentLaunchVerdictView {
  allowed: boolean;
  reason?: string;
  reasonKey?: unknown;
  capUsd?: number;
  notices: Array<{ level: 'info' | 'warn' | 'block'; text: string; textKey?: unknown }>;
}

export interface FileTreeNode {
  name: string;
  path: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  extension?: string;
  children?: FileTreeNode[];
}

export type AgentStatusType = 'idle' | 'running' | 'waiting_approval' | 'done' | 'error';

/** Статус агента кодом (TASK-204); зеркало `electron/services/studioToolAdapter.ts`. */
export type AgentStatusCode = 'analyzing' | 'continuing' | 'processing' | 'executing' | 'approval_cancelled' | 'aborted' | 'completed' | 'failed';

export interface AgentStatusKey {
  code: AgentStatusCode;
  detail?: string;
  detailKey?: unknown;
}

export interface ProjectAgentStatus {
  projectPath: string;
  projectName: string;
  status: AgentStatusType;
  lastMessage?: string;
  /** Сообщение кодом (TASK-204): текст — из словарей (`src/lib/agentStatusText.ts`). */
  messageKey?: AgentStatusKey;
  pendingApproval?: ApprovalRequest;
  activeSubagentsCount?: number;
  updatedAt: number;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionData {
  title: string;
  subtitle?: string;
  options: QuestionOption[];
  isMultiSelect?: boolean;
  allowOther?: boolean;
}

/** Вид карточки HITL кодом (TASK-204); зеркало `electron/services/hitlTypes.ts`. */
export type HitlTextCode =
  | 'file_write'
  | 'file_write_excluded'
  | 'command'
  | 'command_denied'
  | 'process'
  | 'sync_merge'
  | 'sync_continue'
  | 'sync_abort'
  | 'read'
  | 'read_outside'
  | 'question'
  | 'read_excluded'
  | 'subagent'
  | 'tool'
  | 'browser_host'
  | 'assistant_question'
  | 'merge_security'
  | 'merge_security_many'
  | 'merge_renumber'
  | 'plan_conflict'
  | 'plan_renumber'
  | 'ci_rerun'
  | 'ci_play'
  | 'task_create'
  | 'tracker_sync'
  | 'doc_merge'
  | 'task_claim'
  | 'task_release'
  | 'pr_publish'
  | 'computer_action'
  | 'computer_dangerous';

/** Строка пояснения кодом (TASK-202.8); зеркало `electron/services/hitlTypes.ts`. */
export interface HitlTextLine {
  code: string;
  params?: Record<string, HitlLineParam>;
}

export type HitlLineParam = string | HitlTextLine | HitlTextLine[];

export interface HitlTextKey {
  code: HitlTextCode;
  target?: string;
  agent?: string;
  ownDetails?: boolean;
  params?: Record<string, string>;
  lines?: HitlTextLine[];
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  projectPath: string;
  type: 'command' | 'file_write' | 'question' | 'subagent_dispatch' | 'computer_action';
  title: string;
  details?: string;
  command?: string;
  filePath?: string;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    patch: string;
  };
  questionData?: QuestionData;
  /** Заголовок и пояснение кодом (TASK-204); без поля — `title`/`details` как есть. */
  textKey?: HitlTextKey;
  createdAt: number;
  /** Метаданные единого HITL-контура (TASK-57). */
  origin?: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  /** Имя профиля аккаунта Claude Code (TASK-152.4). */
  claudeAccount?: string;
  hostId?: string;
  tool?: string;
  /** Класс риска (TASK-140.4, decision-112): считает хост. */
  risk?: 'low' | 'moderate' | 'high';
  riskReason?: string;
  riskReasonKey?: import('../lib/hitlRiskReason').HitlRiskReasonKey;
  expiresAt?: number;
  /** Восстановлен после перезапуска: агент уже не ждёт ответа, решение попадёт только в аудит. */
  orphaned?: boolean;
}

export interface SubagentInfo {
  id: string;
  parentSessionId: string;
  projectPath: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  progress?: string;
  output?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ClaudeModelOption {
  id: string;
  name: string;
  description: string;
  badge?: string;
  family: 'default' | 'sonnet' | 'opus' | 'haiku' | 'fable';
}

export interface RateLimitWarning {
  id: string;
  type: 'rate_limit' | 'context_window' | 'quota_warning' | 'throttled';
  title: string;
  message: string;
  utilization?: number;
  resetsAt?: string;
  tier?: string;
  /** Профиль аккаунта Claude Code, чей лимит (TASK-152.5). */
  accountName?: string;
  timestamp: number;
}

export type ClaudeAccountSource = 'slot' | 'role' | 'project' | 'default';

/** Движки, у которых бывают профили аккаунтов (decision-163). */
export type CliAccountEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli';
export type OtherCliAccountEngine = Exclude<CliAccountEngine, 'claude-cli'>;

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  kind: 'managed' | 'external';
  configDir: string;
  /** Нет — Claude Code. */
  engine?: OtherCliAccountEngine;
  createdAt?: string;
}

export interface ClaudeAccountView extends ClaudeAccountProfile {
  isDefault: boolean;
  isHomeClaudeDir?: boolean;
  projectCount: number;
}

export interface ClaudeAccountsOverview {
  accounts: ClaudeAccountView[];
  /** Профили Codex CLI и Gemini CLI (decision-163). */
  engineAccounts: ClaudeAccountView[];
  roleAccounts: Record<string, string>;
  processConfigDir?: string;
  processConfigDirAccountId?: string;
  platform: string;
}

export interface ClaudeAccountAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  configDirectory?: string;
  error?: string;
  /** Код ошибки статуса для текста на языке окна (decision-165); без него `error` — текст самого CLI. */
  errorKey?: import('../lib/appError').AppErrorKey;
  /** CLI не сообщает статус входа (Gemini CLI): вход проверяется в терминале. */
  unsupported?: boolean;
  checkedAt: number;
}

export interface ClaudeAuthStatus {
  isLoggedIn: boolean;
  email?: string;
  displayName?: string;
  seatTier?: string;
  organizationName?: string;
  /** Профиль аккаунта, чей статус показан (TASK-152, decision-87). */
  accountId?: string;
  accountName?: string;
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
}

export interface AutoApproveRules {
  enabled: boolean;
  allowCommands: boolean;
  allowFileWrite: boolean;
  allowFileRead: boolean;
  allowSubagents: boolean;
  writeExcludePatterns: string[];
  readExcludePatterns: string[];
  commandDenyList: string[];
  /** Таймаут команд агента (run_command) в секундах; по умолчанию 5 минут (TASK-33). */
  commandTimeoutSec?: number;
  /** Таймаут ожидания решения человека в минутах; по умолчанию 24 часа (TASK-57). */
  approvalTimeoutMin?: number;
  /** Allow-список инструментов (права роли, decision-9); пустой — без ограничений. */
  allowedTools?: string[];
}

// ─────────────────── Единый HITL-контур (TASK-57), зеркало electron/services/hitlTypes.ts ───────────────────

export type HitlOrigin = 'studio' | 'swarm' | 'handoff' | 'assigned' | 'external' | 'automation' | 'terminal';
export type HitlEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api' | 'antigravity';
export type HitlDecisionSourceKind = 'local' | 'remote' | 'mcp' | 'auto' | 'timeout' | 'cancelled' | 'shutdown';
export type HitlOutcome = 'executed' | 'failed' | 'not_executed' | 'session_gone';

export interface HitlDecisionSource {
  kind: HitlDecisionSourceKind;
  deviceId?: string;
  deviceName?: string;
  rule?: string;
}

export interface RolePermissions {
  autoApprove?: boolean;
  allowCommands?: boolean;
  allowFileWrite?: boolean;
  allowFileRead?: boolean;
  allowSubagents?: boolean;
  writeExcludePatterns?: string[];
  readExcludePatterns?: string[];
  commandDenyList?: string[];
  commandTimeoutSec?: number;
  allowedTools?: string[];
  approvalTimeoutMin?: number;
  /** Заведение задач агентом (decision-89): `propose` — с меткой `agent-created`, `ask` — карточка HITL, `deny`. */
  taskCreate?: 'propose' | 'ask' | 'deny';
  /** Принятие ветки документации агентом (decision-151); не задано — через карточку. */
  docMerge?: 'allow' | 'ask' | 'deny';
  /** Захват задачи на origin агентом (decision-153); не задано — через карточку. */
  taskClaim?: 'allow' | 'ask' | 'deny';
}

// Реестр ролей агентов (decision-9, TASK-60). Зеркало `electron/services/roleTypes.ts`.
export type RoleEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api';
export type RoleSource = 'builtin' | 'global' | 'project';
export type ToolCategory = 'read' | 'write' | 'command' | 'search' | 'subagent' | 'question';

export interface RoleDefinition {
  slug: string;
  name: string;
  engine?: RoleEngine;
  provider?: string;
  /** Профиль OpenAI-совместимого провайдера: имя или id (decision-40). */
  profile?: string;
  model?: string;
  /** Тир модели (decision-44): явный `model` важнее. */
  modelTier?: ModelTier;
  tools?: ToolCategory[];
  permissions?: RolePermissions;
  dod?: string[];
  handoffTo?: string[];
  maxTurns?: number;
  budgetUsd?: number;
  systemPrompt: string;
  source: RoleSource;
  filePath?: string;
}

// Экспорт ролей в нативные субагенты и хуки терминала (TASK-77). Зеркало `roleSyncService.ts`.
export type RoleExportTarget = 'claude' | 'codex' | 'antigravity';
export type RoleSyncFileAction = 'create' | 'unchanged' | 'update' | 'conflict' | 'foreign' | 'orphan';

export interface RoleSyncOptionsInput {
  targets: RoleExportTarget[];
  hooks: boolean;
}

export interface RoleSyncFile {
  relPath: string;
  kind: 'agent' | 'hookScript' | 'hookSettings';
  target?: RoleExportTarget;
  roleSlug?: string;
  action: RoleSyncFileAction;
  modified?: boolean;
  desired: string | null;
  current: string | null;
  /** Заметки кодом словаря ошибок (TASK-202.11). */
  notes: import('../lib/appError').AppErrorKey[];
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
}

export interface RoleSyncPlan {
  projectPath: string;
  options: RoleSyncOptionsInput & { hookTimeoutSec: number };
  files: RoleSyncFile[];
  skipped: Array<{ target: RoleExportTarget; roleSlug: string; reason: string; reasonKey?: import('../lib/appError').AppErrorKey }>;
  summary: {
    create: number;
    update: number;
    conflict: number;
    orphan: number;
    foreign: number;
    unchanged: number;
    synced: boolean;
    drift: number;
  };
}

export interface RoleSyncResult {
  written: string[];
  deleted: string[];
  skipped: Array<{ relPath: string; reason: string; reasonKey?: import('../lib/appError').AppErrorKey }>;
  plan: RoleSyncPlan;
}

// Менеджер скиллов проекта (TASK-105, decision-61). Зеркало `skillCatalog.ts` и `skillService.ts`.
export type SkillRoot = 'claude' | 'agents';
export type SkillStatus = 'synced' | 'diverged' | 'claudeOnly' | 'agentsOnly';
export type SkillFileState = 'same' | 'changed' | 'onlyClaude' | 'onlyAgents';
export type SkillProblem = 'noSkillMd' | 'badFrontmatter' | 'noName' | 'noDescription' | 'nameMismatch' | 'nested' | 'tooLarge' | 'symlinks';
export type SkillCopyAction = 'create' | 'overwrite' | 'unchanged';
export type SkillSourceKind = 'template' | 'personal' | 'project';

export interface SkillCopy {
  root: SkillRoot;
  id: string;
  files: Array<{ relPath: string; size: number; hash: string }>;
  hash: string;
  totalBytes: number;
  name?: string;
  description?: string;
  problems: SkillProblem[];
  skillMd: string | null;
}

export interface SkillEntry {
  id: string;
  name?: string;
  description?: string;
  status: SkillStatus;
  copies: Partial<Record<SkillRoot, SkillCopy>>;
  fileDiff?: Array<{ relPath: string; state: SkillFileState }>;
}

export interface ProjectSkillListing {
  projectPath: string;
  entries: SkillEntry[];
  summary: { total: number; synced: number; diverged: number; claudeOnly: number; agentsOnly: number; withProblems: number };
}

export interface SkillSourceRef {
  kind: SkillSourceKind;
  path?: string;
}

export interface SkillSourceInfo {
  kind: SkillSourceKind;
  path: string;
  label: string;
  available: boolean;
}

export interface SkillImportItem {
  id: string;
  from: SkillRoot;
  name?: string;
  description?: string;
  problems: SkillProblem[];
  blocker?: string;
  blockerKey?: import('../lib/appError').AppErrorKey;
  sourceDiverged: boolean;
  actions: Record<SkillRoot, SkillCopyAction>;
}

export interface SkillSourceListing {
  source: SkillSourceInfo;
  items: SkillImportItem[];
}

export interface SkillCopyRequest {
  source: SkillSourceRef;
  fromRoot: SkillRoot;
  id: string;
  toRoots: SkillRoot[];
  overwrite: boolean;
}

export interface SkillCopyResult {
  results: Array<{ root: SkillRoot; outcome: 'created' | 'overwritten' | 'unchanged' | 'skipped'; reason?: 'same-copy' | 'file-in-place' | 'needs-overwrite' }>;
  listing: ProjectSkillListing;
}

export interface TerminalHookSettings {
  version: 1;
  failMode: 'open' | 'closed';
  hookTimeoutSec: number;
  stopChecks: 'off' | 'notify' | 'block';
}

export interface HitlAuditEntry {
  ts: string;
  kind: 'decision' | 'outcome' | 'fallback';
  requestId: string;
  sessionId: string;
  projectPath: string;
  hostId?: string;
  origin?: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  claudeAccount?: string;
  tool?: string;
  type?: ApprovalRequest['type'];
  title?: string;
  filePath?: string;
  commandHash?: string;
  commandPreview?: string;
  decision?: 'allow' | 'deny';
  decidedBy?: HitlDecisionSourceKind;
  deviceId?: string;
  deviceName?: string;
  rule?: string;
  comment?: string;
  waitedMs?: number;
  outcome?: HitlOutcome;
  detail?: string;
  /** Длительность инструмента терминальной сессии (TASK-77). */
  durationMs?: number;
  /** Скриншоты до/после для computer_action (TASK-82). */
  screenshots?: { before?: string; after?: string };
}

export interface HitlAuditQuery {
  month?: string;
  sessionId?: string;
  projectPath?: string;
  decidedBy?: HitlDecisionSourceKind;
  decision?: 'allow' | 'deny';
  kind?: HitlAuditEntry['kind'];
  origin?: HitlOrigin;
  search?: string;
  limit?: number;
}

export type HitlDecideResult =
  | { ok: true; sessionId: string; projectPath: string }
  | { ok: false; reason: 'not_found' | 'already_decided' | 'invalid_source' };

export interface AgentEventBase {
  sessionId: string;
  projectPath: string;
  origin: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  hostId?: string;
  at: number;
}

export type AppBusEvent =
  | { type: 'hitl:requested'; request: ApprovalRequest }
  | { type: 'hitl:decided'; request: ApprovalRequest; approved: boolean; source: HitlDecisionSource; comment?: string }
  | { type: 'hitl:expired'; request: ApprovalRequest }
  | { type: 'hitl:cancelled'; request: ApprovalRequest; reason?: string }
  | {
      type: 'hitl:fallback';
      sessionId: string;
      projectPath: string;
      origin: HitlOrigin;
      engine: HitlEngine;
      agentId?: string;
      agentName?: string;
      role?: string;
      reason: string;
      at: number;
    }
  | ({ type: 'agent:started' } & AgentEventBase)
  | ({ type: 'agent:finished'; outcome: 'done' | 'aborted'; durationMs?: number } & AgentEventBase)
  | ({ type: 'agent:failed'; error: string; durationMs?: number } & AgentEventBase)
  /** Слот переключился на следующую модель fallback-цепочки (TASK-79, decision-44). */
  | ({
      type: 'agent:modelFallback';
      fromModel: string;
      toModel: string;
      errorKind: string;
      errorReason?: string;
      waitedMs?: number;
    } & AgentEventBase)
  // События уведомлений (TASK-63, decision-13 п.1)
  | {
      type: 'swarm:finished';
      swarmId: string;
      projectPath: string;
      name: string;
      /** `plan` — сводное событие плана подзадач (TASK-80, decision-49). */
      mode: 'fan-out' | 'handoff' | 'plan';
      outcome: 'completed' | 'failed' | 'stopped';
      agentsTotal: number;
      agentsFailed: number;
      totalCostUsd?: number;
      durationMs?: number;
      hostId?: string;
      at: number;
    }
  | { type: 'process:crashed'; processId: string; name: string; projectPath: string; exitCode?: number; hostId?: string; at: number }
  | { type: 'pr:created'; projectPath: string; number: number; title: string; url: string; hostId?: string; at: number }
  | { type: 'pr:checksFailed'; projectPath: string; number: number; title: string; url: string; hostId?: string; at: number }
  | { type: 'federation:peerIntroduced'; peerHostId: string; peerName: string; byDevice: string; hostId?: string; at: number }
  | {
      type: 'federation:hostNotice';
      hostId: string;
      machineName: string;
      id: string;
      kind: string;
      title: string;
      text: string;
      level: 'info' | 'success' | 'warning' | 'error';
      projectPath?: string;
      at: number;
    }
  | {
      type: 'remote:deviceConnected';
      deviceId: string;
      deviceName: string;
      mode: string;
      isApproved: boolean;
      hostId?: string;
      at: number;
    }
  | { type: 'remote:deviceApprovalRequested'; deviceId: string; deviceName: string; mode: string; hostId?: string; at: number }
  | {
      type: 'remote:deviceApprovalResolved';
      deviceId: string;
      outcome: 'approved' | 'rejected' | 'disconnected';
      hostId?: string;
      at: number;
    }
  // События Automations (TASK-74, decision-52)
  | { type: 'automation:notify'; ruleId: string; ruleName: string; projectPath?: string; title: string; body?: string; at: number }
  | {
      type: 'automation:suspended';
      ruleId: string;
      ruleName: string;
      projectPath?: string;
      reason: 'budget' | 'runs';
      until: number;
      spentUsd?: number;
      limitUsd?: number;
      at: number;
    }
  | {
      type: 'automation:runFinished';
      ruleId: string;
      ruleName: string;
      runId: string;
      projectPath?: string;
      action: string;
      outcome: 'success' | 'failed';
      detail?: string;
      costUsd?: number;
      swarmId?: string;
      at: number;
    }
  // Ревью PR (TASK-81, decision-53)
  /** Опрос PR увидел новый открытый PR. */
  | ({ type: 'pr:opened' } & PrBusInfo)
  /** В PR новая голова (коммиты, force-push) или черновик стал готовым к ревью. */
  | ({ type: 'pr:updated'; previousSha?: string; reason: 'commits' | 'ready' } & PrBusInfo)
  /** PR, пропавший из открытых, оказался слит (TASK-138.5). Задачи переведены до публикации. */
  | {
      type: 'pr:merged';
      projectPath: string;
      number: number;
      title: string;
      url: string;
      headRef: string;
      baseRef: string;
      author?: string;
      /** Задачи PR: ссылка в `references` или номер в ветке и заголовке. */
      taskIds: string[];
      /** Задачи, переведённые по настройке проекта: из `Review` в выбранный статус. */
      movedTasks: Array<{ taskId: string; from: string; to: string }>;
      at: number;
    }
  /** Ревью PR завершено. */
  | {
      type: 'pr:reviewFinished';
      projectPath: string;
      number: number;
      title: string;
      url?: string;
      headSha: string;
      reviewId: string;
      status: 'done' | 'failed';
      confirmed: number;
      refuted: number;
      unverified: number;
      costUsd?: number;
      publish: 'pending' | 'manual' | 'none';
      error?: string;
      at: number;
    }
  /** Security Health: новые находки аудита, секреты или рискованные пакеты в слоте Swarm (decision-56 п. 10). */
  | {
      type: 'security:finding';
      projectPath: string;
      source: 'audit' | 'secrets' | 'dependencies';
      severity: 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';
      title: string;
      /** Сводка без значений секретов: уровни и пакеты, виды и файлы. */
      summary: string;
      count: number;
      /** Ключ дедупликации: набор advisory или агент и состояние его диффа. */
      key: string;
      swarmId?: string;
      agentId?: string;
      at: number;
    };

/** Поля PR в событиях опроса (TASK-81). */
export interface PrBusInfo {
  projectPath: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  author?: string;
  at: number;
}

// ─────────────────── Ревью PR (TASK-81, decision-53) — зеркало electron/services/prReviewService.ts ───────────────────

export type PrReviewSeverity = 'critical' | 'major' | 'minor' | 'nit';

export interface PrReviewFinding {
  id: string;
  file: string;
  line?: number;
  endLine?: number;
  severity: PrReviewSeverity;
  category?: string;
  title: string;
  description: string;
  suggestion?: string;
  evidence?: string;
  reviewers: string[];
  agreement: number;
  verdict?: 'confirmed' | 'refuted' | 'uncertain';
  verdictReason?: string;
  verdictEvidence?: string;
}

export interface PrReviewRecord {
  id: string;
  projectPath: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  status: 'running' | 'done' | 'failed';
  stage: 'preparing' | 'reviewing' | 'verifying' | 'finished';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Коды ошибок (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
  origin: 'manual' | 'automation';
  taskId?: string;
  budgetUsd?: number;
  costUsd?: number;
  reviewers: { roleSlug: string; name: string; agentId?: string; status: 'pending' | 'done' | 'failed'; findings: number; summary?: string; error?: string; errorKey?: import('../lib/appError').AppErrorKey }[];
  verifier?: { roleSlug: string; name?: string; status: 'pending' | 'done' | 'failed' | 'skipped'; error?: string; errorKey?: import('../lib/appError').AppErrorKey };
  swarmIds: string[];
  findings: PrReviewFinding[];
  comment?: string;
  publish: { mode: 'hitl' | 'manual'; state: 'none' | 'pending' | 'published' | 'declined' | 'blocked' | 'failed'; requestId?: string; commentUrl?: string; error?: string; errorKey?: import('../lib/appError').AppErrorKey; at?: number };
}

export interface PrReviewStartOptions {
  reviewers: string[];
  verifier?: string;
  budgetUsd?: number;
  publish: 'hitl' | 'manual';
  force?: boolean;
}

// ─────────────────── Automations (TASK-74, decision-52) — зеркало electron/services/automationRules.ts и automationEngine.ts ───────────────────

export type AutomationEventTrigger =
  | 'task.assigned'
  | 'task.statusChanged'
  | 'swarm.finished'
  | 'agent.failed'
  | 'process.crashed'
  | 'pr.created'
  | 'pr.checksFailed'
  | 'pr.opened'
  | 'pr.updated'
  | 'pr.merged'
  | 'device.connected';

export type AutomationTrigger =
  | { kind: 'cron'; expr: string; catchUp: 'skip' | 'once' }
  | { kind: 'manual' }
  | { kind: 'event'; event: AutomationEventTrigger };

export interface AutomationConditions {
  projects?: string[];
  labels?: string[];
  statusTo?: string[];
  statusFrom?: string[];
  assignee?: string;
  outcomes?: ('completed' | 'failed' | 'stopped')[];
  processName?: string;
}

export type AutomationAction =
  | {
      type: 'runAgent';
      roleSlug: string;
      mode: 'single' | 'doneLoop';
      prompt?: string;
      taskId?: string;
      budgetUsd?: number;
      maxIterations?: number;
    }
  | { type: 'runChecks'; checkIds?: string[] }
  | { type: 'reindexDocs' }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'projectAction'; actionId: string }
  | { type: 'reviewPr'; reviewers: string[]; verifier?: string; budgetUsd?: number; publish: 'hitl' | 'manual'; includeDrafts: boolean }
  | { type: 'auditDependencies'; minSeverity: 'critical' | 'high' | 'moderate' | 'low' | 'info' };

export interface AutomationLimits {
  cooldownMin: number;
  maxRunsPerDay: number;
  dailyBudgetUsd?: number;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  action: AutomationAction;
  limits: AutomationLimits;
}

/** Правило до разбора схемой: значения по умолчанию подставит main. */
export type AutomationRuleInput = Omit<AutomationRule, 'enabled' | 'conditions' | 'limits' | 'trigger' | 'action'> & {
  enabled?: boolean;
  trigger: AutomationTrigger | { kind: 'cron'; expr: string; catchUp?: 'skip' | 'once' };
  conditions?: AutomationConditions;
  action:
    | AutomationAction
    | (Omit<Extract<AutomationAction, { type: 'runAgent' }>, 'mode'> & { mode?: 'single' | 'doneLoop' })
    | (Omit<Extract<AutomationAction, { type: 'reviewPr' }>, 'publish' | 'includeDrafts'> & { publish?: 'hitl' | 'manual'; includeDrafts?: boolean });
  limits?: Partial<AutomationLimits>;
};

export interface AutomationRuleStateView {
  runsToday: number;
  costTodayUsd: number;
  lastRunAt?: number;
  pausedUntil?: number;
  pauseReason?: 'budget' | 'runs';
  nextRunAt?: number;
}

export interface AutomationRuleView {
  key: string;
  scope: 'global' | 'project' | 'builtin';
  id: string;
  name: string;
  projectRoot?: string;
  active: boolean;
  enabled: boolean;
  trust?: 'trusted' | 'untrusted' | 'changed';
  hash?: string;
  rule?: AutomationRule;
  raw?: unknown;
  issue?: string;
  issueKey?: unknown;
  state: AutomationRuleStateView;
  builtinLimits?: { dailyBudgetUsd: number; maxRunsPerDay: number };
}

export interface AutomationsSettings {
  maxConcurrentAgentRuns: number;
  builtinAssigned: { dailyBudgetUsd: number; maxRunsPerDay: number };
}

export interface AutomationListResult {
  rules: AutomationRuleView[];
  settings: AutomationsSettings;
}

export type AutomationRunNowResult = { ok: true; runIds: string[] } | { ok: false; reason: string; reasonKey?: import('../lib/appError').AppErrorKey };

export interface AutomationLogEntry {
  ts: string;
  ruleKey: string;
  ruleId: string;
  ruleName: string;
  scope: 'global' | 'project' | 'builtin';
  status: 'started' | 'success' | 'failed' | 'skipped' | 'suspended' | 'resumed';
  runId?: string;
  projectPath?: string;
  trigger: string;
  subject?: string;
  eventSummary?: string;
  eventSummaryKey?: import('../lib/appError').AppErrorKey;
  action?: string;
  reason?: string;
  detail?: string;
  /** Код подробности (decision-165): текст — по словарю `appErrors`. */
  detailKey?: import('../lib/appError').AppErrorKey;
  swarmId?: string;
  costUsd?: number;
  durationMs?: number;
  depth?: number;
}

// ─────────────────── Нерасшифрованные секреты (TASK-141, decision-88) — зеркало electron/services/secretStorageTypes.ts ───────────────────

export type SecretIssueReason = 'undecryptable' | 'encryptionUnavailable' | 'corruptFile';
export type SecretIssueSource = 'secrets' | 'ai-config' | 'llm-profiles';

export interface SecretIssue {
  key: string;
  reason: SecretIssueReason;
  source: SecretIssueSource;
  at: number;
}

export interface SecretIssuesState {
  issues: SecretIssue[];
  backupFile: string;
}

// ─────────────────── Подключения к внешним сервисам (TASK-138.1, decision-102) — зеркало electron/services/connectionTypes.ts ───────────────────

export type ConnectionAuthMethod = 'oauth-browser' | 'oauth-device' | 'token' | 'basic';
export type ConnectionStatus = 'connected' | 'needsReauth' | 'error' | 'unchecked';
export type ConnectionCategory = 'tracker' | 'vcs' | 'ci' | 'chat';

export interface ConnectionView {
  id: string;
  serviceId: string;
  serviceLabel: string;
  label: string;
  baseUrl: string;
  method: ConnectionAuthMethod;
  scopes: string[];
  account?: { id?: string; login?: string; name?: string };
  username?: string;
  oauthClientId?: string;
  redirectPort?: number;
  status: ConnectionStatus;
  statusDetail?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  hasRefreshToken: boolean;
  hasClientSecret: boolean;
  usedBy: string[];
}

export interface ConnectionServiceInfo {
  id: string;
  label: string;
  categories: ConnectionCategory[];
  methods: ConnectionAuthMethod[];
  defaultBaseUrl?: string;
  selfHosted: boolean;
  scopes: Array<{ id: string; default?: boolean }>;
  clientSecretRequired: Partial<Record<ConnectionAuthMethod, boolean>>;
  builtinClientId?: string;
  tokenHelpUrl?: string;
  oauthAppHelpUrl?: string;
  usernameHint?: string;
  /** Подсказка к полю токена (TASK-138.6). */
  tokenHint?: 'slackApp' | 'webhook';
}

export interface ConnectionFlowView {
  flowId: string;
  serviceId: string;
  method: 'oauth-browser' | 'oauth-device';
  state: 'pending' | 'exchanging' | 'done' | 'error' | 'cancelled';
  userCode?: string;
  verificationUri?: string;
  authorizeUrl?: string;
  expiresAt: number;
  connectionId?: string;
  error?: string;
}

export interface ConnectionInput {
  serviceId: string;
  method: ConnectionAuthMethod;
  label?: string;
  baseUrl?: string;
  scopes?: string[];
  token?: string;
  username?: string;
  clientId?: string;
  clientSecret?: string;
  redirectPort?: number;
}

export interface ConnectionRemoveResult {
  removed: boolean;
  remoteRevoke: 'revoked' | 'unsupported' | 'failed' | 'notNeeded';
  manualRevokeUrl?: string;
}

// ─────────────────── Синхронизация с трекерами (TASK-128, decision-103) — зеркало electron/services/trackerTypes.ts ───────────────────

export type TrackerField = 'title' | 'description' | 'status';
export type TrackerJournalKind = 'import' | 'export' | 'push' | 'pull' | 'conflict' | 'missingRemote' | 'missingLocal' | 'relinked' | 'unmappedStatus' | 'error';

export interface RemoteStatus {
  name: string;
  type: string;
}

export interface TrackerTarget {
  id: string;
  name: string;
  path?: string;
}

export interface TrackerTargetGroup {
  id: string;
  name: string;
  targets: TrackerTarget[];
}

export interface TrackerSyncConfig {
  version: 1;
  enabled: boolean;
  adapter: string;
  target: TrackerTarget | null;
  statusMap: Record<string, string>;
  conflictPolicy: 'backlog' | 'remote';
  exportLabel: string;
  importClosed: boolean;
}

export interface TrackerJournalEntry {
  kind: TrackerJournalKind;
  taskId?: string;
  externalId?: string;
  title?: string;
  fields?: TrackerField[];
  detail?: string;
  detailKey?: import('../lib/appError').AppErrorKey;
}

export interface TrackerRunSummary {
  at: number;
  finishedAt: number;
  dryRun: boolean;
  ok: boolean;
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  counts: Partial<Record<TrackerJournalKind, number>>;
  entries: TrackerJournalEntry[];
}

export interface TrackerSyncStatusView {
  projectPath: string;
  config: TrackerSyncConfig;
  connectionId: string | null;
  intervalMinutes: number;
  linkedTasks: number;
  running: boolean;
  lastRun: TrackerRunSummary | null;
  adapters: Array<{ id: string; label: string; serviceId: string }>;
}

/** Лимиты задач агентов (TASK-155) — зеркало electron/services/agentTaskSettingsService.ts. */
export interface AgentTaskSettings {
  limits: { perSession: number; perProjectPerDay: number };
}

/** Восстановление из резервной копии (TASK-154). */
export type SecretBackupReason = SecretIssueReason | 'replaced';
export type SecretRestoreStatus = 'restorable' | 'current' | 'unreadable' | 'noValue';

export interface SecretBackupItem {
  id: string;
  key: string;
  reason: SecretBackupReason;
  source: SecretIssueSource;
  at: number;
  status: SecretRestoreStatus;
  replacesCurrent: boolean;
  suggested: boolean;
  restoredAt?: number;
}

export interface SecretBackupPreview {
  items: SecretBackupItem[];
  backupFile: string;
  encryptionAvailable: boolean;
}

/** Удаление записей из копии (TASK-157). */
export interface SecretBackupDeleteResult {
  removed: string[];
  skipped: Array<{ id: string; reason: 'unknown' }>;
  preview: SecretBackupPreview;
}

export interface SecretRestoreResult {
  restored: string[];
  skipped: Array<{ id: string; reason: 'unknown' | 'notRestorable' | 'duplicateKey' }>;
  preview: SecretBackupPreview;
}

// ─────────────────── Уведомления (TASK-63, decision-13) — зеркало electron/services/notificationTypes.ts ───────────────────

export type NotificationChannel = 'tray' | 'os' | 'sound' | 'telegram' | 'remote';

export type NotificationKind =
  | 'hitl'
  | 'agentFinished'
  | 'agentFailed'
  | 'swarmFinished'
  | 'processCrashed'
  | 'prCreated'
  | 'prChecksFailed'
  | 'prMerged'
  | 'deviceConnected'
  | 'deviceApproval'
  | 'modelFallback'
  | 'automation'
  | 'prReview'
  | 'securityFinding'
  | 'agentTask'
  | 'docBranch'
  | 'spendLimit'
  | 'mergeQueue';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export type NotificationAction =
  | { type: 'openHitl'; requestId?: string }
  | { type: 'openSwarm'; projectPath?: string; sessionId?: string }
  | { type: 'openProcesses'; projectPath?: string }
  | { type: 'openPrs'; projectPath?: string; url?: string }
  | { type: 'openRemote'; tab?: 'devices' }
  | { type: 'openAutomations'; projectPath?: string }
  | { type: 'openSecurity'; projectPath?: string }
  | { type: 'openTask'; projectPath?: string; taskId?: string }
  | { type: 'openDocBranch'; projectPath?: string; branchId?: string }
  | { type: 'openApp' };

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  at: number;
  dedupKey: string;
  projectPath?: string;
  projectName?: string;
  hostId?: string;
  requestId?: string;
  sessionId?: string;
  action?: NotificationAction;
  agentTaskApproval?: { ticket: string; count: number };
}

export interface QuietHoursSettings {
  enabled: boolean;
  from: string;
  to: string;
  allowCritical: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  channels: Record<NotificationKind, NotificationChannel[]>;
  quietHours: QuietHoursSettings;
  soundVolume: number;
  dedupWindowMs: number;
  minimizeToTray: boolean;
  telegramBotAutoStart: boolean;
}

export interface NotificationCapabilities {
  osNotifications: boolean;
  /** Кнопки «Разрешить/Отклонить» прямо в системном уведомлении (только macOS). */
  osActions: boolean;
  tray: boolean;
  telegram: boolean;
}

export interface NotificationDelivery {
  notification: AppNotification;
  channels: NotificationChannel[];
}

export interface NotificationSettingsState {
  settings: NotificationSettings;
  capabilities: NotificationCapabilities;
  bot: { running: boolean; processId: string | null; configured: boolean };
}

/** Флаги совместимости OpenAI-совместимого сервера (electron/services/llmProfiles.ts, decision-39). */
export interface LlmCompatFlags {
  tools: boolean;
  vision: boolean;
  streamUsage: boolean;
  openRouterUsage: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  reasoning: 'none' | 'reasoning_effort' | 'reasoning_object' | 'ollama_think';
  responseFormat: boolean;
}

export interface LlmProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
  compat: LlmCompatFlags;
  headers?: Record<string, string>;
}

export interface LlmProfile {
  id: string;
  name: string;
  presetId: string;
  baseUrl: string;
  local: boolean;
  compat: LlmCompatFlags;
  headers?: Record<string, string>;
}

export interface LlmProfileView extends LlmProfile {
  hasApiKey: boolean;
}

export interface ModelCatalogResult {
  models: string[];
  fetchedAt: number | null;
  cached: boolean;
  /** Английский запасной текст ошибки; окно собирает свой по полям ниже (`modelCatalogErrorText`, decision-165). */
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  errorCauseKey?: import('../lib/appError').AppErrorKey;
  errorInfo?: ProviderErrorInfo;
  errorDetail?: string;
}

export interface AIProviderConfig {
  provider: 'anthropic' | 'openrouter' | 'deepseek' | 'ollama' | 'custom' | 'openai-compatible';
  /** Движок основной модели (TASK-134.1, decision-74); без поля `anthropic` без ключа — подписка. */
  engine?: 'claude-cli' | 'api';
  /** Профиль для `openai-compatible` (TASK-70.1). */
  profileId?: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  thinkingBudget?: number;
  /** Усилие рассуждений (TASK-70.3, decision-41); без значения — режим модели по умолчанию. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max';
  autoApprove?: boolean;
  autoApproveRules?: AutoApproveRules;
}

export interface AIToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status?: 'pending' | 'accepted' | 'rejected' | 'running' | 'done' | 'error';
  result?: any;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    patch: string;
    /** Содержимое усечено при сохранении на диск (TASK-35); полный текст был доступен только в живой сессии. */
    truncated?: boolean;
  };
}

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thought?: string;
  toolCalls?: AIToolCall[];
  timestamp: string;
  /** Токены и стоимость ответа модели, если провайдер их сообщил (TASK-56). */
  usage?: AgentUsage;
  /** Ответ завершился ошибкой (TASK-70.6): текст для пользователя; карточка строится по `providerError`. */
  error?: string;
  /** Снимок ошибки провайдера (decision-43) — локализованные заголовок и совет, кнопка «Повторить». */
  providerError?: ProviderErrorInfo;
}

/** Зеркало `electron/services/providerErrors.ts` (decision-43). */
export type ProviderErrorKind = 'auth' | 'quota' | 'model_not_found' | 'rate_limit' | 'unavailable' | 'bad_request' | 'config' | 'unknown';

export type ProviderErrorReason =
  | 'tools'
  | 'reasoning'
  | 'context'
  | 'unsupported'
  | 'moderation'
  | 'refused'
  | 'dns'
  | 'timeout'
  | 'tls'
  | 'network'
  | 'server'
  | 'overloaded'
  | 'forbidden'
  | 'endpoint'
  | 'no_model'
  | 'no_key'
  | 'no_profile'
  | 'provider'
  | 'engine';

export interface TaskDraftRequest {
  title: string;
  /** Проект задачи: по нему Claude Code берёт аккаунт (decision-87). */
  projectPath?: string;
  description?: string;
  existingCriteria?: string[];
  language?: 'ru' | 'en';
}

export interface TaskDraftResponse {
  ok: boolean;
  draft?: { description: string; criteria: string[] };
  model?: string;
  /** `empty_title`, `unparsed` (ответ не похож на черновик) или текст ошибки. */
  error?: string;
  /** Код ошибки (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
  /** Цель назначения «Черновик описания задачи» непригодна: `error` называет назначение. */
  modelProblem?: boolean;
  providerError?: ProviderErrorInfo;
}

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  reason?: ProviderErrorReason;
  status?: number;
  code?: string;
  retryable: boolean;
  retryAfterMs?: number;
  provider?: string;
  profileId?: string;
  endpoint?: string;
  model?: string;
  local?: boolean;
  reasoningEffort?: string;
  serverMessage?: string;
  message: string;
  /** Код ошибки настройки или ошибки ProjectHub (decision-165): совет — по словарю `appErrors`, `message` — английский. */
  messageKey?: import('../lib/appError').AppErrorKey;
  /** Назначение, для которого выбиралась модель (TASK-134.1, decision-74). */
  purpose?: string;
}

/** Диалог Agents Studio; хранится файлом `~/.projecthub/sessions/<hash(projectPath)>/<id>.json` (TASK-35). */
/** Части контекста агента (TASK-64) — что показывает `ContextAppliedCard` и что можно отключить на сессию. */
export type ContextPartKey = 'task' | 'memory' | 'rag' | 'gitnexus' | 'git';

/** Результат `contextBuilder.buildAgentContext` (main) — зеркало `AgentContextResult` для превью в Agents Studio. */
export interface AgentContextPreview {
  combined: string;
  parts: Array<{ key: ContextPartKey; label: string; text: string }>;
  includedKeys: ContextPartKey[];
  truncatedKeys: ContextPartKey[];
}

export interface AISession {
  id: string;
  title: string;
  /** Заголовок по умолчанию: первый промпт заменит его своим началом (TASK-204). */
  autoTitle?: boolean;
  createdAt: number;
  messages: AIMessage[];
  claudeCliSessionId?: string;
  /** Задача, привязанная к сессии (TASK-64) — по ней contextBuilder собирает контекст на каждое сообщение. */
  activeTaskId?: string;
  /** Какие части контекста включены; по умолчанию (без поля) — все. */
  contextParts?: Partial<Record<ContextPartKey, boolean>>;
  /** Вкладку закрыли — сессия в истории, а не удалена (TASK-140.10, decision-83). */
  archivedAt?: number;
  /** Откуда начата сессия: с телефона — пометка во вкладке. */
  origin?: 'desktop' | 'phone';
  originDevice?: string;
  /** Модель и режим последнего промпта — для истории и продолжения с телефона. */
  lastSelection?: { provider: string; profileId?: string; model: string };
  lastMode?: 'chat' | 'agent' | 'architect';
  /** Агент вкладки (TASK-170): провайдер, модель и аккаунт Claude Code; без поля — общий выбор Studio. */
  agent?: StudioSessionAgent;
  /**
   * Участник общего хоста, чья это сессия (TASK-142.3): пишет в неё только он со своих устройств, окно хоста и другие
   * участники видят её только для чтения. Без поля — сессия владельца хоста.
   */
  memberId?: string;
}

/** Агент вкладки Agents Studio (TASK-170). `claudeAccountId` действует только для Claude Code CLI. */
export interface StudioSessionAgent {
  provider: AIProviderConfig['provider'];
  profileId?: string;
  model: string;
  claudeAccountId?: string;
}

/** Запрос хоста к стору Agents Studio от имени телефона (`aiStudio:remoteRequest`). */
export type StudioRemoteRequestPayload =
  | {
      requestId: string;
      kind: 'send';
      projectPath: string;
      sessionId?: string;
      text: string;
      selection?: { provider: string; profileId?: string; model: string; claudeAccountId?: string };
      mode?: 'chat' | 'agent' | 'architect';
      deviceName: string;
      /** Участник общего хоста, чьё устройство прислало промпт (TASK-142.3). */
      memberId?: string;
    }
  | { requestId: string; kind: 'abort' | 'clear'; projectPath: string; sessionId: string };

export interface AIStreamRequest {
  sessionId: string;
  projectPath: string;
  messages: AIMessage[];
  config: AIProviderConfig;
  mode: 'chat' | 'agent' | 'architect';
  /** Потолок ответа модели на один шаг API-пути (TASK-88); без значения — потолок по умолчанию. */
  maxTokens?: number;
  claudeCliSessionId?: string;
  taskId?: string;
  contextParts?: Partial<Record<ContextPartKey, boolean>>;
  /** Активное рабочее дерево (worktree) — рабочий каталог агента; backlog общий (TASK-62). */
  workspaceRoot?: string;
  /** Аккаунт Claude Code вкладки (TASK-170); без поля — аккаунт проекта. */
  claudeAccountId?: string;
  /** Участник общего хоста, чья сессия (TASK-142.3): хост сам выбирает его worktree и права HITL. */
  memberId?: string;
}

export interface GitWorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  lockReason?: string;
  isPrunable: boolean;
  pruneReason?: string;
  isMain: boolean;
  taskId?: string;
  /** Что отработала политика `worktreeInit` сразу после создания дерева (TASK-62). */
  init?: WorktreeInitOutcome;
}

export interface AddWorktreeOptions {
  branch: string;
  newBranch?: boolean;
  baseCommitOrBranch?: string;
  customPath?: string;
}

/** Замена номера входящей стороны при слиянии (decision-76). */
export interface BacklogRenumbering {
  kind: 'task' | 'decision' | 'doc' | 'mem';
  from: string;
  to: string;
}

/** План перенумерации для подтверждения человеком до слияния (decision-76 п. 6). */
export interface BacklogRenumberSummary {
  renumber: BacklogRenumbering[];
  mentionCount: number;
  fileCount: number;
  /** Тот же план по-английски — для журнала; окно строит сообщение само (`buildRenumberMessage`). */
  text: string;
  /** План строками словаря карточки HITL (TASK-202.8). */
  lines?: HitlTextLine[];
}

export interface MergeOptions {
  /** Человек подтвердил перенумерацию входящей стороны (показан `renumberRequired`). */
  renumber?: boolean;
}

export interface MergeWorktreeResult {
  success: boolean;
  error?: string;
  /** Код ошибки (decision-165): окно показывает её на своём языке. */
  errorKey?: unknown;
  conflictedFiles?: string[];
  wasAborted?: boolean;
  uncleanWorkingTree?: boolean;
  /** Номера backlog совпали — слияние не начато, нужен ответ человека и повтор с `renumber: true`. */
  renumberRequired?: BacklogRenumberSummary;
  /** Слито с перенумерацией входящей стороны. */
  renumbered?: BacklogRenumbering[];
}

export interface OrphanedWorktreeScan {
  orphanedWorktrees: GitWorktreeInfo[];
  orphanedPaths: string[];
  orphanedBranches: string[];
}

export interface CleanOrphanedResult {
  removedWorktrees: string[];
  removedBranches: string[];
  deletedBranches?: string[];
  errors: string[];
}

export interface PtySession {
  id: string;
  projectPath: string;
  cwd?: string;
  worktreeBranch?: string;
  projectName: string;
  type: 'claude' | 'shell' | 'claude-login';
  title: string;
  createdAt: number;
  status: 'running' | 'exited';
  exitCode?: number;
  /** Аккаунт Claude Code, под которым запущен терминал (TASK-152). */
  claudeAccountId?: string;
  claudeAccountName?: string;
}

export interface CreatePtyOptions {
  sessionId?: string;
  projectPath: string;
  cwd?: string;
  worktreeBranch?: string;
  projectName?: string;
  /** `claude-login` — `claude auth login` под профилем `claudeAccountId` (TASK-152.2). */
  type: 'claude' | 'shell' | 'claude-login';
  title?: string;
  cols?: number;
  rows?: number;
  /** Профиль аккаунта: для `claude-login` — обязателен; для `claude` — аккаунт вкладки Studio, иначе по проекту. */
  claudeAccountId?: string;
  /** `claude --resume <id>` вместо новой сессии (TASK-230: продолжить разговор Studio в терминале). */
  resumeSessionId?: string;
}

/** Сессия Claude Code рабочей папки (TASK-230, `/resume` в Studio). */
export interface CliSessionSummary {
  id: string;
  updatedAt: number;
  title: string;
}

export interface ClaudeUsageLimitWindow {
  percent: number;
  resetsAt?: string;
}

export interface ClaudeUsageBreakdownItem {
  name: string;
  percent: number;
}

export interface ClaudeUsageBreakdown {
  requests?: number;
  sessions?: number;
  contextAbove150kPercent?: number;
  subagentHeavyPercent?: number;
  sessionsOver8hPercent?: number;
  topSkills?: ClaudeUsageBreakdownItem[];
  topSubagents?: ClaudeUsageBreakdownItem[];
  topMcpServers?: ClaudeUsageBreakdownItem[];
}

export interface ClaudeModelTokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD?: number;
}

export interface ClaudeUsageData {
  planType: string;
  sessionLimit?: ClaudeUsageLimitWindow;
  weeklyLimit?: ClaudeUsageLimitWindow;
  fableLimit?: ClaudeUsageLimitWindow;
  last24h?: ClaudeUsageBreakdown;
  last7d?: ClaudeUsageBreakdown;
  totalSessions?: number;
  totalMessages?: number;
  modelUsage?: Record<string, ClaudeModelTokenStats>;
  dailyActivity?: {
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }[];
  rawText?: string;
  /** Источники данных без вывода CLI (TASK-202.4): окно собирает пояснение на своём языке. */
  sources?: { accountName: string; configDir: string; statsFile: string; hasStatsCache: boolean; rateLimitsAt?: number };
  updatedAt: number;
  isFallback?: boolean;
  /** Профиль аккаунта Claude Code, чьи это лимиты (TASK-152.5). */
  accountId?: string;
  accountName?: string;
  /** Почему `claude -p /usage` не дал лимитов (TASK-126); при успешном ответе поля нет. */
  cliError?: {
    kind: 'auth' | 'timeout' | 'failed' | 'unrecognized';
    detail?: string;
  };
}

declare global {
  interface Window {
    api: IElectronAPI;
  }
}

// Multi-Agent Swarm & Fleet Orchestration Types (TASK-54, TASK-56)
// Зеркало `electron/services/swarmTypes.ts` и `agentCost.ts`.
export type SwarmMode = 'fan_out' | 'handoff' | 'done_loop';
export type SwarmStatus = 'idle' | 'preparing' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type AgentSlotStatus =
  | 'pending'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'budget_exceeded';

export type AgentCostSource = 'provider' | 'price-table' | 'local' | 'unknown';

/** Зеркало `electron/services/agentCost.ts::ModelPrice` — USD за 1M токенов. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceTable {
  updatedAt: string;
  models: Record<string, ModelPrice>;
}

/** Зеркало `electron/services/agentPricing.ts`. */
export type PriceOverrideSource = 'manual' | 'openrouter';

export interface PriceOverrideEntry extends ModelPrice {
  source?: PriceOverrideSource;
}

export interface PriceOverrides {
  updatedAt?: string;
  models: Record<string, PriceOverrideEntry>;
}

export interface AgentPricingState {
  builtin: PriceTable;
  overrides: PriceOverrides;
  filePath: string;
  loadError?: string;
}

export interface OpenRouterImportedPrice {
  id: string;
  sourceId: string;
  name?: string;
  price: ModelPrice;
  hasLongContextTier: boolean;
}

export interface OpenRouterImportResult {
  entries: OpenRouterImportedPrice[];
  skipped: { variant: number; dynamic: number; invalid: number; duplicate: number };
  total: number;
}

/** Реальный usage и стоимость ответа модели/прогона агента (TASK-56). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd?: number;
  costSource: AgentCostSource;
  model?: string;
  turns?: number;
  /** Токены оценены по длине текста: сервер не сообщил usage. */
  estimated?: boolean;
}

export interface AgentSlotConfig {
  id: string;
  name: string;
  engine: 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api';
  /** Отображаемая метка роли (для UI/логов/HITL-карточек). */
  role?: string;
  /** slug роли из реестра (decision-9, TASK-60) — предзаполняет engine/model/permissions в UI. */
  roleSlug?: string;
  /** Профиль, прежний провайдер или только модель; без поля — настройки Agents Studio (decision-40). */
  providerConfig?: Partial<AIProviderConfig>;
  /** Тир модели (decision-44): цепочка из таблицы тиров; явная модель слота — первое звено. */
  modelTier?: ModelTier;
  /** Доп. инструкции слота поверх системного промпта роли. */
  systemPromptAddon?: string;
  /** Бюджет слота/роли в USD; при превышении агент останавливается. */
  budgetUsd?: number;
  /** Права роли для HITL: сужают глобальные настройки auto-approve (TASK-57). */
  permissions?: RolePermissions;
  /** Аккаунт Claude Code слота `claude-cli` (TASK-152.4): id профиля, важнее роли и проекта. */
  claudeAccountId?: string;
}

export interface AgentSlotDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  patch: string;
  truncated?: boolean;
  /** Затронутые модули (TASK-61). */
  modules?: string[];
  /** Задетые символы по GitNexus; отсутствует, если репозиторий не проиндексирован. */
  dependentSymbols?: number;
  affectedProcesses?: number;
  riskLevel?: string;
}

// ─── Автосудья Swarm Arena (TASK-61, decision-12); зеркало electron/services/arenaTypes.ts ───

export type CheckKind = 'lint' | 'test' | 'build' | 'typecheck' | 'ui-smoke' | 'custom';
export type CheckArtifactKind = 'screenshot' | 'trace';

/** Артефакты проверки `ui-smoke` (TASK-78, decision-55). */
export interface CheckArtifactsConfig {
  from?: string[];
  minScreenshots?: number;
}

export interface CheckArtifact {
  name: string;
  relPath: string;
  kind: CheckArtifactKind;
  bytes: number;
}
export type CheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'timeout' | 'skipped' | 'error';

export interface CheckDefinition {
  id: string;
  kind: CheckKind;
  name: string;
  command: string;
  timeoutMs?: number;
  blocking?: boolean;
  enabled?: boolean;
  portStrategy?: 'fixed' | 'auto';
  port?: number;
  artifacts?: CheckArtifactsConfig;
}

export interface CheckRunResult {
  id: string;
  kind: CheckKind;
  name: string;
  command: string;
  status: CheckStatus;
  blocking: boolean;
  exitCode?: number;
  startedAt?: number;
  durationMs?: number;
  failedTests?: number;
  passedTests?: number;
  totalTests?: number;
  errorCount?: number;
  warningCount?: number;
  outputTail?: string;
  outputTruncated?: boolean;
  detail?: string;
  /** Код причины (decision-165): текст — по словарю `appErrors`, `detail` — английский запасной. */
  detailKey?: import('../lib/appError').AppErrorKey;
  artifacts?: CheckArtifact[];
  artifactsTruncated?: boolean;
}

export type ScoreComponentKey = 'checks' | 'acceptance' | 'review' | 'diffSize' | 'locality' | 'cost' | 'time' | 'security';
export type ScoreWeights = Record<ScoreComponentKey, number>;

export interface ScoreComponent {
  key: ScoreComponentKey;
  weight: number;
  normalized: number;
  points: number;
  raw?: number;
  detail: string;
  detailKey?: import('../lib/appError').AppErrorKey;
  unknown?: boolean;
}

export interface CandidateScore {
  agentId: string;
  total: number;
  blocked: boolean;
  blockedReason?: string;
  blockedReasonKey?: import('../lib/appError').AppErrorKey;
  components: ScoreComponent[];
  computedAt: number;
}

export type ReviewSeverity = 'info' | 'minor' | 'major' | 'critical';
export type CriterionVerdict = 'met' | 'partial' | 'unmet' | 'unknown';
export type ReviewerStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ReviewerFinding {
  file?: string;
  line?: number;
  severity: ReviewSeverity;
  message: string;
}

export interface ReviewerCriterionVerdict {
  index: number;
  text: string;
  verdict: CriterionVerdict;
  comment?: string;
}

export interface ReviewerVerdict {
  agentId: string;
  status: ReviewerStatus;
  summary?: string;
  findings?: ReviewerFinding[];
  criteria?: ReviewerCriterionVerdict[];
  risks?: string[];
  overall?: number;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  errorKey?: unknown;
  providerError?: ProviderErrorInfo;
  raw?: string;
}

export type JudgeStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JudgeState {
  status: JudgeStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  recommendedAgentId?: string;
  weights?: ScoreWeights;
  stage?: 'checks' | 'diff' | 'review' | 'scoring';
  autoMerge?: {
    enabled: boolean;
    attempted: boolean;
    merged: boolean;
    agentId?: string;
    reason: string;
    reasonKey?: import('../lib/appError').AppErrorKey;
  };
}

export interface ArenaSettings {
  weights?: Partial<ScoreWeights>;
  autoMerge?: { enabled?: boolean; minScore?: number };
  reviewer?: { enabled?: boolean; roleSlug?: string; provider?: string; profile?: string; model?: string };
  maxConcurrentChecks?: number;
}

export interface ArenaConfig {
  checks: CheckDefinition[];
  weights: ScoreWeights;
  autoMerge: { enabled: boolean; minScore: number };
  reviewer: { enabled: boolean; roleSlug: string; provider?: string; profile?: string; model?: string };
  maxConcurrentChecks: number;
}

export interface ComposeSelection {
  agentId: string;
  files: string[];
}

export interface ComposeResult {
  success: boolean;
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  applied?: Array<{ agentId: string; branch: string; files: string[] }>;
}

export interface AgentSlotMetrics {
  startTime: number;
  endTime?: number;
  durationMs?: number;
  charsGenerated?: number;
  tokensEstimated?: number;
  speedCharsPerSec?: number;
  usage?: AgentUsage;
  costUsd?: number;
}

/** Зеркало `electron/services/slotProvider.ts::ResolvedProviderInfo`. */
export interface ResolvedProviderInfo {
  provider: AIProviderConfig['provider'];
  model?: string;
  profileId?: string;
  profileName?: string;
  local?: boolean;
}

export interface AgentSlotState {
  id: string;
  config: AgentSlotConfig;
  status: AgentSlotStatus;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeMissing?: boolean;
  /** Хвост логов (кольцевой буфер); полный транскрипт читается через getSwarmTranscript. */
  logs: string[];
  logsDropped?: number;
  liveOutput: string;
  liveOutputTruncated?: boolean;
  finalOutput?: string;
  diffSummary?: AgentSlotDiffSummary;
  metrics: AgentSlotMetrics;
  winner?: boolean;
  error?: string;
  /** Код ошибки агента (decision-165): текст — по словарю `appErrors`. */
  errorKey?: import('../lib/appError').AppErrorKey;
  commitHash?: string;
  stashHash?: string;
  commitStatus?: 'committed' | 'stashed' | 'no_changes' | 'pending';
  lastCommitHash?: string;
  resumeCount?: number;
  /** `session_id` Claude CLI для `--resume` в цикле «до готовности» (TASK-75). */
  cliSessionId?: string;
  /** Результаты проверок автосудьи (TASK-61). */
  checks?: CheckRunResult[];
  /** Секреты и изменения зависимостей в диффе кандидата (TASK-73, decision-56 п. 5). */
  security?: AgentSlotSecurity;
  score?: CandidateScore;
  review?: ReviewerVerdict;
  /** Провайдер, с которым агент реально работал (API-движок, decision-40) — для экспорта и UI. */
  providerInfo?: ResolvedProviderInfo;
  /** Снимок ошибки провайдера (decision-43), если агент упал на запросе к модели. */
  providerError?: ProviderErrorInfo;
  /** Тир, фактическая модель и переключения модели (decision-44). */
  modelRouting?: ModelRoutingInfo;
  /** Чекпоинты рабочего каталога по ходам (decision-45). */
  checkpoints?: AgentCheckpoint[];
  /** Откаты агента к чекпоинтам (decision-45). */
  rewinds?: AgentRewindRecord[];
  /** Сквозные номера запусков, ходов и чекпоинтов. */
  trace?: AgentTraceCounters;
  /** Пояснение об откате для следующего запуска агента. */
  pendingRewindNote?: string;
}

// ─── Чекпоинты и таймлайн агента (TASK-72, decision-45); зеркало electron/services/agentTraceTypes.ts ───

export type CheckpointKind = 'start' | 'turn' | 'end' | 'pre_rewind';

export interface AgentCheckpoint {
  n: number;
  kind: CheckpointKind;
  run?: number;
  turn?: number;
  at: number;
  ref: string;
  commit: string;
  tree: string;
  parent: string | null;
  filesChanged?: number;
}

export interface AgentRewindRecord {
  at: number;
  toCheckpoint: number;
  toTurn?: number;
  toKind: CheckpointKind;
  preRewindCheckpoint?: number;
  removedFiles: number;
  commitHash?: string;
}

export interface AgentTraceCounters {
  runs: number;
  turns: number;
  checkpoints: number;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  costSource?: AgentCostSource;
  model?: string;
  partial?: boolean;
  estimated?: boolean;
}

export type TimelineToolStatus = 'ok' | 'error' | 'running' | 'no_result' | 'not_executed';
export type TimelineHitlDecision = 'requested' | 'allow' | 'deny' | 'expired' | 'cancelled';

export interface TimelineHitl {
  requestId: string;
  decision: TimelineHitlDecision;
  decidedBy?: string;
  rule?: string;
  tool?: string;
  title?: string;
  at: number;
}

export interface TimelineTool {
  toolId: string;
  name: string;
  input?: string;
  run: number;
  turn: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TimelineToolStatus;
  outputChars?: number;
  hitl: TimelineHitl[];
}

export interface TimelineTurn {
  turn: number;
  run: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  tools: TimelineTool[];
  usage?: TraceUsage;
  checkpoint?: number;
}

export interface TimelineRun {
  run: number;
  engine?: string;
  model?: string;
  iteration?: number;
  afterRewind?: boolean;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status?: string;
  numTurns?: number;
  usage?: TraceUsage;
  turns: number[];
  errors: string[];
  checkpoints: number[];
}

export interface TimelineModelSwitch {
  at: number;
  run: number;
  from: string;
  to: string;
  kind: string;
  reason?: string;
  waitedMs?: number;
}

export interface TimelineCheckpointEvent {
  type: 'checkpoint';
  v: 1;
  at: number;
  run: number;
  turn?: number;
  n: number;
  kind: CheckpointKind;
  ref: string;
  commit: string;
  tree: string;
  parent: string | null;
  filesChanged?: number;
}

export interface TimelineRewindEvent {
  type: 'rewind';
  v: 1;
  at: number;
  run: number;
  toCheckpoint: number;
  toTurn?: number;
  preRewindCheckpoint?: number;
  removedFiles: number;
}

/** Продолжение после отката или с уточнением (decision-48 п. 4). */
export interface TimelineContinueEvent {
  type: 'continue';
  v: 1;
  at: number;
  run: number;
  mode: ContinueMode;
  toCheckpoint?: number;
  iteration?: number;
  stage?: number;
  instruction?: boolean;
}

export interface AgentTimeline {
  runs: TimelineRun[];
  turns: TimelineTurn[];
  tools: TimelineTool[];
  hitl: TimelineHitl[];
  switches: TimelineModelSwitch[];
  checkpoints: TimelineCheckpointEvent[];
  rewinds: TimelineRewindEvent[];
  continuations: TimelineContinueEvent[];
  toolNames: string[];
  startedAt?: number;
  endedAt?: number;
  totals: {
    runs: number;
    turns: number;
    tools: number;
    toolErrors: number;
    toolTimeMs: number;
    durationMs: number;
    costUsd?: number;
    costPartial: boolean;
  };
  truncated?: boolean;
}

export interface AgentActionAvailability {
  allowed: boolean;
  reason?: string;
  reasonKey?: import('../lib/appError').AppErrorKey;
}

/** Ответ `swarm:getTimeline` (зеркало `AgentTimelineView` из agentFleetService). */
export interface AgentTimelineView {
  swarmId: string;
  agentId: string;
  timeline: AgentTimeline;
  checkpoints: AgentCheckpoint[];
  rewinds: AgentRewindRecord[];
  rewind: AgentActionAvailability;
  /** Режим продолжения по сессии (decision-48 п. 1); для handoff — этап (0-based), с которого перезапуск. */
  continueAgent: AgentActionAvailability & { mode: ContinueMode; fromStage?: number };
  pendingRewindNote?: string;
}

export interface AgentRewindResult {
  success: boolean;
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  removedFiles?: number;
  preRewindCheckpoint?: number;
  commitHash?: string;
}

// ─── Тиры моделей (TASK-79, decision-44); зеркало electron/services/modelTiers.ts ───

export type ModelTier = 'cheap' | 'balanced' | 'frontier';
export type TierEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api';

export interface TierModelEntry {
  engine: TierEngine;
  model: string;
  /** Профиль (имя или id) для движка `api`. */
  profile?: string;
  /** Прежний провайдер для движка `api`; без `profile` и `provider` — провайдер Agents Studio. */
  provider?: string;
  source?: 'auto' | 'manual';
}

export interface ModelTierSettings {
  version: 1;
  updatedAt?: string;
  fallbackToLowerTier: boolean;
  maxSwitches: number;
  maxWaitMs: number;
  tiers: Record<ModelTier, TierModelEntry[]>;
}

export interface ModelTierState {
  settings: ModelTierSettings;
  filePath: string;
  loadError?: string;
  problems: string[];
  /** Коды проблем по порядку `problems` (decision-165). */
  problemKeys?: unknown[];
}

export interface ModelTierSeedResult extends ModelTierState {
  added: number;
}

export type ChainLinkRef = Pick<TierModelEntry, 'engine' | 'model' | 'profile' | 'provider'> & { tier?: ModelTier };

export type FallbackStopReason = 'not_switchable' | 'exhausted' | 'limit' | 'disabled' | 'side_effects';

export interface ModelSwitchRecord {
  at: number;
  from: ChainLinkRef;
  to: ChainLinkRef;
  kind: ProviderErrorKind;
  reason?: ProviderErrorReason;
  status?: number;
  code?: string;
  waitedMs?: number;
  message: string;
}

export interface ModelRoutingInfo {
  requestedTier?: ModelTier;
  source: 'explicit' | 'tier' | 'default';
  engine: TierEngine;
  current?: ChainLinkRef;
  chainLength: number;
  maxSwitches?: number;
  switches: ModelSwitchRecord[];
  stopped?: FallbackStopReason;
  note?: string;
}

export interface HandoffStageState {
  stageIndex: number;
  role: string;
  agentId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  inputPrompt: string;
  instructions?: string;
  /** Сырой вывод агента (устаревшее; для новых сессий используйте summary+reportPath). */
  outputResult?: string;
  /** Артефакт этапа (decision-9 п.5): усечённое резюме для промпта следующего этапа. */
  summary?: string;
  /** Путь к полному отчёту этапа в общем worktree. */
  reportPath?: string;
  /** Коммит, которым зафиксирован результат этапа. */
  commitHash?: string;
  durationMs?: number;
  /** Результат этапа отменён откатом этого или более раннего этапа (decision-48 п. 3.1). */
  invalidatedAt?: number;
  rerunCount?: number;
}

export type ContinueMode = 'agent' | 'loop' | 'handoff';

/** Запись о продолжении после отката (зеркало `SwarmContinuation`, decision-48 п. 4). */
export interface SwarmContinuation {
  at: number;
  mode: ContinueMode;
  agentId: string;
  toCheckpoint?: number;
  afterIteration?: number;
  fromStage?: number;
  stages?: number[];
  instruction?: string;
  note?: string;
}

export interface SwarmSession {
  id: string;
  projectPath: string;
  taskId?: string;
  taskTitle?: string;
  /** Источник запуска для HITL/аудита (TASK-60): по умолчанию выводится из `mode`. */
  origin?: 'swarm' | 'assigned' | 'automation';
  /** Участник общего хоста, запустивший сессию (TASK-142.3). */
  memberId?: string;
  /** Агент участника работает в его worktree; в основную ветку — только через очередь слияния. */
  memberWorktree?: { path: string; branch: string };
  mode: SwarmMode;
  prompt: string;
  baseBranch: string;
  useWorktrees: boolean;
  autoCommitAgentResults?: boolean;
  status: SwarmStatus;
  createdAt: number;
  completedAt?: number;
  interruptedAt?: number;
  agents: AgentSlotState[];
  handoffStages?: HandoffStageState[];
  currentHandoffStageIndex?: number;
  winnerAgentId?: string;
  pendingMergeApproval?: { requestId: string; agentIds: string[]; since: number };
  error?: string;
  errorKey?: import('../lib/appError').AppErrorKey;
  budgetUsd?: number;
  totalCostUsd?: number;
  /** Примечания ограничений при запуске (бюджеты Team, decision-124). */
  launchNotices?: Array<{ level: 'info' | 'warn' | 'block'; text: string }>;
  restored?: boolean;
  /** Состояние автосудьи арены (TASK-61). */
  judge?: JudgeState;
  /** Состояние цикла «до готовности» (TASK-75). */
  doneLoop?: DoneLoopState;
  /** Продолжения после отката (decision-48 п. 4). */
  continuations?: SwarmContinuation[];
}

export interface StartFanOutOptions {
  projectPath: string;
  prompt: string;
  taskId?: string;
  taskTitle?: string;
  baseBranch?: string;
  useWorktrees?: boolean;
  autoCommitAgentResults?: boolean;
  budgetUsd?: number;
  agents: AgentSlotConfig[];
  /** Источник запуска для HITL/аудита (TASK-60); по умолчанию 'swarm'. */
  origin?: 'swarm' | 'assigned' | 'automation';
}

export interface StartHandoffOptions {
  projectPath: string;
  prompt: string;
  taskId?: string;
  taskTitle?: string;
  baseBranch?: string;
  useWorktrees?: boolean;
  autoCommitAgentResults?: boolean;
  budgetUsd?: number;
  stages: {
    role: string;
    agent: AgentSlotConfig;
    instructions?: string;
  }[];
}

// ─── Цикл «до готовности» (TASK-75, decision-28); зеркало electron/services/doneLoopTypes.ts ───

export type DoneLoopPhase = 'running_agent' | 'checking' | 'verifying' | 'finished' | 'failed' | 'stopped';
export type DoneLoopOutcome = 'success' | 'iteration_limit' | 'budget' | 'agent_error' | 'task_error' | 'stopped';
export type CriterionReportStatus = 'done' | 'not_done' | 'blocked';

export interface CriterionVerification {
  index: number;
  text: string;
  reported?: CriterionReportStatus;
  evidence?: string;
  accepted: boolean;
  reason?: string;
  reasonKey?: import('../lib/appError').AppErrorKey;
  alreadyChecked?: boolean;
  ui?: boolean;
  screenshots?: CriterionScreenshot[];
}

export interface CriterionScreenshot {
  ref: string;
  checkId: string;
  name: string;
  relPath: string;
}

export interface DoneLoopIteration {
  index: number;
  startedAt: number;
  finishedAt?: number;
  agentStatus?: string;
  checks: CheckRunResult[];
  reportFound: boolean;
  reportError?: string;
  reportErrorKey?: import('../lib/appError').AppErrorKey;
  reportSummary?: string;
  criteria: CriterionVerification[];
  costUsd?: number;
  commitHash?: string;
  tamperedCriteria?: boolean;
  decision?: 'finish' | 'retry' | 'fail';
  run?: number;
  /** Отменена откатом (decision-48 п. 2.2). */
  rolledBack?: 'full' | 'partial';
  /** Отрезок цикла: 0 — исходный запуск, N — N-е продолжение после отката. */
  segment?: number;
}

export interface DoneLoopSettings {
  maxIterations: number;
  budgetUsd?: number;
  checks: CheckDefinition[];
  autoReview: boolean;
}

export interface DoneLoopState {
  settings: DoneLoopSettings;
  phase: DoneLoopPhase;
  currentIteration: number;
  iterations: DoneLoopIteration[];
  instructions?: string;
  criteriaBaseline?: Array<{ text: string; completed: boolean }>;
  outcome?: DoneLoopOutcome;
  reason?: string;
  reasonKey?: import('../lib/appError').AppErrorKey;
  totalCostUsd?: number;
  task?: {
    filePath?: string;
    criteriaChecked: number[];
    movedToReview?: boolean;
    reviewStatus?: string;
    previousStatus?: string;
    finalSummaryWritten?: boolean;
    error?: string;
    errorKey?: unknown;
  };
}

export interface StartDoneLoopOptions {
  projectPath: string;
  taskId: string;
  taskTitle?: string;
  prompt: string;
  agent: AgentSlotConfig;
  baseBranch?: string;
  useWorktrees?: boolean;
  autoCommitAgentResults?: boolean;
  budgetUsd?: number;
  maxIterations?: number;
  checkIds?: string[];
  autoReview?: boolean;
}

/** Назначения моделей (decision-74). Зеркало `electron/services/modelPurposes.ts`. */
export type ModelPurpose =
  | 'studio'
  | 'agent'
  | 'plan.architect'
  | 'plan.node'
  | 'arena.reviewer'
  | 'pr.review'
  | 'voice.classify'
  | 'voice.punctuate'
  | 'voice.computer'
  | 'task.draft';

/** Чем обслуживается назначение (decision-74, decision-75). Зеркало `ModelRouteView` из `modelRouter.ts`. */
export interface ModelRouteView {
  purpose: ModelPurpose;
  kind: 'complete' | 'turn' | 'agent';
  source: 'slot' | 'role' | 'purpose' | 'tier' | 'main';
  engine: 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api';
  model?: string;
  tier?: ModelTier;
  tierSource?: 'hint' | 'slot' | 'role' | 'purpose' | 'default';
  /** Адресат API-пути: имя профиля или прежний провайдер. */
  provider?: string;
  /** Готовая подпись (ru) из main-процесса: «sonnet · Claude Code». */
  label: string;
  /** Вызов идёт через Claude Code по подписке. */
  subscription: boolean;
  local?: boolean;
  notes: string[];
  /** Коды пояснений по порядку `notes` (decision-165). */
  noteKeys?: unknown[];
  problem?: { code: 'engine_unsupported' | 'no_key' | 'no_profile' | 'no_model' | 'provider'; message: string; messageKey?: unknown };
}

/** Цель назначения — зеркало `ModelTarget` (`electron/services/modelTarget.ts`, decision-74 п. 1). */
export interface ModelTargetSpec {
  engine?: TierEngine;
  /** Профиль LLM по имени или id; прежний провайдер — `provider`. */
  profile?: string;
  provider?: string;
  model?: string;
  modelTier?: ModelTier;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'max';
}

/** Чем обслуживать назначение — зеркало `PurposeAssignment` (`modelPurposes.ts`, decision-74 п. 5). */
export type PurposeAssignment =
  | { mode: 'main' }
  | { mode: 'tier'; tier: ModelTier }
  | { mode: 'custom'; target: ModelTargetSpec };

export interface ModelAssignments {
  version: 1;
  updatedAt?: string;
  /** Только изменённые пользователем; остальные — по каталогу. */
  assignments: Partial<Record<ModelPurpose, PurposeAssignment>>;
}

export interface ModelAssignmentState {
  settings: ModelAssignments;
  filePath: string;
  loadError?: string;
  problems: string[];
  /** Коды проблем по порядку `problems` (decision-165). */
  problemKeys?: unknown[];
}

/** Чем план будет построен и исполнен при текущих настройках (decision-75). */
export interface PlanModelsPreview {
  architect: ModelRouteView;
  node: ModelRouteView;
}

/** Планировщик подзадач (TASK-80, decision-49). Зеркало `electron/services/planTypes.ts`. */
export type PlanNodeState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'merging'
  | 'merged'
  | 'conflict'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'missing';

export type PlanPhase = 'planning' | 'awaiting_approval' | 'running' | 'finished' | 'failed';

export type PlanOutcome = 'success' | 'partial' | 'failed' | 'budget_exceeded' | 'stopped';

export interface PlanNode {
  key: string;
  taskId: string;
  title: string;
  state: PlanNodeState;
  dependsOn: string[];
  swarmId?: string;
  branch?: string;
  mergeCommit?: string;
  conflictFiles?: string[];
  /** Совпавшие номера backlog ждут решения человека (decision-76). */
  renumberPending?: Array<{ from: string; to: string }>;
  costUsd?: number;
  iterations?: number;
  reason?: string;
  /** Код причины (decision-165): текст — по словарю `appErrors`. */
  reasonKey?: import('../lib/appError').AppErrorKey;
  /** Назначение, для которого не удалось выбрать модель (decision-75). */
  reasonPurpose?: string;
  /** Тир, который подзадаче назначила роль architect (decision-75). */
  modelTier?: ModelTier;
  /** Чем узел запущен (decision-75). */
  model?: ModelRouteView;
  startedAt?: number;
  finishedAt?: number;
}

export interface PlanSettings {
  maxParallel: number;
  budgetUsd?: number;
  maxIterations?: number;
  checkIds?: string[];
  agent?: AgentSlotConfig;
  architect?: AgentSlotConfig;
}

export interface PlanState {
  id: string;
  projectPath: string;
  taskId: string;
  taskTitle?: string;
  phase: PlanPhase;
  outcome?: PlanOutcome;
  reason?: string;
  reasonKey?: import('../lib/appError').AppErrorKey;
  /** Назначение, для которого не удалось выбрать модель (decision-75). */
  reasonPurpose?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  settings: PlanSettings;
  summary?: string;
  nodes: PlanNode[];
  integrationBranch?: string;
  integrationWorktree?: string;
  approvedGraphHash?: string;
  approvedAt?: number;
  architect: { attempts: number; costUsd?: number; errors?: string[]; rawResponse?: string; model?: ModelRouteView };
  totalCostUsd?: number;
  stopped?: boolean;
}

export interface GeneratePlanOptions {
  projectPath: string;
  taskId: string;
  taskTitle?: string;
  settings?: Partial<PlanSettings>;
}

export interface PlanEventPayload {
  type: 'plan_updated' | 'plan_removed';
  planId: string;
  plan?: PlanState;
}

export interface SwarmEventPayload {
  type: 'swarm_updated' | 'agent_updated' | 'agent_chunk' | 'swarm_completed' | 'swarm_removed' | 'error';
  swarmId: string;
  agentId?: string;
  session?: SwarmSession;
  chunk?: string;
  error?: string;
}

export interface SwarmTranscript {
  swarmId: string;
  agentId: string;
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

export type SwarmExportFormat = 'markdown' | 'json';

// ─────────── Security Health (TASK-73, decision-56) — зеркало electron/services/dependencyAudit.ts, securityHealthService.ts ───────────

export type AuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';
export type AuditEcosystem = 'npm' | 'pip' | 'yarn' | 'pnpm' | 'cargo';
export type AuditRunStatus = 'done' | 'no_lockfile' | 'not_installed' | 'unsupported' | 'error';
export type SeverityCounts = Record<AuditSeverity, number>;

export interface AuditAdvisory {
  id: string;
  title: string;
  url?: string;
  severity: AuditSeverity;
  range?: string;
  fixVersions?: string[];
  aliases?: string[];
}

export interface AuditFinding {
  ecosystem: AuditEcosystem;
  package: string;
  version?: string;
  severity: AuditSeverity;
  direct?: boolean;
  advisories: AuditAdvisory[];
  via?: string[];
  range?: string;
  fix?: { available: boolean; name?: string; version?: string; major?: boolean };
}

export interface EcosystemReport {
  ecosystem: AuditEcosystem;
  manifest?: string;
  status: AuditRunStatus;
  errorKind?: 'network' | 'timeout' | 'format' | 'tool';
  message?: string;
  /** Код причины (decision-165): текст — по словарю `appErrors`, без кода `message` — текст инструмента. */
  messageKey?: import('../lib/appError').AppErrorKey;
  findings: AuditFinding[];
  counts: SeverityCounts;
  dependencyCount?: number;
  ranAt: number;
  durationMs?: number;
  stale?: boolean;
  staleSince?: number;
}

/** Граф для вкладок «Граф кода» и «Граф документации» (TASK-167): тот же вид, что `electron/services/projectGraph.ts`. */
export interface ProjectGraphNode {
  id: string;
  label: string;
  type: string;
  props: Record<string, string | number>;
  cluster?: string;
}

export interface ProjectGraphEdge {
  source: string;
  target: string;
  type: string;
  weight?: number;
  description?: string;
}

export interface ProjectGraph {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

export type ProjectGraphUnavailable = 'no-index' | 'no-cli' | 'not-registered' | 'disabled' | 'error';

export type ProjectGraphResult =
  | { ok: true; graph: ProjectGraph; indexedAt?: string; repo?: string }
  | { ok: false; reason: ProjectGraphUnavailable; error?: string; errorKey?: import('../lib/appError').AppErrorKey };

export interface SecurityReport {
  version: number;
  projectPath: string;
  ranAt?: number;
  durationMs?: number;
  ecosystems: EcosystemReport[];
  counts: SeverityCounts;
  tasks: Record<string, string>;
}

export interface SecuritySettings {
  version: number;
  registryLookups: boolean;
}

export type DiffSecretKind =
  | 'provider_key'
  | 'github_token'
  | 'slack_token'
  | 'aws_key'
  | 'google_key'
  | 'huggingface_token'
  | 'telegram_token'
  | 'private_key'
  | 'jwt'
  | 'url_password'
  | 'bearer_token'
  | 'assigned_secret'
  | 'env_file';

export interface DiffSecretFinding {
  kind: DiffSecretKind;
  file: string;
  line?: number;
}

export type DependencyRiskFlag = 'not_found' | 'recent' | 'young' | 'deprecated';

export interface DependencyChange {
  ecosystem: 'npm' | 'pip';
  manifest: string;
  name: string;
  section?: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
  kind: 'added' | 'changed' | 'removed';
  from?: string;
  to?: string;
  source: 'registry' | 'git' | 'file' | 'url' | 'workspace' | 'alias';
  resolved?: string;
  registry?: { publishedAt?: string; createdAt?: string; deprecated?: string; notFound?: boolean; error?: string };
  flags?: DependencyRiskFlag[];
}

export interface AgentSlotSecurity {
  scannedAt: number;
  headSha?: string;
  secrets: DiffSecretFinding[];
  secretsSuppressed: number;
  secretsTruncated?: boolean;
  dependencies: DependencyChange[];
  lockChanges: Array<{ manifest: string; added: number; sample: string[] }>;
  registry: 'done' | 'partial' | 'disabled' | 'none' | 'pending';
  notifiedKey?: string;
}

export type GitCommitResult =
  | { ok: true; overridden?: boolean }
  | { ok: false; reason: 'secrets'; findings: DiffSecretFinding[]; suppressed: number; truncated: boolean; treeHash: string }
  | { ok: false; reason: 'error'; error: string };
