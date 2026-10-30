import type { BrowserWindow } from 'electron';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  /** Главное окно и окна проектов (TASK-295): события рабочей области проекта идут во все. */
  getAppWindows: () => BrowserWindow[];
  /** Родитель диалога файла: окно приложения в фокусе, иначе главное. */
  getDialogWindow: () => BrowserWindow | null;
  getVoiceOverlayWindow: () => BrowserWindow | null;
  createVoiceOverlayWindow: () => BrowserWindow;
}
