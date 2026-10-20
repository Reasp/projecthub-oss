import { TrackerSyncService } from './trackerSyncService';
import type { TrackerToolDeps } from './trackerSyncTools';
import { connectionService } from './connectionServiceInstance';
import { getUserDataDir } from './appPaths';
import { projectRegistry } from './projectRegistry';
import { hitlService } from './hitlService';

/** Боевой экземпляр синка трекеров (TASK-128, decision-103): подключения decision-102, реестр проектов, HITL. */
export const trackerSyncService = new TrackerSyncService({
  userDataDir: () => getUserDataDir(),
  authorizedFetch: (connectionId, target, init) => connectionService.authorizedFetch(connectionId, target, init),
  getConnection: async (connectionId) => {
    const found = (await connectionService.list()).find((c) => c.id === connectionId);
    return found ? { serviceId: found.serviceId, label: found.label } : null;
  },
  listProjectRoots: async () => (await projectRegistry.getProjects()).map((p) => p.path)
});

// Окно «Подключения» показывает, какие проекты синхронизируются через подключение.
connectionService.registerUsageProvider(() => trackerSyncService.usages());

export const trackerToolDeps: TrackerToolDeps = {
  listProjectRoots: async () => (await projectRegistry.getProjects()).map((p) => p.path),
  getStatus: (projectPath) => trackerSyncService.getStatus(projectPath),
  preview: (projectPath) => trackerSyncService.preview(projectPath),
  run: (projectPath) => trackerSyncService.run(projectPath),
  recordAutoDecision: (info, decision, rule, detail) => hitlService.recordAutoDecision(info, decision, rule, detail),
  async requestApproval(request) {
    const res = await hitlService.request({ ...request, id: hitlService.newRequestId(), createdAt: Date.now() });
    return Boolean(res?.approved);
  }
};
