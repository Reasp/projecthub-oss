import path from 'node:path';

/**
 * Профили аккаунтов Claude Code (TASK-152, decision-87). Чистый модуль без Electron: формат файла
 * `<userData>/claude-accounts.json`, резолвер аккаунта запуска и разбор `claude auth status`.
 *
 * Профиль — это каталог `CLAUDE_CONFIG_DIR`. Секретов модуль не видит и не хранит: вход лежит в
 * каталоге (или в Keychain на macOS) и проверяется только командой CLI.
 */

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default';
export const DEFAULT_CLAUDE_ACCOUNT_NAME = 'По умолчанию';
export const CLAUDE_ACCOUNTS_VERSION = 1;
export const CLAUDE_ACCOUNT_NAME_MAX_LENGTH = 40;

/** `managed` — каталог ProjectHub; `external` — подключённый существующий каталог (например, из Rider). */
export type ClaudeAccountKind = 'managed' | 'external';

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  kind: ClaudeAccountKind;
  /** Абсолютный путь — значение `CLAUDE_CONFIG_DIR`. */
  configDir: string;
  createdAt?: string;
}

/** Содержимое `claude-accounts.json`. Профиль по умолчанию в списке не хранится — только его имя. */
export interface ClaudeAccountsSettings {
  version: number;
  defaultName?: string;
  profiles: ClaudeAccountProfile[];
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
  for (const item of Array.isArray(input.profiles) ? input.profiles : []) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    const name = cleanName(entry.name);
    const configDir = typeof entry.configDir === 'string' ? entry.configDir.trim() : '';
    const kind: ClaudeAccountKind | null = entry.kind === 'managed' || entry.kind === 'external' ? entry.kind : null;
    if (!isValidClaudeAccountId(id) || seen.has(id) || !name || !kind || !configDir || !path.isAbsolute(configDir)) continue;
    seen.add(id);
    result.profiles.push({
      id,
      name,
      kind,
      configDir: path.normalize(configDir),
      ...(typeof entry.createdAt === 'string' && entry.createdAt ? { createdAt: entry.createdAt } : {})
    });
  }

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
  if (!fallback) throw new Error('Список аккаунтов Claude Code пуст: нет даже профиля по умолчанию.');

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

/** Новый id профиля: короткий, пригоден как имя каталога, не совпадает с занятыми. */
export function newClaudeAccountId(existingIds: Iterable<string>, now = Date.now(), random = Math.random): string {
  const taken = new Set(existingIds);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `a-${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!taken.has(id) && isValidClaudeAccountId(id)) return id;
  }
  throw new Error('Не удалось подобрать свободный id профиля аккаунта.');
}

/** Ошибка проверки имени профиля или `null`. Имена уникальны без учёта регистра. */
export function validateClaudeAccountName(name: unknown, accounts: ClaudeAccountProfile[], selfId?: string): string | null {
  const clean = cleanName(name);
  if (!clean) return 'Имя профиля не задано.';
  const lower = clean.toLowerCase();
  if (accounts.some((account) => account.id !== selfId && account.name.toLowerCase() === lower)) {
    return `Профиль с именем «${clean}» уже есть.`;
  }
  return null;
}

export interface AddClaudeAccountInput {
  name: string;
  kind: ClaudeAccountKind;
  /** Для `external` — подключаемый каталог; для `managed` вычисляется из `homeDir`. */
  configDir?: string;
}

/** Добавление профиля: возвращает новые настройки и профиль либо бросает с понятной причиной. */
export function addClaudeAccount(
  settings: ClaudeAccountsSettings,
  input: AddClaudeAccountInput,
  ctx: { homeDir: string; platform: NodeJS.Platform; now?: Date; id?: string }
): { settings: ClaudeAccountsSettings; account: ClaudeAccountProfile } {
  const accounts = listClaudeAccounts(settings, ctx.homeDir);
  const nameError = validateClaudeAccountName(input.name, accounts);
  if (nameError) throw new Error(nameError);

  const id = ctx.id ?? newClaudeAccountId(accounts.map((a) => a.id));
  if (!isValidClaudeAccountId(id) || accounts.some((a) => a.id === id)) throw new Error(`Некорректный id профиля: ${id}`);

  let configDir: string;
  if (input.kind === 'external') {
    const dir = input.configDir?.trim();
    if (!dir || !path.isAbsolute(dir)) throw new Error('Укажите абсолютный путь к каталогу конфигурации Claude Code.');
    configDir = path.normalize(dir);
  } else {
    configDir = managedClaudeConfigDir(ctx.homeDir, id);
  }
  const duplicate = accounts.find((a) => sameDir(a.configDir, configDir, ctx.platform));
  if (duplicate) throw new Error(`Этот каталог уже подключён как профиль «${duplicate.name}».`);

  const account: ClaudeAccountProfile = {
    id,
    name: cleanName(input.name) as string,
    kind: input.kind,
    configDir,
    createdAt: (ctx.now ?? new Date()).toISOString()
  };
  return { settings: { ...settings, profiles: [...settings.profiles, account] }, account };
}

export function renameClaudeAccount(
  settings: ClaudeAccountsSettings,
  id: string,
  name: string,
  homeDir: string
): ClaudeAccountsSettings {
  const accounts = listClaudeAccounts(settings, homeDir);
  if (!accounts.some((a) => a.id === id)) throw new Error('Профиль не найден.');
  const nameError = validateClaudeAccountName(name, accounts, id);
  if (nameError) throw new Error(nameError);
  const clean = cleanName(name) as string;
  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return { ...settings, defaultName: clean };
  return { ...settings, profiles: settings.profiles.map((p) => (p.id === id ? { ...p, name: clean } : p)) };
}

/** Удаление профиля вместе с привязками ролей к нему. Профиль по умолчанию не удаляется. */
export function removeClaudeAccount(
  settings: ClaudeAccountsSettings,
  id: string
): { settings: ClaudeAccountsSettings; removed: ClaudeAccountProfile } {
  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) throw new Error('Профиль по умолчанию удалить нельзя.');
  const removed = settings.profiles.find((p) => p.id === id);
  if (!removed) throw new Error('Профиль не найден.');
  const roleAccounts = Object.fromEntries(Object.entries(settings.roleAccounts).filter(([, accountId]) => accountId !== id));
  return { settings: { ...settings, profiles: settings.profiles.filter((p) => p.id !== id), roleAccounts }, removed };
}

/** Привязка роли к профилю на машине; `null` или профиль по умолчанию без явного выбора — снять. */
export function setRoleClaudeAccount(
  settings: ClaudeAccountsSettings,
  roleSlug: string,
  accountId: string | null,
  homeDir: string
): ClaudeAccountsSettings {
  const slug = roleSlug.trim();
  if (!slug) throw new Error('Роль не задана.');
  const roleAccounts = { ...settings.roleAccounts };
  if (!accountId) {
    delete roleAccounts[slug];
  } else {
    if (!listClaudeAccounts(settings, homeDir).some((a) => a.id === accountId)) throw new Error('Профиль не найден.');
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
  /** Статус не получен (CLI не запустился, не ответил, ответ не JSON). */
  error?: string;
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
  return {
    loggedIn: false,
    error: firstLine ? firstLine.slice(0, 200) : `claude auth status: код выхода ${code ?? 'нет'}`,
    checkedAt
  };
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
