/**
 * IPC вкладок графов (TASK-167, decision-118): граф кода GitNexus и граф документации LightRAG.
 * Путь проекта проверяется по реестру (decision-5 п. 2); наружу из main уходит только готовый граф.
 */
import { ipcMain } from 'electron';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { projectGraphService } from '../services/projectGraphService';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerGraphIpc() {
  ipcMain.handle('graph:getCode', async (_event, projectPath: unknown, force: unknown) => {
    try {
      const root = await assertRegisteredProject(String(projectPath ?? ''));
      return await projectGraphService.getCodeGraph(root, force === true);
    } catch (err) {
      return { ok: false, reason: 'error', error: errorText(err) };
    }
  });

  ipcMain.handle('graph:getDocs', async (_event, projectPath: unknown) => {
    try {
      const root = await assertRegisteredProject(String(projectPath ?? ''));
      return await projectGraphService.getDocsGraph(root);
    } catch (err) {
      return { ok: false, reason: 'error', error: errorText(err) };
    }
  });
}
