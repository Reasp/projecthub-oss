import { BrowserWindow, ipcMain, shell } from 'electron';
import { mcpServerService } from '../services/mcpServerService';
import { remoteControlService } from '../services/remoteControlService';
import { telegramService } from '../services/telegramService';
import { notificationService } from '../services/notificationService';
import { secretStorageService, SECRETS_FILE_NAME } from '../services/secretStorageService';
import { hitlService } from '../services/hitlService';
import type { DeviceRights } from '../../src/types/remote';

/** Секреты, которые хранит сам рендерер (ключ Whisper API в `voiceService`). */
const RENDERER_SECRET_KEYS = new Set(['whisperApiKey']);

function isOpenExternalAllowed(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function registerMcpIpc() {
  // Shell External Link Security Guard
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string' || !isOpenExternalAllowed(url)) {
      console.warn(`[Security] shell:openExternal rejected URL: ${String(url).slice(0, 200)}`);
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      console.error('[Security] shell.openExternal failed:', err);
      return false;
    }
  });

  // SafeStorage & Secret Encryption
  ipcMain.handle('secrets:isEncryptionAvailable', async () => {
    return secretStorageService.isEncryptionAvailable();
  });

  ipcMain.handle('secrets:encrypt', async (_event, text: string) => {
    return secretStorageService.encrypt(text);
  });

  ipcMain.handle('secrets:decrypt', async (_event, cipherText: string) => {
    return secretStorageService.decrypt(cipherText);
  });

  // Рендереру доступны только его собственные секреты: токены MCP, хуков и Remote Control ему не нужны
  // (decision-5 п. 4, decision-88 п. 6).
  ipcMain.handle('secrets:setSecret', async (_event, { key, value }: { key: string; value: string }) => {
    if (!RENDERER_SECRET_KEYS.has(key)) return false;
    await secretStorageService.setSecret(key, value);
    return true;
  });

  ipcMain.handle('secrets:getSecret', async (_event, key: string) => {
    if (!RENDERER_SECRET_KEYS.has(key)) return null;
    return await secretStorageService.getSecret(key);
  });

  ipcMain.handle('secrets:deleteSecret', async (_event, key: string) => {
    if (!RENDERER_SECRET_KEYS.has(key)) return false;
    return await secretStorageService.deleteSecret(key);
  });

  // Нерасшифрованные секреты (TASK-141): баннер в окне, резервная копия в userData.
  ipcMain.handle('secrets:getIssues', () => secretStorageService.getIssues());
  ipcMain.handle('secrets:acknowledgeIssues', () => secretStorageService.acknowledgeIssues());
  ipcMain.handle('secrets:showBackup', async () => {
    const { backupFile } = await secretStorageService.getIssues();
    shell.showItemInFolder(backupFile);
    return true;
  });
  // Восстановление из копии (TASK-154): рендерер видит только ключи и статусы и передаёт id записей.
  ipcMain.handle('secrets:getBackupPreview', () => secretStorageService.getBackupPreview());
  ipcMain.handle('secrets:restoreFromBackup', async (_event, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, 500) : [];
    const result = await secretStorageService.restoreFromBackup(list);
    // Аудит решения человека: имя ключа, без значения.
    for (const key of result.restored) {
      hitlService.recordHumanDecision(
        { sessionId: 'ui', projectPath: '', type: 'file_write', title: `Секрет восстановлен из резервной копии: ${key}`, tool: 'secret_restore', filePath: SECRETS_FILE_NAME },
        'allow',
        { kind: 'local' },
        'secret-restore'
      );
    }
    return result;
  });
  secretStorageService.onIssuesChanged((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('secrets:issuesChanged', state);
    }
  });

  // Built-in Remote MCP Server
  ipcMain.handle('mcp:getStatus', async () => {
    return mcpServerService.getStatus();
  });

  ipcMain.handle('mcp:toggleServer', async (_event, enable: boolean) => {
    if (enable) {
      await mcpServerService.start();
    } else {
      await mcpServerService.stop();
    }
    return mcpServerService.getStatus();
  });

  ipcMain.handle('mcp:regenerateToken', async () => {
    return mcpServerService.regenerateToken();
  });

  ipcMain.handle('mcp:setAppState', async (_event, state: { activeProject?: any; activeTab?: string }) => {
    mcpServerService.setAppState(state);
    return true;
  });

  // Remote Control (TASK-51)
  ipcMain.handle('remote:getStatus', async () => {
    return remoteControlService.getStatus();
  });

  ipcMain.handle('remote:toggle', async (_event, enable?: boolean) => {
    return await remoteControlService.toggle(enable);
  });

  ipcMain.handle('remote:updateConfig', async (_event, config) => {
    const status = await remoteControlService.updateConfig(config);
    // Токен/чат Telegram сменились — приводим демона бота к новому состоянию (TASK-63):
    // иначе он продолжал бы работать со старым токеном до перезапуска приложения.
    if (config && typeof config === 'object' && ('telegramBotToken' in config || 'telegramChatId' in config)) {
      await telegramService.stopBot();
      await telegramService.sync(notificationService.getSettings().telegramBotAutoStart);
    }
    return status;
  });

  ipcMain.handle('remote:regenerateToken', async () => {
    return remoteControlService.regenerateToken();
  });

  ipcMain.handle('remote:disconnectDevice', async (_event, deviceId: string) => {
    return remoteControlService.disconnectDevice(deviceId);
  });

  ipcMain.handle('remote:approveDevice', async (_event, deviceId: string) => {
    return remoteControlService.approveDevice(deviceId);
  });

  // Права конкретного устройства (TASK-65): уже, чем глобальный readOnly хоста.
  ipcMain.handle('remote:setDeviceRights', async (_event, deviceId: string, rights: DeviceRights) => {
    return remoteControlService.setDeviceRights(deviceId, rights);
  });

  ipcMain.handle('remote:revokeDevice', async (_event, deviceId: string) => {
    remoteControlService.revokeDeviceToken(deviceId);
    return remoteControlService.getStatus();
  });

  ipcMain.handle('remote:testTelegramNotification', async (_event, text?: string) => {
    return await remoteControlService.sendTelegramNotification(text || 'Тестовое уведомление от ProjectHub! 🚀');
  });

  ipcMain.handle('remote:startTunnel', async () => {
    return await remoteControlService.startTunnel();
  });

  ipcMain.handle('remote:stopTunnel', async () => {
    remoteControlService.stopTunnel();
    return remoteControlService.getStatus();
  });
}
