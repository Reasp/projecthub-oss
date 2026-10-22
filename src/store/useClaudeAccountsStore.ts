import { create } from 'zustand';
import type {
  ClaudeAccountAuthStatus,
  ClaudeAccountProfile,
  ClaudeAccountSource,
  ClaudeAccountsOverview,
  OtherCliAccountEngine
} from '../types/electron';

/**
 * Профили аккаунтов Claude Code в рендерере (TASK-152, decision-87): список, статусы входа, аккаунт
 * проектов для бейджа и окно входа со встроенным терминалом.
 */

export interface ProjectClaudeAccount {
  account: ClaudeAccountProfile;
  source: ClaudeAccountSource;
}

interface ClaudeAccountsState {
  overview: ClaudeAccountsOverview | null;
  statuses: Record<string, ClaudeAccountAuthStatus>;
  /** Группы профилей с одним и тем же входом (на macOS — признак общего Keychain). */
  sharedLogin: string[][];
  statusesLoading: boolean;
  /** Аккаунт проекта по корню проекта — для бейджа в шапке. */
  projectAccounts: Record<string, ProjectClaudeAccount>;
  /** Профиль, в который сейчас идёт вход (окно со встроенным терминалом). */
  loginAccountId: string | null;
  /** Окно «Аккаунты Claude Code» (из бейджа проекта и строки состояния). */
  isManagerOpen: boolean;

  refresh: () => Promise<void>;
  refreshStatuses: (force?: boolean) => Promise<void>;
  refreshStatus: (id: string, force?: boolean) => Promise<ClaudeAccountAuthStatus | null>;
  loadProjectAccount: (projectPath: string) => Promise<ProjectClaudeAccount | null>;
  setProjectAccount: (projectPath: string, accountId: string | null) => Promise<void>;
  /** Аккаунты Codex CLI и Gemini CLI проекта по корню проекта (decision-163); `null` — обычный каталог CLI. */
  projectEngineAccounts: Record<string, Record<OtherCliAccountEngine, string | null>>;
  loadProjectEngines: (projectPath: string) => Promise<void>;
  setProjectEngineAccount: (projectPath: string, engine: OtherCliAccountEngine, accountId: string | null) => Promise<void>;
  openLogin: (accountId: string) => void;
  /** Вход в аккаунт проекта (или профиль по умолчанию без проекта). */
  openLoginForProject: (projectPath?: string) => Promise<void>;
  closeLogin: () => void;
  openManager: () => void;
  closeManager: () => void;
}

export const useClaudeAccountsStore = create<ClaudeAccountsState>((set, get) => ({
  overview: null,
  statuses: {},
  sharedLogin: [],
  statusesLoading: false,
  projectAccounts: {},
  projectEngineAccounts: {},
  loginAccountId: null,
  isManagerOpen: false,

  refresh: async () => {
    if (!window.api?.claudeAccounts) return;
    const overview = await window.api.claudeAccounts.overview();
    set({ overview });
  },

  refreshStatuses: async (force = false) => {
    if (!window.api?.claudeAccounts) return;
    set({ statusesLoading: true });
    try {
      const { statuses, sharedLogin } = await window.api.claudeAccounts.statuses(force);
      set({ statuses, sharedLogin });
    } finally {
      set({ statusesLoading: false });
    }
  },

  refreshStatus: async (id, force = false) => {
    if (!window.api?.claudeAccounts) return null;
    const status = await window.api.claudeAccounts.status(id, force);
    set((state) => ({ statuses: { ...state.statuses, [id]: status } }));
    return status;
  },

  loadProjectAccount: async (projectPath) => {
    if (!window.api?.claudeAccounts || !projectPath) return null;
    try {
      const resolved = await window.api.claudeAccounts.forProject(projectPath);
      set((state) => ({ projectAccounts: { ...state.projectAccounts, [projectPath]: resolved } }));
      return resolved;
    } catch (err) {
      console.warn('[ClaudeAccounts] Не удалось определить аккаунт проекта:', err);
      return null;
    }
  },

  setProjectAccount: async (projectPath, accountId) => {
    if (!window.api?.claudeAccounts) return;
    await window.api.claudeAccounts.setProject(projectPath, accountId);
    await Promise.all([get().loadProjectAccount(projectPath), get().refresh()]);
  },

  loadProjectEngines: async (projectPath) => {
    if (!window.api?.claudeAccounts?.projectEngines || !projectPath) return;
    try {
      const engines = await window.api.claudeAccounts.projectEngines(projectPath);
      set((state) => ({ projectEngineAccounts: { ...state.projectEngineAccounts, [projectPath]: engines } }));
    } catch (err) {
      console.warn('[ClaudeAccounts] Не удалось прочитать аккаунты Codex/Gemini проекта:', err);
    }
  },

  setProjectEngineAccount: async (projectPath, engine, accountId) => {
    if (!window.api?.claudeAccounts) return;
    await window.api.claudeAccounts.setProjectEngine(projectPath, engine, accountId);
    await Promise.all([get().loadProjectEngines(projectPath), get().refresh()]);
  },

  openLogin: (accountId) => set({ loginAccountId: accountId }),

  openLoginForProject: async (projectPath) => {
    const resolved = projectPath ? await get().loadProjectAccount(projectPath) : null;
    set({ loginAccountId: resolved?.account.id ?? 'default' });
  },

  closeLogin: () => set({ loginAccountId: null }),
  openManager: () => set({ isManagerOpen: true }),
  closeManager: () => set({ isManagerOpen: false })
}));
