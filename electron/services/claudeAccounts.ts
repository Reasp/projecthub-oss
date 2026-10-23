import path from 'node:path';
import { AppError, type AppErrorKey, type AppErrorParam } from '../../src/lib/appError.js';
import { DEFAULT_ACCOUNT_BUILTIN_NAME } from '../../src/lib/cliAccountEngines.js';

/**
 * Профили аккаунтов Claude Code (TASK-152, decision-87). Чистый модуль без Electron: формат файла
 * `<userData>/claude-accounts.json`, резолвер аккаунта запуска и разбор `claude auth status`.
 *
 * Профиль — это каталог `CLAUDE_CONFIG_DIR`. Секретов модуль не видит и не хранит: вход лежит в
 * каталоге (или в Keychain на macOS) и проверяется только командой CLI.
 *
 * Те же профили есть у Codex CLI (`CODEX_HOME`) и Gemini CLI (`GEMINI_CLI_HOME`) — поле `engine`, decision-163.
 */

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default';
export const DEFAULT_CLAUDE_ACCOUNT_NAME = DEFAULT_ACCOUNT_BUILTIN_NAME;
export const CLAUDE_ACCOUNTS_VERSION = 1;
export const CLAUDE_ACCOUNT_NAME_MAX_LENGTH = 40;

/** `managed` — каталог ProjectHub; `external` — подключённый существующий каталог (например, из Rider). */
export type ClaudeAccountKind = 'managed' | 'external';

/** CLI-движок, у которого бывают аккаунты (TASK-152.6, decision-163). */
export type CliAccountEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli';
/** Движки, кроме Claude Code: у них нет профиля по умолчанию — без привязки CLI берёт свой обычный каталог. */
export type OtherCliAccountEngine = Exclude<CliAccountEngine, 'claude-cli'>;
export const OTHER_CLI_ACCOUNT_ENGINES: readonly OtherCliAccountEngine[] = ['codex-cli', 'gemini-cli'];

/**
 * Переменная окружения каталога аккаунта: `CODEX_HOME` — каталог Codex CLI (по умолчанию `~/.codex`), `GEMINI_CLI_HOME`
 * — корень, внутри которого Gemini CLI держит `.gemini` (по умолчанию домашний каталог).
 */
export const CLI_ACCOUNT_ENV_VAR: Record<CliAccountEngine, string> = {
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'codex-cli': 'CODEX_HOME',
  'gemini-cli': 'GEMINI_CLI_HOME'
};

export function isOtherCliAccountEngine(value: unknown): value is OtherCliAccountEngine {
  return value === 'codex-cli' || value === 'gemini-cli';
}

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  kind: ClaudeAccountKind;
  /** Абсолютный путь — значение переменной каталога движка (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). */
  configDir: string;
  /** Движок аккаунта; нет поля — Claude Code. */
  engine?: OtherCliAccountEngine;
  createdAt?: string;
}

/** Движок профиля: без поля — Claude Code. */
export function accountEngine(account: Pick<ClaudeAccountProfile, 'engine'>): CliAccountEngine {
  return account.engine ?? 'claude-cli';
}

/** Содержимое `claude-accounts.json`. Профиль по умолчанию в списке не хранится — только его имя. */
export interface ClaudeAccountsSettings {
  version: number;
  defaultName?: string;
  profiles: ClaudeAccountProfile[];
  /**
   * Профили Codex CLI и Gemini CLI (decision-163). Отдельный ключ, а не `profiles`: прежние сборки ProjectHub не знают
   * поля `engine` и отдали бы такой каталог в `CLAUDE_CONFIG_DIR`. Пустой список в файл не пишется.
   */
  engineProfiles?: ClaudeAccountProfile[];
  /** Аккаунт роли на этой машине: slug роли → id профиля (decision-87 п. 6). */
  roleAccounts: Record<string, string>;
}

export type ClaudeAccountSource = 'slot' | 'role' | 'project' | 'default';

/** Подпись источника аккаунта для логов и отчёта. */
export const CLAUDE_ACCOUNT_SOURCE_LABEL: Record<ClaudeAccountSource, string> = {
  slot: 'слот',
  role: 'роль',
  project: 'проект',
  default: 'по умолчанию'
};

export interface ClaudeAccountResolution {
  account: ClaudeAccountProfile;
  source: ClaudeAccountSource;
  /** Ссылки на профили, которых больше нет: уровень пропущен, вызывающий пишет предупреждение. */
  missing: Array<{ source: Exclude<ClaudeAccountSource, 'default'>; id: string }>;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function emptyClaudeAccountsSettings(): ClaudeAccountsSettings {
  return { version: CLAUDE_ACCOUNTS_VERSION, profiles: [], roleAccounts: {} };
}

/** Каталог профиля по умолчанию — прежний `~/.projecthub/claude_config`. */
export function defaultClaudeConfigDir(homeDir: string): string {
  return path.join(homeDir, '.projecthub', 'claude_config');
}

/** Каталог своего профиля ProjectHub. */
export function managedClaudeConfigDir(homeDir: string, id: string): string {
  return path.join(homeDir, '.projecthub', 'claude_accounts', id);
}

const MANAGED_DIR_NAME: Record<OtherCliAccountEngine, string> = { 'codex-cli': 'codex_accounts', 'gemini-cli': 'gemini_accounts' };

/** Каталог своего профиля ProjectHub для движка. */
export function managedCliAccountDir(homeDir: string, engine: CliAccountEngine, id: string): string {
  return engine === 'claude-cli' ? managedClaudeConfigDir(homeDir, id) : path.join(homeDir, '.projecthub', MANAGED_DIR_NAME[engine], id);
}

export function isValidClaudeAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID.test(id) && id !== DEFAULT_CLAUDE_ACCOUNT_ID;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, CLAUDE_ACCOUNT_NAME_MAX_LENGTH) : undefined;
}

function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * Разбор файла профилей. Некорректные записи отбрасываются, повторы `id` — тоже (побеждает первая).
 * Запись с `id: "default"` не может переопределить каталог профиля по умолчанию.
 */
export function normalizeClaudeAccountsSettings(raw: unknown): ClaudeAccountsSettings {
  const result = emptyClaudeAccountsSettings();
  if (!raw || typeof raw !== 'object') return result;
  const input = raw as Record<string, unknown>;

  const defaultName = cleanName(input.defaultName);
  if (defaultName) result.defaultName = defaultName;

  const seen = new Set<string>();
  const parseProfile = (item: unknown, engine: OtherCliAccountEngine | null): ClaudeAccountProfile | null => {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    const name = cleanName(entry.name);
    const configDir = typeof entry.configDir === 'string' ? entry.configDir.trim() : '';
    const kind: ClaudeAccountKind | null = entry.kind === 'managed' || entry.kind === 'external' ? entry.kind : null;
    if (!isValidClaudeAccountId(id) || seen.has(id) || !name || !kind || !configDir || !path.isAbsolute(configDir)) return null;
    seen.add(id);
    return {
      id,
      name,
      kind,
      configDir: path.normalize(configDir),
      ...(engine ? { engine } : {}),
      ...(typeof entry.createdAt === 'string' && entry.createdAt ? { createdAt: entry.createdAt } : {})
    };
  };
  for (const item of Array.isArray(input.profiles) ? input.profiles : []) {
    const profile = parseProfile(item, null);
    if (profile) result.profiles.push(profile);
  }
  const engineProfiles: ClaudeAccountProfile[] = [];
  for (const item of Array.isArray(input.engineProfiles) ? input.engineProfiles : []) {
    const engine = item && typeof item === 'object' ? (item as Record<string, unknown>).engine : undefined;
    if (!isOtherCliAccountEngine(engine)) continue;
    const profile = parseProfile(item, engine);
    if (profile) engineProfiles.push(profile);
  }
  if (engineProfiles.length) result.engineProfiles = engineProfiles;

  if (input.roleAccounts && typeof input.roleAccounts === 'object' && !Array.isArray(input.roleAccounts)) {
    for (const [slug, id] of Object.entries(input.roleAccounts as Record<string, unknown>)) {
      if (slug.trim() && typeof id === 'string' && (id === DEFAULT_CLAUDE_ACCOUNT_ID || seen.has(id))) {
        result.roleAccounts[slug.trim()] = id;
      }
    }
  }
  return result;
}

/** Профиль по умолчанию — первым, затем профили из файла в порядке добавления. */
export function listClaudeAccounts(settings: ClaudeAccountsSettings, homeDir: string): ClaudeAccountProfile[] {
  return [
    {
      id: DEFAULT_CLAUDE_ACCOUNT_ID,
      name: settings.defaultName ?? DEFAULT_CLAUDE_ACCOUNT_NAME,
      kind: 'managed',
      configDir: defaultClaudeConfigDir(homeDir)
    },
    ...settings.profiles
  ];
}

/** Профили Codex CLI или Gemini CLI в порядке добавления. Профиля по умолчанию у них нет. */
export function listEngineAccounts(settings: ClaudeAccountsSettings, engine: OtherCliAccountEngine): ClaudeAccountProfile[] {
  return (settings.engineProfiles ?? []).filter((p) => p.engine === engine);
}

/** Все профили всех движков: Claude Code (с профилем по умолчанию), затем остальные. */
export function listAllAccounts(settings: ClaudeAccountsSettings, homeDir: string): ClaudeAccountProfile[] {
  return [...listClaudeAccounts(settings, homeDir), ...(settings.engineProfiles ?? [])];
}

/** Профили того же движка — для проверки имени. */
function sameEngineAccounts(settings: ClaudeAccountsSettings, engine: CliAccountEngine, homeDir: string): ClaudeAccountProfile[] {
  return engine === 'claude-cli' ? listClaudeAccounts(settings, homeDir) : listEngineAccounts(settings, engine);
}

function cleanId(id: string | null | undefined): string | undefined {
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/**
 * Аккаунт запуска Claude CLI: слот → роль → проект → по умолчанию (decision-87 п. 5). Ссылка на
 * удалённый профиль пропускается и попадает в `missing`, запуск не ломается.
 */
export function resolveClaudeAccount(input: {
  accounts: ClaudeAccountProfile[];
  slotAccountId?: string | null;
  roleAccountId?: string | null;
  projectAccountId?: string | null;
}): ClaudeAccountResolution {
  const byId = new Map(input.accounts.map((account) => [account.id, account]));
  const fallback = byId.get(DEFAULT_CLAUDE_ACCOUNT_ID) ?? input.accounts[0];
  if (!fallback) throw new AppError('accounts.listEmpty');

  const missing: ClaudeAccountResolution['missing'] = [];
  const levels: Array<[Exclude<ClaudeAccountSource, 'default'>, string | undefined]> = [
    ['slot', cleanId(input.slotAccountId)],
    ['role', cleanId(input.roleAccountId)],
    ['project', cleanId(input.projectAccountId)]
  ];
  for (const [source, id] of levels) {
    if (!id) continue;
    const account = byId.get(id);
    if (account) return { account, source, missing };
    missing.push({ source, id });
  }
  return { account: fallback, source: 'default', missing };
}

/** Окружение запуска Claude CLI под аккаунтом. */
export function claudeAccountEnv(account: Pick<ClaudeAccountProfile, 'configDir'>): { CLAUDE_CONFIG_DIR: string } {
  return { CLAUDE_CONFIG_DIR: account.configDir };
}

export interface EngineAccountResolution {
  /** Нет — привязок нет: CLI работает со своим обычным каталогом, окружение не меняется. */
  account?: ClaudeAccountProfile;
  source: ClaudeAccountSource;
  missing: ClaudeAccountResolution['missing'];
}

/**
 * Аккаунт запуска Codex CLI или Gemini CLI: слот → роль → проект, как у Claude Code (decision-163). Профиль другого
 * движка на уровне пропускается молча — например, слот сменил движок, а поле аккаунта осталось; удалённый профиль
 * попадает в `missing`. Ничего не нашлось — профиля нет, а не профиль по умолчанию.
 */
export function resolveEngineAccount(input: {
  engine: OtherCliAccountEngine;
  accounts: ClaudeAccountProfile[];
  slotAccountId?: string | null;
  roleAccountId?: string | null;
  projectAccountId?: string | null;
}): EngineAccountResolution {
  const byId = new Map(input.accounts.map((account) => [account.id, account]));
  const missing: EngineAccountResolution['missing'] = [];
  const levels: Array<[Exclude<ClaudeAccountSource, 'default'>, string | undefined]> = [
    ['slot', cleanId(input.slotAccountId)],
    ['role', cleanId(input.roleAccountId)],
    ['project', cleanId(input.projectAccountId)]
  ];
  for (const [source, id] of levels) {
    if (!id) continue;
    const account = byId.get(id);
    if (!account) missing.push({ source, id });
    else if (account.engine === input.engine) return { account, source, missing };
  }
  return { source: 'default', missing };
}

/** Окружение запуска CLI движка под аккаунтом: одна переменная каталога. */
export function cliAccountEnv(engine: CliAccountEngine, account: Pick<ClaudeAccountProfile, 'configDir'>): Record<string, string> {
  return { [CLI_ACCOUNT_ENV_VAR[engine]]: account.configDir };
}

/** Новый id профиля: короткий, пригоден как имя каталога, не совпадает с занятыми. */
export function newClaudeAccountId(existingIds: Iterable<string>, now = Date.now(), random = Math.random): string {
  const taken = new Set(existingIds);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `a-${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!taken.has(id) && isValidClaudeAccountId(id)) return id;
  }
  throw new AppError('accounts.noFreeId');
}

/** Имя профиля в параметре ошибки: встроенное имя профиля по умолчанию окно и телефон показывают на своём языке. */
function accountNameParam(account: ClaudeAccountProfile): AppErrorParam {
  return account.id === DEFAULT_CLAUDE_ACCOUNT_ID && account.name === DEFAULT_CLAUDE_ACCOUNT_NAME ? { code: 'accounts.defaultName' } : account.name;
}

/** Ошибка проверки имени профиля или `null`. Имена уникальны без учёта регистра. */
export function validateClaudeAccountName(name: unknown, accounts: ClaudeAccountProfile[], selfId?: string): AppError | null {
  const clean = cleanName(name);
  if (!clean) return new AppError('accounts.nameEmpty');
  const lower = clean.toLowerCase();
  if (accounts.some((account) => account.id !== selfId && account.name.toLowerCase() === lower)) {
    return new AppError('accounts.nameTaken', { name: clean });
  }
  return null;
}

export interface AddClaudeAccountInput {
  name: string;
  kind: ClaudeAccountKind;
  /** Для `external` — подключаемый каталог; для `managed` вычисляется из `homeDir`. */
  configDir?: string;
  /** Движок профиля; нет — Claude Code (decision-163). */
  engine?: CliAccountEngine;
}

/** Без пустого списка: файл прежнего вида остаётся прежним. */
function withEngineProfiles(settings: ClaudeAccountsSettings, engineProfiles: ClaudeAccountProfile[]): ClaudeAccountsSettings {
  const rest: ClaudeAccountsSettings = { ...settings };
  delete rest.engineProfiles;
  return engineProfiles.length ? { ...rest, engineProfiles } : rest;
}

/** Добавление профиля: возвращает новые настройки и профиль либо бросает с понятной причиной. */
export function addClaudeAccount(
  settings: ClaudeAccountsSettings,
  input: AddClaudeAccountInput,
  ctx: { homeDir: string; platform: NodeJS.Platform; now?: Date; id?: string }
): { settings: ClaudeAccountsSettings; account: ClaudeAccountProfile } {
  const engine = input.engine ?? 'claude-cli';
  // Имена уникальны внутри движка, id и каталоги — среди всех профилей.
  const nameError = validateClaudeAccountName(input.name, sameEngineAccounts(settings, engine, ctx.homeDir));
  if (nameError) throw nameError;
  const accounts = listAllAccounts(settings, ctx.homeDir);

  const id = ctx.id ?? newClaudeAccountId(accounts.map((a) => a.id));
  if (!isValidClaudeAccountId(id) || accounts.some((a) => a.id === id)) throw new AppError('accounts.invalidId', { id });

  let configDir: string;
  if (input.kind === 'external') {
    const dir = input.configDir?.trim();
    if (!dir || !path.isAbsolute(dir)) throw new AppError('accounts.dirNotAbsolute');
    configDir = path.normalize(dir);
  } else {
    configDir = managedCliAccountDir(ctx.homeDir, engine, id);
  }
  const duplicate = accounts.find((a) => sameDir(a.configDir, configDir, ctx.platform));
  if (duplicate) throw new AppError('accounts.dirAlreadyConnected', { name: accountNameParam(duplicate) });

  const account: ClaudeAccountProfile = {
    id,
    name: cleanName(input.name) as string,
    kind: input.kind,
    configDir,
    ...(engine !== 'claude-cli' ? { engine } : {}),
    createdAt: (ctx.now ?? new Date()).toISOString()
  };
  if (engine === 'claude-cli') return { settings: { ...settings, profiles: [...settings.profiles, account] }, account };
  return { settings: withEngineProfiles(settings, [...(settings.engineProfiles ?? []), account]), account };
}

export function renameClaudeAccount(
  settings: ClaudeAccountsSettings,
  id: string,
  name: string,
  homeDir: string
): ClaudeAccountsSettings {
  const target = listAllAccounts(settings, homeDir).find((a) => a.id === id);
  if (!target) throw new AppError('accounts.profileNotFound');
  const nameError = validateClaudeAccountName(name, sameEngineAccounts(settings, accountEngine(target), homeDir), id);
  if (nameError) throw nameError;
  const clean = cleanName(name) as string;
  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return { ...settings, defaultName: clean };
  const rename = (p: ClaudeAccountProfile) => (p.id === id ? { ...p, name: clean } : p);
  if (target.engine) return withEngineProfiles(settings, (settings.engineProfiles ?? []).map(rename));
  return { ...settings, profiles: settings.profiles.map(rename) };
}

/** Удаление профиля любого движка вместе с привязками ролей к нему. Профиль по умолчанию не удаляется. */
export function removeClaudeAccount(
  settings: ClaudeAccountsSettings,
  id: string
): { settings: ClaudeAccountsSettings; removed: ClaudeAccountProfile } {
  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) throw new AppError('accounts.defaultNotRemovable');
  const removed = [...settings.profiles, ...(settings.engineProfiles ?? [])].find((p) => p.id === id);
  if (!removed) throw new AppError('accounts.profileNotFound');
  const roleAccounts = Object.fromEntries(Object.entries(settings.roleAccounts).filter(([, accountId]) => accountId !== id));
  const next = withEngineProfiles(settings, (settings.engineProfiles ?? []).filter((p) => p.id !== id));
  return { settings: { ...next, profiles: settings.profiles.filter((p) => p.id !== id), roleAccounts }, removed };
}

/** Привязка роли к профилю на машине; `null` или профиль по умолчанию без явного выбора — снять. */
export function setRoleClaudeAccount(
  settings: ClaudeAccountsSettings,
  roleSlug: string,
  accountId: string | null,
  homeDir: string
): ClaudeAccountsSettings {
  const slug = roleSlug.trim();
  if (!slug) throw new AppError('accounts.roleEmpty');
  const roleAccounts = { ...settings.roleAccounts };
  if (!accountId) {
    delete roleAccounts[slug];
  } else {
    if (!listAllAccounts(settings, homeDir).some((a) => a.id === accountId)) throw new AppError('accounts.profileNotFound');
    roleAccounts[slug] = accountId;
  }
  return { ...settings, roleAccounts };
}

// --- Статус входа -----------------------------------------------------------------------------

export interface ClaudeAccountAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  /** Каталог, который CLI считает своим: должен совпасть с каталогом профиля. */
  configDirectory?: string;
  /** Статус не получен (CLI не запустился, не ответил, ответ не JSON). Английский текст или текст самого CLI. */
  error?: string;
  /** Код ошибки статуса для окна (decision-165); без него `error` — первая строка ответа CLI. */
  errorKey?: AppErrorKey;
  /** CLI не умеет сообщать статус входа без запуска сессии (Gemini CLI): вход проверяется в терминале. */
  unsupported?: boolean;
  checkedAt: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Разбор `claude auth status --json` (Claude Code 2.1.302): без входа — `loggedIn: false` и код 1.
 * Секретов в выводе нет; сохраняются только перечисленные поля.
 */
export function parseClaudeAuthStatus(stdout: string, code: number | null, checkedAt = Date.now()): ClaudeAccountAuthStatus {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof data.loggedIn === 'boolean') {
        const status: ClaudeAccountAuthStatus = { loggedIn: data.loggedIn, checkedAt };
        const fields = ['authMethod', 'email', 'orgName', 'subscriptionType', 'configDirectory'] as const;
        for (const field of fields) {
          const value = optionalString(data[field]);
          if (value && !(field === 'authMethod' && value === 'none')) status[field] = value;
        }
        return status;
      }
    } catch {
      // ниже — как неизвестный ответ
    }
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (firstLine) return { loggedIn: false, error: firstLine.slice(0, 200), checkedAt };
  return authStatusFailure(new AppError('accounts.statusExitCode', { command: 'claude auth status', code: code ?? '?' }), checkedAt);
}

/** Статус не получен по причине ProjectHub, а не по ответу CLI: английский текст и код для окна. */
export function authStatusFailure(err: AppError, checkedAt = Date.now()): ClaudeAccountAuthStatus {
  return { loggedIn: false, error: err.message, errorKey: err.appErrorKey, checkedAt };
}

/**
 * Разбор `codex login status` (decision-163): «Logged in using ChatGPT», «Logged in using an API key - sk-…»,
 * «Not logged in». Хвост с маской ключа не сохраняется. Синтаксис по документации Codex CLI, вживую не проверен —
 * Codex у владельца не оплачен; незнакомый ответ становится ошибкой статуса, а не входом.
 */
export function parseCodexLoginStatus(output: string, code: number | null, checkedAt = Date.now()): ClaudeAccountAuthStatus {
  const text = output.trim();
  const loggedIn = /logged in using\s+(chatgpt|an api key|api key)/i.exec(text);
  if (loggedIn) return { loggedIn: true, authMethod: /chatgpt/i.test(loggedIn[1]) ? 'chatgpt' : 'api-key', checkedAt };
  if (/not logged in/i.test(text)) return { loggedIn: false, checkedAt };
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (firstLine) return { loggedIn: false, error: firstLine.slice(0, 200), checkedAt };
  return authStatusFailure(new AppError('accounts.statusExitCode', { command: 'codex login status', code: code ?? '?' }), checkedAt);
}

/**
 * Профили, которые видят один и тот же вход (e-mail и организация). На macOS это признак общего
 * Keychain (decision-87 п. 12); на других ОС — просто два каталога с одним аккаунтом.
 */
export function findSharedLoginGroups(statuses: Array<{ id: string; status: ClaudeAccountAuthStatus | undefined }>): string[][] {
  const groups = new Map<string, string[]>();
  for (const { id, status } of statuses) {
    if (!status?.loggedIn || !status.email) continue;
    const key = `${status.email.toLowerCase()}|${(status.orgName ?? '').toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

/** Каталог из переменной процесса совпадает с одним из профилей — тогда предупреждать не о чем. */
export function findAccountByConfigDir(
  accounts: ClaudeAccountProfile[],
  dir: string | undefined,
  platform: NodeJS.Platform
): ClaudeAccountProfile | undefined {
  const value = dir?.trim();
  if (!value) return undefined;
  return accounts.find((account) => sameDir(account.configDir, value, platform));
}
