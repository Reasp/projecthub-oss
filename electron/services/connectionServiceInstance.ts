import { shell } from 'electron';
import { WebSocket } from 'ws';
import { ConnectionService, type ConnectionSocket } from './connectionService';
import { getUserDataDir } from './appPaths';
import { secretStorageService } from './secretStorageService';

/** Боевой экземпляр слоя подключений (TASK-138.1, decision-102): `userData`, `safeStorage`, системный браузер. */
export const connectionService = new ConnectionService({
  dir: () => getUserDataDir(),
  secrets: {
    get: (key) => secretStorageService.getSecret(key),
    set: (key, value) => secretStorageService.setSecret(key, value),
    delete: (key) => secretStorageService.deleteSecret(key)
  },
  fetch: (input, init) => fetch(input, init),
  // Исходящий WebSocket для кнопок рабочих чатов (TASK-138.6): адрес и заголовки собирает сервис подключений.
  openSocket: (url, headers): ConnectionSocket => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onOpen: (cb) => void ws.on('open', cb),
      onMessage: (cb) => void ws.on('message', (raw) => cb(raw.toString())),
      onClose: (cb) => {
        ws.on('close', (code, reason) => cb(code, reason.toString()));
        // Ошибка рукопожатия приходит событием `error`, за ним `close`; без обработчика процесс бы упал.
        ws.on('error', () => undefined);
      }
    };
  },
  openExternal: async (url) => {
    // Только http(s), как и `shell:openExternal` в mcpIpc.
    if (!/^https?:\/\//i.test(url)) throw new Error('Разрешены только адреса http(s)');
    await shell.openExternal(url);
  }
});
