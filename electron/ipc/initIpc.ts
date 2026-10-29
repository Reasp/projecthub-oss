import { dialog, ipcMain, shell } from 'electron';
import type { IpcContext } from './types';
import {
  applyInit,
  approveInitTarget,
  foundationStatus,
  previewInit,
  templateUpdateStatus,
  type InitApplyRequest,
  type InitRequest
} from '../services/projectInitService';
import {
  addTemplateFromFolder,
  addTemplateFromGit,
  addTemplateFromZip,
  duplicateTemplate,
  listTemplates,
  removeTemplate,
  setTemplateTrusted,
  updateTemplateFromGit
} from '../services/templateCatalog';
import { previewSaveProject, saveProjectAsTemplate, type SaveTemplateOptions } from '../services/templateSaveService';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { isIndexProfileId } from '../services/codeIndexProfiles';
import { AppError } from '../../src/lib/appError';
import { toIpcFailure, type IpcFailure } from './appErrorIpc';

/** Результат IPC без исключений: рендерер показывает текст ошибки по коду на языке окна (decision-165). */
type IpcResult<T> = { ok: true; value: T } | IpcFailure;

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return toIpcFailure(err);
  }
}

function asRequest(raw: unknown): InitRequest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid initialization request');
  const r = raw as Record<string, unknown>;
  const bools = (v: unknown) =>
    v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, b]) => typeof b === 'boolean')) as Record<string, boolean> : undefined;
  return {
    targetDir: String(r.targetDir ?? ''),
    projectName: typeof r.projectName === 'string' ? r.projectName : undefined,
    locale: r.locale === 'ru' ? 'ru' : 'en',
    rulesMode: r.rulesMode === 'replace' ? 'replace' : 'append',
    rulesTargets: Array.isArray(r.rulesTargets) ? r.rulesTargets.map(String) : undefined,
    templateId: typeof r.templateId === 'string' && r.templateId ? r.templateId : null,
    placement: r.placement === 'root' || r.placement === 'subfolder' ? r.placement : undefined,
    features: bools(r.features),
    sets: bools(r.sets),
    commands: bools(r.commands),
    gitHooks: typeof r.gitHooks === 'boolean' ? r.gitHooks : undefined,
    indexProfiles: Array.isArray(r.indexProfiles) ? r.indexProfiles.filter(isIndexProfileId) : undefined
  };
}

/**
 * Инициализация проекта и каталог шаблонов (TASK-136, decision-78). Папку вне реестра можно
 * инициализировать только после выбора в системном диалоге (`init:selectFolder`): путь из рендерера
 * без диалога main-процесс не примет.
 */
export function registerInitIpc(ctx: IpcContext) {
  ipcMain.handle('init:selectFolder', async () => {
    const win = ctx.getMainWindow();
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const pick = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (pick.canceled || !pick.filePaths[0]) return null;
    approveInitTarget(pick.filePaths[0]);
    return pick.filePaths[0];
  });

  ipcMain.handle('init:preview', (_event, raw: unknown) => wrap(() => previewInit(asRequest(raw))));

  ipcMain.handle('init:apply', (event, raw: unknown) =>
    wrap(() => {
      const request = asRequest(raw) as InitApplyRequest;
      const r = raw as Record<string, unknown>;
      request.choices = r.choices && typeof r.choices === 'object' ? (r.choices as InitApplyRequest['choices']) : {};
      request.confirmTemplateHash = typeof r.confirmTemplateHash === 'string' ? r.confirmTemplateHash : undefined;
      return applyInit(request, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('init:progress', progress);
      });
    })
  );

  ipcMain.handle('init:foundationStatus', (_event, projectPath: unknown) =>
    wrap(async () => foundationStatus(await assertRegisteredProject(String(projectPath ?? ''))))
  );

  // Обновление из новой версии шаблона (TASK-156): что применено и есть ли новая версия.
  ipcMain.handle('init:templateStatus', (_event, projectPath: unknown, locale: unknown) =>
    wrap(async () => templateUpdateStatus(await assertRegisteredProject(String(projectPath ?? '')), locale === 'ru' ? 'ru' : 'en'))
  );

  // Каталог шаблонов (TASK-136.5)
  ipcMain.handle('templates:list', (_event, locale: unknown) => wrap(() => listTemplates(locale === 'ru' ? 'ru' : 'en')));

  ipcMain.handle('templates:addFolder', () =>
    wrap(async () => {
      const win = ctx.getMainWindow();
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
      const pick = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (pick.canceled || !pick.filePaths[0]) return null;
      return addTemplateFromFolder(pick.filePaths[0]);
    })
  );

  ipcMain.handle('templates:addZip', () =>
    wrap(async () => {
      const win = ctx.getMainWindow();
      const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] };
      const pick = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (pick.canceled || !pick.filePaths[0]) return null;
      return addTemplateFromZip(pick.filePaths[0]);
    })
  );

  ipcMain.handle('templates:addGit', (_event, url: unknown) => wrap(() => addTemplateFromGit(String(url ?? ''))));
  ipcMain.handle('templates:update', (_event, id: unknown) => wrap(() => updateTemplateFromGit(String(id ?? ''))));
  ipcMain.handle('templates:duplicate', (_event, id: unknown, name: unknown) =>
    wrap(() => duplicateTemplate(String(id ?? ''), typeof name === 'string' ? name : undefined))
  );
  ipcMain.handle('templates:remove', (_event, id: unknown) => wrap(() => removeTemplate(String(id ?? ''))));
  ipcMain.handle('templates:setTrusted', (_event, id: unknown, trusted: unknown) =>
    wrap(() => setTemplateTrusted(String(id ?? ''), trusted === true))
  );
  ipcMain.handle('templates:openFolder', (_event, id: unknown) =>
    wrap(async () => {
      const entry = (await listTemplates()).find((t) => t.id === String(id ?? ''));
      if (!entry) throw new AppError('templates.notFound', { id: String(id ?? '') });
      const error = await shell.openPath(entry.dir);
      if (error) throw new Error(error);
      return true;
    })
  );

  const saveOptions = (raw: unknown): SaveTemplateOptions => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      name: String(r.name ?? ''),
      description: typeof r.description === 'string' ? r.description : undefined,
      exclude: Array.isArray(r.exclude) ? r.exclude.map(String) : []
    };
  };
  ipcMain.handle('templates:previewSaveProject', (_event, projectPath: unknown, raw: unknown) =>
    wrap(async () => previewSaveProject(await assertRegisteredProject(String(projectPath ?? '')), saveOptions(raw)))
  );
  ipcMain.handle('templates:saveProject', (_event, projectPath: unknown, raw: unknown) =>
    wrap(async () => saveProjectAsTemplate(await assertRegisteredProject(String(projectPath ?? '')), saveOptions(raw)))
  );
}
