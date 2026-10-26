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
  ContextPartKey,
  StudioSessionAgent
} from '../types/electron';
import { useProjectStore } from './useProjectStore';
import { useClaudeAccountsStore } from './useClaudeAccountsStore';
import { messagesForModel, retryTarget } from '../lib/providerErrorView';
import { upsertToolCall } from '../lib/aiToolCalls';
import { effectiveSessionAgent, sessionClaudeAccountId, sessionRequestConfig } from '../lib/studioSessionAgent';
import { canWriteStudioSession } from '../utils/studioRemote';
import { getDictionary } from '../i18n';
import { isAutoSessionTitle, localizeLegacyTitle, titleFromPrompt } from '../lib/studioSessionTitle';

export type { AISession };

interface AIStudioState {
  sessions: Record<string, AISession[]>; // projectPath -> list of sessions (in-memory, файлы через main — TASK-35)
  sessionsLoaded: Record<string, boolean>; // projectPath -> история прочитана с диска
  activeSessionId: Record<string, string>; // projectPath -> active sessionId
  lastActiveSessionId: Record<string, string>; // projectPath -> previous active sessionId
  /** sessionId -> идёт ответ: вкладки одного проекта отвечают параллельно (TASK-171). */
  streamingSessions: Record<string, true>;
  config: AIProviderConfig;
  mode: 'chat' | 'agent' | 'architect';
  isSettingsOpen: boolean;
  claudeAuth: ClaudeAuthStatus | null;

  // Subagents & Human Approvals & Rate Limits
  pendingApprovals: Record<string, ApprovalRequest[]>; // projectPath -> active requests
  subagents: Record<string, SubagentInfo[]>; // projectPath -> active subagents (вкладка фильтрует по parentSessionId)
  rateLimitWarnings: Record<string, RateLimitWarning | null>; // sessionId -> active warning
  liveOutputs: Record<string, string>; // sessionId -> console output string
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
  /** Включает/выключает часть контекста (задача/RAG/GitNexus/git) на сессию. */
  toggleContextPart: (projectPath: string, sessionId: string, key: ContextPartKey, enabled: boolean) => void;
  clearSession: (projectPath: string, sessionId?: string) => void;
  sendMessage: (projectPath: string, text: string, opts?: SendMessageOptions) => Promise<void>;
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
}

export interface SendMessageOptions {
  /** Сессия, в которую идёт сообщение; по умолчанию — активная вкладка. */
  sessionId?: string;
  /** Конфиг этого запроса (модель с телефона); глобальный выбор Agents Studio не меняется. */
  config?: AIProviderConfig;
  mode?: 'chat' | 'agent' | 'architect';
  /** Кто пишет: участник общего хоста с устройства (TASK-142.3); окно хоста — без поля. */
  memberId?: string;
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

type SessionScopedFields = 'streamingSessions' | 'liveOutputs' | 'rateLimitWarnings' | 'pendingApprovals';

/** Сброс стрима, живого вывода, предупреждения о лимитах и ожидающих одобрений закрываемой/очищаемой сессии. */
function sessionResetPatch(
  state: Pick<AIStudioState, SessionScopedFields>,
  projectPath: string,
  sessionId: string | undefined
): Partial<Pick<AIStudioState, SessionScopedFields>> {
  if (!sessionId) return {};
  const patch: Partial<Pick<AIStudioState, SessionScopedFields>> = {
    streamingSessions: withoutKey(state.streamingSessions, sessionId),
    liveOutputs: withoutKey(state.liveOutputs, sessionId),
    rateLimitWarnings: withoutKey(state.rateLimitWarnings, sessionId)
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

/** Словарь Studio на языке интерфейса — для заголовков вкладок по умолчанию (TASK-204). */
const studioText = () => getDictionary(useProjectStore.getState().language).aiStudio;

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
      config: DEFAULT_CONFIG,
      mode: 'agent',
      isSettingsOpen: false,
      claudeAuth: null,
      pendingApprovals: {},
      subagents: {},
      rateLimitWarnings: {},
      liveOutputs: {},
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
          ...(opts.memberId ? { memberId: opts.memberId } : {})
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

      renameSession: (projectPath: string, sessionId: string, newTitle: string) => {
        const cleanTitle = newTitle.trim();
        if (!cleanTitle) return;
        set((state) => {
          const projectSessions = state.sessions[projectPath] || [];
          return {
            sessions: {
              ...state.sessions,
              [projectPath]: projectSessions.map((s) =>
                s.id === sessionId ? { ...s, title: cleanTitle, autoTitle: undefined } : s
              )
            }
          };
        });
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
            [projectPath]: (state.sessions[projectPath] || []).map((s) => (s.id === sessionId ? { ...s, agent } : s))
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
        if (targetSessionId) releaseSessionInMain(targetSessionId);
        // Очищенная вкладка остаётся: новый ответ в ней — только после конца прерванного (общий канал сессии).
        const wasStreaming = !!(targetSessionId && get().streamingSessions[targetSessionId]);
        set((state) => {
          const existing = state.sessions[projectPath] || [];

          const updated = existing.map((s) =>
            s.id === targetSessionId
              ? { ...s, messages: [], title: studioText().newChat, autoTitle: true, claudeCliSessionId: undefined }
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
        await window.api.abortAIStream(sessionId);
        releaseStreamLater(sessionId, set);
      },

      sendMessage: async (projectPath: string, text: string, opts: SendMessageOptions = {}) => {
        if (!text.trim() || !window.api?.streamAIChat) return;

        let activeSessionId = opts.sessionId || get().activeSessionId[projectPath];
        let projectSessions = get().sessions[projectPath] || [];

        if (!activeSessionId || !projectSessions.some((s) => s.id === activeSessionId)) {
          if (opts.sessionId) return; // сессию для телефона готовит обработчик запроса — сюда не доходит
          activeSessionId = get().createSession(projectPath);
          projectSessions = get().sessions[projectPath] || [];
        }
        // Занята только эта вкладка: другие вкладки проекта отвечают параллельно (TASK-171).
        if (get().streamingSessions[activeSessionId]) return;
        const currentSession = projectSessions.find((s) => s.id === activeSessionId)!;
        // Пишет в сессию только её владелец (decision-84 п. 5): чужая сессия участника — только для чтения.
        if (!canWriteStudioSession(currentSession, opts.memberId)) return;
        // Модель с телефона — на этот запрос; иначе агент вкладки поверх общего конфига (TASK-170).
        const requestConfig = opts.config ?? sessionRequestConfig(get().config, currentSession.agent);
        const requestMode = opts.mode ?? get().mode;
        const claudeAccountId = requestConfig.provider === 'anthropic' ? sessionClaudeAccountId(currentSession.agent) : undefined;
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
          timestamp: new Date().toISOString()
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
        const sessionTitle = autoTitle ? titleFromPrompt(text) || currentSession.title : currentSession.title;

        set((state) => {
          const pSessions = state.sessions[projectPath] || [];
          const updated = pSessions.map((s) =>
            s.id === activeSessionId
              ? { ...s, title: sessionTitle, ...(autoTitle ? { autoTitle: undefined } : {}), messages: updatedMessages, lastSelection, lastMode: requestMode }
              : s
          );

          return {
            sessions: {
              ...state.sessions,
              [projectPath]: updated
            },
            streamingSessions: { ...state.streamingSessions, [activeSessionId]: true },
            // Вывод прошлого ответа этой вкладки не смешивается с новым.
            liveOutputs: withoutKey(state.liveOutputs, activeSessionId)
          };
        });

        const streamId = activeSessionId;
        const streamEnded = (state: AIStudioState) => ({ streamingSessions: withoutKey(state.streamingSessions, streamId) });

        // Listen to streaming events
        const unsubChunk = window.api.onAIChunk(streamId, (chunk) => {
          set((state) => {
            const pSessions = state.sessions[projectPath] || [];
            const sIdx = pSessions.findIndex((s) => s.id === activeSessionId);
            if (sIdx === -1) return state;

            const targetSession = { ...pSessions[sIdx] };
            if (chunk.claudeCliSessionId) {
              targetSession.claudeCliSessionId = chunk.claudeCliSessionId;
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

            return {
              sessions: {
                ...state.sessions,
                [projectPath]: newSessions
              },
              pendingApprovals: newPendingApprovals,
              subagents: newSubagents,
              rateLimitWarnings: newRateLimitWarnings,
              liveOutputs: newLiveOutputs
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

            msgs[mIdx] = {
              ...completedMsg,
              id: assistantMsgId,
              toolCalls: finalTools.length > 0 ? finalTools : undefined
            };

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
          taskId: currentSession.activeTaskId,
          contextParts: currentSession.contextParts,
          // Агент работает в активном рабочем дереве проекта (TASK-62, decision-15).
          workspaceRoot: useProjectStore.getState().workspaceRoot || undefined,
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
        await get().sendMessage(projectPath, target.userText, { sessionId: session.id });
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
