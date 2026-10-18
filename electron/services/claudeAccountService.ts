import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getHomeDir, getUserDataDir } from './appPaths.js';
import { projectRegistry } from './projectRegistry.js';
import { findOwningProject } from './pathGuard.js';
import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  addClaudeAccount,
  claudeAccountEnv,
  defaultClaudeConfigDir,
  findAccountByConfigDir,
  findSharedLoginGroups,
  listClaudeAccounts,
  normalizeClaudeAccountsSettings,
  parseClaudeAuthStatus,
  removeClaudeAccount,
  renameClaudeAccount,
  resolveClaudeAccount,
  setRoleClaudeAccount,
  type AddClaudeAccountInput,
  type ClaudeAccountAuthStatus,
  type ClaudeAccountProfile,
  type ClaudeAccountResolution,
  type ClaudeAccountsSettings
} from './claudeAccounts.js';

/**
 * Аккаунты Claude Code (TASK-152, decision-87): профили в `<userData>/claude-accounts.json`, привязка
 * проекта в реестре машины, единый резолвер окружения для всех запусков Claude CLI.
 */

const SETTINGS_FILE = 'claude-accounts.json';
const AUTH_STATUS_TTL_MS = 30 * 1000;
const AUTH_STATUS_TIMEOUT_MS = 10 * 1000;
const LOGOUT_TIMEOUT_MS = 15 * 1000;

/** Значение `CLAUDE_CONFIG_DIR`, с которым запущен сам ProjectHub (например, из Rider), — снимок при старте. */
const PROCESS_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;

/** Каталог профиля по умолчанию (прежний `PROJECT_HUB_CLAUDE_DIR`) и служебное хранилище ProjectHub. */
export function defaultClaudeAccountDir(): string {
  return defaultClaudeConfigDir(getHomeDir());
}

export interface ClaudeAccountQuery {
  /** Корень проекта или его worktree; по нему берётся привязка проекта. */
  projectPath?: string | null;
  /** Переопределение слота Swarm (TASK-152.4). */
  slotAccountId?: string | null;
  /** Роль агента: её привязка на машине (TASK-152.4). */
  roleSlug?: string | null;
}

export interface ClaudeAccountView extends ClaudeAccountProfile {
  isDefault: boolean;
  /**
   * Подключён обычный `~/.claude`: с `CLAUDE_CONFIG_DIR` CLI держит `.claude.json` внутри каталога, а не в
   * `~/.claude.json`, — при первом запуске создаёт копию, дальше настройки двух файлов расходятся (2.1.302).
   */
  isHomeClaudeDir?: boolean;
  /** Сколько проектов реестра привязано к профилю. */
  projectCount: number;
}

export interface ClaudeAccountsOverview {
  accounts: ClaudeAccountView[];
  roleAccounts: Record<string, string>;
  /** `CLAUDE_CONFIG_DIR` процесса ProjectHub и профиль, который на него указывает (decision-87 п. 7). */
  processConfigDir?: string;
  processConfigDirAccountId?: string;
  platform: NodeJS.Platform;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
}

/** `claude <args>` под каталогом аккаунта. stdin закрыт сразу: CLI иначе ждёт ввод. */
export function runClaudeCliWithAccount(args: string[], configDir: string, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', args, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: configDir }
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* процесс уже завершён */ }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: err.message });
    });
  });
}

function isSameDir(a: string, b: string): boolean {
  return findAccountByConfigDir([{ id: '', name: '', kind: 'external', configDir: a }], b, process.platform) !== undefined;
}

class ClaudeAccountService {
  private settings: ClaudeAccountsSettings | null = null;
  private loading: Promise<ClaudeAccountsSettings> | null = null;
  private authCache = new Map<string, ClaudeAccountAuthStatus>();
  private authInflight = new Map<string, Promise<ClaudeAccountAuthStatus>>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  private filePath(): string {
    return path.join(getUserDataDir(), SETTINGS_FILE);
  }

  private async load(): Promise<ClaudeAccountsSettings> {
    if (this.settings) return this.settings;
    if (!this.loading) {
      this.loading = (async () => {
        let raw: unknown;
        try {
          raw = JSON.parse(await fs.readFile(this.filePath(), 'utf-8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            console.warn('[ClaudeAccounts] Не удалось прочитать claude-accounts.json, профили не загружены:', (err as Error)?.message);
          }
        }
        this.settings = normalizeClaudeAccountsSettings(raw);
        return this.settings;
      })().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private save(next: ClaudeAccountsSettings): Promise<void> {
    this.settings = next;
    const file = this.filePath();
    const run = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
      await fs.rename(tmp, file);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async listAccounts(): Promise<ClaudeAccountProfile[]> {
    return listClaudeAccounts(await this.load(), getHomeDir());
  }

  async getAccount(id: string): Promise<ClaudeAccountProfile | undefined> {
    return (await this.listAccounts()).find((account) => account.id === id);
  }

  async overview(): Promise<ClaudeAccountsOverview> {
    const settings = await this.load();
    const accounts = listClaudeAccounts(settings, getHomeDir());
    const projects = await projectRegistry.getProjects();
    const counts = new Map<string, number>();
    for (const project of projects) {
      const id = project.claudeAccountId && accounts.some((a) => a.id === project.claudeAccountId)
        ? project.claudeAccountId
        : DEFAULT_CLAUDE_ACCOUNT_ID;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const processAccount = findAccountByConfigDir(accounts, PROCESS_CLAUDE_CONFIG_DIR, process.platform);
    return {
      accounts: accounts.map((account) => ({
        ...account,
        isDefault: account.id === DEFAULT_CLAUDE_ACCOUNT_ID,
        ...(isSameDir(account.configDir, path.join(getHomeDir(), '.claude')) ? { isHomeClaudeDir: true } : {}),
        projectCount: counts.get(account.id) ?? 0
      })),
      roleAccounts: { ...settings.roleAccounts },
      ...(PROCESS_CLAUDE_CONFIG_DIR ? { processConfigDir: PROCESS_CLAUDE_CONFIG_DIR } : {}),
      ...(processAccount ? { processConfigDirAccountId: processAccount.id } : {}),
      platform: process.platform
    };
  }

  /** Привязка проекта (по корню или worktree внутри него). */
  async projectAccountId(projectPath: string | null | undefined): Promise<string | undefined> {
    if (!projectPath?.trim()) return undefined;
    const projects = await projectRegistry.getProjects();
    const owner = findOwningProject(projects.map((p) => p.path), projectPath);
    if (!owner) return undefined;
    const normalized = path.normalize(owner).toLowerCase();
    return projects.find((p) => path.normalize(p.path).toLowerCase() === normalized)?.claudeAccountId;
  }

  /** Аккаунт запуска: слот → роль → проект → по умолчанию. Пропущенные ссылки — в лог. */
  async resolve(query: ClaudeAccountQuery = {}): Promise<ClaudeAccountResolution> {
    const settings = await this.load();
    const accounts = listClaudeAccounts(settings, getHomeDir());
    const roleAccountId = query.roleSlug ? settings.roleAccounts[query.roleSlug] : undefined;
    let projectAccountId: string | undefined;
    try {
      projectAccountId = await this.projectAccountId(query.projectPath);
    } catch (err) {
      console.warn('[ClaudeAccounts] Реестр проектов недоступен, аккаунт проекта не определён:', (err as Error)?.message);
    }
    const resolution = resolveClaudeAccount({ accounts, slotAccountId: query.slotAccountId, roleAccountId, projectAccountId });
    for (const miss of resolution.missing) {
      console.warn(`[ClaudeAccounts] Профиль «${miss.id}» (${miss.source}) не найден — используется «${resolution.account.name}».`);
    }
    return resolution;
  }

  /** Окружение запуска Claude CLI: `{ CLAUDE_CONFIG_DIR }` аккаунта из резолвера. */
  async envFor(query: ClaudeAccountQuery = {}): Promise<{ CLAUDE_CONFIG_DIR: string }> {
    return claudeAccountEnv((await this.resolve(query)).account);
  }

  async createManaged(name: string): Promise<ClaudeAccountProfile> {
    return this.add({ name, kind: 'managed' });
  }

  async connectExternal(name: string, configDir: string): Promise<ClaudeAccountProfile> {
    const dir = path.resolve(configDir.trim());
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Каталог не найден: ${dir}`);
    return this.add({ name, kind: 'external', configDir: dir });
  }

  private async add(input: AddClaudeAccountInput): Promise<ClaudeAccountProfile> {
    const { settings, account } = addClaudeAccount(await this.load(), input, { homeDir: getHomeDir(), platform: process.platform });
    if (account.kind === 'managed') mkdirSync(account.configDir, { recursive: true });
    await this.save(settings);
    return account;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.save(renameClaudeAccount(await this.load(), id, name, getHomeDir()));
  }

  /**
   * Удаление профиля: снимаются привязки проектов и ролей. Каталог не удаляется — ни свой (там может
   * остаться история сессий), ни тем более внешний.
   */
  async remove(id: string): Promise<{ removed: ClaudeAccountProfile; unboundProjects: number }> {
    const { settings, removed } = removeClaudeAccount(await this.load(), id);
    await this.save(settings);
    this.authCache.delete(id);
    const unboundProjects = await projectRegistry.clearClaudeAccount(id);
    return { removed, unboundProjects };
  }

  async setProjectAccount(projectPath: string, accountId: string | null): Promise<boolean> {
    if (accountId && accountId !== DEFAULT_CLAUDE_ACCOUNT_ID && !(await this.getAccount(accountId))) {
      throw new Error('Профиль аккаунта не найден.');
    }
    // Профиль по умолчанию — это отсутствие привязки: так проект переживает переименование профилей.
    return projectRegistry.setClaudeAccountId(projectPath, accountId === DEFAULT_CLAUDE_ACCOUNT_ID ? null : accountId);
  }

  async setRoleAccount(roleSlug: string, accountId: string | null): Promise<void> {
    await this.save(setRoleClaudeAccount(await this.load(), roleSlug, accountId, getHomeDir()));
  }

  /** `claude auth status --json` профиля; кэш на 30 с, параллельные запросы делят один запуск. */
  async authStatus(id: string, force = false): Promise<ClaudeAccountAuthStatus> {
    const account = await this.getAccount(id);
    if (!account) return { loggedIn: false, error: 'Профиль не найден.', checkedAt: Date.now() };
    const cached = this.authCache.get(id);
    if (!force && cached && Date.now() - cached.checkedAt < AUTH_STATUS_TTL_MS) return cached;
    const inflight = this.authInflight.get(id);
    if (inflight) return inflight;

    const run = (async () => {
      const result = await runClaudeCliWithAccount(['auth', 'status', '--json'], account.configDir, AUTH_STATUS_TIMEOUT_MS);
      const status = result.timedOut
        ? { loggedIn: false, error: 'claude auth status не ответил вовремя.', checkedAt: Date.now() }
        : result.spawnError
          ? { loggedIn: false, error: `Не удалось запустить Claude CLI: ${result.spawnError}`, checkedAt: Date.now() }
          : parseClaudeAuthStatus(result.stdout || result.stderr, result.code);
      this.authCache.set(id, status);
      return status;
    })().finally(() => this.authInflight.delete(id));
    this.authInflight.set(id, run);
    return run;
  }

  /** Статусы всех профилей и группы профилей с одним входом (признак общего Keychain на macOS). */
  async allAuthStatuses(force = false): Promise<{ statuses: Record<string, ClaudeAccountAuthStatus>; sharedLogin: string[][] }> {
    const accounts = await this.listAccounts();
    const entries = await Promise.all(accounts.map(async (a) => [a.id, await this.authStatus(a.id, force)] as const));
    const statuses = Object.fromEntries(entries);
    return { statuses, sharedLogin: findSharedLoginGroups(entries.map(([id, status]) => ({ id, status }))) };
  }

  invalidateAuth(id?: string): void {
    if (id) this.authCache.delete(id);
    else this.authCache.clear();
  }

  /**
   * Выход — только `claude auth logout` с каталогом профиля (decision-87 п. 10). Файлы входа и
   * глобальный `~/.claude.json` ProjectHub не трогает.
   */
  async logout(id: string): Promise<ClaudeAccountAuthStatus> {
    const account = await this.getAccount(id);
    if (!account) throw new Error('Профиль не найден.');
    const result = await runClaudeCliWithAccount(['auth', 'logout'], account.configDir, LOGOUT_TIMEOUT_MS);
    if (result.spawnError) throw new Error(`Не удалось запустить Claude CLI: ${result.spawnError}`);
    this.authCache.delete(id);
    return this.authStatus(id, true);
  }
}

export const claudeAccountService = new ClaudeAccountService();
