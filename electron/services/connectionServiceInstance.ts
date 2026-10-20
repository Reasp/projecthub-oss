import { shell } from 'electron';
import { ConnectionService } from './connectionService';
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
  openExternal: async (url) => {
    // Только http(s), как и `shell:openExternal` в mcpIpc.
    if (!/^https?:\/\//i.test(url)) throw new Error('Разрешены только адреса http(s)');
    await shell.openExternal(url);
  }
});
