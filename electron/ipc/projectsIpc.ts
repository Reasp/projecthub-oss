import { ipcMain, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import type { ProjectInfo, ScanOptions } from '../../src/types/electron';
import { projectRegistry } from '../services/projectRegistry';
import {
  INSPECT_CONCURRENCY,
  inspectProject,
  invalidateInspectCache,
  mapWithConcurrency,
  scanDirectories
} from '../services/projectScanner';
import { gitService } from '../services/gitService';
import { checkTemplateAvailable } from '../services/templateWizard';
import type { IpcContext } from './types';

export function registerProjectsIpc(ctx: IpcContext) {
  // 1. List registered projects with fresh metadata
  ipcMain.handle('projects:list', async () => {
    const registered = await projectRegistry.getProjects();
    const inspected = await mapWithConcurrency(registered, INSPECT_CONCURRENCY, (entry) =>
      inspectProject(entry.path, { useCache: true })
    );

    const results: ProjectInfo[] = [];
    registered.forEach((entry, i) => {
      const details = inspected[i];
      if (details) {
        details.favorite = Boolean(entry.favorite);
        details.addedAt = entry.addedAt;
        results.push(details);
      }
    });

    return results;
  });

  // 2. Scan directories and auto-register discovered projects
  ipcMain.handle('projects:scan', async (_event, options?: ScanOptions) => {
    const roots = options?.roots && options.roots.length > 0
      ? options.roots
      : await projectRegistry.getScanRoots();

    const depth = options?.depth ?? 2;
    return await scanDirectories(roots, depth);
  });

  // 3. Add project by path manually
  ipcMain.handle('projects:add', async (_event, folderPath: string) => {
    const details = await inspectProject(folderPath);
    if (!details) {
      return null;
    }
    await projectRegistry.addProject(details.path, false);
    return details;
  });

  // 4. Remove project from registry
  ipcMain.handle('projects:remove', async (_event, projectPath: string) => {
    gitService.unwatchProjectGit(projectPath);
    invalidateInspectCache(projectPath);
    return await projectRegistry.removeProject(projectPath);
  });

  // 5. Refresh single project
  ipcMain.handle('projects:refresh', async (_event, projectPath: string) => {
    return await inspectProject(projectPath);
  });

  // 6. Toggle Favorite status
  ipcMain.handle('projects:toggleFavorite', async (_event, projectPath: string) => {
    return await projectRegistry.toggleFavorite(projectPath);
  });

  // 6.1 Set Voice Alias
  ipcMain.handle('projects:setVoiceAlias', async (_event, { projectPath, alias }: { projectPath: string; alias: string }) => {
    return await projectRegistry.setVoiceAlias(projectPath, alias);
  });

  // 7. Get/Set Scan Roots
  ipcMain.handle('projects:getScanRoots', async () => {
    return await projectRegistry.getScanRoots();
  });

  ipcMain.handle('projects:setScanRoots', async (_event, roots: string[]) => {
    return await projectRegistry.setScanRoots(roots);
  });

  ipcMain.handle('projects:getDetails', async (_event, projectPath: string) => {
    return await inspectProject(projectPath);
  });

  // Dialog: Select Directory
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = ctx.getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Выберите папку проекта с Backlog.md или репозиторием'
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // System open actions
  ipcMain.handle('system:openInExplorer', async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });

  /**
   * Открыть путь в VS Code. Раньше команда запускалась «вслепую»: без `code` в PATH кнопка молча
   * ничего не делала. Теперь результат возвращается в UI, а на macOS при отсутствии `code`
   * VS Code открывается как приложение (`open -a`), без установки shell-команды (decision-73).
   */
  const runDetached = (cmd: string, args: string[], shell: boolean) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false;
      const done = (result: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawn(cmd, args, { shell, detached: true, stdio: 'ignore' });
        child.on('error', (err) => done({ ok: false, error: err.message }));
        // `code` и `open` передают путь уже запущенному приложению и быстро выходят; код 127 — команды нет
        child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `exit code ${code}` }));
        setTimeout(() => {
          child.unref();
          done({ ok: true });
        }, 3000);
      } catch (err) {
        done({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

  ipcMain.handle('system:openInCode', async (_event, targetPath: string) => {
    const isWin = process.platform === 'win32';
    const result = await runDetached(isWin ? 'code.cmd' : 'code', [`"${targetPath.replace(/"/g, '\\"')}"`], true);
    if (result.ok || process.platform !== 'darwin') return result;
    return runDetached('open', ['-a', 'Visual Studio Code', targetPath], false);
  });

  ipcMain.handle('system:openTerminal', async (_event, targetPath: string) => {
    const isWin = process.platform === 'win32';
    if (isWin) {
      spawn('cmd.exe', ['/c', 'start', 'powershell.exe'], { cwd: targetPath, shell: true, detached: true });
    } else {
      spawn('open', ['-a', 'Terminal', targetPath], { detached: true });
    }
  });

  ipcMain.handle('system:getPlatform', async () => {
    return process.platform;
  });

  // Путь шаблона: переопределение встроенного (decision-78, п. 7). Создание проекта — init:* (initIpc.ts).
  ipcMain.handle('template:checkAvailable', async (_event, customSource?: string) => {
    return await checkTemplateAvailable(customSource);
  });

  ipcMain.handle('template:setPath', async (_event, templatePath: string | null) => {
    if (templatePath !== null && typeof templatePath !== 'string') return false;
    return await projectRegistry.setTemplatePath(templatePath);
  });
}
