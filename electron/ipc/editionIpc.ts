import { ipcMain, dialog } from 'electron';
import fs from 'node:fs/promises';
import { editionRegistry, type AgentLaunchContext } from '../extensions/editionRegistry';
import { buildEdition, loadEditionModules } from '../extensions/loadEditionModules';
import { assertRegisteredProject } from '../services/projectPathGuard';
import type { IpcContext } from './types';

/** Контекст проверки из рендерера: только известные поля, проект — из реестра. */
async function launchContextFromRenderer(raw: unknown): Promise<AgentLaunchContext> {
  const ctx = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const origin = ctx.origin === 'studio' || ctx.origin === 'assigned' || ctx.origin === 'automation' ? ctx.origin : 'swarm';
  const projectPath = await assertRegisteredProject(String(ctx.projectPath ?? ''));
  const taskId = str(ctx.taskId);
  const roleSlug = str(ctx.roleSlug);
  const model = str(ctx.model);
  return {
    projectPath,
    ...(taskId ? { taskId } : {}),
    ...(roleSlug ? { roleSlug } : {}),
    engine: str(ctx.engine) ?? 'claude-cli',
    ...(model ? { model } : {}),
    origin,
    slots: typeof ctx.slots === 'number' && ctx.slots > 0 ? Math.min(20, Math.floor(ctx.slots)) : 1
  };
}

/**
 * Точки расширения в IPC (decision-123 п. 4): каналы платных модулей — только с префиксом `ee:`, проверка
 * перед запуском агента — общий канал открытого клиента. Модули `ee/` регистрируются здесь же.
 */
export function registerEditionIpc(ctx: IpcContext): void {
  editionRegistry.setIpcRegistrar((channel, handler) => {
    if (!channel.startsWith('ee:')) throw new Error(`Канал платного модуля должен начинаться с ee: (${channel})`);
    ipcMain.handle(channel, (_event, ...args) => handler(...args));
  });
  editionRegistry.setTextFileSaver(async (options) => {
    const win = ctx.getMainWindow();
    const dialogOptions = { title: options.title, defaultPath: options.defaultName, ...(options.filters ? { filters: options.filters } : {}) };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      await fs.writeFile(result.filePath, options.content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('edition:info', () => ({ edition: buildEdition }));

  ipcMain.handle('agents:launchCheck', async (_event, raw: unknown) => editionRegistry.checkAgentLaunch(await launchContextFromRenderer(raw)));

  void loadEditionModules();
}
