import { ipcMain } from 'electron';
import { trackerSyncService } from '../services/trackerSyncServiceInstance';
import { assertRegisteredProject } from '../services/projectPathGuard';
import type { TrackerSyncConfig } from '../services/trackerTypes';

/**
 * Синхронизация задач с внешним трекером (TASK-128, decision-103). Путь проекта рендерера проверяется по
 * реестру: писать `.projecthub/tracker-sync.json` можно только в зарегистрированный проект.
 */
export function registerTrackerSyncIpc() {
  trackerSyncService.startScheduler();

  const root = (projectPath: unknown) => assertRegisteredProject(String(projectPath ?? ''));

  ipcMain.handle('trackerSync:status', async (_event, projectPath: string) => trackerSyncService.getStatus(await root(projectPath)));

  ipcMain.handle(
    'trackerSync:save',
    async (_event, projectPath: string, patch: { config?: Partial<TrackerSyncConfig>; connectionId?: string | null; intervalMinutes?: number }) => {
      const p = patch && typeof patch === 'object' ? patch : {};
      return trackerSyncService.saveSettings(await root(projectPath), {
        ...(p.config && typeof p.config === 'object' ? { config: p.config } : {}),
        ...(p.connectionId !== undefined ? { connectionId: p.connectionId ? String(p.connectionId) : null } : {}),
        ...(p.intervalMinutes !== undefined ? { intervalMinutes: Number(p.intervalMinutes) || 0 } : {})
      });
    }
  );

  ipcMain.handle('trackerSync:targets', async (_event, projectPath: string) => trackerSyncService.listTargets(await root(projectPath)));
  ipcMain.handle('trackerSync:describeTarget', async (_event, projectPath: string) => trackerSyncService.describeTarget(await root(projectPath)));
  ipcMain.handle('trackerSync:preview', async (_event, projectPath: string) => trackerSyncService.preview(await root(projectPath)));
  ipcMain.handle('trackerSync:run', async (_event, projectPath: string) => trackerSyncService.run(await root(projectPath)));
}
