import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { CreatePtyOptions, AISession } from '../../src/types/electron';
import { ptyService } from '../services/ptyService';
import {
  aiAgentService,
  type AIProviderConfig,
  type AIStreamRequest
} from '../services/aiAgentService';
import { claudeBridgeService } from '../services/claudeBridgeService';
import { federationClientService } from '../services/federationClientService';
import { remoteControlService } from '../services/remoteControlService';
import { aiSessionStore } from '../services/aiSessionStore';
import { studioRemoteBridge } from '../services/studioRemoteBridge';
import { claudeUsageService } from '../services/claudeUsageService';
import {
  agentFleetService,
  type StartFanOutOptions,
  type StartDoneLoopOptions,
  type StartHandoffOptions,
  type SwarmExportFormat
} from '../services/agentFleetService';
import { loadDoneLoopSettings } from '../services/doneLoopService';
import { planService, type ConflictResolution, type GeneratePlanOptions } from '../services/planService';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { attachmentAbsPath, attachmentPreviewDataUrl, isSafeToOpenAttachment, saveStudioAttachment, workDirInProject } from '../services/studioPromptAttachments';
import { sanitizePromptAttachments } from '../../src/lib/promptAttachments';
import type { RunJudgeOptions } from '../services/arenaJudgeService';
import { loadArenaConfig, saveArenaConfig } from '../services/arenaConfig';
import { deleteAgentResult, listAgentResults, pruneAgentResults, restoreAgentResult } from '../services/agentResultStore';
import { resultRefSessionPart } from '../services/agentResultRefs';
import { visualArtifactService } from '../services/visualArtifactService';
import type { ArenaSettings } from '../services/actionConfigService';
import type { CheckDefinition, ComposeSelection } from '../services/arenaTypes';
import { buildAgentContext, type ContextPartKey } from '../services/contextBuilder';
import { llmProfileService } from '../services/llmProfileService';
import { llmModelCatalogService } from '../services/llmModelCatalogService';
import { LLM_PROVIDER_PRESETS, profileFromLegacyConfig } from '../services/llmProfiles';
import { pricingService } from '../services/pricingService';
import { modelTierService } from '../services/modelTierService';
import { modelAssignmentService } from '../services/modelAssignmentService';
import { modelCallService } from '../services/modelCallService';
import { ModelRouteError } from '../services/modelRouter';
import { buildTaskDraftPrompt, parseTaskDraft } from '../services/taskDraftPrompt';
import { providerErrorInfoOf, toProviderErrorInfo } from '../services/providerErrors';
import { AppError, appErrorFields, appErrorKeyOf } from '../../src/lib/appError';
import { toIpcFailure } from './appErrorIpc';
import { launchRefusal } from '../extensions/editionRegistry';
import { hostText } from '../i18n/hostText';
import { getHostLanguage } from '../services/hostLanguage';
import { usesClaudeCli } from '../services/modelTarget';
import { hitlService } from '../services/hitlService';
import { editionRegistry, type AgentLaunchContext } from '../extensions/editionRegistry';
import { studioLiveRuns } from '../services/studioLiveRuns';
import type { IpcContext } from './types';
import path from 'node:path';
import { claudeAccountService } from '../services/claudeAccountService';
import { isCliSessionId, listCliSessions, readCliSessionMessages, readCliSessionTail } from '../services/claudeCliSessions';
import { cliRewindPoints, cliRewindPreview, runCliRewindFiles } from '../services/claudeCliRewind';
import { checkAddDir } from '../services/cliAddDir';
import { stopCliBackgroundSession } from '../services/cliBackgroundSession';
import {
  memoryDialogFile,
  memoryDialogFolder,
  readMemoryFile,
  runCliMemoryDialog,
  saveMemoryFile,
  type CliMemoryDialog
} from '../services/cliMemoryDialog';
import { runCliCommandList, runCliExport, runCliRename, runCliStatus } from '../services/cliSessionInfo';
import { searchProjectFiles } from '../services/projectFileIndex';
import { isCliSessionUuid } from '../services/cliControlRequest';

/** Запрос Agents Studio как запуск агента для ограничений (decision-124): движок, модель, задача. */
function studioLaunchContext(req: AIStreamRequest): AgentLaunchContext {
  return {
    projectPath: req.projectPath,
    ...(req.taskId ? { taskId: req.taskId } : {}),
    engine: usesClaudeCli(req.config) ? 'claude-cli' : 'api',
    ...(req.config.model ? { model: req.config.model } : {}),
    origin: 'studio',
    ...(req.memberId ? { memberId: req.memberId } : {}),
    slots: 1
  };
}

/**
 * Сессия Studio участника общего хоста (TASK-142.3, decision-84 п. 4, 8): рабочий каталог — его worktree, а не
 * активное дерево окна; без доверия (роль ниже maintainer) — только с HITL. Ошибка — запуск не идёт.
 */
async function applyStudioMember(req: AIStreamRequest): Promise<AIStreamRequest> {
  if (!req.memberId) return req;
  const profile = editionRegistry.launcherProfile(req.memberId);
  // Изолированный участник (TASK-150.2, TASK-246): Studio — чат процесса хоста с фоновыми процессами и управлением
  // компьютером; агенты участника по задачам идут в его контейнере, Studio — отказ, а не запуск вне контейнера.
  if (profile?.sandbox) throw new AppError('swarm.sandboxStudio');
  const trusted = profile?.trusted === true;
  const workspace = await editionRegistry.memberWorkspace({ projectPath: req.projectPath, memberId: req.memberId, ...(req.taskId ? { taskId: req.taskId } : {}) });
  return {
    ...req,
    ...(workspace ? { workspaceRoot: workspace.worktreePath } : {}),
    ...(trusted ? {} : { config: { ...req.config, autoApprove: false } })
  };
}

/** Черновик задачи: Claude Code по подписке отвечает за 6–20 с, на загруженной машине дольше. */
const TASK_DRAFT_TIMEOUT_MS = 90_000;
const TASK_DRAFT_MAX_TOKENS = 1200;

export function registerAiIpc(ctx: IpcContext) {
  // PTY Terminals
  ipcMain.handle('pty:create', async (_event, options: CreatePtyOptions) => {
    return await ptyService.createSession(options);
  });

  ipcMain.handle('pty:write', async (_event, sessionId: string, data: string) => {
    return ptyService.write(sessionId, data);
  });

  ipcMain.handle('pty:resize', async (_event, sessionId: string, cols: number, rows: number) => {
    return ptyService.resize(sessionId, cols, rows);
  });

  ipcMain.handle('pty:kill', async (_event, sessionId: string) => {
    return ptyService.kill(sessionId);
  });

  ipcMain.handle('pty:list', async () => {
    return ptyService.listSessions();
  });

  ipcMain.handle('pty:getOutput', async (_event, sessionId: string) => {
    return ptyService.getOutput(String(sessionId ?? ''));
  });

  // AI Config & Auth
  ipcMain.handle('ai:getConfig', async () => {
    return await aiAgentService.getConfig();
  });

  ipcMain.handle('ai:saveConfig', async (_event, config: AIProviderConfig) => {
    return await aiAgentService.saveConfig(config);
  });

  // Профили OpenAI-совместимых провайдеров и их каталог моделей (TASK-70.1, TASK-70.2, decision-39).
  // Ключ профиля в renderer не возвращается: только признак hasApiKey.
  ipcMain.handle('llmProfiles:presets', () => LLM_PROVIDER_PRESETS);
  ipcMain.handle('llmProfiles:list', () => llmProfileService.listProfiles());
  ipcMain.handle('llmProfiles:save', (_event, input: { profile: unknown; apiKey?: string | null }) =>
    llmProfileService.saveProfile({ profile: input?.profile, apiKey: input?.apiKey })
  );
  ipcMain.handle('llmProfiles:delete', async (_event, id: string) => {
    const removed = await llmProfileService.deleteProfile(String(id));
    if (removed) await llmModelCatalogService.forget(String(id)).catch(() => undefined);
    return removed;
  });
  // Ручной перенос прежнего провайдера Agents Studio в профиль (decision-40): ключ берётся из сохранённых
  // настроек в main-процессе, сам ai-config.json не меняется — провайдера переключает пользователь.
  ipcMain.handle('llmProfiles:importLegacy', async (_event, expectedProvider: string) => {
    const config = await aiAgentService.getConfig();
    if (config.provider !== expectedProvider) {
      throw new AppError('studio.saveSettingsFirst');
    }
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const profile = profileFromLegacyConfig(config, id);
    return llmProfileService.saveProfile({ profile, apiKey: config.apiKey?.trim() || undefined });
  });
  ipcMain.handle('llmProfiles:listModels', (_event, id: string, refresh?: boolean) =>
    llmModelCatalogService.listModels(String(id), { refresh: refresh === true })
  );

  // Таблица цен агентов (TASK-70.4, decision-42): встроенная + переопределения agent-pricing.json.
  // Сохранение сразу применяется в Swarm и Agents Studio. Импорт OpenRouter — только по кнопке и ничего не пишет.
  void pricingService.ensureLoaded();
  ipcMain.handle('pricing:get', () => pricingService.getState());
  ipcMain.handle('pricing:save', (_event, overrides: unknown) => pricingService.saveOverrides(overrides));
  ipcMain.handle('pricing:fetchOpenRouter', () => pricingService.fetchOpenRouterPrices());

  // Тиры моделей (TASK-79, decision-44): таблица <userData>/model-tiers.json. «Заполнить из настроенного»
  // ничего не пишет — черновик сохраняется отдельной кнопкой.
  ipcMain.handle('modelTiers:get', () => modelTierService.getState());
  ipcMain.handle('modelTiers:save', (_event, settings: unknown) => modelTierService.save(settings));
  ipcMain.handle('modelTiers:seed', (_event, draft?: unknown) => modelTierService.seed(draft));

  // Назначения моделей (TASK-134.3, decision-74 п. 5): <userData>/model-assignments.json и «Сейчас» по черновику окна.
  ipcMain.handle('modelAssignments:get', () => modelAssignmentService.getState());
  ipcMain.handle('modelAssignments:save', (_event, settings: unknown) => modelAssignmentService.save(settings));
  ipcMain.handle('modelAssignments:preview', (_event, draft?: { assignments?: unknown; main?: unknown }) =>
    modelCallService.previewPurposes({
      assignments: draft?.assignments,
      ...(draft?.main && typeof draft.main === 'object' ? { main: draft.main as Partial<AIProviderConfig> } : {})
    })
  );

  // Черновик описания задачи (TASK-134.4, decision-99): модель назначения «Черновик описания задачи»,
  // вызов только из main. Неразобранный ответ — ошибка, а не шаблон вместо модели.
  ipcMain.handle('ai:taskDraft', async (_event, payload: unknown) => {
    const request = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const title = typeof request.title === 'string' ? request.title.trim() : '';
    if (!title) return { ok: false, error: 'empty_title' };
    const existingCriteria = Array.isArray(request.existingCriteria)
      ? request.existingCriteria.filter((c): c is string => typeof c === 'string')
      : [];
    // Проект задачи — для аккаунта Claude Code (decision-87); незарегистрированный путь не принимается.
    const projectPath =
      typeof request.projectPath === 'string' && request.projectPath
        ? await assertRegisteredProject(request.projectPath).catch(() => undefined)
        : undefined;
    try {
      const completion = await modelCallService.complete({
        purpose: 'task.draft',
        prompt: buildTaskDraftPrompt({
          title,
          ...(typeof request.description === 'string' ? { description: request.description } : {}),
          existingCriteria,
          language: request.language === 'en' ? 'en' : 'ru'
        }),
        maxTokens: TASK_DRAFT_MAX_TOKENS,
        temperature: 0.2,
        timeoutMs: TASK_DRAFT_TIMEOUT_MS,
        ...(projectPath ? { projectPath } : {})
      });
      const draft = parseTaskDraft(completion.text);
      if (!draft) return { ok: false, error: 'unparsed', model: completion.model };
      return { ok: true, draft, model: completion.model };
    } catch (err) {
      const providerError = providerErrorInfoOf(err);
      return {
        ...toIpcFailure(err),
        ...(err instanceof ModelRouteError ? { modelProblem: true } : {}),
        ...(providerError ? { providerError } : {})
      };
    }
  });

  // Аккаунт Claude Code (TASK-152, decision-87): статус и выход — по проекту или явному профилю.
  ipcMain.handle('ai:getClaudeAuthStatus', async (_event, query?: { projectPath?: string; accountId?: string; force?: boolean }) => {
    return await aiAgentService.getClaudeAuthStatus({
      ...(typeof query?.projectPath === 'string' ? { projectPath: query.projectPath } : {}),
      ...(typeof query?.accountId === 'string' ? { accountId: query.accountId } : {}),
      force: query?.force === true
    });
  });

  ipcMain.handle('ai:claudeLogout', async (_event, query?: { projectPath?: string; accountId?: string }) => {
    return await aiAgentService.claudeLogout({
      ...(typeof query?.projectPath === 'string' ? { projectPath: query.projectPath } : {}),
      ...(typeof query?.accountId === 'string' ? { accountId: query.accountId } : {})
    });
  });

  // Сессии Claude Code рабочей папки для `/resume` в Agents Studio (TASK-230): под аккаунтом вкладки.
  ipcMain.handle('ai:listCliSessions', async (_event, query?: { projectPath?: unknown; cwd?: unknown; claudeAccountId?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = typeof query?.cwd === 'string' && query.cwd.trim() ? path.resolve(query.cwd) : projectPath;
    const rel = path.relative(projectPath, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
    const slotAccountId = typeof query?.claudeAccountId === 'string' && query.claudeAccountId ? query.claudeAccountId : undefined;
    const { account } = await claudeAccountService.resolve({ projectPath, ...(slotAccountId ? { slotAccountId } : {}) });
    return listCliSessions(account.configDir, cwd);
  });

  // Переписка выбранной сессии CLI — в ленту вкладки после `/resume` (TASK-282): те же проверки, что у списка.
  ipcMain.handle('ai:readCliSession', async (_event, query?: { projectPath?: unknown; cwd?: unknown; claudeAccountId?: unknown; cliSessionId?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = typeof query?.cwd === 'string' && query.cwd.trim() ? path.resolve(query.cwd) : projectPath;
    const rel = path.relative(projectPath, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !isCliSessionId(query?.cliSessionId)) return [];
    const slotAccountId = typeof query?.claudeAccountId === 'string' && query.claudeAccountId ? query.claudeAccountId : undefined;
    const { account } = await claudeAccountService.resolve({ projectPath, ...(slotAccountId ? { slotAccountId } : {}) });
    return readCliSessionMessages(account.configDir, cwd, query.cliSessionId);
  });

  // Разговор вкладки занят фоновой сессией CLI (TASK-301, decision-219): остановить её под аккаунтом вкладки.
  ipcMain.handle('ai:stopCliBackgroundSession', async (_event, query?: { projectPath?: unknown; cwd?: unknown; claudeAccountId?: unknown; cliSessionId?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = workDirInProject(projectPath, query?.cwd);
    if (!isCliSessionId(query?.cliSessionId)) return { ok: false, error: 'invalid session id' };
    const slotAccountId = typeof query?.claudeAccountId === 'string' && query.claudeAccountId ? query.claudeAccountId : undefined;
    const { account } = await claudeAccountService.resolve({ projectPath, ...(slotAccountId ? { slotAccountId } : {}) });
    const result = await stopCliBackgroundSession({ configDir: account.configDir, cwd, cliSessionId: query.cliSessionId });
    console.info(`[aiIpc] background CLI session: ${result.ok ? `stopped ${result.stopped ?? 'none'}` : result.error.message}`);
    return result.ok ? { ok: true, stopped: result.stopped } : { ok: false, error: result.error.message, errorKey: result.error.appErrorKey };
  });

  // `/rewind` (TASK-284, decision-205): точки отката, предпросмотр файлов и откат файлов — те же проверки, что у списка.
  type CliRewindQuery = { projectPath?: unknown; cwd?: unknown; claudeAccountId?: unknown; cliSessionId?: unknown; promptUuid?: unknown };
  const cliRewindScope = async (query?: CliRewindQuery) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = typeof query?.cwd === 'string' && query.cwd.trim() ? path.resolve(query.cwd) : projectPath;
    const rel = path.relative(projectPath, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !isCliSessionId(query?.cliSessionId)) return null;
    const slotAccountId = typeof query?.claudeAccountId === 'string' && query.claudeAccountId ? query.claudeAccountId : undefined;
    const { account } = await claudeAccountService.resolve({ projectPath, ...(slotAccountId ? { slotAccountId } : {}) });
    const transcript = await readCliSessionTail(account.configDir, cwd, query.cliSessionId);
    return transcript === null ? null : { configDir: account.configDir, cwd, cliSessionId: query.cliSessionId, transcript };
  };
  ipcMain.handle('ai:cliRewindPoints', async (_event, query?: CliRewindQuery) => {
    const scope = await cliRewindScope(query);
    return scope ? cliRewindPoints(scope.transcript) : [];
  });
  ipcMain.handle('ai:cliRewindPreview', async (_event, query?: CliRewindQuery) => {
    const scope = await cliRewindScope(query);
    if (!scope || !isCliSessionId(query?.promptUuid)) return [];
    return cliRewindPreview(scope.configDir, scope.cwd, scope.cliSessionId, scope.transcript, query.promptUuid);
  });
  ipcMain.handle('ai:cliRewindFiles', async (_event, query?: CliRewindQuery) => {
    const scope = await cliRewindScope(query);
    if (!scope || !isCliSessionId(query?.promptUuid)) return { ok: false, output: 'session not found' };
    const promptUuid = query.promptUuid;
    // Откатывается только реплика текущего разговора вкладки: чужой uuid CLI отклонил бы и сам.
    if (!cliRewindPoints(scope.transcript).some((p) => p.uuid === promptUuid)) return { ok: false, output: 'message not found' };
    const result = await runCliRewindFiles(scope.configDir, scope.cwd, scope.cliSessionId, promptUuid);
    console.info(`[aiIpc] /rewind files ${scope.cliSessionId} → ${promptUuid}: ${result.ok ? 'ok' : 'failed'}`);
    return result;
  });

  // `/add-dir` в Agents Studio (TASK-285): каталог проверяется до того, как попадёт во вкладку. Каталог вкладки — внутри
  // проекта, как у списка сессий; относительный путь — от него.
  ipcMain.handle('ai:checkAddDir', async (_event, query?: { projectPath?: unknown; cwd?: unknown; dir?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = typeof query?.cwd === 'string' && query.cwd.trim() ? path.resolve(query.cwd) : projectPath;
    const rel = path.relative(projectPath, cwd);
    const base = rel.startsWith('..') || path.isAbsolute(rel) ? projectPath : cwd;
    return checkAddDir(typeof query?.dir === 'string' ? query.dir : '', base);
  });

  // Вложения в промпт (TASK-289, decision-210): файл — в каталог вложений вкладки внутри проекта; превью и открытие —
  // только файлов этого каталога.
  ipcMain.handle('ai:saveAttachment', async (_event, query?: { projectPath?: unknown; cwd?: unknown; name?: unknown; mime?: unknown; data?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const saved = await saveStudioAttachment(projectPath, workDirInProject(projectPath, query?.cwd), {
      name: query?.name,
      mime: query?.mime,
      data: query?.data
    });
    console.info(`[aiIpc] attachment saved (${saved.mime || 'unknown type'}, ${saved.size} bytes)`);
    return saved;
  });
  ipcMain.handle('ai:attachmentPreview', async (_event, query?: { projectPath?: unknown; path?: unknown; mime?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    return attachmentPreviewDataUrl(projectPath, query?.path, query?.mime);
  });
  ipcMain.handle('ai:openAttachment', async (_event, query?: { projectPath?: unknown; path?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const abs = attachmentAbsPath(projectPath, query?.path);
    if (!abs || !existsSync(abs)) return false;
    // Открываются только картинки, PDF и текст: исполняемый файл (в том числе присланный с телефона) не запускается,
    // а показывается в папке.
    if (!isSafeToOpenAttachment(abs)) {
      shell.showItemInFolder(abs);
      return true;
    }
    return (await shell.openPath(abs)) === '';
  });

  // `/memory` (TASK-286, decision-207): строки диалога даёт сам CLI под аккаунтом вкладки. Открыть и сохранить можно
  // только файл из последнего ответа CLI для этого аккаунта и каталога — путь из рендерера сам по себе ничего не открывает.
  type CliMemoryQuery = { projectPath?: unknown; cwd?: unknown; claudeAccountId?: unknown };
  const memoryDialogs = new Map<string, CliMemoryDialog>();
  const cliMemoryScope = async (query?: CliMemoryQuery) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = typeof query?.cwd === 'string' && query.cwd.trim() ? path.resolve(query.cwd) : projectPath;
    const rel = path.relative(projectPath, cwd);
    const workDir = rel.startsWith('..') || path.isAbsolute(rel) ? projectPath : cwd;
    const slotAccountId = typeof query?.claudeAccountId === 'string' && query.claudeAccountId ? query.claudeAccountId : undefined;
    const { account } = await claudeAccountService.resolve({ projectPath, ...(slotAccountId ? { slotAccountId } : {}) });
    return { configDir: account.configDir, cwd: workDir, key: `${account.configDir}\n${workDir}` };
  };
  ipcMain.handle('ai:cliMemoryDialog', async (_event, query?: CliMemoryQuery & { addDirs?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const addDirs = Array.isArray(query?.addDirs) ? query.addDirs.filter((d): d is string => typeof d === 'string') : [];
    const result = await runCliMemoryDialog({ configDir: scope.configDir, cwd: scope.cwd, addDirs });
    if (result.ok) memoryDialogs.set(scope.key, result.dialog);
    else console.warn(`[aiIpc] /memory: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
    return result;
  });
  ipcMain.handle('ai:readCliMemoryFile', async (_event, query?: CliMemoryQuery & { file?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const dialog = memoryDialogs.get(scope.key);
    const file = typeof query?.file === 'string' ? query.file : '';
    if (!dialog || !memoryDialogFile(dialog, file)) return { ok: false, reason: 'denied' };
    return readMemoryFile(path.resolve(file));
  });
  ipcMain.handle('ai:saveCliMemoryFile', async (_event, query?: CliMemoryQuery & { file?: unknown; content?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const dialog = memoryDialogs.get(scope.key);
    const file = typeof query?.file === 'string' ? query.file : '';
    if (!dialog || !memoryDialogFile(dialog, file) || typeof query?.content !== 'string') return { ok: false };
    const result = await saveMemoryFile(path.resolve(file), query.content);
    console.info(`[aiIpc] /memory: saved ${result.ok ? 'ok' : 'failed'}`);
    return result;
  });
  ipcMain.handle('ai:openCliMemoryFolder', async (_event, query?: CliMemoryQuery & { dir?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const dialog = memoryDialogs.get(scope.key);
    const dir = typeof query?.dir === 'string' ? query.dir : '';
    if (!dialog || !memoryDialogFolder(dialog, dir)) return false;
    // Папки автопамяти может ещё не быть — CLI создаёт её при первой записи; терминальный диалог тоже открывает её сразу.
    await fs.mkdir(path.resolve(dir), { recursive: true }).catch(() => undefined);
    return (await shell.openPath(path.resolve(dir))) === '';
  });

  // `/status`, `/help` и имя сессии CLI вкладки (TASK-287, decision-208): данные даёт CLI под аккаунтом вкладки, без хода.
  const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : []);
  const cliId = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  ipcMain.handle('ai:cliStatus', async (_event, query?: CliMemoryQuery & { addDirs?: unknown; cliSessionId?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const result = await runCliStatus({ configDir: scope.configDir, cwd: scope.cwd, addDirs: stringList(query?.addDirs), cliSessionId: cliId(query?.cliSessionId) });
    if (!result.ok) console.warn(`[aiIpc] /status: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
    return result;
  });
  ipcMain.handle('ai:cliCommands', async (_event, query?: CliMemoryQuery & { addDirs?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const result = await runCliCommandList({ configDir: scope.configDir, cwd: scope.cwd, addDirs: stringList(query?.addDirs) });
    if (!result.ok) console.warn(`[aiIpc] /help: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
    return result;
  });
  // `@` в поле ввода вкладки (TASK-300, decision-214): файлы рабочего каталога вкладки, только имена. Запрос в лог не пишется.
  ipcMain.handle('ai:searchFiles', async (_event, query?: { projectPath?: unknown; cwd?: unknown; query?: unknown; limit?: unknown }) => {
    const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
    const cwd = workDirInProject(projectPath, query?.cwd);
    const text = typeof query?.query === 'string' ? query.query.slice(0, 300) : '';
    const limit = typeof query?.limit === 'number' && Number.isFinite(query.limit) ? query.limit : 50;
    try {
      return { ok: true, ...(await searchProjectFiles(cwd, text, limit)) };
    } catch (err) {
      console.warn(`[aiIpc] @ files: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, entries: [], truncated: false };
    }
  });
  ipcMain.handle('ai:cliRenameSession', async (_event, query?: CliMemoryQuery & { addDirs?: unknown; cliSessionId?: unknown; name?: unknown }) => {
    const scope = await cliMemoryScope(query);
    const cliSessionId = cliId(query?.cliSessionId) ?? '';
    const result = await runCliRename(
      {
        configDir: scope.configDir,
        cwd: scope.cwd,
        addDirs: stringList(query?.addDirs),
        cliSessionId,
        name: typeof query?.name === 'string' ? query.name : ''
      },
      // Вкладка держит процесс этой сессии (TASK-298) — имя уходит в него.
      (request) => claudeBridgeService.requestLiveCli(cliSessionId, scope.configDir, request)
    );
    // Имя сессии в лог не пишется — это текст пользователя.
    console.info(`[aiIpc] session name to Claude Code: ${result.ok ? 'ok' : result.reason}`);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });

  // `/export` и экспорт из шапки вкладки (TASK-288, decision-209): Markdown переписки собирает рендерер, main только
  // спрашивает, куда сохранить. У вкладки Claude Code с разговором есть второй тип файла — расшифровка CLI (`.txt`),
  // её даёт сам CLI запросом `export_conversation`. Последняя выбранная папка запоминается до перезапуска.
  let lastExportDir: string | undefined;
  // `app.getPath('documents')` бросает, если у профиля Windows нет папки «Документы» (перенесённая или удалённая
  // известная папка): тогда домашняя папка, а без неё — только имя файла, диалог откроется в своей последней папке.
  const defaultExportDir = (): string => {
    for (const name of ['documents', 'home'] as const) {
      try {
        return app.getPath(name);
      } catch {
        /* следующая */
      }
    }
    return '';
  };
  ipcMain.handle(
    'ai:exportConversation',
    async (_event, query?: CliMemoryQuery & { addDirs?: unknown; cliSessionId?: unknown; markdown?: unknown; fileName?: unknown }) => {
      const projectPath = await assertRegisteredProject(String(query?.projectPath ?? ''));
      const markdown = typeof query?.markdown === 'string' ? query.markdown : '';
      if (!markdown || markdown.length > 50_000_000) return { ok: false, reason: 'io' };
      const cliSessionId = isCliSessionUuid(query?.cliSessionId) ? query.cliSessionId : undefined;
      const rawName = typeof query?.fileName === 'string' ? path.basename(query.fileName) : '';
      const fileName = /^[^<>:"|?*\\/]{1,160}$/.test(rawName) ? rawName : 'conversation.md';
      const text = hostText(getHostLanguage()).dialogs;
      const markdownFilter = { name: text.markdownFilter, extensions: ['md'] };
      const cliFilter = { name: text.cliTranscriptFilter, extensions: ['txt'] };
      const wantsTxt = /\.txt$/i.test(fileName) && !!cliSessionId;
      const dialogOptions = {
        title: text.exportConversation,
        defaultPath: path.join(lastExportDir ?? defaultExportDir(), cliSessionId || !/\.txt$/i.test(fileName) ? fileName : fileName.replace(/\.txt$/i, '.md')),
        filters: cliSessionId ? (wantsTxt ? [cliFilter, markdownFilter] : [markdownFilter, cliFilter]) : [markdownFilter]
      };
      const win = ctx.getDialogWindow();
      const picked = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      const target = picked.filePath;
      lastExportDir = path.dirname(target);
      let content = markdown;
      let format: 'markdown' | 'cli' = 'markdown';
      if (cliSessionId && path.extname(target).toLowerCase() === '.txt') {
        const scope = await cliMemoryScope({ ...query, projectPath });
        const result = await runCliExport({ configDir: scope.configDir, cwd: scope.cwd, addDirs: stringList(query?.addDirs), cliSessionId });
        if (!result.ok) {
          console.warn(`[aiIpc] /export: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
          return { ok: false, reason: result.reason };
        }
        content = result.text;
        format = 'cli';
      }
      try {
        await fs.writeFile(target, content, 'utf-8');
      } catch (err) {
        console.warn(`[aiIpc] /export: write failed — ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, reason: 'io' };
      }
      console.info(`[aiIpc] /export: saved (${format})`);
      return { ok: true, path: target, format };
    }
  );

  // Streaming & Session Lifecycle
  ipcMain.handle('ai:abortStream', async (_event, sessionId: string) => {
    aiAgentService.abortStream(sessionId);
    claudeBridgeService.abortSession(sessionId);
    return true;
  });

  // Фоновые задачи идущего хода Claude Code (TASK-290, decision-211): вывод и остановка запросами в stdin хода.
  ipcMain.handle('ai:cliBackgroundTaskOutput', async (_event, query?: { sessionId?: unknown; taskId?: unknown }) => {
    if (typeof query?.sessionId !== 'string') return null;
    return claudeBridgeService.cliBackgroundTaskOutput(query.sessionId, query.taskId);
  });
  ipcMain.handle('ai:stopCliBackgroundTask', async (_event, query?: { sessionId?: unknown; taskId?: unknown }) => {
    if (typeof query?.sessionId !== 'string') return false;
    return claudeBridgeService.stopCliBackgroundTask(query.sessionId, query.taskId);
  });

  // Реплика во время хода Claude Code (TASK-298, decision-215): в stdin живого процесса вкладки и снятие её до модели.
  ipcMain.handle('ai:cliSendDuringTurn', async (_event, query?: { sessionId?: unknown; message?: { id?: unknown; text?: unknown; attachments?: unknown } }) => {
    const message = query?.message;
    if (typeof query?.sessionId !== 'string' || typeof message?.id !== 'string' || typeof message.text !== 'string') return false;
    if (message.id.length > 200 || message.text.length > 200_000) return false;
    const attachments = sanitizePromptAttachments(message.attachments);
    if (!message.text.trim() && attachments.length === 0) return false;
    return claudeBridgeService.injectCliMessage(query.sessionId, { id: message.id, text: message.text, attachments });
  });
  ipcMain.handle('ai:cliCancelDuringTurn', async (_event, query?: { sessionId?: unknown; messageId?: unknown }) => {
    if (typeof query?.sessionId !== 'string' || typeof query.messageId !== 'string') return false;
    return claudeBridgeService.cancelCliMessage(query.sessionId, query.messageId);
  });

  ipcMain.handle('ai:clearSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    claudeBridgeService.clearSession(sessionId);
    return true;
  });

  ipcMain.handle('ai:applyDiff', async (_event, projectPath: string, relativePath: string, newContent: string) => {
    return await aiAgentService.applyDiff(projectPath, relativePath, newContent);
  });

  // AI Session Store
  ipcMain.handle('aiSessions:list', async (_event, projectPath: string) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return [];
    return aiSessionStore.list(projectPath);
  });

  ipcMain.handle('aiSessions:save', async (_event, projectPath: string, session: AISession) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return false;
    try {
      await aiSessionStore.save(projectPath, session);
      return true;
    } catch (e) {
      console.error('[Main] aiSessions:save failed:', e);
      return false;
    }
  });

  ipcMain.handle('aiSessions:delete', async (_event, projectPath: string, sessionId: string) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return false;
    return aiSessionStore.delete(projectPath, sessionId);
  });

  ipcMain.handle('aiSessions:import', async (_event, sessionsByProject: Record<string, AISession[]>) => {
    try {
      return await aiSessionStore.importLegacy(sessionsByProject);
    } catch (e) {
      console.error('[Main] aiSessions:import failed:', e);
      return 0;
    }
  });

  // Запросы телефона к Agents Studio идут в главное окно: сессиями владеет его стор (TASK-140.10, decision-83).
  studioRemoteBridge.setWindowGetter(() => ctx.getMainWindow());

  // AI Stream Chat
  ipcMain.handle('ai:streamChat', async (event, rawReq: AIStreamRequest) => {
    let req = rawReq;
    // Поток — окну, которое начало ход: главное или окно проекта (TASK-295).
    const targetWin = BrowserWindow.fromWebContents(event.sender) ?? ctx.getMainWindow();
    if (!targetWin) return;
    const send = (channel: string, payload: unknown, extra?: unknown) => {
      if (!targetWin.isDestroyed()) {
        if (extra === undefined) targetWin.webContents.send(channel, payload);
        else targetWin.webContents.send(channel, payload, extra);
      }
    };

    // Поток любой сессии Studio дублируется сопряжённым телефонам в сокращённом виде (TASK-140.10, decision-83).
    // Побочный вопрос `/btw` (TASK-283) — не вкладка: телефону его поток не нужен.
    const phone = rawReq.claudeCliFork === 'side' ? null : studioRemoteBridge;
    phone?.streamStarted(req.projectPath, req.sessionId);
    // Ограничения запуска (бюджеты Team, decision-124): исчерпанный бюджет не пускает новый промпт.
    const launchCtx = studioLaunchContext(req);
    const launch = await editionRegistry.checkAgentLaunch(launchCtx);
    // Отказ до запуска — снимком с кодом (decision-165): карточка Studio и телефон показывают его на своём языке.
    const refuse = (err: Error) => {
      const info = appErrorKeyOf(err) ? toProviderErrorInfo(err) : undefined;
      send(`ai:error:${req.sessionId}`, err.message, info);
      phone?.streamEnded(req.projectPath, req.sessionId, err.message, info?.messageKey);
    };
    if (!launch.allowed) {
      refuse(launchRefusal(launch));
      return;
    }
    try {
      req = await applyStudioMember(req);
    } catch (err) {
      refuse(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Дерево вкладки удалили (TASK-268, decision-195): запуск в основном дереве вместо него — молчаливая подмена каталога.
    const workDir = req.workspaceRoot?.trim();
    if (workDir && !existsSync(workDir)) {
      refuse(new AppError('studio.worktreeMissing', { path: workDir }));
      return;
    }
    // Запросы HITL сессии участника уходят его устройствам (decision-84 п. 5). Сессия принадлежит ему навсегда.
    hitlService.bindSessionOwner(req.sessionId, req.memberId);
    const startedAt = Date.now();
    // Идущий ответ Studio считается лимитом одновременных агентов участника и бюджетами (decision-135).
    studioLiveRuns.start(launchCtx, req.sessionId, startedAt);
    try {
      await claudeBridgeService.runAgentTask(
        req,
        (chunk) => {
          send(`ai:chunk:${req.sessionId}`, chunk);
          phone?.streamChunk(req.projectPath, req.sessionId, chunk);
        },
        (fullMsg) => {
          studioLiveRuns.finish(req.sessionId);
          send(`ai:complete:${req.sessionId}`, fullMsg);
          phone?.streamEnded(req.projectPath, req.sessionId);
          const usage = fullMsg.usage;
          editionRegistry.emitAgentRun({
            ...launchCtx,
            at: Date.now(),
            startedAt,
            ...(usage?.model ? { model: usage.model } : {}),
            sessionId: req.sessionId,
            agentId: req.sessionId,
            status: 'completed',
            ...(typeof usage?.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
            ...(usage?.costSource ? { costSource: usage.costSource } : {}),
            ...(usage?.estimated ? { estimated: true } : {}),
            ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {})
          });
        },
        // Второй аргумент — снимок ошибки провайдера (decision-43): renderer строит по нему локализованную карточку.
        (err, info) => {
          studioLiveRuns.finish(req.sessionId);
          send(`ai:error:${req.sessionId}`, err, info);
          phone?.streamEnded(req.projectPath, req.sessionId, info?.message || err, info?.messageKey);
        },
        // Подсказка следующего промпта Claude Code (TASK-294) — после конца хода, окну, которое его начало.
        (suggestion) => send('ai:promptSuggestion', { sessionId: req.sessionId, suggestion })
      );
    } catch (err: any) {
      // Ошибка ProjectHub с кодом без снимка провайдера — снимком «unknown» с кодом: карточка покажет её на языке окна.
      const info = providerErrorInfoOf(err) ?? (appErrorKeyOf(err) ? toProviderErrorInfo(err) : undefined);
      const message = info?.message || err?.message || String(err);
      studioLiveRuns.finish(req.sessionId);
      console.error(`[Main] ai:streamChat failed for session ${req.sessionId}: ${message}`);
      claudeBridgeService.setProjectStatus(req.projectPath, 'error', { code: 'failed', detail: message });
      send(`ai:error:${req.sessionId}`, message, info);
      phone?.streamEnded(req.projectPath, req.sessionId, message, info?.messageKey);
    }
    // `finally` здесь нельзя: путь Claude CLI возвращается сразу после запуска процесса, конец ответа —
    // только `onComplete`/`onError` (они же срабатывают при отмене).
  });

  // Ответ окна на запрос телефона (TASK-140.10): промпт или остановка в сессии Agents Studio.
  ipcMain.handle('aiStudio:remoteReply', (_event, requestId: unknown, reply: unknown) => studioRemoteBridge.resolve(requestId, reply));

  // Предпросмотр контекста агента для карточки в Agents Studio (TASK-64) — без запуска стрима.
  ipcMain.handle(
    'ai:previewContext',
    async (
      _event,
      projectPath: string,
      taskId: string,
      contextParts?: Partial<Record<ContextPartKey, boolean>>
    ) => {
      const safeProject = await assertRegisteredProject(projectPath);
      return await buildAgentContext({ projectPath: safeProject, taskId, enabledParts: contextParts });
    }
  );

  // Claude Bridge Handlers
  ipcMain.handle('claudeBridge:getAllProjectStatuses', async () => {
    return claudeBridgeService.getAllProjectStatuses();
  });

  ipcMain.handle('claudeBridge:getProjectStatus', async (_event, projectPath: string) => {
    return claudeBridgeService.getProjectStatus(projectPath);
  });

  ipcMain.handle('claudeBridge:sendApprovalResponse', async (_event, requestId: string, response: { approved: boolean; text?: string }) => {
    // Вызов идёт из окна ProjectHub через preload — источник указываем явно (TASK-86).
    return claudeBridgeService.sendApprovalResponse(requestId, response, { kind: 'local' });
  });

  ipcMain.handle('claudeBridge:getSubagents', async (_event, projectPath: string) => {
    return claudeBridgeService.getSubagents(projectPath);
  });

  ipcMain.handle('claudeBridge:getAvailableModels', async () => {
    return claudeBridgeService.getAvailableModels();
  });

  // Лимиты по аккаунтам (TASK-152.5): явный профиль, аккаунт проекта или профиль по умолчанию.
  ipcMain.handle('claudeBridge:getUsage', async (_event, forceRefresh = false, query?: { accountId?: string; projectPath?: string }) => {
    if (typeof query?.accountId === 'string' && query.accountId) {
      return await claudeUsageService.getUsage(forceRefresh === true, query.accountId);
    }
    return await claudeUsageService.getUsageForProject(
      typeof query?.projectPath === 'string' ? query.projectPath : undefined,
      forceRefresh === true
    );
  });

  // Multi-Agent Swarm (TASK-54)
  agentFleetService.on('swarmEvent', (event) => {
    // Карточки агентов видят главное окно и окна проектов (TASK-295).
    for (const win of ctx.getAppWindows()) win.webContents.send('swarm:event', event);
  });

  ipcMain.handle('swarm:startFanOut', async (_event, options: StartFanOutOptions) => {
    const safeProject = await assertRegisteredProject(options.projectPath);
    return await agentFleetService.startFanOut({ ...options, projectPath: safeProject });
  });

  ipcMain.handle('swarm:startHandoff', async (_event, options: StartHandoffOptions) => {
    const safeProject = await assertRegisteredProject(options.projectPath);
    return await agentFleetService.startHandoff({ ...options, projectPath: safeProject });
  });

  // Цикл «до готовности» (TASK-75, decision-28)
  ipcMain.handle('swarm:startDoneLoop', async (_event, options: StartDoneLoopOptions) => {
    const safeProject = await assertRegisteredProject(options.projectPath);
    try {
      return await agentFleetService.startDoneLoop({ ...options, projectPath: safeProject });
    } catch (err) {
      return appErrorFields(err);
    }
  });

  ipcMain.handle('doneLoop:getConfig', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await loadDoneLoopSettings(safeProject);
  });

  // Планировщик подзадач (TASK-80, decision-49)
  planService.on('planEvent', (event) => {
    // Карточки агентов видят главное окно и окна проектов (TASK-295).
    for (const win of ctx.getAppWindows()) win.webContents.send('plan:event', event);
  });

  ipcMain.handle('plan:generate', async (_event, options: GeneratePlanOptions) => {
    const safeProject = await assertRegisteredProject(options.projectPath);
    try {
      return await planService.generatePlan({ ...options, projectPath: safeProject });
    } catch (err) {
      return appErrorFields(err);
    }
  });

  ipcMain.handle('plan:list', async (_event, projectPath?: string) => {
    const safeProject = projectPath ? await assertRegisteredProject(projectPath) : undefined;
    return planService.listPlans(safeProject);
  });

  ipcMain.handle('plan:getForTask', async (_event, projectPath: string, taskId: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    const plan = planService.getPlanForTask(safeProject, taskId);
    if (plan) await planService.refreshGraph(plan);
    return plan ?? null;
  });

  // Чем план будет построен и исполнен при текущих настройках (decision-75)
  ipcMain.handle('plan:models', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    try {
      return await planService.previewModels(safeProject);
    } catch (err) {
      return appErrorFields(err);
    }
  });

  ipcMain.handle('plan:approve', async (_event, planId: string) => planService.approvePlan(planId));

  ipcMain.handle('plan:stop', async (_event, planId: string) => planService.stopPlan(planId));

  ipcMain.handle('plan:skipNode', async (_event, planId: string, taskId: string, skipped: boolean) =>
    planService.skipNode(planId, taskId, skipped)
  );

  ipcMain.handle('plan:resolveConflict', async (_event, planId: string, taskId: string, action: ConflictResolution) =>
    planService.resolveConflict(planId, taskId, action)
  );

  ipcMain.handle('plan:discard', async (_event, planId: string) => planService.discardPlan(planId));

  // Запуск агента, назначенного на задачу через assignee (decision-9 п.4, TASK-60)
  ipcMain.handle(
    'swarm:runAssigned',
    async (
      _event,
      options: { projectPath: string; taskId: string; taskTitle?: string; prompt: string; roleSlug: string; hostId?: string }
    ) => {
      const safeProject = await assertRegisteredProject(options.projectPath);

      // Назначение на другую машину (TASK-66, decision-11 п.5): запускаем агента там через
      // hub-соединение. Маршрутизация живёт здесь, а не в agentFleetService: тот отвечает за
      // локальных агентов и ничего не должен знать о федерации.
      const localHostId = remoteControlService.getHostId();
      if (options.hostId && options.hostId !== localHostId) {
        if (!federationClientService.isConnected(options.hostId)) {
          return appErrorFields(new AppError('swarm.hostNotConnected', { hostId: options.hostId }));
        }
        try {
          const result = await federationClientService.call<{ swarmId: string; status: string; hostId: string }>(
            options.hostId,
            'start_assigned_agent',
            {
              projectPath: options.projectPath,
              taskId: options.taskId,
              taskTitle: options.taskTitle,
              prompt: options.prompt,
              roleSlug: options.roleSlug,
              hostId: options.hostId
            }
          );
          return { remote: true, hostId: options.hostId, swarmId: result?.swarmId, status: result?.status };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return appErrorFields(new AppError('swarm.remoteStartFailed', { hostId: options.hostId, detail }));
        }
      }

      return await agentFleetService.startAssignedAgent({ ...options, projectPath: safeProject });
    }
  );

  ipcMain.handle('swarm:stop', async (_event, swarmId: string) => {
    return agentFleetService.stopSwarm(swarmId);
  });

  ipcMain.handle('swarm:pickWinner', async (_event, swarmId: string, winnerAgentId: string, mergeIntoBase = true) => {
    return await agentFleetService.pickWinner(swarmId, winnerAgentId, mergeIntoBase);
  });

  ipcMain.handle('swarm:get', async (_event, swarmId: string) => {
    return agentFleetService.getSwarm(swarmId);
  });

  // Автосудья арены (TASK-61, decision-12)
  ipcMain.handle('swarm:runJudge', async (_event, swarmId: string, options?: RunJudgeOptions) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    const state = await agentFleetService.runJudge(swarmId, {
      rerunChecks: options?.rerunChecks === true,
      skipReview: options?.skipReview === true
    });
    if (!state) return { success: false, ...appErrorFields(new AppError('swarm.notArena')) };
    return { success: true, state };
  });

  ipcMain.handle('swarm:cancelJudge', async (_event, swarmId: string) => {
    if (typeof swarmId !== 'string') return false;
    return agentFleetService.cancelJudge(swarmId);
  });

  ipcMain.handle('swarm:compose', async (_event, swarmId: string, selections: ComposeSelection[]) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    if (!Array.isArray(selections)) return { success: false, error: 'File list is missing' };
    return await agentFleetService.composeFromCandidates(swarmId, selections);
  });

  ipcMain.handle('arena:getConfig', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await loadArenaConfig(safeProject);
  });

  ipcMain.handle(
    'arena:saveConfig',
    async (_event, projectPath: string, patch: { checks?: CheckDefinition[]; arena?: ArenaSettings }) => {
      const safeProject = await assertRegisteredProject(projectPath);
      const ok = await saveArenaConfig(safeProject, patch ?? {});
      return { success: ok, config: ok ? await loadArenaConfig(safeProject) : undefined };
    }
  );

  // Артефакты проверок ui-smoke (TASK-78, decision-55 п. 5): только из <userData>/visual, путь проверяет сервис.
  ipcMain.handle('visual:readArtifact', async (_event, relPath: string) => {
    if (typeof relPath !== 'string') return { error: 'Invalid path' };
    return await visualArtifactService.readImage(relPath);
  });

  ipcMain.handle('visual:revealArtifact', async (_event, relPath: string) => {
    if (typeof relPath !== 'string') return false;
    const abs = await visualArtifactService.resolveExisting(relPath);
    if (!abs) return false;
    shell.showItemInFolder(abs);
    return true;
  });

  ipcMain.handle('swarm:list', async (_event, projectPath?: string) => {
    const safeProject = projectPath ? await assertRegisteredProject(projectPath) : undefined;
    await agentFleetService.ready;
    return agentFleetService.listSwarms(safeProject);
  });

  // Персистентность, транскрипты и экспорт swarm-сессий (TASK-56)
  ipcMain.handle('swarm:resume', async (_event, swarmId: string) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    return await agentFleetService.resumeSwarm(swarmId);
  });

  ipcMain.handle('swarm:discard', async (_event, swarmId: string, cleanupWorktrees = true) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    const projectPath = agentFleetService.getSwarm(swarmId)?.projectPath;
    const result = await agentFleetService.discardSwarm(swarmId, cleanupWorktrees !== false);
    // Удаление сессии добавляет ref результатов — тогда же и очистка по сроку и лимиту проекта (TASK-238).
    if (result.success && projectPath) void pruneProjectResults(projectPath).catch((err) => console.warn('[aiIpc] Result cleanup failed:', err));
    return result;
  });

  /**
   * Ref результатов общие на весь git-репозиторий: в нём может лежать несколько проектов (монорепо, инфраструктура
   * подпапкой). Поэтому живые — сессии всех проектов, а не только этого: чужую открытую сессию очистка не тронет.
   */
  const liveResultSessions = () => new Set(agentFleetService.listSwarms().map((s) => resultRefSessionPart(s.id)));

  /** Очистка ref результатов по настройке проекта; ref живых сессий не трогаются. */
  const pruneProjectResults = async (projectPath: string) => {
    const { resultRetention } = await loadArenaConfig(projectPath);
    return await pruneAgentResults(projectPath, resultRetention, liveResultSessions());
  };

  // Сохранённые результаты агентов (TASK-238): список, восстановление в ветку, удаление, очистка по сроку.
  ipcMain.handle('swarm:listResults', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    await agentFleetService.ready;
    const live = liveResultSessions();
    const results = (await listAgentResults(safeProject)).map((r) => ({ ...r, live: live.has(r.sessionId) }));
    return { results, retention: (await loadArenaConfig(safeProject)).resultRetention };
  });

  ipcMain.handle('swarm:restoreResult', async (_event, projectPath: string, ref: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    if (typeof ref !== 'string') throw new AppError('swarm.resultNotFound', { ref: String(ref) });
    return await restoreAgentResult(safeProject, ref);
  });

  ipcMain.handle('swarm:deleteResult', async (_event, projectPath: string, ref: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    if (typeof ref !== 'string') throw new AppError('swarm.resultNotFound', { ref: String(ref) });
    await deleteAgentResult(safeProject, ref);
    return { success: true };
  });

  ipcMain.handle('swarm:pruneResults', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    await agentFleetService.ready;
    const removed = await pruneProjectResults(safeProject);
    return { removed: removed.length };
  });

  ipcMain.handle('swarm:readTranscript', async (_event, swarmId: string, agentId: string) => {
    if (typeof swarmId !== 'string' || typeof agentId !== 'string') return null;
    return await agentFleetService.readTranscript(swarmId, agentId);
  });

  // Таймлайн, откат к чекпоинту, продолжение агента и трасса JSONL (TASK-72, decision-45)
  ipcMain.handle('swarm:getTimeline', async (_event, swarmId: string, agentId: string) => {
    if (typeof swarmId !== 'string' || typeof agentId !== 'string') return null;
    return await agentFleetService.getTimeline(swarmId, agentId);
  });

  ipcMain.handle('swarm:rewind', async (_event, swarmId: string, agentId: string, checkpoint: number) => {
    if (typeof swarmId !== 'string' || typeof agentId !== 'string' || !Number.isInteger(checkpoint)) {
      return { success: false, error: 'Invalid arguments' };
    }
    return await agentFleetService.rewindAgent(swarmId, agentId, checkpoint);
  });

  ipcMain.handle('swarm:continueAgent', async (_event, swarmId: string, agentId: string, instruction?: string) => {
    if (typeof swarmId !== 'string' || typeof agentId !== 'string') return { success: false, error: 'Invalid arguments' };
    return await agentFleetService.continueAgent(swarmId, agentId, typeof instruction === 'string' ? instruction : undefined);
  });

  ipcMain.handle('swarm:exportTrace', async (_event, swarmId: string, agentId?: string) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    const content = await agentFleetService.exportTrace(swarmId, typeof agentId === 'string' ? agentId : undefined);
    if (content === null) return { success: false, ...appErrorFields(new AppError('swarm.traceNotFound', { id: swarmId })) };
    const win = ctx.getDialogWindow();
    const dialogOptions = {
      title: hostText(getHostLanguage()).dialogs.exportTrace,
      defaultPath: `${swarmId}${typeof agentId === 'string' ? `-${agentId}` : ''}.trace.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('swarm:export', async (_event, swarmId: string, format: SwarmExportFormat) => {
    if (typeof swarmId !== 'string') return null;
    return agentFleetService.exportSession(swarmId, format === 'json' ? 'json' : 'markdown');
  });

  ipcMain.handle('swarm:exportToFile', async (_event, swarmId: string, format: SwarmExportFormat) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    const fmt: SwarmExportFormat = format === 'json' ? 'json' : 'markdown';
    const content = agentFleetService.exportSession(swarmId, fmt);
    if (content === null) return { success: false, error: `Swarm session ${swarmId} not found` };
    const win = ctx.getDialogWindow();
    const ext = fmt === 'json' ? 'json' : 'md';
    const dialogOptions = {
      title: hostText(getHostLanguage()).dialogs.exportSwarm,
      defaultPath: `${swarmId}.${ext}`,
      filters: fmt === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
    };
    const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}
