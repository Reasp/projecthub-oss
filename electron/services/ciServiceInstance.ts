import { simpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CiService } from './ciService';
import type { CiToolDeps } from './ciTools';
import { prService } from './prServiceInstance';
import { connectionService } from './connectionServiceInstance';
import { getStatePath } from './appPaths';
import { projectRegistry } from './projectRegistry';
import { hitlService } from './hitlService';
import { redactSecrets } from './hitlAudit';
import { maskDetectedSecrets } from './secretPatterns';

/**
 * Боевой экземпляр CI/CD (TASK-138.3, decision-109): хостинг репозитория через PR-интеграцию (подключение или `gh`),
 * Jenkins — через подключение из настройки проекта. Логи маскируются токенами подключений и шаблонами секретов.
 */
export const ciService = new CiService({
  hostingAccess: (projectPath) => prService.ciAccess(projectPath),
  connections: {
    list: async () =>
      (await connectionService.list()).map((c) => ({ id: c.id, serviceId: c.serviceId, label: c.label, baseUrl: c.baseUrl, status: c.status })),
    authorizedFetch: (connectionId, target, init) => connectionService.authorizedFetch(connectionId, target, init)
  },
  statePath: () => getStatePath('ci.json'),
  mask: (text) => maskDetectedSecrets(redactSecrets(text))
});

void ciService.init().catch(() => undefined);
// Окно «Подключения» показывает, какие проекты смотрят сборки через подключение Jenkins.
connectionService.registerUsageProvider(() => ciService.usages());

export const ciToolDeps: CiToolDeps = {
  listProjectRoots: async () => (await projectRegistry.getProjects()).map((p) => p.path),
  listRuns: (projectPath, filter) => ciService.listRuns(projectPath, filter),
  getRun: (projectPath, provider, runId) => ciService.getRun(projectPath, provider, runId),
  failedLogs: (projectPath, provider, runId, jobId) => ciService.failedLogs(projectPath, provider, runId, jobId),
  retry: (projectPath, provider, runId) => ciService.retry(projectPath, provider, runId),
  playJob: (projectPath, provider, jobId) => ciService.playJob(projectPath, provider, jobId),
  describeTarget: (projectPath, provider) => ciService.describeTarget(projectPath, provider),
  async currentBranch(sessionPath) {
    if (!existsSync(path.join(sessionPath, '.git'))) return null;
    const branch = (await simpleGit(sessionPath).revparse(['--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  },
  recordAutoDecision: (info, decision, rule, detail) => hitlService.recordAutoDecision(info, decision, rule, detail),
  async requestApproval(request) {
    const res = await hitlService.request({ ...request, id: hitlService.newRequestId(), createdAt: Date.now() });
    return Boolean(res?.approved);
  }
};
