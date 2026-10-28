import { app, dialog, ipcMain } from 'electron';
import { PROFILE_FILE_EXTENSION, profileSectionList as sectionList } from '../services/profileFormat';
import { cloneProfileProject, profileService, setProfileAppVersion, type ProfileHostCall } from '../services/profileService';
import { federationClientService } from '../services/federationClientService';
import { getHostLanguage } from '../services/hostLanguage';
import { hostText } from '../i18n/hostText';
import type { IpcContext } from './types';

/**
 * IPC переноса профиля (TASK-224, decision-175): экспорт в файл, предпросмотр и применение импорта, клонирование
 * проекта из профиля. Пароль идёт в main и никуда не сохраняется; файл выбирает человек системным диалогом.
 * Домашний хост (TASK-225) — сопряжённый ПК федерации: права проверяет он сам по токену этого ПК.
 */

function hostCall(hostId: string): ProfileHostCall {
  return (method, params) => federationClientService.call(hostId, method, params);
}

export function registerProfileIpc(ctx: IpcContext) {
  setProfileAppVersion(app.getVersion());

  ipcMain.handle('profile:export', async (_event, password: unknown, sections?: unknown) => {
    if (typeof password !== 'string') return { canceled: true };
    const tx = hostText(getHostLanguage()).dialogs;
    const win = ctx.getMainWindow();
    const options = {
      title: tx.exportProfile,
      defaultPath: `projecthub-profile-${new Date().toISOString().slice(0, 10)}.${PROFILE_FILE_EXTENSION}`,
      filters: [{ name: 'ProjectHub profile', extensions: [PROFILE_FILE_EXTENSION] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };
    const done = await profileService.exportToFile(result.filePath, password, sectionList(sections));
    return { canceled: false, filePath: result.filePath, sections: done.sections };
  });

  ipcMain.handle('profile:chooseFile', async () => {
    const tx = hostText(getHostLanguage()).dialogs;
    const win = ctx.getMainWindow();
    const options = {
      title: tx.importProfile,
      properties: ['openFile' as const],
      filters: [{ name: 'ProjectHub profile', extensions: [PROFILE_FILE_EXTENSION] }]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('profile:preview', async (_event, filePath: unknown, password: unknown) => {
    if (typeof filePath !== 'string' || typeof password !== 'string') return null;
    return profileService.previewFile(filePath, password);
  });

  ipcMain.handle('profile:apply', async (_event, token: unknown, sections: unknown) => {
    if (typeof token !== 'string') return { applied: [] };
    return profileService.apply(token, sectionList(sections));
  });

  ipcMain.handle('profile:previewFromHost', async (_event, hostId: unknown, sections: unknown) => {
    if (typeof hostId !== 'string' || !hostId) return null;
    return profileService.previewFromHost(hostCall(hostId), sectionList(sections));
  });

  ipcMain.handle('profile:previewOnHost', async (_event, hostId: unknown, sections: unknown) => {
    if (typeof hostId !== 'string' || !hostId) return null;
    return profileService.previewOnHost(hostCall(hostId), sectionList(sections));
  });

  ipcMain.handle('profile:applyOnHost', async (_event, hostId: unknown, token: unknown, sections: unknown) => {
    if (typeof hostId !== 'string' || !hostId || typeof token !== 'string') return { applied: [] };
    return profileService.applyOnHost(hostCall(hostId), token, sectionList(sections));
  });

  ipcMain.handle('profile:cloneProject', async (_event, remote: unknown, name: unknown) => {
    if (typeof remote !== 'string') return null;
    const tx = hostText(getHostLanguage()).dialogs;
    const win = ctx.getMainWindow();
    const options = { title: tx.cloneProjectInto, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return cloneProfileProject(remote, result.filePaths[0], typeof name === 'string' ? name : '');
  });

  ipcMain.handle('profile:relaunch', () => {
    app.relaunch();
    app.quit();
  });
}
