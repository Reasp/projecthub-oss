import { ipcMain } from 'electron';
import { ciService } from '../services/ciServiceInstance';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { hitlService } from '../services/hitlService';
import { CI_TOOLS_AUDIT_RULE } from '../services/ciTools';

/**
 * CI/CD проекта (TASK-138.3, decision-109). Путь проекта рендерера проверяется по реестру. Перезапуск и запуск
 * ручного задания из окна — решение человека: он подтвердил его в диалоге, в аудит HITL идёт как решение из окна.
 */
export function registerCiIpc() {
  const root = (projectPath: unknown) => assertRegisteredProject(String(projectPath ?? ''));
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

  ipcMain.handle('ci:providers', async (_event, projectPath: string) => ciService.providers(await root(projectPath)));

  ipcMain.handle('ci:runs', async (_event, projectPath: string, filter: { branch?: string; sha?: string; limit?: number } = {}) => {
    const f = filter && typeof filter === 'object' ? filter : {};
    return ciService.listRuns(await root(projectPath), {
      ...(str(f.branch) ? { branch: str(f.branch) } : {}),
      ...(str(f.sha) ? { sha: str(f.sha) } : {}),
      ...(Number(f.limit) > 0 ? { limit: Number(f.limit) } : {})
    });
  });

  ipcMain.handle('ci:run', async (_event, projectPath: string, provider: string, runId: string) => ciService.getRun(await root(projectPath), str(provider), str(runId)));

  ipcMain.handle('ci:logs', async (_event, projectPath: string, provider: string, runId: string, jobId?: string) =>
    ciService.failedLogs(await root(projectPath), str(provider), str(runId), str(jobId) || undefined)
  );

  ipcMain.handle('ci:retry', async (_event, projectPath: string, provider: string, runId: string, jobId?: string) => {
    const project = await root(projectPath);
    const job = str(jobId);
    const where = await ciService.describeTarget(project, str(provider));
    hitlService.recordHumanDecision(
      {
        sessionId: 'ui',
        projectPath: project,
        type: 'command',
        title: job ? 'Запуск ручного задания CI из окна' : 'Перезапуск упавших заданий CI из окна',
        details: where,
        command: `ci_rerun ${str(provider)} ${str(runId)}${job ? ` ${job}` : ''}`,
        origin: 'studio',
        tool: 'ci_rerun'
      },
      'allow',
      { kind: 'local' },
      CI_TOOLS_AUDIT_RULE
    );
    if (job) await ciService.playJob(project, str(provider), job);
    else await ciService.retry(project, str(provider), str(runId));
    return { ok: true };
  });

  ipcMain.handle('ci:getJenkins', async (_event, projectPath: string) => ciService.getJenkins(await root(projectPath)));

  ipcMain.handle('ci:setJenkins', async (_event, projectPath: string, value: { connectionId?: string; job?: string } | null) => {
    const project = await root(projectPath);
    if (!value || !str(value.connectionId) || !str(value.job)) return ciService.setJenkins(project, null);
    return ciService.setJenkins(project, { connectionId: str(value.connectionId), job: str(value.job) });
  });
}
