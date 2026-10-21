/**
 * IPC вкладок графов (TASK-167, decision-118): граф кода GitNexus и граф документации LightRAG.
 * Настройка индексации GitNexus и переиндексация (TASK-176, decision-131).
 * Путь проекта проверяется по реестру (decision-5 п. 2); наружу из main уходит только готовый граф.
 */
import path from 'node:path';
import { ipcMain } from 'electron';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { projectGraphService } from '../services/projectGraphService';
import { getCodeIndexState, previewCodeIndex, reindexCodeGraph, saveCodeIndexSettings } from '../services/codeIndexService';
import { findIndexDocsDir } from '../services/docsReindex';

type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

const localeOf = (value: unknown) => (value === 'en' ? 'en' : 'ru');

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

  ipcMain.handle('codeIndex:getState', (_event, projectPath: unknown) =>
    wrap(async () => getCodeIndexState(await assertRegisteredProject(String(projectPath ?? ''))))
  );

  ipcMain.handle('codeIndex:preview', (_event, projectPath: unknown, settings: unknown, locale: unknown) =>
    wrap(async () => previewCodeIndex(await assertRegisteredProject(String(projectPath ?? '')), settings, localeOf(locale)))
  );

  ipcMain.handle('codeIndex:save', (_event, projectPath: unknown, settings: unknown, locale: unknown) =>
    wrap(async () => saveCodeIndexSettings(await assertRegisteredProject(String(projectPath ?? '')), settings, localeOf(locale)))
  );

  ipcMain.handle('codeIndex:reindex', (_event, projectPath: unknown, force: unknown) =>
    wrap(async () => reindexCodeGraph(await assertRegisteredProject(String(projectPath ?? '')), force === true))
  );

  // Каталог со скриптом index-docs: корень проекта или .projecthub/infra — относительно корня, '' для корня.
  ipcMain.handle('docs:indexDocsDir', async (_event, projectPath: unknown) => {
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    const dir = findIndexDocsDir(root);
    return dir === null ? null : path.relative(root, dir).replace(/\\/g, '/');
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
