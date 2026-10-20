import { PRService } from './prService';
import { connectionService } from './connectionServiceInstance';
import { getStatePath } from './appPaths';

/** Боевой экземпляр PR-интеграции (TASK-138.2, decision-105): подключения decision-102, затем GitHub CLI. */
export const prService = new PRService({
  connections: {
    list: async () =>
      (await connectionService.list()).map((c) => ({ id: c.id, serviceId: c.serviceId, label: c.label, baseUrl: c.baseUrl, status: c.status })),
    authorizedFetch: (connectionId, target, init) => connectionService.authorizedFetch(connectionId, target, init),
    addWithToken: (input) => connectionService.addWithToken(input)
  },
  statePath: () => getStatePath('pr-hosting.json'),
  // Лог GitHub Actions: API отвечает переходом на подписанный адрес хранилища, токен туда не уходит (TASK-138.3).
  download: (url) => fetch(url)
});

// Окно «Подключения» показывает, для PR каких репозиториев используется подключение.
connectionService.registerUsageProvider(() => prService.usages());
