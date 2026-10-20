import { ipcMain } from 'electron';
import { connectionService } from '../services/connectionServiceInstance';
import type { ConnectionInput } from '../services/connectionTypes';
import type { IpcContext } from './types';

/**
 * Подключения к внешним сервисам (TASK-138.1, decision-102). Рендерер получает записи без секретов;
 * токен и `client_secret` передаются только в main и обратно не возвращаются.
 */

function toInput(raw: unknown): ConnectionInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const port = Number(o.redirectPort);
  return {
    serviceId: String(o.serviceId ?? ''),
    method: String(o.method ?? '') as ConnectionInput['method'],
    label: text(o.label),
    baseUrl: text(o.baseUrl),
    scopes: Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === 'string') : undefined,
    token: text(o.token),
    username: text(o.username),
    clientId: text(o.clientId),
    clientSecret: text(o.clientSecret),
    redirectPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  };
}

export function registerConnectionsIpc(ctx: IpcContext) {
  connectionService.onChanged((list) => ctx.getMainWindow()?.webContents.send('connections:changed', list));
  connectionService.onFlowChanged((flow) => ctx.getMainWindow()?.webContents.send('connections:flowChanged', flow));

  ipcMain.handle('connections:services', () => connectionService.services());
  ipcMain.handle('connections:list', () => connectionService.list());

  ipcMain.handle('connections:addToken', (_event, input: unknown, reconnectId?: string) =>
    connectionService.addWithToken(toInput(input), reconnectId ? String(reconnectId) : undefined)
  );
  ipcMain.handle('connections:startOAuth', (_event, input: unknown, reconnectId?: string) =>
    connectionService.startOAuth(toInput(input), reconnectId ? String(reconnectId) : undefined)
  );
  ipcMain.handle('connections:getFlow', (_event, flowId: string) => connectionService.getFlow(String(flowId)));
  ipcMain.handle('connections:cancelFlow', (_event, flowId: string) => connectionService.cancelFlow(String(flowId)));
  ipcMain.handle('connections:openFlowPage', (_event, flowId: string) => connectionService.openFlowPage(String(flowId)));

  ipcMain.handle('connections:check', (_event, id: string) => connectionService.check(String(id)));
  ipcMain.handle('connections:rename', (_event, id: string, label: string) => connectionService.rename(String(id), String(label ?? '')));
  ipcMain.handle('connections:remove', (_event, id: string) => connectionService.remove(String(id)));
}
