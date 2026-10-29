import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppError } from '../../src/lib/appError';
import { getUserDataDir } from '../services/appPaths';
import { inspectUpdateFile, stageVerifiedInstaller, type UpdateCheckContext } from '../services/offlineUpdateService';
import { UPDATE_TRUSTED_KEYS } from '../services/updateTrustedKeys';
import { appendRemoteAudit } from '../services/remoteActionAudit';
import { getDiagnosticsInfo, collectDiagnosticsArchive } from '../services/diagnosticsService';
import { updaterService } from '../services/updaterService';

/** Экран «Диагностика» и проверка обновлений (TASK-58, decision-14 пп.2 и 4). */
export function registerDiagnosticsIpc() {
  ipcMain.handle('diagnostics:getInfo', async () => {
    return getDiagnosticsInfo();
  });

  ipcMain.handle('diagnostics:collectArchive', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Домашний каталог законно: это место сохранения архива по умолчанию в диалоге, а не состояние (TASK-165).
    const defaultPath = path.join(
      os.homedir(),
      `projecthub-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
    );
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] })
      : await dialog.showSaveDialog({ defaultPath, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    try {
      await collectDiagnosticsArchive(result.filePath);
      return { success: true, path: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('updater:getStatus', async () => {
    return updaterService.getStatus();
  });

  ipcMain.handle('updater:check', async () => {
    await updaterService.checkForUpdates();
    return updaterService.getStatus();
  });

  ipcMain.handle('updater:installNow', async () => {
    updaterService.installNow();
    return true;
  });

  // Обновление файлом (TASK-147.4, decision-189): путь берётся только из системного диалога main, окно его не передаёт.
  // Что человек подтвердил: путь, версия и хэш установщика. При установке манифест читается заново и обязан совпасть —
  // иначе его подменили в общей папке другим подписанным выпуском.
  let pendingUpdate: { path: string; version: string; sha256: string } | null = null;
  const updateContext = (): UpdateCheckContext => ({ trustedKeys: UPDATE_TRUSTED_KEYS, currentVersion: app.getVersion(), platform: process.platform, arch: process.arch });

  ipcMain.handle('updater:pickFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openFile' as const], filters: [{ name: 'ProjectHub update', extensions: ['json'] }] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    pendingUpdate = null;
    const update = await inspectUpdateFile(result.filePaths[0], updateContext());
    pendingUpdate = { path: update.manifestPath, version: update.manifest.version, sha256: update.manifest.sha256 };
    return { canceled: false, version: update.manifest.version, currentVersion: app.getVersion(), file: update.manifest.file, size: update.manifest.size };
  });

  ipcMain.handle('updater:installFile', async () => {
    if (!pendingUpdate) throw new AppError('update.noPending');
    // Проверка заново: файл в общей папке могли заменить, пока человек читал подтверждение.
    const update = await inspectUpdateFile(pendingUpdate.path, updateContext());
    if (update.manifest.version !== pendingUpdate.version || update.manifest.sha256 !== pendingUpdate.sha256) {
      pendingUpdate = null;
      throw new AppError('update.changedAfterCheck');
    }
    // Свой каталог на каждую установку: копия прошлого установщика может быть ещё занята его процессом.
    const staged = await stageVerifiedInstaller(update, path.join(getUserDataDir(), 'update-staging', `${update.manifest.version}-${Date.now()}`));
    void appendRemoteAudit({
      ts: Date.now(),
      method: 'install_update_file',
      ok: true,
      deviceId: 'local',
      actor: 'window',
      target: { version: update.manifest.version, sha256: update.manifest.sha256.slice(0, 16), keyId: update.manifest.keyId }
    });
    try {
      if (process.platform === 'darwin') {
        // Образ диска открывается системой, перенос в «Программы» делает человек.
        const err = await shell.openPath(staged);
        if (err) throw new Error(err);
        return { launched: true, quitting: false };
      }
      if (process.platform === 'linux') {
        // AppImage — это и есть установленное приложение: заменяем файл, из которого запущены, и перезапускаемся.
        const current = process.env.APPIMAGE;
        if (!current) throw new Error('ProjectHub is not running from an AppImage: replace the installed copy by hand');
        const next = `${current}.update`;
        await fs.copyFile(staged, next);
        await fs.chmod(next, 0o755);
        await fs.rename(next, current);
        app.relaunch();
        setTimeout(() => app.quit(), 500);
        return { launched: true, quitting: true };
      }
      // Ошибки ENOENT/EACCES spawn приходят событием, а не исключением: выходим только после настоящего запуска.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(staged, [], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    } catch (err) {
      throw new AppError('update.launchFailed', { detail: err instanceof Error ? err.message : String(err) });
    }
    // Установщик заменяет файлы приложения — оно должно выйти.
    setTimeout(() => app.quit(), 500);
    return { launched: true, quitting: true };
  });
}
