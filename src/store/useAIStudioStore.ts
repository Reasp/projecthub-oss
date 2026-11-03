import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  createDebouncedStorage,
  migrateLegacySessions,
  SessionPersister
} from './aiSessionPersistence';
import type {
  AISession,
  AIProviderConfig,
  AIMessage,
  AIStreamRequest,
  ClaudeAuthStatus,
  ApprovalRequest,
  SubagentInfo,
  RateLimitWarning,
  AutoApproveRules,
  CliRewindPoint,
  CliBackgroundSnapshot,
  ContextPartKey,
  ProviderErrorInfo,
  StudioSessionAgent,
  StudioSessionWorktree
} from '../types/electron';
import { useProjectStore } from './useProjectStore';
import { useClaudeAccountsStore } from './useClaudeAccountsStore';
import { messagesForModel, retryTarget } from '../lib/providerErrorView';
import { isApprovedPlanExit, upsertToolCall } from '../lib/aiToolCalls';
import { effectiveSessionAgent, keepsClaudeCliSession, sessionClaudeAccountId, sessionRequestConfig } from '../lib/studioSessionAgent';
import { goesToClaudeCli, studioCliCommand, studioLocalCommand, unavailableCliCommand, type StudioCliCommand } from '../lib/studioCliCommands';
import { conversationMarkdown, exportFileName, replyCount, replyToCopy } from '../lib/conversationExport';
import { studioCliText } from '../i18n/studioCliText';
import { canWriteStudioSession } from '../utils/studioRemote';
import { getDictionary } from '../i18n';
import { isAutoSessionTitle, localizeLegacyTitle, titleFromPrompt } from '../lib/studioSessionTitle';
import { sameWorkPath, sessionWorkDir, sessionWorktreeOf } from '../lib/studioWorktree';
import { clearQueue, enqueueMessage, nextAfterTurn, removeQueuedMessage, type StudioQueues } from '../lib/studioMessageQueue';
import { forkedSession, insertAfter } from '../lib/studioSessionFork';
import { feedBeforePoint, rewoundSession } from '../lib/studioRewind';
import { hasAddDir, MAX_ADD_DIRS, withAddDir, withoutAddDir } from '../lib/studioAddDir';
import { cliTitleToSync } from '../lib/studioCliTitle';
import { sanitizePromptAttachments, type PromptAttachment } from '../lib/promptAttachments';

export type { AISession };

interface AIStudioState {
  sessions: Record<string, AISession[]>; // projectPath -> list of sessions (in-memory, файлы через main — TASK-35)
  sessionsLoaded: Record<string, boolean>; // projectPath -> история прочитана с диска
  activeSessionId: Record<string, string>; // projectPath -> active sessionId
  lastActiveSessionId: Record<string, string>; // projectPath -> previous active sessionId
  /** sessionId -> идёт ответ: вкладки одного проекта отвечают параллельно (TASK-171). */
  streamingSessions: Record<string, true>;
  /** sessionId -> сообщения, написанные во время ответа вкладки (TASK-273): уходят по одному после конца хода. */
  queuedMessages: StudioQueues<SendMessageOptions>;
  removeQueuedMessage: (sessionId: string, messageId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  /** Отправить первое сообщение очереди сейчас — после остановки или ошибки очередь сама не идёт. */
  sendNextQueued: (projectPath: string, sessionId: string) => void;
  config: AIProviderConfig;
  mode: 'chat' | 'agent' | 'architect';
  isSettingsOpen: boolean;
  claudeAuth: ClaudeAuthStatus | null;

  // Subagents & Human Approvals & Rate Limits
  pendingApprovals: Record<string, ApprovalRequest[]>; // projectPath -> active requests
  subagents: Record<string, SubagentInfo[]>; // projectPath -> active subagents (вкладка фильтрует по parentSessionId)
  rateLimitWarnings: Record<string, RateLimitWarning | null>; // sessionId -> active warning
  liveOutputs: Record<string, string>; // sessionId -> console output string
  /** Фоновые задачи Claude Code идущего хода вкладки (TASK-290): sessionId → снимок. */
  cliBackground: Record<string, CliBackgroundSnapshot>;
  isSubagentsPanelOpen: boolean;
  isActivitySidebarOpen: boolean;
  setIsSubagentsPanelOpen: (open: boolean) => void;
  setIsActivitySidebarOpen: (open: boolean) => void;
  clearLiveOutput: (sessionId: string) => void;
  sendApprovalResponse: (projectPath: string, requestId: string, approved: boolean, text?: string) => Promise<void>;
  /** Убирает карточку, решённую из другого места (Центр решений, телефон, MCP-клиент, таймаут) — TASK-57. */
  removePendingApproval: (projectPath: string, requestId: string) => void;
  fetchSubagents: (projectPath: string) => Promise<void>;
  dismissRateLimitWarning: (sessionId: string) => void;

  // Actions
  fetchConfig: () => Promise<void>;
  saveConfig: (config: AIProviderConfig) => Promise<void>;
  /**
   * Статус аккаунта Claude Code (TASK-152): аккаунта вкладки (TASK-170), иначе проекта, без проекта —
   * профиль по умолчанию.
   */
  fetchClaudeAuth: (projectPath?: string, force?: boolean, accountId?: string) => Promise<void>;
  /** Окно входа со встроенным терминалом для аккаунта вкладки или проекта (TASK-152.2, TASK-170). */
  startClaudeLogin: (projectPath?: string, accountId?: string) => Promise<void>;
  claudeLogout: (projectPath?: string) => Promise<void>;
  setMode: (mode: 'chat' | 'agent' | 'architect') => void;
  setIsSettingsOpen: (open: boolean) => void;
  /** Прочитать историю диалогов проекта с диска (один раз на проект); мигрирует старый localStorage. */
  loadSessions: (projectPath: string) => Promise<void>;
  createSession: (projectPath: string, initialTitle?: string, opts?: CreateSessionOptions) => string;
  /**
   * Вернуть сессию из истории во вкладки (TASK-140.10): с ПК из окна истории или по промпту с телефона.
   * `activate` — сделать вкладку активной.
   */
  reopenSession: (projectPath: string, session: AISession, activate?: boolean) => void;
  switchSession: (projectPath: string, sessionId: string) => void;
  switchSessionByIndex: (projectPath: string, index: number) => void;
  switchToNextSession: (projectPath: string) => void;
  switchToPrevSession: (projectPath: string) => void;
  switchToLastActiveSession: (projectPath: string) => void;
  closeSession: (projectPath: string, sessionId: string) => void;
  closeCurrentSession: (projectPath: string) => void;
  renameSession: (projectPath: string, sessionId: string, newTitle: string) => void;
  /** Привязывает сессию к задаче (TASK-64) — дальше contextBuilder собирает контекст на каждое сообщение. */
  setSessionTask: (projectPath: string, sessionId: string, taskId: string | undefined) => void;
  /** Агент вкладки (TASK-170): провайдер, модель и аккаунт Claude Code только этой сессии. */
  setSessionAgent: (projectPath: string, sessionId: string, agent: StudioSessionAgent) => void;
  /**
   * Перенести вкладку в другое рабочее дерево (TASK-268, decision-195). Разговор Claude CLI живёт в каталоге, где
   * начат: в другом дереве `--resume` его не найдёт, поэтому его id снимается, а лента остаётся.
   */
  setSessionWorktree: (projectPath: string, sessionId: string, worktree: StudioSessionWorktree) => void;
  /** Включает/выключает часть контекста (задача/RAG/GitNexus/git) на сессию. */
  toggleContextPart: (projectPath: string, sessionId: string, key: ContextPartKey, enabled: boolean) => void;
  clearSession: (projectPath: string, sessionId?: string) => void;
  sendMessage: (projectPath: string, text: string, opts?: SendMessageOptions) => Promise<void>;
  /**
   * Слеш-команда Claude Code, которую Studio выполняет сама (TASK-230): `/resume` — выбор сессии CLI, интерактивные
   * команды — продолжение в терминале. Окно Studio показывает диалог по этому полю.
   */
  cliCommand: PendingCliCommand | null;
  clearCliCommand: () => void;
  /** `/memory` (TASK-286): окно файлов памяти Claude Code этой вкладки — её аккаунт, каталог и `/add-dir`. */
  openCliMemory: (projectPath: string, sessionId: string) => void;
  /**
   * Окно команды без хода (TASK-286, TASK-287): `/memory`, `/status`, `/help` — для аккаунта, каталога и `/add-dir`
   * вкладки, а `/status` — и для её сессии CLI.
   */
  openCliDialog: (projectPath: string, sessionId: string, kind: 'memory' | 'status' | 'help') => void;
  /**
   * Передать заголовок вкладки в Claude Code именем её сессии (TASK-287): только заголовок, заданный человеком, и только
   * между ходами — идущий ход дописывает тот же файл сессии. Иначе ничего не делает.
   */
  syncCliTitle: (projectPath: string, sessionId: string) => void;
  /** Привязать вкладку к сессии Claude Code: следующее сообщение продолжит её через `--resume`. */
  attachCliSession: (projectPath: string, sessionId: string, cliSessionId: string, cwd: string) => void;
  /**
   * `/fork` и `/branch` (TASK-283): вкладка-ответвление сразу за исходной, с её лентой и разговором CLI. Возвращает id
   * новой вкладки; `null` — у вкладки ещё нет разговора CLI, вместо ответвления — подсказка.
   */
  forkSession: (projectPath: string, sessionId: string, title?: string) => string | null;
  /** Побочные вопросы `/btw` по вкладкам (TASK-283): ответ над полем ввода, в разговор вкладки не попадает. */
  sideQuestions: Record<string, StudioSideQuestion>;
  askSideQuestion: (projectPath: string, sessionId: string, question: string) => Promise<void>;
  /** Закрыть панель побочного вопроса; идущий ответ останавливается. */
  closeSideQuestion: (sessionId: string) => void;
  /**
   * `/add-dir [путь]` (TASK-285): каталог вкладки для `--add-dir`. Без пути — системный выбор каталога. Итог — в панели
   * над полем ввода.
   */
  addSessionDir: (projectPath: string, sessionId: string, dir: string) => Promise<void>;
  removeSessionDir: (projectPath: string, sessionId: string, dir: string) => void;
  /**
   * `/copy [N]` (TASK-288): ответ N с конца — в буфер обмена, итог в панели над полем ввода. `null` — после `/copy` не
   * число, только подсказка. Вкладка любого движка.
   */
  copyReply: (projectPath: string, sessionId: string, n: number | null) => Promise<void>;
  /**
   * `/export [имя]` и кнопка шапки (TASK-288, decision-209): переписка вкладки в Markdown через системный диалог; у
   * вкладки Claude Code с разговором — на выбор и расшифровка CLI. Итог — в панели над полем ввода.
   */
  exportConversation: (projectPath: string, sessionId: string, fileName?: string) => Promise<void>;
  /** Вложение в промпт (TASK-289): файл — в каталог вложений вкладки (её дерево), ответ — ссылка для реплики. */
  saveAttachment: (projectPath: string, sessionId: string | undefined, payload: { name: string; mime: string; data: string }) => Promise<PromptAttachment>;
  /** Окно `/rewind` (TASK-284): вкладка и, если окно открыто с реплики ленты, эта реплика. */
  rewindRequest: { projectPath: string; sessionId: string; messageId?: string } | null;
  openRewind: (projectPath: string, sessionId: string, messageId?: string) => void;
  closeRewind: () => void;
  /** Откат разговора вкладки к точке: лента до реплики, следующий ход — ответвление CLI до записи перед ней. */
  /** `filesRestored` — сколько файлов вернул откат кода перед этим: итог показывается одной подсказкой. */
  rewindConversation: (projectPath: string, sessionId: string, point: CliRewindPoint, messageId?: string, filesRestored?: number) => Promise<void>;
  /** Откат файлов к состоянию перед репликой (`--rewind-files`); итог — в панели над полем ввода. */
  rewindFiles: (projectPath: string, sessionId: string, point: CliRewindPoint, fileCount: number) => Promise<boolean>;
  /** Текст для поля ввода вкладки: откат возвращает реплику (TASK-284); `nonce` различает повтор того же текста. */
  promptPrefill: { sessionId: string; text: string; nonce: number } | null;
  /** Поле приняло текст — повторный показ поля его не подставит. */
  clearPromptPrefill: () => void;
  /**
   * Повтор ответа, упавшего с ошибкой (TASK-70.6): сообщение пользователя и ответ с ошибкой убираются
   * из диалога, и сообщение отправляется заново — с текущими настройками провайдера и модели.
   */
  retryFailedMessage: (projectPath: string, assistantMessageId: string) => Promise<void>;
  /** Останавливает ответ одной сессии; ответы других вкладок идут дальше (TASK-171). */
  abortStream: (sessionId: string) => Promise<void>;
  acceptDiff: (projectPath: string, messageId: string, toolId: string, filePath: string, newContent: string) => Promise<void>;
  rejectDiff: (projectPath: string, messageId: string, toolId: string) => void;
}

export const DEFAULT_AUTO_APPROVE_RULES: AutoApproveRules = {
  enabled: true,
  allowCommands: true,
  allowFileWrite: true,
  allowFileRead: true,
  allowSubagents: true,
  writeExcludePatterns: ['.env*', '**/*.key', '**/*.pem', 'infra.config.json'],
  readExcludePatterns: ['.env*', '**/*.key', '**/*.pem', '**/id_rsa*'],
  commandDenyList: ['rm -rf', 'git push', 'git reset --hard', 'del /f /s /q']
};

const DEFAULT_CONFIG: AIProviderConfig = {
  provider: 'anthropic',
  model: 'default',
  // temperature и thinkingBudget не заданы — действуют значения модели (TASK-88).
  autoApprove: false,
  autoApproveRules: DEFAULT_AUTO_APPROVE_RULES
};

/**
 * Сообщает main-процессу, что сессия закрыта/очищена: там отклоняются ожидающие одобрения,
 * убиваются процессы сессии и забывается resume-id Claude CLI (TASK-33).
 */
export interface CreateSessionOptions {
  /** Сделать новую вкладку активной (по умолчанию да; сессия с телефона не переключает вкладку на ПК). */
  activate?: boolean;
  origin?: 'desktop' | 'phone';
  originDevice?: string;
  /** Сессия участника общего хоста (TASK-142.3): писать в неё может только он. */
  memberId?: string;
  /** Агент новой вкладки (TASK-221): выбран на телефоне при открытии сессии; без поля — агент активной вкладки. */
  agent?: StudioSessionAgent;
  /** Дерево вкладки (TASK-268): «Начать в worktree» закрепляет вкладку за деревом задачи сразу. */
  worktree?: StudioSessionWorktree;
  /** Задача вкладки (TASK-268): контекст задачи с первого сообщения. */
  taskId?: string;
}

/** Перехваченная слеш-команда Claude Code вкладки (TASK-230). */
/** Панель над полем ввода (TASK-283): ответ `/btw` или подсказка, почему команда не выполнена. */
export interface StudioSideQuestion {
  command: 'btw' | 'fork' | 'rewind' | 'addDir' | 'copy' | 'export';
  /** Канал ответа: у каждого вопроса свой, ответ прежнего вопроса в новый не попадёт. Пустой у подсказки. */
  streamId: string;
  question: string;
  answer: string;
  status: 'running' | 'done' | 'error' | 'notice';
  error?: string;
  providerError?: ProviderErrorInfo;
  notice?: string;
}

export type PendingCliCommand = Extract<StudioCliCommand, { kind: 'resume' | 'terminal' | 'memory' | 'status' | 'help' }> & {
  projectPath: string;
  sessionId: string;
  claudeAccountId?: string;
  /** Сессия CLI вкладки, если разговор уже начат. */
  cliSessionId?: string;
  /** Рабочее дерево вкладки: каталог сессий CLI и терминала. */
  workspaceRoot: string;
  /** Каталоги `/add-dir` вкладки — `/memory` ищет инструкции и в них, как ход CLI. */
  addDirs?: string[];
};

export interface SendMessageOptions {
  /** Сессия, в которую идёт сообщение; по умолчанию — активная вкладка. */
  sessionId?: string;
  /** Промпт пришёл с телефона в активную вкладку: диалогов слеш-команд на ПК нет, ответ — текстом в ленте. */
  fromRemote?: boolean;
  /** Конфиг этого запроса (модель с телефона); глобальный выбор Agents Studio не меняется. */
  config?: AIProviderConfig;
  mode?: 'chat' | 'agent' | 'architect';
  /** Кто пишет: участник общего хоста с устройства (TASK-142.3); окно хоста — без поля. */
  memberId?: string;
  /**
   * Вкладка, в чьей очереди ждало сообщение (TASK-273). В отличие от `sessionId` слеш-команды Claude Code при этом
   * по-прежнему перехватываются окном — сообщение было набрано в нём.
   */
  queuedSessionId?: string;
  /** Вложения реплики (TASK-289): файлы уже в каталоге вложений вкладки. С ними текст не разбирается как слеш-команда. */
  attachments?: PromptAttachment[];
}

function releaseSessionInMain(sessionId: string): void {
  window.api?.clearAISession?.(sessionId).catch((err: unknown) => {
    console.error('Failed to clear AI session in main:', err);
  });
}

/** Запись без ключа; та же ссылка, если ключа не было (селекторы не перерисовываются зря). */
export function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

type SessionScopedFields = 'streamingSessions' | 'liveOutputs' | 'cliBackground' | 'rateLimitWarnings' | 'pendingApprovals' | 'queuedMessages' | 'sideQuestions';

/**
 * Сброс стрима, живого вывода, предупреждения о лимитах, очереди, побочного вопроса и ожидающих одобрений
 * закрываемой/очищаемой сессии. Поток побочного вопроса останавливает вызывающий (`stopSideStream`).
 */
function sessionResetPatch(
  state: Pick<AIStudioState, SessionScopedFields>,
  projectPath: string,
  sessionId: string | undefined
): Partial<Pick<AIStudioState, SessionScopedFields>> {
  if (!sessionId) return {};
  const patch: Partial<Pick<AIStudioState, SessionScopedFields>> = {
    streamingSessions: withoutKey(state.streamingSessions, sessionId),
    liveOutputs: withoutKey(state.liveOutputs, sessionId),
    cliBackground: withoutKey(state.cliBackground, sessionId),
    rateLimitWarnings: withoutKey(state.rateLimitWarnings, sessionId),
    queuedMessages: clearQueue(state.queuedMessages, sessionId),
    sideQuestions: withoutKey(state.sideQuestions, sessionId)
  };
  const current = state.pendingApprovals[projectPath] || [];
  if (current.some((r) => r.sessionId === sessionId)) {
    patch.pendingApprovals = {
      ...state.pendingApprovals,
      [projectPath]: current.filter((r) => r.sessionId !== sessionId)
    };
  }
  return patch;
}

/** Запись сессий на диск с дебаунсом; подключается к стору ниже через subscribe. */
const sessionPersister = new SessionPersister();

/** Одноразовая миграция старого localStorage-блоба; результат кэшируется на время жизни рендерера. */
let legacyMigration: Promise<Record<string, AISession[]>> | null = null;
function runLegacyMigration(): Promise<Record<string, AISession[]>> {
  if (!legacyMigration) {
    legacyMigration = migrateLegacySessions().catch((e) => {
      console.error('[AIStudio] Ошибка миграции сессий:', e);
      return {};
    });
  }
  return legacyMigration;
}

const loadingProjects = new Set<string>();

/**
 * Идущие ответы: подписки на `ai:*:<sessionId>`. Канал у сессии один, поэтому новый ответ во вкладке стартует
 * только после конца прошлого — иначе конец остановленного ответа достался бы новому (TASK-171).
 */
const liveStreams = new Map<string, { cleanup: () => void }>();
/** Вкладки, чей ход остановил человек: конец такого хода очередь не отправляет (TASK-273). */
const abortedTurns = new Set<string>();
/** Сколько ждать конца остановленного ответа от main, прежде чем снять его самим. */
export const ABORT_FALLBACK_MS = 3000;

/**
 * После остановки флаг ответа снимает конец ответа от main (onComplete/onError приходят и при отмене). Если он не
 * пришёл за `ABORT_FALLBACK_MS`, подписки и флаг снимаются здесь.
 */
function releaseStreamLater(sessionId: string, setState: (fn: (s: AIStudioState) => Partial<AIStudioState>) => void): void {
  const stream = liveStreams.get(sessionId);
  const release = () => {
    if (stream && liveStreams.get(sessionId) !== stream) return;
    stream?.cleanup();
    setState((state) => ({ streamingSessions: withoutKey(state.streamingSessions, sessionId) }));
  };
  if (stream) setTimeout(release, ABORT_FALLBACK_MS);
  else release();
}

/** Потоки побочных вопросов `/btw` по вкладкам (TASK-283): новый вопрос и закрытие панели останавливают прежний. */
const sideStreams = new Map<string, { streamId: string; cleanup: () => void }>();

function stopSideStream(sessionId: string): void {
  const side = sideStreams.get(sessionId);
  if (!side) return;
  sideStreams.delete(sessionId);
  side.cleanup();
  void window.api?.abortAIStream?.(side.streamId);
}

/** Активное дерево проекта: у выбранного проекта — окна, у остальных — запомненное (TASK-268). */
function activeWorkRoot(projectPath: string): string | null | undefined {
  const projectState = useProjectStore.getState();
  return projectState.selectedProject?.path === projectPath ? projectState.workspaceRoot : projectState.activeWorktreeByProject[projectPath];
}

/**
 * Запрос к разговору CLI вкладки (`/rewind`, TASK-284): каталог, где он начат, аккаунт вкладки и id сессии. `null` —
 * разговора CLI у вкладки нет.
 */
export function tabCliQuery(
  projectPath: string,
  session: AISession
): { projectPath: string; cwd: string; cliSessionId: string; claudeAccountId?: string } | null {
  if (!session.claudeCliSessionId) return null;
  const claudeAccountId = sessionClaudeAccountId(session.agent);
  return {
    projectPath,
    cwd: session.claudeCliCwd || sessionWorkDir(session, activeWorkRoot(projectPath), projectPath),
    cliSessionId: session.claudeCliSessionId,
    ...(claudeAccountId ? { claudeAccountId } : {})
  };
}

/** Словарь Studio на языке интерфейса — для заголовков вкладок по умолчанию (TASK-204). */
/** Вкладки, чьё имя сейчас уходит в CLI, и те, чей заголовок сменился за это время (TASK-287). */
const titleSyncs = new Set<string>();
const titleSyncAgain = new Set<string>();

const studioText = () => getDictionary(useProjectStore.getState().language).aiStudio;
const cliText = () => studioCliText(useProjectStore.getState().language);

/**
 * Итог `/copy` и `/export` (TASK-288) в панели над полем ввода. Идущий ответ `/btw` не перекрывается: копирование уже
 * сделано, подсказка о нём не важнее ответа.
 */
function setSideNotice(
  set: (fn: (state: AIStudioState) => Partial<AIStudioState>) => void,
  get: () => AIStudioState,
  sessionId: string,
  command: 'copy' | 'export',
  notice: string
): void {
  if (get().sideQuestions[sessionId]?.status === 'running') return;
  set((state) => ({ sideQuestions: { ...state.sideQuestions, [sessionId]: { command, streamId: '', question: '', answer: '', status: 'notice', notice } } }));
}

function createInitialSession(): AISession {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    title: studioText().newChat,
    autoTitle: true,
    createdAt: Date.now(),
    messages: []
  };
}

export const useAIStudioStore = create<AIStudioState>()(
  persist(
    (set, get) => ({
      sessions: {},
      sessionsLoaded: {},
      activeSessionId: {},
      lastActiveSessionId: {},
      streamingSessions: {},
      queuedMessages: {},
      sideQuestions: {},
      rewindRequest: null,
      promptPrefill: null,
      config: DEFAULT_CONFIG,
      mode: 'agent',
      isSettingsOpen: false,
      claudeAuth: null,
      pendingApprovals: {},
      subagents: {},
      rateLimitWarnings: {},
      liveOutputs: {},
      cliBackground: {},
      isSubagentsPanelOpen: false,
      isActivitySidebarOpen: false,

      setIsSubagentsPanelOpen: (isSubagentsPanelOpen) => set({ isSubagentsPanelOpen }),
      setIsActivitySidebarOpen: (isActivitySidebarOpen) => set({ isActivitySidebarOpen }),

      clearLiveOutput: (sessionId: string) => {
        set((state) => ({ liveOutputs: withoutKey(state.liveOutputs, sessionId) }));
      },

      dismissRateLimitWarning: (sessionId: string) => {
        set((state) => ({ rateLimitWarnings: withoutKey(state.rateLimitWarnings, sessionId) }));
      },

      fetchSubagents: async (projectPath: string) => {
        if (window.api?.getSubagents) {
          try {
            const list = await window.api.getSubagents(projectPath);
            set((state) => ({
              subagents: {
                ...state.subagents,
                [projectPath]: list
              }
            }));
          } catch (e) {
            console.error('Failed to fetch subagents:', e);
          }
        }
      },

      removePendingApproval: (projectPath: string, requestId: string) => {
        set((state) => {
          const current = state.pendingApprovals[projectPath] || [];
          if (!current.some((r) => r.id === requestId)) return state;
          return {
            pendingApprovals: {
              ...state.pendingApprovals,
              [projectPath]: current.filter((r) => r.id !== requestId)
            }
          };
        });
      },

      sendApprovalResponse: async (projectPath: string, requestId: string, approved: boolean, text?: string) => {
        if (window.api?.sendApprovalResponse) {
          try {
            // Решение уходит в единую очередь HITL по requestId (TASK-57); карточка снимается
            // сразу — если запрос уже решён с другого устройства, main вернёт false.
            await window.api.sendApprovalResponse(requestId, { approved, text });
            get().removePendingApproval(projectPath, requestId);
          } catch (e) {
            console.error('Failed to send approval response:', e);
          }
        }
      },

      fetchConfig: async () => {
        if (window.api?.getAIConfig) {
          try {
            const loaded = await window.api.getAIConfig();
            if (loaded) {
              set((state) => ({
                config: {
                  ...state.config,
                  ...loaded
                }
              }));
            }
          } catch (err) {
            console.error('Failed to fetch AI config:', err);
          }
        }
      },

      fetchClaudeAuth: async (projectPath, force, accountId) => {
        if (window.api?.getClaudeAuthStatus) {
          try {
            const auth = await window.api.getClaudeAuthStatus({
              ...(projectPath ? { projectPath } : {}),
              ...(accountId ? { accountId } : {}),
              force: force === true
            });
            set({ claudeAuth: auth });
          } catch (err) {
            console.error('Failed to fetch Claude auth status:', err);
          }
        }
      },

      startClaudeLogin: async (projectPath, accountId) => {
        try {
          if (accountId) useClaudeAccountsStore.getState().openLogin(accountId);
          else await useClaudeAccountsStore.getState().openLoginForProject(projectPath);
        } catch (err) {
          console.error('Failed to start Claude login:', err);
        }
      },

      claudeLogout: async (projectPath) => {
        if (window.api?.claudeLogout) {
          try {
            const accountId = get().claudeAuth?.accountId;
            await window.api.claudeLogout(accountId ? { accountId } : projectPath ? { projectPath } : {});
            set((state) => ({ claudeAuth: { ...state.claudeAuth, isLoggedIn: false, email: undefined, seatTier: undefined } }));
          } catch (err) {
            console.error('Failed to log out from Claude:', err);
          }
        }
      },

      saveConfig: async (config: AIProviderConfig) => {
        set({ config });
        if (window.api?.saveAIConfig) {
          try {
            await window.api.saveAIConfig(config);
          } catch (err) {
            console.error('Failed to save AI config:', err);
          }
        }
      },

      setMode: (mode) => set({ mode }),
      setIsSettingsOpen: (isSettingsOpen) => set({ isSettingsOpen }),

      loadSessions: async (projectPath: string) => {
        if (!projectPath || get().sessionsLoaded[projectPath] || loadingProjects.has(projectPath)) return;
        loadingProjects.add(projectPath);
        try {
          const migrated = await runLegacyMigration();
          let fromDisk: AISession[] = [];
          if (window.api?.listAISessions) {
            try {
              fromDisk = await window.api.listAISessions(projectPath);
            } catch (e) {
              console.error('[AIStudio] Не удалось прочитать сессии с диска:', e);
            }
          }
          // Если импорт в файлы не удался, показываем хотя бы то, что было в localStorage.
          if (fromDisk.length === 0 && migrated[projectPath]?.length) {
            fromDisk = migrated[projectPath];
          }
          // Закрытые вкладки живут в истории (TASK-140.10) — во вкладки их не возвращаем.
          fromDisk = fromDisk.filter((s) => typeof s.archivedAt !== 'number');
          sessionPersister.markLoaded(projectPath, fromDisk);
          // Старый русский заголовок по умолчанию — на язык интерфейса (TASK-204). Новая ссылка помечает сессию
          // изменённой, и заголовок уходит на диск: его читают обзор компьютеров и телефон.
          fromDisk = fromDisk.map((s) => localizeLegacyTitle(s, studioText()));

          set((state) => {
            // Сессии, созданные до завершения загрузки (например, голосовая команда), сохраняем.
            const inMemory = state.sessions[projectPath] || [];
            const known = new Set(fromDisk.map((s) => s.id));
            const merged = [...fromDisk, ...inMemory.filter((s) => !known.has(s.id))];
            const activeId = state.activeSessionId[projectPath];
            const activeValid = activeId && merged.some((s) => s.id === activeId);
            return {
              sessions: { ...state.sessions, [projectPath]: merged },
              sessionsLoaded: { ...state.sessionsLoaded, [projectPath]: true },
              activeSessionId: activeValid || merged.length === 0
                ? state.activeSessionId
                : { ...state.activeSessionId, [projectPath]: merged[merged.length - 1].id }
            };
          });
        } finally {
          loadingProjects.delete(projectPath);
        }
      },

      createSession: (projectPath: string, initialTitle?: string, opts: CreateSessionOptions = {}) => {
        const existing = get().sessions[projectPath] || [];
        // Новая вкладка начинает с агента текущей (TASK-170), дальше её агент меняется независимо.
        const active = existing.find((s) => s.id === get().activeSessionId[projectPath]);
        const newSession: AISession = {
          id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: initialTitle || studioText().chatN.replace('{n}', String(existing.length + 1)),
          ...(initialTitle ? {} : { autoTitle: true }),
          createdAt: Date.now(),
          messages: [],
          agent: opts.agent ?? effectiveSessionAgent(get().config, active?.agent),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.originDevice ? { originDevice: opts.originDevice } : {}),
          ...(opts.memberId ? { memberId: opts.memberId } : {}),
          ...(opts.worktree ? { worktree: opts.worktree } : {}),
          ...(opts.taskId ? { activeTaskId: opts.taskId } : {})
        };
        const activate = opts.activate !== false || !get().activeSessionId[projectPath];

        set((state) => {
          const current = state.sessions[projectPath] || [];
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: [...current, newSession]
            },
            ...(activate ? { activeSessionId: { ...state.activeSessionId, [projectPath]: newSession.id } } : {})
          };
        });

        return newSession.id;
      },

      reopenSession: (projectPath: string, session: AISession, activate = true) => {
        const { archivedAt: _archivedAt, ...open } = session;
        set((state) => {
          const current = state.sessions[projectPath] || [];
          if (current.some((s) => s.id === session.id)) {
            return activate ? { activeSessionId: { ...state.activeSessionId, [projectPath]: session.id } } : {};
          }
          return {
            sessions: { ...state.sessions, [projectPath]: [...current, open] },
            ...(activate ? { activeSessionId: { ...state.activeSessionId, [projectPath]: session.id } } : {})
          };
        });
      },

      switchSession: (projectPath: string, sessionId: string) => {
        const cur = get().activeSessionId[projectPath];
        set((state) => ({
          lastActiveSessionId: cur && cur !== sessionId
            ? { ...state.lastActiveSessionId, [projectPath]: cur }
            : state.lastActiveSessionId,
          activeSessionId: {
            ...state.activeSessionId,
            [projectPath]: sessionId
          }
        }));
      },

      switchSessionByIndex: (projectPath: string, index: number) => {
        const sessions = get().sessions[projectPath] || [];
        if (index >= 0 && index < sessions.length) {
          get().switchSession(projectPath, sessions[index].id);
        }
      },

      switchToNextSession: (projectPath: string) => {
        const sessions = get().sessions[projectPath] || [];
        if (sessions.length <= 1) return;
        const curId = get().activeSessionId[projectPath];
        const curIdx = sessions.findIndex((s) => s.id === curId);
        const nextIdx = (curIdx + 1) % sessions.length;
        get().switchSession(projectPath, sessions[nextIdx].id);
      },

      switchToPrevSession: (projectPath: string) => {
        const sessions = get().sessions[projectPath] || [];
        if (sessions.length <= 1) return;
        const curId = get().activeSessionId[projectPath];
        const curIdx = sessions.findIndex((s) => s.id === curId);
        const prevIdx = (curIdx - 1 + sessions.length) % sessions.length;
        get().switchSession(projectPath, sessions[prevIdx].id);
      },

      switchToLastActiveSession: (projectPath: string) => {
        const lastId = get().lastActiveSessionId[projectPath];
        const sessions = get().sessions[projectPath] || [];
        if (lastId && sessions.some((s) => s.id === lastId)) {
          get().switchSession(projectPath, lastId);
        } else {
          get().switchToPrevSession(projectPath);
        }
      },

      closeCurrentSession: (projectPath: string) => {
        const curId = get().activeSessionId[projectPath];
        if (curId) {
          get().closeSession(projectPath, curId);
        }
      },

      cliCommand: null,
      clearCliCommand: () => set({ cliCommand: null }),

      openCliMemory: (projectPath: string, sessionId: string) => get().openCliDialog(projectPath, sessionId, 'memory'),

      openCliDialog: (projectPath: string, sessionId: string, kind: 'memory' | 'status' | 'help') => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session) return;
        const claudeAccountId = sessionClaudeAccountId(session.agent);
        set({
          cliCommand: {
            kind,
            projectPath,
            sessionId,
            ...(claudeAccountId ? { claudeAccountId } : {}),
            ...(session.claudeCliSessionId ? { cliSessionId: session.claudeCliSessionId } : {}),
            workspaceRoot: sessionWorkDir(session, activeWorkRoot(projectPath), projectPath),
            ...(session.claudeCliAddDirs?.length ? { addDirs: [...session.claudeCliAddDirs] } : {})
          }
        });
      },

      syncCliTitle: (projectPath: string, sessionId: string) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || get().streamingSessions[sessionId] || !window.api?.cliRenameSession) return;
        if (!goesToClaudeCli(sessionRequestConfig(get().config, session.agent))) return;
        const name = cliTitleToSync(session);
        if (!name || !session.claudeCliSessionId) return;
        if (titleSyncs.has(sessionId)) {
          titleSyncAgain.add(sessionId);
          return;
        }
        titleSyncs.add(sessionId);
        const cliSessionId = session.claudeCliSessionId;
        const claudeAccountId = sessionClaudeAccountId(session.agent);
        void window.api
          .cliRenameSession({
            projectPath,
            // Разговор CLI лежит в каталоге, где начат (TASK-230): `--resume` ищет его там.
            cwd: session.claudeCliCwd || sessionWorkDir(session, activeWorkRoot(projectPath), projectPath),
            ...(claudeAccountId ? { claudeAccountId } : {}),
            ...(session.claudeCliAddDirs?.length ? { addDirs: [...session.claudeCliAddDirs] } : {}),
            cliSessionId,
            name
          })
          .then((result) => {
            if (!result.ok) return;
            set((state) => ({
              sessions: {
                ...state.sessions,
                [projectPath]: (state.sessions[projectPath] || []).map((s) =>
                  s.id === sessionId && s.claudeCliSessionId === cliSessionId ? { ...s, claudeCliTitle: { sessionId: cliSessionId, title: name } } : s
                )
              }
            }));
          })
          .catch(() => undefined)
          .finally(() => {
            titleSyncs.delete(sessionId);
            // Заголовок сменили, пока имя уходило: передать новое. Неудача не повторяется по кругу — до следующего
            // переименования или конца хода.
            if (titleSyncAgain.delete(sessionId)) get().syncCliTitle(projectPath, sessionId);
          });
      },

      removeQueuedMessage: (sessionId: string, messageId: string) =>
        set((state) => ({ queuedMessages: removeQueuedMessage(state.queuedMessages, sessionId, messageId) })),
      clearQueuedMessages: (sessionId: string) => set((state) => ({ queuedMessages: clearQueue(state.queuedMessages, sessionId) })),
      sendNextQueued: (projectPath: string, sessionId: string) => {
        const next = get().queuedMessages[sessionId]?.[0];
        if (!next || get().streamingSessions[sessionId]) return;
        set((state) => ({ queuedMessages: removeQueuedMessage(state.queuedMessages, sessionId, next.id) }));
        void get().sendMessage(projectPath, next.text, { ...next.opts, queuedSessionId: sessionId });
      },
      attachCliSession: (projectPath: string, sessionId: string, cliSessionId: string, cwd: string) => {
        set((state) => ({
          cliCommand: null,
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) =>
              // Продолжаемая сессия CLI сохраняет своё имя: заголовок вкладки ей не передаётся (TASK-287).
              s.id === sessionId
                ? { ...s, claudeCliSessionId: cliSessionId, claudeCliCwd: cwd, claudeCliForkPending: undefined, claudeCliResumeAt: undefined, titleByUser: undefined, claudeCliTitle: undefined }
                : s
            )
          }
        }));
        // Пустая вкладка показывает переписку продолжаемой сессии, как `/resume` в CLI (TASK-282). Вкладка со своей
        // перепиской её сохраняет: чужие реплики посреди неё сбили бы порядок.
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || (session.messages || []).length > 0 || !window.api?.readCliSession) return;
        const claudeAccountId = sessionClaudeAccountId(session.agent);
        void window.api
          .readCliSession({ projectPath, cwd, cliSessionId, ...(claudeAccountId ? { claudeAccountId } : {}) })
          .then((history) => {
            if (history.length === 0) return;
            set((state) => ({
              sessions: {
                ...state.sessions,
                [projectPath]: (state.sessions[projectPath] || []).map((s) => {
                  // За время чтения вкладку могли привязать к другой сессии или начать в ней разговор.
                  if (s.id !== sessionId || s.claudeCliSessionId !== cliSessionId || (s.messages || []).length > 0) return s;
                  const firstPrompt = history.find((m) => m.role === 'user')?.content ?? '';
                  const autoTitle = isAutoSessionTitle(s) && Boolean(firstPrompt);
                  return {
                    ...s,
                    messages: history.map((m) => ({ ...m })),
                    ...(autoTitle ? { title: titleFromPrompt(firstPrompt), autoTitle: undefined } : {})
                  };
                })
              }
            }));
          })
          .catch((err) => console.warn('[AIStudio] Не удалось прочитать переписку сессии Claude Code:', err));
      },

      forkSession: (projectPath: string, sessionId: string, title?: string) => {
        const source = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!source) return null;
        const fork = forkedSession(source, {
          id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: title?.trim() || cliText().forkTitle(source.title),
          now: Date.now()
        });
        // `/fork <имя>` — имя задал человек: оно уйдёт в CLI, когда ответвление получит свою сессию (TASK-287).
        if (fork && title?.trim()) fork.titleByUser = true;
        if (!fork) {
          set((state) => ({
            sideQuestions: {
              ...state.sideQuestions,
              [sessionId]: { command: 'fork', streamId: '', question: '', answer: '', status: 'notice', notice: cliText().forkNothing }
            }
          }));
          return null;
        }
        set((state) => ({
          sessions: { ...state.sessions, [projectPath]: insertAfter(state.sessions[projectPath] || [], sessionId, fork) }
        }));
        get().switchSession(projectPath, fork.id);
        return fork.id;
      },

      askSideQuestion: async (projectPath: string, sessionId: string, question: string) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || !window.api?.streamAIChat) return;
        stopSideStream(sessionId);
        const text = question.trim();
        if (!text) {
          set((state) => ({
            sideQuestions: {
              ...state.sideQuestions,
              [sessionId]: { command: 'btw', streamId: '', question: '', answer: '', status: 'notice', notice: cliText().btwUsage }
            }
          }));
          return;
        }
        const streamId = `${sessionId}::btw-${Date.now()}`;
        // Ответ прежнего вопроса или закрытой панели в эту запись не попадает.
        const patch = (fn: (q: StudioSideQuestion) => StudioSideQuestion) =>
          set((state) => {
            const current = state.sideQuestions[sessionId];
            return current?.streamId === streamId ? { sideQuestions: { ...state.sideQuestions, [sessionId]: fn(current) } } : {};
          });
        set((state) => ({
          sideQuestions: { ...state.sideQuestions, [sessionId]: { command: 'btw', streamId, question: text, answer: '', status: 'running' } }
        }));
        const unsubChunk = window.api.onAIChunk(streamId, (chunk) => {
          if (chunk.text) patch((q) => ({ ...q, answer: q.answer + chunk.text }));
        });
        const unsubComplete = window.api.onAIComplete(streamId, (msg) => {
          patch((q) => ({ ...q, answer: msg.content || q.answer, status: 'done' }));
          cleanup();
        });
        const unsubError = window.api.onAIError(streamId, (err, info) => {
          patch((q) => ({ ...q, status: 'error', error: err, ...(info ? { providerError: info } : {}) }));
          cleanup();
        });
        const cleanup = () => {
          unsubChunk();
          unsubComplete();
          unsubError();
          if (sideStreams.get(sessionId)?.streamId === streamId) sideStreams.delete(sessionId);
        };
        sideStreams.set(sessionId, { streamId, cleanup });

        // Ответвление разговора вкладки без записи (`--fork-session --no-session-persistence`) в её каталоге и аккаунте.
        const config = sessionRequestConfig(get().config, session.agent);
        const claudeAccountId = sessionClaudeAccountId(session.agent);
        const workDir = sessionWorkDir(session, activeWorkRoot(projectPath), projectPath);
        const req: AIStreamRequest = {
          sessionId: streamId,
          projectPath,
          messages: [{ id: `msg-${Date.now()}`, role: 'user', content: text, timestamp: new Date().toISOString() }],
          config,
          mode: 'chat',
          ...(session.claudeCliSessionId ? { claudeCliSessionId: session.claudeCliSessionId } : {}),
          claudeCliFork: 'side',
          // Откаченная вкладка (TASK-284) спрашивает об откаченном разговоре.
          ...(session.claudeCliForkPending && session.claudeCliResumeAt ? { claudeCliResumeAt: session.claudeCliResumeAt } : {}),
          ...(sameWorkPath(workDir, projectPath) ? {} : { workspaceRoot: workDir }),
          ...(claudeAccountId ? { claudeAccountId } : {}),
          ...(session.activeTaskId ? { taskId: session.activeTaskId } : {}),
          ...(session.contextParts ? { contextParts: session.contextParts } : {})
        };
        try {
          await window.api.streamAIChat(req);
        } catch (err) {
          patch((q) => ({ ...q, status: 'error', error: err instanceof Error ? err.message : String(err) }));
          cleanup();
        }
      },

      closeSideQuestion: (sessionId: string) => {
        stopSideStream(sessionId);
        set((state) => ({ sideQuestions: withoutKey(state.sideQuestions, sessionId) }));
      },

      copyReply: async (projectPath: string, sessionId: string, n: number | null) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session) return;
        const c = cliText();
        const messages = session.messages || [];
        const streaming = !!get().streamingSessions[sessionId];
        let text: string;
        if (n === null) text = c.copyUsage;
        else {
          const reply = replyToCopy(messages, n, streaming);
          if (reply === null) text = c.copyNothing(replyCount(messages, streaming));
          else {
            try {
              await navigator.clipboard.writeText(reply);
              text = c.copyDone(n);
            } catch {
              text = c.copyFailed;
            }
          }
        }
        setSideNotice(set, get, sessionId, 'copy', text);
      },

      exportConversation: async (projectPath: string, sessionId: string, fileName?: string) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || !window.api?.exportConversation) return;
        const c = cliText();
        const messages = session.messages || [];
        if (!messages.some((m) => m.content.trim() || m.toolCalls?.length || m.attachments?.length)) {
          setSideNotice(set, get, sessionId, 'export', c.exportNothing);
          return;
        }
        const requestConfig = sessionRequestConfig(get().config, session.agent);
        const viaCli = goesToClaudeCli(requestConfig);
        const engine = viaCli ? 'Claude Code' : requestConfig.provider;
        const now = new Date();
        const markdown = conversationMarkdown({
          title: session.title,
          messages,
          labels: c.exportLabels,
          exportedAt: now,
          agent: requestConfig.model ? `${engine} · ${requestConfig.model}` : engine
        });
        const claudeAccountId = viaCli ? sessionClaudeAccountId(session.agent) : undefined;
        const cliSessionId = viaCli ? session.claudeCliSessionId : undefined;
        const result = await window.api
          .exportConversation({
            projectPath,
            markdown,
            fileName: fileName || exportFileName(session.title, now),
            ...(cliSessionId
              ? {
                  cliSessionId,
                  // Разговор CLI лежит в каталоге, где начат (TASK-230): `--resume` ищет его там.
                  cwd: session.claudeCliCwd || sessionWorkDir(session, activeWorkRoot(projectPath), projectPath),
                  ...(claudeAccountId ? { claudeAccountId } : {}),
                  ...(session.claudeCliAddDirs?.length ? { addDirs: [...session.claudeCliAddDirs] } : {})
                }
              : {})
          })
          .catch(() => ({ ok: false as const, canceled: undefined, reason: 'io' as const }));
        if (result.ok) setSideNotice(set, get, sessionId, 'export', c.exportDone(result.path, result.format));
        else if (!result.canceled) setSideNotice(set, get, sessionId, 'export', c.exportFailed(result.reason));
      },

      saveAttachment: async (projectPath: string, sessionId: string | undefined, payload: { name: string; mime: string; data: string }) => {
        const session = sessionId ? (get().sessions[projectPath] || []).find((s) => s.id === sessionId) : undefined;
        // Тот же каталог, где пойдёт ход вкладки: агент открывает файл по пути от него.
        const cwd = session ? sessionWorkDir(session, activeWorkRoot(projectPath), projectPath) : activeWorkRoot(projectPath) || projectPath;
        return window.api.saveStudioAttachment({ projectPath, cwd, ...payload });
      },

      addSessionDir: async (projectPath: string, sessionId: string, dir: string) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || !window.api?.checkAddDir) return;
        const notice = (text: string) =>
          set((state) => ({
            sideQuestions: { ...state.sideQuestions, [sessionId]: { command: 'addDir', streamId: '', question: '', answer: '', status: 'notice', notice: text } }
          }));
        let input = dir.trim();
        if (!input) {
          const picked = await window.api.selectDirectory?.().catch(() => null);
          if (!picked) return;
          input = picked;
        }
        const workDir = sessionWorkDir(session, activeWorkRoot(projectPath), projectPath);
        const checked = await window.api.checkAddDir({ projectPath, cwd: workDir, dir: input }).catch(() => null);
        if (!checked) {
          notice(cliText().addDirFailed(input, 'notFound'));
          return;
        }
        if (!checked.ok) {
          notice(cliText().addDirFailed(input, checked.reason));
          return;
        }
        const current = (get().sessions[projectPath] || []).find((s) => s.id === sessionId)?.claudeCliAddDirs;
        if (hasAddDir(current, checked.path)) {
          notice(cliText().addDirExists(checked.path));
          return;
        }
        const next = withAddDir(current, checked.path);
        if (next.length === (current?.length ?? 0)) {
          notice(cliText().addDirLimit(MAX_ADD_DIRS));
          return;
        }
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) => (s.id === sessionId ? { ...s, claudeCliAddDirs: next } : s))
          }
        }));
        notice(cliText().addDirAdded(checked.path));
        void sessionPersister.flushNow();
      },

      removeSessionDir: (projectPath: string, sessionId: string, dir: string) => {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) => {
              if (s.id !== sessionId) return s;
              const { claudeCliAddDirs: _dirs, ...rest } = s;
              const next = withoutAddDir(s.claudeCliAddDirs, dir);
              return next.length ? { ...rest, claudeCliAddDirs: next } : rest;
            })
          }
        }));
        void sessionPersister.flushNow();
      },

      openRewind: (projectPath: string, sessionId: string, messageId?: string) =>
        set({ rewindRequest: { projectPath, sessionId, ...(messageId ? { messageId } : {}) } }),
      closeRewind: () => set({ rewindRequest: null }),
      clearPromptPrefill: () => set({ promptPrefill: null }),

      rewindConversation: async (projectPath: string, sessionId: string, point: CliRewindPoint, messageId?: string, filesRestored?: number) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session) return;
        // Реплики нет в ленте вкладки (ленту начали позже разговора) — лента до точки из файла сессии CLI.
        let feed: AIMessage[] | undefined;
        const query = tabCliQuery(projectPath, session);
        if (!messageId && query && window.api?.readCliSession) {
          const history = await window.api.readCliSession(query).catch(() => []);
          feed = feedBeforePoint(history.map((m) => ({ ...m })), point);
        }
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) => (s.id === sessionId ? rewoundSession(s, point, messageId, feed) : s))
          },
          // Реплика возвращается в поле ввода, как в CLI: её можно поправить и отправить заново.
          promptPrefill: { sessionId, text: point.text, nonce: Date.now() },
          sideQuestions: {
            ...state.sideQuestions,
            [sessionId]: {
              command: 'rewind',
              streamId: '',
              question: '',
              answer: '',
              status: 'notice',
              notice: filesRestored === undefined ? cliText().rewindConversationDone : `${cliText().rewindFilesDone(filesRestored)} ${cliText().rewindConversationDone}`
            }
          }
        }));
        void sessionPersister.flushNow();
      },

      rewindFiles: async (projectPath: string, sessionId: string, point: CliRewindPoint, fileCount: number) => {
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        const query = session ? tabCliQuery(projectPath, session) : null;
        if (!query || !window.api?.cliRewindFiles) return false;
        const result = await window.api
          .cliRewindFiles({ ...query, promptUuid: point.uuid })
          .catch((err: unknown) => ({ ok: false, output: err instanceof Error ? err.message : String(err) }));
        const texts = cliText();
        set((state) => ({
          sideQuestions: {
            ...state.sideQuestions,
            [sessionId]: {
              command: 'rewind',
              streamId: '',
              question: '',
              answer: '',
              status: 'notice',
              notice: result.ok ? texts.rewindFilesDone(fileCount) : texts.rewindFilesFailed(result.output || '—')
            }
          }
        }));
        return result.ok;
      },

      renameSession: (projectPath: string, sessionId: string, newTitle: string) => {
        const cleanTitle = newTitle.trim();
        if (!cleanTitle) return;
        set((state) => {
          const projectSessions = state.sessions[projectPath] || [];
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: projectSessions.map((s) =>
                s.id === sessionId ? { ...s, title: cleanTitle, autoTitle: undefined, titleByUser: true } : s
              )
            }
          };
        });
        // Имя сессии в `/resume` CLI и в терминале — заголовок вкладки (TASK-287); во время хода — после него.
        get().syncCliTitle(projectPath, sessionId);
      },

      setSessionTask: (projectPath: string, sessionId: string, taskId: string | undefined) => {
        set((state) => {
          const projectSessions = state.sessions[projectPath] || [];
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: projectSessions.map((s) =>
                s.id === sessionId ? { ...s, activeTaskId: taskId } : s
              )
            }
          };
        });
      },

      setSessionAgent: (projectPath: string, sessionId: string, agent: StudioSessionAgent) => {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) => {
              if (s.id !== sessionId) return s;
              // Другой аккаунт Claude Code или провайдер — прежний разговор CLI под ним не найдётся (`--resume`).
              const keep = keepsClaudeCliSession(effectiveSessionAgent(state.config, s.agent), agent);
              return keep ? { ...s, agent } : { ...s, agent, claudeCliSessionId: undefined };
            })
          }
        }));
      },

      setSessionWorktree: (projectPath: string, sessionId: string, worktree: StudioSessionWorktree) => {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) => {
              if (s.id !== sessionId) return s;
              const before = sessionWorkDir(s, null, projectPath);
              if (sameWorkPath(before, worktree.path)) return { ...s, worktree };
              return { ...s, worktree, claudeCliSessionId: undefined, claudeCliCwd: undefined };
            })
          }
        }));
      },

      toggleContextPart: (projectPath: string, sessionId: string, key: ContextPartKey, enabled: boolean) => {
        set((state) => {
          const projectSessions = state.sessions[projectPath] || [];
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: projectSessions.map((s) =>
                s.id === sessionId ? { ...s, contextParts: { ...s.contextParts, [key]: enabled } } : s
              )
            }
          };
        });
      },

      closeSession: (projectPath: string, sessionId: string) => {
        releaseSessionInMain(sessionId);
        stopSideStream(sessionId);
        // Диалог с сообщениями уходит в историю (файл остаётся с `archivedAt`), пустой — удаляется (TASK-140.10).
        const closing = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (closing && closing.messages.length > 0) sessionPersister.archive(projectPath, { ...closing, archivedAt: Date.now() });
        set((state) => {
          const existing = state.sessions[projectPath] || [];
          const filtered = existing.filter((s) => s.id !== sessionId);

          if (filtered.length === 0) {
            const fresh = createInitialSession();
            return {
              sessions: {
                ...state.sessions,
                [projectPath]: [fresh]
              },
              activeSessionId: {
                ...state.activeSessionId,
                [projectPath]: fresh.id
              }
            };
          }

          let currentActive = state.activeSessionId[projectPath];
          if (currentActive === sessionId) {
            currentActive = filtered[filtered.length - 1].id;
          }

          return {
            sessions: {
              ...state.sessions,
              [projectPath]: filtered
            },
            activeSessionId: {
              ...state.activeSessionId,
              [projectPath]: currentActive
            },
            ...sessionResetPatch(state, projectPath, sessionId)
          };
        });
      },

      clearSession: (projectPath: string, sessionId?: string) => {
        const targetSessionId = sessionId || get().activeSessionId[projectPath];
        if (targetSessionId) {
          releaseSessionInMain(targetSessionId);
          stopSideStream(targetSessionId);
        }
        // Очищенная вкладка остаётся: новый ответ в ней — только после конца прерванного (общий канал сессии).
        const wasStreaming = !!(targetSessionId && get().streamingSessions[targetSessionId]);
        set((state) => {
          const existing = state.sessions[projectPath] || [];

          const updated = existing.map((s) =>
            s.id === targetSessionId
              ? {
                  ...s,
                  messages: [],
                  title: studioText().newChat,
                  autoTitle: true,
                  titleByUser: undefined,
                  claudeCliTitle: undefined,
                  claudeCliSessionId: undefined,
                  claudeCliForkPending: undefined,
                  claudeCliResumeAt: undefined
                }
              : s
          );

          const reset = sessionResetPatch(state, projectPath, targetSessionId);
          if (wasStreaming) delete reset.streamingSessions;
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: updated
            },
            ...reset
          };
        });
        if (wasStreaming && targetSessionId) releaseStreamLater(targetSessionId, set);
      },

      abortStream: async (sessionId: string) => {
        if (!sessionId || !get().streamingSessions[sessionId] || !window.api?.abortAIStream) return;
        abortedTurns.add(sessionId);
        await window.api.abortAIStream(sessionId);
        releaseStreamLater(sessionId, set);
      },

      sendMessage: async (projectPath: string, text: string, opts: SendMessageOptions = {}) => {
        const attachments = sanitizePromptAttachments(opts.attachments);
        if ((!text.trim() && attachments.length === 0) || !window.api?.streamAIChat) return;

        let activeSessionId = opts.sessionId || opts.queuedSessionId || get().activeSessionId[projectPath];
        let projectSessions = get().sessions[projectPath] || [];

        if (!activeSessionId || !projectSessions.some((s) => s.id === activeSessionId)) {
          // Сессию для телефона готовит обработчик запроса; вкладку очереди могли закрыть — тогда сообщение не нужно.
          if (opts.sessionId || opts.queuedSessionId) return;
          activeSessionId = get().createSession(projectPath);
          projectSessions = get().sessions[projectPath] || [];
        }
        const currentSession = projectSessions.find((s) => s.id === activeSessionId)!;
        // Пишет в сессию только её владелец (decision-84 п. 5): чужая сессия участника — только для чтения.
        if (!canWriteStudioSession(currentSession, opts.memberId)) return;
        // Модель с телефона — на этот запрос; иначе агент вкладки поверх общего конфига (TASK-170).
        const requestConfig = opts.config ?? sessionRequestConfig(get().config, currentSession.agent);
        // Интерактивные команды Claude Code в `claude -p` не работают — Studio выполняет их сама (TASK-230). С телефона
        // (`opts.sessionId`) диалога нет: команда уходит в CLI как раньше.
        // `/copy` и `/export` (TASK-288) — у вкладки любого движка, и во время хода: они только читают ленту.
        // Реплика со вложениями — промпт модели, а не команда Studio (TASK-289).
        const noCommands = !!(opts.sessionId || opts.fromRemote) || attachments.length > 0;
        const local = noCommands ? null : studioLocalCommand(text);
        if (local?.kind === 'copy') {
          await get().copyReply(projectPath, activeSessionId, local.n);
          return;
        }
        if (local?.kind === 'export') {
          await get().exportConversation(projectPath, activeSessionId, local.fileName);
          return;
        }
        const cli = noCommands ? null : studioCliCommand(text, requestConfig);
        // `/btw` (TASK-283) отвечает и во время хода вкладки, как в CLI: в очередь не встаёт.
        if (cli?.kind === 'btw') {
          await get().askSideQuestion(projectPath, activeSessionId, cli.question);
          return;
        }
        // `/add-dir` (TASK-285) меняет только следующие ходы — ждать конца текущего незачем.
        if (cli?.kind === 'addDir') {
          await get().addSessionDir(projectPath, activeSessionId, cli.path);
          return;
        }
        // `/memory` (TASK-286) только читает и правит файлы памяти — открывается и во время хода, как в CLI.
        if (cli?.kind === 'memory') {
          get().openCliMemory(projectPath, activeSessionId);
          return;
        }
        // `/status` и `/help` (TASK-287) только показывают сведения — тоже во время хода, без очереди.
        if (cli?.kind === 'status' || cli?.kind === 'help') {
          get().openCliDialog(projectPath, activeSessionId, cli.kind);
          return;
        }
        // Занята только эта вкладка (TASK-171): сообщение встаёт в её очередь и уйдёт после хода (TASK-273).
        if (get().streamingSessions[activeSessionId]) {
          const queueKey = activeSessionId;
          const { queuedSessionId: _queued, ...queuedOpts } = opts;
          set((state) => ({
            queuedMessages: enqueueMessage(state.queuedMessages, queueKey, {
              id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              text: text.trim(),
              opts: queuedOpts,
              queuedAt: Date.now(),
              ...(attachments.length > 0 ? { attachmentNames: attachments.map((a) => a.name) } : {})
            })
          }));
          return;
        }
        const requestMode = opts.mode ?? get().mode;
        const claudeAccountId = requestConfig.provider === 'anthropic' ? sessionClaudeAccountId(currentSession.agent) : undefined;
        // Каталог вкладки (TASK-268, decision-195): её дерево, а не активное дерево приложения. Вкладка без дерева
        // закрепляется за каталогом первого сообщения — после смены активного дерева разговор остаётся в своём.
        const projectState = useProjectStore.getState();
        const isSelected = projectState.selectedProject?.path === projectPath;
        const activeRoot = isSelected ? projectState.workspaceRoot : projectState.activeWorktreeByProject[projectPath];
        const workDir = sessionWorkDir(currentSession, activeRoot, projectPath);
        const pinnedWorktree = currentSession.worktree ?? sessionWorktreeOf(workDir, isSelected ? projectState.worktrees : [], projectPath);
        const cliCwd = workDir;
        // `/fork` после хода вкладки (из очереди) берёт и его: ответвление — от законченного разговора.
        if (cli?.kind === 'fork') {
          get().forkSession(projectPath, activeSessionId, cli.title);
          return;
        }
        // `/rewind` (TASK-284) — окно выбора точки; во время хода команда ждала в очереди.
        if (cli?.kind === 'rewind') {
          get().openRewind(projectPath, activeSessionId);
          return;
        }
        if (cli?.kind === 'resume' && cli.cliSessionId) {
          get().attachCliSession(projectPath, activeSessionId, cli.cliSessionId, cliCwd);
          return;
        }
        // `/plan` (TASK-282) — режим architect, то есть plan mode CLI (decision-196); текст после команды уходит уже в нём.
        if (cli?.kind === 'plan') {
          set({ mode: 'architect' });
          if (cli.prompt) await get().sendMessage(projectPath, cli.prompt, { ...opts, mode: 'architect' });
          return;
        }
        if (cli) {
          set({
            cliCommand: {
              ...cli,
              projectPath,
              sessionId: activeSessionId,
              ...(claudeAccountId ? { claudeAccountId } : {}),
              ...(currentSession.claudeCliSessionId ? { cliSessionId: currentSession.claudeCliSessionId } : {}),
              workspaceRoot: cliCwd
            }
          });
          return;
        }
        const lastSelection = {
          provider: requestConfig.provider,
          ...(requestConfig.profileId ? { profileId: requestConfig.profileId } : {}),
          model: requestConfig.model
        };

        const currentMessages = currentSession.messages || [];

        const userMsg: AIMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: text.trim(),
          timestamp: new Date().toISOString(),
          ...(attachments.length > 0 ? { attachments } : {})
        };

        const assistantMsgId = `asst-${Date.now() + 1}`;
        const initialAssistantMsg: AIMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          thought: '',
          toolCalls: [],
          timestamp: new Date().toISOString()
        };

        const updatedMessages = [...currentMessages, userMsg, initialAssistantMsg];

        // Заголовок по умолчанию заменяется началом первого промпта (TASK-204).
        const autoTitle = isAutoSessionTitle(currentSession);
        const sessionTitle = autoTitle ? titleFromPrompt(text) || attachments[0]?.name || currentSession.title : currentSession.title;

        set((state) => {
          const pSessions = state.sessions[projectPath] || [];
          const updated = pSessions.map((s) =>
            s.id === activeSessionId
              ? { ...s, title: sessionTitle, ...(autoTitle ? { autoTitle: undefined } : {}), messages: updatedMessages, lastSelection, lastMode: requestMode, worktree: pinnedWorktree }
              : s
          );

          return {
            sessions: {
              ...state.sessions,
              [projectPath]: updated
            },
            streamingSessions: { ...state.streamingSessions, [activeSessionId]: true },
            // Вывод прошлого ответа этой вкладки не смешивается с новым.
            liveOutputs: withoutKey(state.liveOutputs, activeSessionId),
            cliBackground: withoutKey(state.cliBackground, activeSessionId)
          };
        });

        const streamId = activeSessionId;
        // Ход кончился — процесс CLI вышел, его фоновые задачи тоже (TASK-290).
        const streamEnded = (state: AIStudioState) => ({
          streamingSessions: withoutKey(state.streamingSessions, streamId),
          cliBackground: withoutKey(state.cliBackground, streamId)
        });
        abortedTurns.delete(streamId);
        // Конец хода (TASK-273): сам закончившийся ход отправляет следующее сообщение очереди; остановка и ошибка — нет.
        const afterTurn = (ended: 'complete' | 'error') => {
          const aborted = abortedTurns.delete(streamId);
          const next = nextAfterTurn(get().queuedMessages[streamId], {
            ended: aborted ? 'aborted' : ended,
            streaming: !!get().streamingSessions[streamId]
          });
          if (next) get().sendNextQueued(projectPath, streamId);
          // Переименование во время хода и первое имя новой сессии CLI уходят после хода (TASK-287).
          else get().syncCliTitle(projectPath, streamId);
        };

        // Listen to streaming events
        const unsubChunk = window.api.onAIChunk(streamId, (chunk) => {
          set((state) => {
            const pSessions = state.sessions[projectPath] || [];
            const sIdx = pSessions.findIndex((s) => s.id === activeSessionId);
            if (sIdx === -1) return state;

            const targetSession = { ...pSessions[sIdx] };
            if (chunk.claudeCliSessionId) {
              targetSession.claudeCliSessionId = chunk.claudeCliSessionId;
              targetSession.claudeCliCwd = workDir;
              // Ответвление получило свою сессию CLI (TASK-283): дальше вкладка продолжает её, а не исходную.
              delete targetSession.claudeCliForkPending;
              delete targetSession.claudeCliResumeAt;
            }
            // `/rename` выполнил CLI (TASK-287): заголовок вкладки — его имя, и передавать его обратно не нужно.
            if (chunk.claudeCliTitle) {
              targetSession.title = chunk.claudeCliTitle;
              targetSession.titleByUser = true;
              delete targetSession.autoTitle;
              if (targetSession.claudeCliSessionId) targetSession.claudeCliTitle = { sessionId: targetSession.claudeCliSessionId, title: chunk.claudeCliTitle };
            }

            const msgs = [...targetSession.messages];
            const mIdx = msgs.findIndex((m) => m.id === assistantMsgId);
            if (mIdx === -1) return state;

            const target = { ...msgs[mIdx] };
            if (chunk.text) {
              target.content = (target.content || '') + chunk.text;
            }
            if (chunk.thought) {
              target.thought = (target.thought || '') + chunk.thought;
            }
            if (chunk.toolCall) {
              target.toolCalls = upsertToolCall(target.toolCalls, chunk.toolCall);
            }

            msgs[mIdx] = target;
            targetSession.messages = msgs;

            const newSessions = [...pSessions];
            newSessions[sIdx] = targetSession;

            let newPendingApprovals = state.pendingApprovals;
            if (chunk.approvalRequest) {
              const currentList = state.pendingApprovals[projectPath] || [];
              if (!currentList.some((r) => r.id === chunk.approvalRequest!.id)) {
                newPendingApprovals = {
                  ...state.pendingApprovals,
                  [projectPath]: [...currentList, chunk.approvalRequest]
                };
              }
            }

            let newSubagents = state.subagents;
            if (chunk.subagent) {
              const currentSub = state.subagents[projectPath] || [];
              const idx = currentSub.findIndex((s) => s.id === chunk.subagent!.id);
              const updated = [...currentSub];
              if (idx >= 0) {
                updated[idx] = chunk.subagent;
              } else {
                updated.push(chunk.subagent);
              }
              newSubagents = {
                ...state.subagents,
                [projectPath]: updated
              };
            }

            let newRateLimitWarnings = state.rateLimitWarnings;
            if (chunk.rateLimitWarning) {
              newRateLimitWarnings = {
                ...state.rateLimitWarnings,
                [streamId]: chunk.rateLimitWarning
              };
            }

            let newLiveOutputs = state.liveOutputs;
            if (chunk.toolCall?.result && typeof chunk.toolCall.result === 'string') {
              newLiveOutputs = {
                ...state.liveOutputs,
                [streamId]: chunk.toolCall.result
              };
            }

            // План утверждён (ExitPlanMode выполнен): CLI вышел из plan mode — и вкладка выходит из architect (TASK-272).
            const planApproved = isApprovedPlanExit(chunk.toolCall) && state.mode === 'architect';

            return {
              sessions: {
                ...state.sessions,
                [projectPath]: newSessions
              },
              pendingApprovals: newPendingApprovals,
              subagents: newSubagents,
              rateLimitWarnings: newRateLimitWarnings,
              liveOutputs: newLiveOutputs,
              ...(chunk.cliBackground ? { cliBackground: { ...state.cliBackground, [streamId]: chunk.cliBackground } } : {}),
              ...(planApproved ? { mode: 'agent' as const } : {})
            };
          });
        });

        const unsubComplete = window.api.onAIComplete(streamId, (completedMsg) => {
          set((state) => {
            const pSessions = state.sessions[projectPath] || [];
            const sIdx = pSessions.findIndex((s) => s.id === activeSessionId);
            if (sIdx === -1) return streamEnded(state);

            const targetSession = { ...pSessions[sIdx] };
            const msgs = [...targetSession.messages];
            const mIdx = msgs.findIndex((m) => m.id === assistantMsgId);
            if (mIdx === -1) return streamEnded(state);

            const finalTools = (completedMsg.toolCalls || msgs[mIdx].toolCalls || []).map((tc) => ({
              ...tc,
              status: tc.status === 'running' || !tc.status ? (tc.diff ? 'pending' : 'done') : tc.status
            }));

            // Встроенная команда, которую CLI без терминала отклонил, — свой текст на языке окна вместо английского ответа.
            const rejected = goesToClaudeCli(requestConfig) ? unavailableCliCommand(completedMsg.content) : null;
            msgs[mIdx] = {
              ...completedMsg,
              ...(rejected ? { content: studioCliText(useProjectStore.getState().language).terminalHint(rejected) } : {}),
              id: assistantMsgId,
              toolCalls: finalTools.length > 0 ? finalTools : undefined
            };

            targetSession.messages = msgs;

            const newSessions = [...pSessions];
            newSessions[sIdx] = targetSession;
            // В окне — сразу диалог с кнопкой терминала, как для команд из списка; с телефона — только текст.
            const offerTerminal = rejected && !opts.sessionId && !opts.fromRemote;

            return {
              sessions: {
                ...state.sessions,
                [projectPath]: newSessions
              },
              ...(offerTerminal
                ? {
                    cliCommand: {
                      kind: 'terminal' as const,
                      command: rejected,
                      projectPath,
                      sessionId: activeSessionId,
                      ...(claudeAccountId ? { claudeAccountId } : {}),
                      ...(targetSession.claudeCliSessionId ? { cliSessionId: targetSession.claudeCliSessionId } : {}),
                      workspaceRoot: targetSession.claudeCliCwd || cliCwd
                    }
                  }
                : {}),
              ...streamEnded(state)
            };
          });

          cleanup();
          // Ответ завершён — записываем сессию сразу, не дожидаясь дебаунса (TASK-35, AC #1).
          void sessionPersister.flushNow();

          // Голосовой диалог (TASK-83 п. 3): стор лишь сообщает, что ответ готов. Решение, читать
          // ли его вслух, и подготовка текста остаются в голосовом модуле — иначе стор потянул бы
          // за собой настройки TTS и правила чистки от кода.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('projecthub:agent-answer', {
                detail: { projectPath, sessionId: activeSessionId, text: completedMsg.content || '' }
              })
            );
          }
          afterTurn('complete');
        });

        const unsubError = window.api.onAIError(streamId, (err, info) => {
          set((state) => {
            const pSessions = state.sessions[projectPath] || [];
            const sIdx = pSessions.findIndex((s) => s.id === activeSessionId);
            if (sIdx === -1) return streamEnded(state);

            const targetSession = { ...pSessions[sIdx] };
            const msgs = [...targetSession.messages];
            const mIdx = msgs.findIndex((m) => m.id === assistantMsgId);
            if (mIdx === -1) return streamEnded(state);

            // Ошибка — отдельными полями, а не текстом ответа: карточка показывает её локализованно
            // (decision-43), а в историю для модели текст ошибки больше не попадает.
            const target = { ...msgs[mIdx], error: err, ...(info ? { providerError: info } : {}) };

            msgs[mIdx] = target;
            targetSession.messages = msgs;

            const newSessions = [...pSessions];
            newSessions[sIdx] = targetSession;

            return {
              sessions: {
                ...state.sessions,
                [projectPath]: newSessions
              },
              ...streamEnded(state)
            };
          });

          cleanup();
          void sessionPersister.flushNow();
          afterTurn('error');
        });

        const stream = { cleanup: () => {} };
        const cleanup = () => {
          unsubChunk();
          unsubComplete();
          unsubError();
          if (liveStreams.get(streamId) === stream) liveStreams.delete(streamId);
        };
        stream.cleanup = cleanup;
        liveStreams.set(streamId, stream);

        const streamReq: AIStreamRequest = {
          sessionId: streamId,
          projectPath,
          messages: messagesForModel([...currentMessages, userMsg]),
          config: requestConfig,
          mode: requestMode,
          claudeCliSessionId: currentSession.claudeCliSessionId,
          ...(currentSession.claudeCliForkPending && currentSession.claudeCliSessionId
            ? { claudeCliFork: 'branch' as const, ...(currentSession.claudeCliResumeAt ? { claudeCliResumeAt: currentSession.claudeCliResumeAt } : {}) }
            : {}),
          // Каталоги `/add-dir` вкладки (TASK-285) — только Claude Code: у API-движков своего `--add-dir` нет.
          ...(currentSession.claudeCliAddDirs?.length && goesToClaudeCli(requestConfig) ? { claudeCliAddDirs: currentSession.claudeCliAddDirs } : {}),
          taskId: currentSession.activeTaskId,
          contextParts: currentSession.contextParts,
          // Агент работает в дереве вкладки (TASK-268, decision-195); основное дерево — без поля, как раньше.
          ...(sameWorkPath(workDir, projectPath) ? {} : { workspaceRoot: workDir }),
          ...(claudeAccountId ? { claudeAccountId } : {}),
          // Сессия участника: хост сам выберет его worktree и права (TASK-142.3).
          ...(currentSession.memberId ? { memberId: currentSession.memberId } : {})
        };

        try {
          await window.api.streamAIChat(streamReq);
        } catch (err: any) {
          console.error('streamAIChat invocation error:', err);
          set(streamEnded);
          cleanup();
        }
      },

      retryFailedMessage: async (projectPath: string, assistantMessageId: string) => {
        const sessionId = get().activeSessionId[projectPath];
        const session = (get().sessions[projectPath] || []).find((s) => s.id === sessionId);
        if (!session || get().streamingSessions[session.id]) return;
        const target = retryTarget(session.messages || [], assistantMessageId);
        if (!target) return;
        set((state) => ({
          sessions: {
            ...state.sessions,
            [projectPath]: (state.sessions[projectPath] || []).map((s) =>
              s.id === sessionId ? { ...s, messages: s.messages.filter((m) => !target.removeIds.includes(m.id)) } : s
            )
          }
        }));
        await get().sendMessage(projectPath, target.userText, {
          sessionId: session.id,
          ...(target.attachments.length > 0 ? { attachments: target.attachments } : {})
        });
      },

      acceptDiff: async (projectPath: string, messageId: string, toolId: string, filePath: string, newContent: string) => {
        if (window.api?.applyAIDiff) {
          try {
            await window.api.applyAIDiff(projectPath, filePath, newContent);

            set((state) => {
              const activeSessionId = state.activeSessionId[projectPath];
              const pSessions = state.sessions[projectPath] || [];

              const updated = pSessions.map((s) => {
                if (s.id === activeSessionId) {
                  return {
                    ...s,
                    messages: s.messages.map((m) => {
                      if (m.id === messageId && m.toolCalls) {
                        return {
                          ...m,
                          toolCalls: m.toolCalls.map((tc) =>
                            tc.id === toolId ? { ...tc, status: 'accepted' as const } : tc
                          )
                        };
                      }
                      return m;
                    })
                  };
                }
                return s;
              });

              return {
                sessions: {
                  ...state.sessions,
                  [projectPath]: updated
                }
              };
            });
          } catch (e) {
            console.error('Failed to apply diff:', e);
          }
        }
      },

      rejectDiff: (projectPath: string, messageId: string, toolId: string) => {
        set((state) => {
          const activeSessionId = state.activeSessionId[projectPath];
          const pSessions = state.sessions[projectPath] || [];

          const updated = pSessions.map((s) => {
            if (s.id === activeSessionId) {
              return {
                ...s,
                messages: s.messages.map((m) => {
                  if (m.id === messageId && m.toolCalls) {
                    return {
                      ...m,
                      toolCalls: m.toolCalls.map((tc) =>
                        tc.id === toolId ? { ...tc, status: 'rejected' as const } : tc
                      )
                    };
                  }
                  return m;
                })
              };
            }
            return s;
          });

          return {
            sessions: {
              ...state.sessions,
              [projectPath]: updated
            }
          };
        });
      }
    }),
    {
      name: 'projecthub-ai-studio-storage',
      version: 2,
      // В localStorage — только лёгкие настройки, запись с дебаунсом и без повторов одинаковых значений (TASK-35).
      storage: createJSONStorage(() => createDebouncedStorage(localStorage)),
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        config: {
          ...state.config,
          apiKey: undefined // Не сохраняем API-ключ в открытом виде в localStorage — защищено через safeStorage (DPAPI)
        },
        mode: state.mode
      }),
      // Старый блоб (version 0/1) мог содержать sessions — в состояние их не подмешиваем,
      // историю поднимает loadSessions() с диска после миграции.
      migrate: (persisted: any) => {
        if (persisted && typeof persisted === 'object') {
          const { sessions: _legacy, ...rest } = persisted;
          return rest;
        }
        return persisted;
      },
      merge: (persisted: any, current) => {
        const { sessions: _legacy, ...rest } = (persisted || {}) as Record<string, unknown>;
        return { ...current, ...rest };
      }
    }
  )
);

// Запись изменившихся сессий на диск: одна подписка покрывает создание, переименование,
// стриминг (с дебаунсом), очистку и закрытие (удаление файла).
sessionPersister.setResolver((projectPath, sessionId) =>
  useAIStudioStore.getState().sessions[projectPath]?.find((s) => s.id === sessionId)
);
useAIStudioStore.subscribe((state, prev) => {
  if (state.sessions !== prev.sessions) sessionPersister.track(prev.sessions, state.sessions);
});
