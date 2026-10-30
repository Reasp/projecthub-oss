import { ipcMain } from 'electron';
import { federationClientService } from '../services/federationClientService.js';
import { remoteControlService } from '../services/remoteControlService.js';
import type { PeerTransport } from '../services/federationProtocol.js';
import { deepLinkService } from '../services/deepLinkService.js';

/** Сколько ждать ответа хоста на вызов туннеля IPC. */
const TUNNEL_TIMEOUT_MS = 15 * 60_000;

/**
 * IPC hub-режима федерации (TASK-66, decision-11 п.4): список удалённых хостов, сопряжение с
 * ними и единый проброс RPC. Рендерер не открывает сокеты сам — всё через main, как и остальной
 * Remote Control.
 */
export function registerFederationIpc() {
  ipcMain.handle('federation:listPeers', async () => {
    return await federationClientService.listPeers();
  });

  ipcMain.handle(
    'federation:addPeer',
    async (
      _event,
      options: {
        hostId: string;
        machineName?: string;
        transport: PeerTransport;
        address: string;
        secretKey?: string;
        hostKey?: string;
        pin?: string;
        autoConnect?: boolean;
      }
    ) => {
      return await federationClientService.addPeer(options);
    }
  );

  ipcMain.handle('federation:removePeer', async (_event, hostId: string) => {
    await federationClientService.removePeer(hostId);
    return await federationClientService.listPeers();
  });

  ipcMain.handle('federation:connectPeer', async (_event, hostId: string) => {
    return await federationClientService.connectPeer(hostId);
  });

  ipcMain.handle('federation:disconnectPeer', async (_event, hostId: string) => {
    return await federationClientService.disconnectPeer(hostId);
  });

  /**
   * Проброс RPC на удалённый хост. Права проверяет он сам по токену нашего устройства —
   * здесь намеренно нет никакой «доверенной» ветки в обход его проверок.
   */
  ipcMain.handle('federation:call', async (_event, hostId: string, method: string, params?: Record<string, unknown>) => {
    return await federationClientService.call(hostId, method, params || {});
  });

  /**
   * Вызов IPC проекта другого ПК (TASK-280, decision-194): preload снял с путей префикс `phr://`, хост исполняет свой
   * обработчик канала и сам проверяет канал, права и пути. Таймаут длиннее обычного RPC: push, клон worktree, ответ модели.
   */
  ipcMain.handle('remote:ipcInvoke', async (_event, hostId: string, projectPath: string, channel: string, args: unknown[]) => {
    return await federationClientService.call(hostId, 'ipc_invoke', { projectPath, channel, args: Array.isArray(args) ? args : [] }, TUNNEL_TIMEOUT_MS);
  });

  /** Сводка флота этого ПК для раздела «Компьютеры» (TASK-174, decision-129): без сети, человек за ПК может всё. */
  ipcMain.handle('fleet:getLocalOverview', async () => {
    return await remoteControlService.getLocalOverview();
  });

  /** Ссылки `projecthub://`, пришедшие в приложение (decision-143 п. 4): рендерер забирает очередь целиком. */
  ipcMain.handle('deeplink:take', () => deepLinkService.take());

  /** Каталог хостов, известных локальному хосту (свой + пришедшие с релея/LAN). */
  ipcMain.handle('federation:getHosts', async () => {
    return remoteControlService.getFederationHostsList();
  });
}
