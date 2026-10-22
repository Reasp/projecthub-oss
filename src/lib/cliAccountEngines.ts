import type { ClaudeAccountView, ClaudeAccountsOverview, CliAccountEngine, OtherCliAccountEngine } from '../types/electron';

/**
 * Аккаунты CLI-движков в интерфейсе (TASK-152.6, decision-163): имя CLI, переменная каталога и профили движка.
 * Имена CLI — названия продуктов, не переводятся.
 */

export const OTHER_CLI_ACCOUNT_ENGINES: readonly OtherCliAccountEngine[] = ['codex-cli', 'gemini-cli'];

export const CLI_ENGINE_NAME: Record<CliAccountEngine, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI'
};

export const CLI_ENGINE_ENV: Record<CliAccountEngine, string> = {
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'codex-cli': 'CODEX_HOME',
  'gemini-cli': 'GEMINI_CLI_HOME'
};

export function isOtherCliAccountEngine(value: unknown): value is OtherCliAccountEngine {
  return value === 'codex-cli' || value === 'gemini-cli';
}

/** Движок профиля: без поля — Claude Code. */
export function accountEngineOf(account: Pick<ClaudeAccountView, 'engine'>): CliAccountEngine {
  return account.engine ?? 'claude-cli';
}

/** Профили движка для выбора в слоте, роли и проекте; у Claude Code — вместе с профилем по умолчанию. */
export function accountsForEngine(overview: Pick<ClaudeAccountsOverview, 'accounts' | 'engineAccounts'> | null | undefined, engine: CliAccountEngine): ClaudeAccountView[] {
  if (!overview) return [];
  if (engine === 'claude-cli') return overview.accounts;
  return (overview.engineAccounts ?? []).filter((a) => a.engine === engine);
}

/** Показывать ли выбор аккаунта: у Claude Code — когда профилей больше одного, у других — когда есть хоть один. */
export function hasAccountChoice(accounts: readonly ClaudeAccountView[], engine: CliAccountEngine): boolean {
  return engine === 'claude-cli' ? accounts.length > 1 : accounts.length > 0;
}
