import { ipcMain, dialog } from 'electron';
import { claudeAccountService } from '../services/claudeAccountService';
import { CLI_ACCOUNT_ENV_VAR, isOtherCliAccountEngine, type CliAccountEngine } from '../services/claudeAccounts';
import { assertRegisteredProject } from '../services/projectPathGuard';
import type { IpcContext } from './types';

/** Движок из рендерера: неизвестное значение — Claude Code, как до decision-163. */
function engineOf(value: unknown): CliAccountEngine {
  return isOtherCliAccountEngine(value) ? value : 'claude-cli';
}

const ENGINE_TITLE: Record<CliAccountEngine, string> = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex CLI', 'gemini-cli': 'Gemini CLI' };

/**
 * Профили аккаунтов Claude Code (TASK-152, decision-87). Каталог внешнего профиля рендерер не
 * передаёт: его выбирают в системном диалоге main-процесса или берут из `CLAUDE_CONFIG_DIR` процесса.
 */
export function registerClaudeAccountsIpc(ctx: IpcContext) {
  ipcMain.handle('claudeAccounts:overview', () => claudeAccountService.overview());

  ipcMain.handle('claudeAccounts:statuses', (_event, force?: boolean) => claudeAccountService.allAuthStatuses(force === true));

  ipcMain.handle('claudeAccounts:status', (_event, id: string, force?: boolean) =>
    claudeAccountService.authStatus(String(id), force === true)
  );

  ipcMain.handle('claudeAccounts:create', (_event, name: string, engine?: string) =>
    claudeAccountService.createManaged(String(name ?? ''), engineOf(engine))
  );

  ipcMain.handle('claudeAccounts:connectExternal', async (_event, input: { name?: string; source?: 'dialog' | 'processEnv'; engine?: string }) => {
    const name = String(input?.name ?? '');
    const engine = engineOf(input?.engine);
    if (input?.source === 'processEnv') {
      if (engine !== 'claude-cli') throw new Error('Из переменной процесса подключается только каталог Claude Code.');
      const { processConfigDir } = await claudeAccountService.overview();
      if (!processConfigDir) throw new Error('ProjectHub запущен без переменной CLAUDE_CONFIG_DIR.');
      return claudeAccountService.connectExternal(name, processConfigDir);
    }
    const win = ctx.getMainWindow();
    const options = {
      properties: ['openDirectory' as const, 'showHiddenFiles' as const],
      title: `${ENGINE_TITLE[engine]}: ${CLI_ACCOUNT_ENV_VAR[engine]}`
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return claudeAccountService.connectExternal(name, result.filePaths[0], engine);
  });

  ipcMain.handle('claudeAccounts:rename', (_event, id: string, name: string) => claudeAccountService.rename(String(id), String(name ?? '')));

  ipcMain.handle('claudeAccounts:remove', (_event, id: string) => claudeAccountService.remove(String(id)));

  ipcMain.handle('claudeAccounts:logout', (_event, id: string) => claudeAccountService.logout(String(id)));

  ipcMain.handle('claudeAccounts:forProject', async (_event, projectPath: string) => {
    const resolution = await claudeAccountService.resolve({ projectPath: String(projectPath ?? '') });
    return { account: resolution.account, source: resolution.source };
  });

  ipcMain.handle('claudeAccounts:setProject', async (_event, projectPath: string, accountId: string | null) => {
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    return claudeAccountService.setProjectAccount(root, accountId ? String(accountId) : null);
  });

  ipcMain.handle('claudeAccounts:setProjectEngine', async (_event, projectPath: string, engine: string, accountId: string | null) => {
    if (!isOtherCliAccountEngine(engine)) throw new Error(`Unknown CLI engine: ${String(engine)}`);
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    return claudeAccountService.setProjectEngineAccount(root, engine, accountId ? String(accountId) : null);
  });

  ipcMain.handle('claudeAccounts:projectEngines', async (_event, projectPath: string) => {
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    return {
      'codex-cli': (await claudeAccountService.projectEngineAccountId('codex-cli', root)) ?? null,
      'gemini-cli': (await claudeAccountService.projectEngineAccountId('gemini-cli', root)) ?? null
    };
  });

  ipcMain.handle('claudeAccounts:setRole', (_event, roleSlug: string, accountId: string | null) =>
    claudeAccountService.setRoleAccount(String(roleSlug ?? ''), accountId ? String(accountId) : null)
  );
}
