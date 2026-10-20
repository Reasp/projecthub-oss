import { ipcMain } from 'electron';
import { chatService } from '../services/chatServiceInstance';
import type { ChatKind } from '../services/chatSubscriptions';

/** Подписки рабочих чатов (TASK-138.4, decision-110): список, сохранение, удаление, каналы для выбора, проверка. */
export function registerChatIpc() {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  ipcMain.handle('chat:list', () => chatService.list());
  ipcMain.handle('chat:save', (_event, raw: unknown) => chatService.save(raw));
  ipcMain.handle('chat:remove', (_event, id: string) => chatService.remove(str(id)));
  ipcMain.handle('chat:targets', (_event, kind: string, connectionId: string) => chatService.listTargets(str(kind) as ChatKind, str(connectionId)));
  ipcMain.handle('chat:test', (_event, id: string) => chatService.sendTest(str(id)));
}
