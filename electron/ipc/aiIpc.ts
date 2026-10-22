import { ipcMain, shell, dialog } from 'electron';
import fs from 'node:fs/promises';
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
import type { RunJudgeOptions } from '../services/arenaJudgeService';
import { loadArenaConfig, saveArenaConfig } from '../services/arenaConfig';
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
import { providerErrorInfoOf } from '../services/providerErrors';
import { usesClaudeCli } from '../services/modelTarget';
import { hitlService } from '../services/hitlService';
import { editionRegistry, type AgentLaunchContext } from '../extensions/editionRegistry';
import { studioLiveRuns } from '../services/studioLiveRuns';
import type { IpcContext } from './types';

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
  const trusted = editionRegistry.launcherProfile(req.memberId)?.trusted === true;
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
      throw new Error('Сначала сохраните настройки Agents Studio с этим провайдером, затем перенесите его в профиль.');
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
        ok: false,
        error: err instanceof Error ? err.message : String(err),
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

  // Streaming & Session Lifecycle
  ipcMain.handle('ai:abortStream', async (_event, sessionId: string) => {
    aiAgentService.abortStream(sessionId);
    claudeBridgeService.abortSession(sessionId);
    return true;
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
  ipcMain.handle('ai:streamChat', async (_event, rawReq: AIStreamRequest) => {
    let req = rawReq;
    const targetWin = ctx.getMainWindow();
    if (!targetWin) return;
    const send = (channel: string, payload: unknown, extra?: unknown) => {
      if (!targetWin.isDestroyed()) {
        if (extra === undefined) targetWin.webContents.send(channel, payload);
        else targetWin.webContents.send(channel, payload, extra);
      }
    };

    // Поток любой сессии Studio дублируется сопряжённым телефонам в сокращённом виде (TASK-140.10, decision-83).
    studioRemoteBridge.streamStarted(req.projectPath, req.sessionId);
    // Ограничения запуска (бюджеты Team, decision-124): исчерпанный бюджет не пускает новый промпт.
    const launchCtx = studioLaunchContext(req);
    const launch = await editionRegistry.checkAgentLaunch(launchCtx);
    if (!launch.allowed) {
      const message = launch.reason || 'Запуск агента запрещён ограничениями';
      send(`ai:error:${req.sessionId}`, message);
      studioRemoteBridge.streamEnded(req.projectPath, req.sessionId, message);
      return;
    }
    try {
      req = await applyStudioMember(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(`ai:error:${req.sessionId}`, message);
      studioRemoteBridge.streamEnded(req.projectPath, req.sessionId, message);
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
          studioRemoteBridge.streamChunk(req.projectPath, req.sessionId, chunk);
        },
        (fullMsg) => {
          studioLiveRuns.finish(req.sessionId);
          send(`ai:complete:${req.sessionId}`, fullMsg);
          studioRemoteBridge.streamEnded(req.projectPath, req.sessionId);
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
          studioRemoteBridge.streamEnded(req.projectPath, req.sessionId, info?.message || err);
        }
      );
    } catch (err: any) {
      const info = providerErrorInfoOf(err);
      const message = info?.message || err?.message || String(err);
      studioLiveRuns.finish(req.sessionId);
      console.error(`[Main] ai:streamChat failed for session ${req.sessionId}: ${message}`);
      claudeBridgeService.setProjectStatus(req.projectPath, 'error', { code: 'failed', detail: message });
      send(`ai:error:${req.sessionId}`, message, info);
      studioRemoteBridge.streamEnded(req.projectPath, req.sessionId, message);
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
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('swarm:event', event);
    }
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
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('doneLoop:getConfig', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await loadDoneLoopSettings(safeProject);
  });

  // Планировщик подзадач (TASK-80, decision-49)
  planService.on('planEvent', (event) => {
    const win = ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('plan:event', event);
    }
  });

  ipcMain.handle('plan:generate', async (_event, options: GeneratePlanOptions) => {
    const safeProject = await assertRegisteredProject(options.projectPath);
    try {
      return await planService.generatePlan({ ...options, projectPath: safeProject });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
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
      return { error: err instanceof Error ? err.message : String(err) };
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
          return { error: `Хост ${options.hostId} не подключён. Добавьте его в «Удалённые хосты» и дождитесь соединения.` };
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
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Не удалось запустить агента на хосте ${options.hostId}: ${message}` };
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
    if (!state) return { success: false, error: 'Сессия не найдена или не является ареной (fan-out)' };
    return { success: true, state };
  });

  ipcMain.handle('swarm:cancelJudge', async (_event, swarmId: string) => {
    if (typeof swarmId !== 'string') return false;
    return agentFleetService.cancelJudge(swarmId);
  });

  ipcMain.handle('swarm:compose', async (_event, swarmId: string, selections: ComposeSelection[]) => {
    if (typeof swarmId !== 'string') return { success: false, error: 'Invalid swarm id' };
    if (!Array.isArray(selections)) return { success: false, error: 'Не передан список файлов' };
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
    return await agentFleetService.discardSwarm(swarmId, cleanupWorktrees !== false);
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
    if (content === null) return { success: false, error: `Трасса сессии ${swarmId} не найдена` };
    const win = ctx.getMainWindow();
    const dialogOptions = {
      title: 'Экспорт трассы агента',
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
    const win = ctx.getMainWindow();
    const ext = fmt === 'json' ? 'json' : 'md';
    const dialogOptions = {
      title: 'Экспорт swarm-сессии',
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
