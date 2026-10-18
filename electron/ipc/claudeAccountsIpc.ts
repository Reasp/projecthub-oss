import { ipcMain, dialog } from 'electron';
import { claudeAccountService } from '../services/claudeAccountService';
import { assertRegisteredProject } from '../services/projectPathGuard';
import type { IpcContext } from './types';

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

  ipcMain.handle('claudeAccounts:create', (_event, name: string) => claudeAccountService.createManaged(String(name ?? '')));

  ipcMain.handle('claudeAccounts:connectExternal', async (_event, input: { name?: string; source?: 'dialog' | 'processEnv' }) => {
    const name = String(input?.name ?? '');
    if (input?.source === 'processEnv') {
      const { processConfigDir } = await claudeAccountService.overview();
      if (!processConfigDir) throw new Error('ProjectHub запущен без переменной CLAUDE_CONFIG_DIR.');
      return claudeAccountService.connectExternal(name, processConfigDir);
    }
    const win = ctx.getMainWindow();
    const options = {
      properties: ['openDirectory' as const, 'showHiddenFiles' as const],
      title: 'Каталог конфигурации Claude Code (значение CLAUDE_CONFIG_DIR)'
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return claudeAccountService.connectExternal(name, result.filePaths[0]);
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

  ipcMain.handle('claudeAccounts:setRole', (_event, roleSlug: string, accountId: string | null) =>
    claudeAccountService.setRoleAccount(String(roleSlug ?? ''), accountId ? String(accountId) : null)
  );
}
