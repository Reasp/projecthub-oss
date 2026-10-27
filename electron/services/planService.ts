/**
 * Планировщик подзадач (TASK-80, decision-49).
 *
 * Контур: роль `architect` возвращает план → подзадачи создаются в `backlog/tasks` → человек
 * утверждает граф → диспетчер запускает готовые узлы в режиме «до готовности» (каждый в своём
 * worktree от интеграционной ветки) → результат узла сливается в интеграционную ветку →
 * зависимые стартуют → итог в родительской задаче.
 *
 * Источник истины по составу плана — файлы задач: граф перечитывается из `backlog/tasks` перед
 * каждым решением, здесь хранится только состояние исполнения. Чистая логика (схема плана,
 * готовность узлов, исход) — в `planSchema.ts` и `planDispatcher.ts`; этот сервис лишь исполняет
 * их решения. В базовую ветку проекта планировщик не сливает никогда (правило 9 infra-dev).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { agentFleetService } from './agentFleetService.js';
import type { AIMessage } from './aiAgentService.js';
import { appEventBus } from './eventBus.js';
import { createBacklogTaskFile } from './backlogTaskCreate.js';
import { applyFinalSummary, normalizeFrontmatter, parseTaskBody, withUpdatedDate } from './backlogTaskFormat.js';
import { readBacklogConfig } from './backlogConfigService.js';
import { buildAgentContext } from './contextBuilder.js';
import { execGit, type GitRunner } from './checkpointGit.js';
import { renumberHitlLines, dropRenumberedBranch, mergeMessageWithRenumber, prepareIncomingForMerge, type PreparedIncoming } from './backlogMerge.js';
import { findReviewStatus } from './doneLoop.js';
import { hitlService } from './hitlService.js';
import { answeredOption, keyedHitlText } from './hitlText.js';
import type { HitlTextLine } from './hitlTypes.js';
import { modelCallService } from './modelCallService.js';
import { modelRouteView, slotFieldsFromResolved, type ModelRouteView } from './modelRouter.js';
import { targetFromRole, targetFromSlot } from './modelTarget.js';
import { providerErrorInfoOf } from './providerErrors.js';
import { loadRoles } from './roleService.js';
import type { RoleDefinition } from './roleTypes.js';
import { findTaskFile } from './taskFileLookup.js';
import { worktreeService } from './worktreeService.js';
import {
  MAX_PLAN_ATTEMPTS,
  buildPlanInstructions,
  parseAgentPlan,
  planRetryPrompt,
  topoOrder
} from './planSchema.js';
import {
  DEFAULT_PLAN_MAX_PARALLEL,
  blockDependents,
  blockUnreachable,
  decidePlanStep,
  graphHash,
  planProgress
} from './planDispatcher.js';
import { PlanStore } from './planStore.js';
import type { AgentPlan, PlanNode, PlanOutcome, PlanSettings, PlanState } from './planTypes.js';
import { AppError, appErrorFields, appErrorKeyOf, type AppErrorKey } from '../../src/lib/appError.js';
import type { AgentSlotConfig, SwarmEventPayload, SwarmSession } from './swarmTypes.js';

/** Сколько ждём ответа роли `architect` на одну попытку. */
const ARCHITECT_TIMEOUT_MS = 5 * 60 * 1000;
/** Сколько символов патча уходит в карточку HITL при конфликте слияния. */
const CONFLICT_PATCH_LIMIT = 20_000;

export interface GeneratePlanOptions {
  projectPath: string;
  taskId: string;
  taskTitle?: string;
  settings?: Partial<PlanSettings>;
}

/** Что человек решил по конфликту слияния узла. */
/** `renumber` — повтор слияния с перенумерацией backlog ветки узла (decision-76). */
export type ConflictResolution = 'retry' | 'skip' | 'stop' | 'renumber';

interface PlanDeps {
  fleet: Pick<typeof agentFleetService, 'startDoneLoop' | 'getSwarm' | 'stopSwarm' | 'on'>;
  git: (cwd: string, args: string[]) => Promise<string>;
  /** Выбор модели по назначению и ход архитектора (decision-74, decision-75). */
  models: Pick<typeof modelCallService, 'resolve' | 'turn'>;
}

const defaultDeps: PlanDeps = {
  fleet: agentFleetService,
  git: (cwd, args) => execGit(args, { cwd }),
  models: modelCallService
};

/** Роль архитектора и роль исполнителя узлов, если в настройках плана не задана другая. */
const ARCHITECT_ROLE = 'architect';
const NODE_ROLE = 'implementer';

/** Чем план будет построен и исполнен при текущих настройках — для панели до запуска. */
export interface PlanModelsPreview {
  architect: ModelRouteView;
  node: ModelRouteView;
}

type ReasonSource = AppError | Error | string | { error: string; errorKey?: AppErrorKey } | unknown;

/** Причина узла или плана: английский текст и код (decision-165); строка или ошибка без кода — текст как есть. */
function reasonFields(source: ReasonSource): { reason: string; reasonKey?: AppErrorKey } {
  if (typeof source === 'string') return { reason: source };
  if (source && typeof source === 'object' && 'error' in source && typeof (source as { error: unknown }).error === 'string') {
    const { error, errorKey } = source as { error: string; errorKey?: AppErrorKey };
    return errorKey ? { reason: error, reasonKey: errorKey } : { reason: error };
  }
  const { error, errorKey } = appErrorFields(source);
  return errorKey ? { reason: error, reasonKey: errorKey } : { reason: error };
}

function setReason(target: { reason?: string; reasonKey?: AppErrorKey }, source: ReasonSource | undefined): void {
  if (source === undefined) {
    target.reason = undefined;
    target.reasonKey = undefined;
    return;
  }
  const fields = reasonFields(source);
  target.reason = fields.reason;
  target.reasonKey = fields.reasonKey;
}

/** Причина сбоя для подстановки в ошибку плана: код, если он есть, иначе текст. */
function causeOf(err: unknown): AppErrorKey | string {
  return appErrorKeyOf(err) ?? (err instanceof Error ? err.message : String(err));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'plan';
}

function isClosedStatus(status: unknown): boolean {
  return typeof status === 'string' && status.trim().toLowerCase() === 'done';
}


/**
 * Запись файла задачи через временный файл и rename: `writeFile` сначала обнуляет файл, и параллельное
 * чтение (вотчер задач, UI, тест) видит пустую задачу. Так же пишет заметку хода `taskSessionNote`.
 */
async function writeTaskFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export class PlanService extends EventEmitter {
  private plans = new Map<string, PlanState>();
  /** Планы, для которых прямо сейчас крутится диспетчер: решения не должны пересекаться. */
  private dispatching = new Set<string>();
  /** Очередь слияний по плану: интеграционный worktree один, параллельные merge в нём недопустимы. */
  private mergeQueues = new Map<string, Promise<void>>();
  private subscribed = false;

  private readonly deps: PlanDeps;

  constructor(
    private readonly store: PlanStore = new PlanStore(),
    deps: Partial<PlanDeps> = {}
  ) {
    super();
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Читает планы с диска и подписывается на события сессий узлов. */
  public async init(): Promise<PlanState[]> {
    const stored = await this.store.list();
    for (const plan of stored) {
      // Узлы, чьи сессии не пережили перезапуск, возвращаются в очередь: работа осталась в их
      // ветке, но управлять чужой прерванной сессией планировщик не может.
      for (const node of plan.nodes) {
        if (node.state === 'running' || node.state === 'merging' || node.state === 'completed') {
          const session = node.swarmId ? this.deps.fleet.getSwarm(node.swarmId) : undefined;
          if (!session || session.status !== 'running') {
            node.state = 'pending';
            setReason(node, new AppError('plans.nodeInterrupted'));
          }
        }
      }
      this.plans.set(plan.id, plan);
    }
    this.subscribe();
    return this.listPlans();
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.deps.fleet.on('swarmEvent', (event: SwarmEventPayload) => {
      if (!event.session) return;
      if (event.type !== 'swarm_completed' && event.type !== 'swarm_updated') return;
      this.onSessionUpdate(event.session);
    });
  }

  public listPlans(projectPath?: string): PlanState[] {
    const all = Array.from(this.plans.values());
    const filtered = projectPath ? all.filter((p) => p.projectPath === projectPath) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  public getPlan(planId: string): PlanState | undefined {
    return this.plans.get(planId);
  }

  public getPlanForTask(projectPath: string, taskId: string): PlanState | undefined {
    return this.listPlans(projectPath).find((p) => p.taskId.toLowerCase() === taskId.toLowerCase());
  }

  private emitPlan(plan: PlanState, immediate = false): void {
    plan.updatedAt = Date.now();
    this.emit('planEvent', { type: 'plan_updated', planId: plan.id, plan });
    if (immediate) {
      this.store.save(plan).catch((e) => console.warn(`[PlanService] Не удалось сохранить план ${plan.id}:`, e));
    } else {
      this.store.scheduleSave(plan);
    }
  }

  // ───────────────────────────── Генерация плана ─────────────────────────────

  /**
   * Ход роли `architect` и создание подзадач. План создаётся в состоянии «ждёт утверждения»:
   * ни один узел не стартует, пока человек не подтвердит граф (decision-49 п. 5).
   */
  public async generatePlan(options: GeneratePlanOptions): Promise<PlanState> {
    const { projectPath, taskId } = options;
    const task = await findTaskFile(projectPath, taskId);
    if (!task) throw new AppError('plans.taskNotFound', { id: taskId });

    const existing = this.getPlanForTask(projectPath, taskId);
    if (existing && (existing.phase === 'planning' || existing.phase === 'running')) {
      throw new AppError('plans.alreadyActive', { id: taskId });
    }

    const settings: PlanSettings = {
      maxParallel: options.settings?.maxParallel ?? DEFAULT_PLAN_MAX_PARALLEL,
      ...(options.settings?.budgetUsd !== undefined ? { budgetUsd: options.settings.budgetUsd } : {}),
      ...(options.settings?.maxIterations !== undefined ? { maxIterations: options.settings.maxIterations } : {}),
      ...(options.settings?.checkIds ? { checkIds: options.settings.checkIds } : {}),
      ...(options.settings?.agent ? { agent: options.settings.agent } : {}),
      ...(options.settings?.architect ? { architect: options.settings.architect } : {})
    };

    const plan: PlanState = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectPath,
      taskId,
      taskTitle: options.taskTitle ?? (typeof task.data.title === 'string' ? task.data.title : undefined),
      phase: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings,
      nodes: [],
      architect: { attempts: 0 }
    };
    this.plans.set(plan.id, plan);
    this.emitPlan(plan, true);

    try {
      const { plan: agentPlan, costUsd } = await this.askArchitect(plan, task.content);
      plan.summary = agentPlan.summary;
      plan.architect.costUsd = costUsd;
      plan.totalCostUsd = costUsd;
      await this.createSubtasks(plan, agentPlan);
      plan.phase = 'awaiting_approval';
      this.emitPlan(plan, true);
    } catch (err) {
      plan.phase = 'failed';
      setReason(plan, err);
      // Ошибка выбора модели называет назначение: по нему панель ведёт в настройки.
      const purpose = providerErrorInfoOf(err)?.purpose;
      if (purpose) plan.reasonPurpose = purpose;
      this.emitPlan(plan, true);
    }
    return plan;
  }

  /**
   * Чем план будет построен и исполнен сейчас: назначения «архитектор» и «узлы плана» с учётом ролей.
   * Тир конкретной подзадачи здесь неизвестен — он уточняет модель узла при запуске.
   */
  public async previewModels(projectPath: string, settings?: Partial<PlanSettings>): Promise<PlanModelsPreview> {
    const [architectRole, nodeRole] = await Promise.all([
      this.findRole(projectPath, settings?.architect?.roleSlug ?? ARCHITECT_ROLE),
      this.findRole(projectPath, settings?.agent?.roleSlug ?? NODE_ROLE)
    ]);
    const [architect, node] = await Promise.all([
      this.deps.models.resolve({ purpose: 'plan.architect', slot: targetFromSlot(settings?.architect), role: targetFromRole(architectRole) }),
      this.deps.models.resolve({ purpose: 'plan.node', slot: targetFromSlot(settings?.agent), role: targetFromRole(nodeRole) })
    ]);
    return { architect: modelRouteView(architect), node: modelRouteView(node) };
  }

  private async findRole(projectPath: string, slugName: string): Promise<RoleDefinition | undefined> {
    try {
      const { roles } = await loadRoles(projectPath);
      return roles.find((r) => r.slug === slugName);
    } catch (err) {
      console.warn('[PlanService] Не удалось загрузить роли:', err);
      return undefined;
    }
  }

  /** Попытки получить валидный план: невалидный не создаёт подзадач, замечания уходят модели. */
  private async askArchitect(plan: PlanState, taskContent: string): Promise<{ plan: AgentPlan; costUsd?: number }> {
    const { criteria } = parseTaskBody(taskContent);
    const context = await buildAgentContext({ projectPath: plan.projectPath, taskId: plan.taskId });
    const instructions = buildPlanInstructions(plan.taskId, criteria.map((c) => c.text));

    const messages: AIMessage[] = [
      {
        id: 'plan-1',
        role: 'user',
        content: [context.combined, instructions].filter(Boolean).join('\n\n'),
        timestamp: new Date().toISOString()
      } as AIMessage
    ];

    // Модель выбирается один раз на все попытки: повторный запрос должен идти той же моделью.
    const role = await this.findRole(plan.projectPath, plan.settings.architect?.roleSlug ?? ARCHITECT_ROLE);
    const resolved = await this.deps.models.resolve({
      purpose: 'plan.architect',
      slot: targetFromSlot(plan.settings.architect),
      role: targetFromRole(role)
    });
    plan.architect.model = modelRouteView(resolved);

    let costUsd: number | undefined;
    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
      plan.architect.attempts = attempt;
      this.emitPlan(plan);

      const answer = await this.deps.models.turn({
        purpose: 'plan.architect',
        resolved,
        sessionId: `plan-${plan.id}`,
        projectPath: plan.projectPath,
        messages,
        ...(role?.systemPrompt ? { roleSystemPrompt: role.systemPrompt } : {}),
        ...(role?.slug ? { roleSlug: role.slug } : {}),
        // Контекст задачи уже в первом сообщении: `taskId` в ход не передаётся, иначе он попал бы в запрос дважды.
        timeoutMs: ARCHITECT_TIMEOUT_MS
      });
      if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;

      const parsed = parseAgentPlan(answer.text);
      if (parsed.ok) {
        plan.architect.errors = undefined;
        plan.architect.rawResponse = undefined;
        return { plan: parsed.plan, ...(costUsd !== undefined ? { costUsd } : {}) };
      }

      plan.architect.errors = parsed.errors;
      plan.architect.rawResponse = answer.text;
      this.emitPlan(plan);
      if (attempt === MAX_PLAN_ATTEMPTS) break;

      messages.push({ id: `plan-a${attempt}`, role: 'assistant', content: answer.text, timestamp: new Date().toISOString() } as AIMessage);
      messages.push({
        id: `plan-u${attempt}`,
        role: 'user',
        content: planRetryPrompt(parsed.errors, attempt, MAX_PLAN_ATTEMPTS),
        timestamp: new Date().toISOString()
      } as AIMessage);
    }

    throw new AppError('plans.invalidPlan', { attempts: MAX_PLAN_ATTEMPTS, errors: (plan.architect.errors ?? []).join('; ') });
  }

  /** Создаёт подзадачи Backlog.md по плану и записывает читаемый план в родительскую задачу. */
  private async createSubtasks(plan: PlanState, agentPlan: AgentPlan): Promise<void> {
    const order = topoOrder(agentPlan.subtasks);
    const byKey = new Map(agentPlan.subtasks.map((s) => [s.key, s]));
    const taskIdByKey = new Map<string, string>();
    const parentTask = await findTaskFile(plan.projectPath, plan.taskId);
    const milestone = typeof parentTask?.data.milestone === 'string' ? parentTask.data.milestone : undefined;

    for (const key of order) {
      const draft = byKey.get(key);
      if (!draft) continue;
      const created = await createBacklogTaskFile(plan.projectPath, {
        title: draft.title,
        description: draft.description,
        labels: draft.labels ?? [],
        acceptanceCriteria: draft.acceptanceCriteria,
        parentTaskId: plan.taskId,
        dependencies: draft.dependsOn.map((d) => taskIdByKey.get(d)).filter((id): id is string => Boolean(id)),
        ...(milestone ? { milestone } : {}),
        type: 'task'
      });
      if (!created) throw new AppError('plans.subtaskCreateFailed', { title: draft.title });
      taskIdByKey.set(key, created.id);

      plan.nodes.push({
        key,
        taskId: created.id,
        title: draft.title,
        state: 'pending',
        dependsOn: draft.dependsOn.map((d) => taskIdByKey.get(d)).filter((id): id is string => Boolean(id)),
        // Тира в формате задач Backlog.md нет, поэтому он живёт в состоянии плана (decision-75).
        ...(draft.modelTier ? { modelTier: draft.modelTier } : {})
      });
    }

    await this.writeParentPlanSection(plan, agentPlan);
  }

  /** Человекочитаемый план в секции `## Implementation Plan` родительской задачи. */
  private async writeParentPlanSection(plan: PlanState, agentPlan: AgentPlan): Promise<void> {
    const file = await findTaskFile(plan.projectPath, plan.taskId);
    if (!file) return;
    const lines = [
      agentPlan.summary,
      '',
      ...plan.nodes.map((node) => {
        const deps = node.dependsOn.length > 0 ? ` (после ${node.dependsOn.join(', ')})` : '';
        return `- ${node.taskId} — ${node.title}${deps}`;
      })
    ];
    const marker = '## Implementation Plan';
    const body = file.content.includes(marker)
      ? file.content.replace(new RegExp(`${marker}[\\s\\S]*?(?=\\n## |$)`), `${marker}\n\n${lines.join('\n')}\n\n`)
      : `${file.content.trimEnd()}\n\n${marker}\n\n${lines.join('\n')}\n`;
    const data = withUpdatedDate(normalizeFrontmatter(file.data));
    await writeTaskFileAtomic(file.filePath, matter.stringify(body, data));
  }

  // ───────────────────────── Утверждение и запуск ─────────────────────────

  /** Утверждение графа человеком: фиксирует хэш и запускает диспетчер. */
  public async approvePlan(planId: string): Promise<{ success: boolean; error?: string }> {
    const plan = this.plans.get(planId);
    if (!plan) return { success: false, ...appErrorFields(new AppError('plans.notFound', { id: planId })) };
    if (plan.phase === 'planning') return { success: false, ...appErrorFields(new AppError('plans.stillGenerating')) };

    await this.refreshGraph(plan);
    plan.approvedGraphHash = graphHash(plan.nodes);
    plan.approvedAt = Date.now();
    plan.stopped = false;
    plan.phase = 'running';
    plan.outcome = undefined;
    setReason(plan, undefined);

    try {
      await this.ensureIntegrationBranch(plan);
    } catch (err) {
      plan.phase = 'failed';
      setReason(plan, new AppError('plans.integrationBranchFailed', { detail: causeOf(err) }));
      this.emitPlan(plan, true);
      return { success: false, error: plan.reason ?? '', ...(plan.reasonKey ? { errorKey: plan.reasonKey } : {}) };
    }

    this.emitPlan(plan, true);
    void this.dispatch(plan.id);
    return { success: true };
  }

  /** Пометить узел пропущенным (или вернуть в план) до старта. */
  public skipNode(planId: string, taskId: string, skipped: boolean): { success: boolean; error?: string } {
    const plan = this.plans.get(planId);
    const node = plan?.nodes.find((n) => n.taskId === taskId);
    if (!plan || !node) return { success: false, ...appErrorFields(new AppError('plans.nodeNotFound')) };
    if (skipped && node.state !== 'pending') return { success: false, ...appErrorFields(new AppError('plans.skipOnlyPending')) };
    if (!skipped && node.state !== 'skipped') return { success: false, ...appErrorFields(new AppError('plans.nodeNotSkipped')) };
    node.state = skipped ? 'skipped' : 'pending';
    setReason(node, skipped ? new AppError('plans.skippedByHuman') : undefined);
    this.emitPlan(plan, true);
    return { success: true };
  }

  public stopPlan(planId: string): { success: boolean; error?: string } {
    const plan = this.plans.get(planId);
    if (!plan) return { success: false, ...appErrorFields(new AppError('plans.notFound', { id: planId })) };
    plan.stopped = true;
    for (const node of plan.nodes) {
      if (node.swarmId && (node.state === 'running' || node.state === 'completed')) {
        this.deps.fleet.stopSwarm(node.swarmId);
      }
    }
    this.emitPlan(plan, true);
    void this.dispatch(plan.id);
    return { success: true };
  }

  public async discardPlan(planId: string): Promise<{ success: boolean; error?: string }> {
    const plan = this.plans.get(planId);
    if (!plan) return { success: false, ...appErrorFields(new AppError('plans.notFound', { id: planId })) };
    if (plan.nodes.some((n) => n.state === 'running' || n.state === 'merging')) {
      return { success: false, ...appErrorFields(new AppError('plans.stopFirst')) };
    }
    this.plans.delete(planId);
    this.mergeQueues.delete(planId);
    await this.store.delete(planId);
    this.emit('planEvent', { type: 'plan_removed', planId });
    return { success: true };
  }

  // ───────────────────────────── Граф и ветки ─────────────────────────────

  /**
   * Пересчёт графа из файлов задач: подхватывает правки человека между генерацией и запуском
   * (переименование, изменение зависимостей, новые и удалённые подзадачи, закрытые вручную).
   */
  public async refreshGraph(plan: PlanState): Promise<void> {
    const subtasks = await this.readSubtasks(plan.projectPath, plan.taskId);
    const byId = new Map(subtasks.map((s) => [s.taskId.toUpperCase(), s]));
    const known = new Set(plan.nodes.map((n) => n.taskId.toUpperCase()));

    for (const node of plan.nodes) {
      const found = byId.get(node.taskId.toUpperCase());
      if (!found) {
        if (node.state !== 'merged' && node.state !== 'failed') {
          node.state = 'missing';
          setReason(node, new AppError('plans.subtaskDeleted'));
        }
        continue;
      }
      node.title = found.title;
      // Зависимости вне плана планировщик не отслеживает: он отвечает только за свои узлы.
      node.dependsOn = found.dependsOn.filter((d) => known.has(d.toUpperCase()));
      if (node.state === 'missing') node.state = 'pending';
      if (node.state === 'pending' && isClosedStatus(found.status)) {
        node.state = 'skipped';
        setReason(node, new AppError('plans.closedManually'));
      }
    }

    for (const sub of subtasks) {
      if (known.has(sub.taskId.toUpperCase())) continue;
      plan.nodes.push({
        key: sub.taskId.toLowerCase(),
        taskId: sub.taskId,
        title: sub.title,
        state: isClosedStatus(sub.status) ? 'skipped' : 'pending',
        dependsOn: sub.dependsOn.filter((d) => known.has(d.toUpperCase()) || d.toUpperCase() !== sub.taskId.toUpperCase()),
        ...(isClosedStatus(sub.status) ? reasonFields(new AppError('plans.closedManually')) : {})
      });
    }
  }

  /** Подзадачи родителя из `backlog/tasks` (нативный формат Backlog.md). */
  private async readSubtasks(
    projectPath: string,
    parentTaskId: string
  ): Promise<{ taskId: string; title: string; status?: string; dependsOn: string[] }[]> {
    const dir = path.join(projectPath, 'backlog', 'tasks');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: { taskId: string; title: string; status?: string; dependsOn: string[] }[] = [];
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf-8');
        const { data } = matter(raw);
        const parent = typeof data.parent_task_id === 'string' ? data.parent_task_id : undefined;
        if (!parent || parent.toUpperCase() !== parentTaskId.toUpperCase()) continue;
        const taskId = typeof data.id === 'string' ? data.id : '';
        if (!taskId) continue;
        out.push({
          taskId,
          title: typeof data.title === 'string' ? data.title : taskId,
          ...(typeof data.status === 'string' ? { status: data.status } : {}),
          dependsOn: Array.isArray(data.dependencies) ? data.dependencies.map((d: unknown) => String(d)) : []
        });
      } catch (err) {
        console.warn(`[PlanService] Пропущен файл подзадачи ${name}:`, err);
      }
    }
    return out.sort((a, b) => a.taskId.localeCompare(b.taskId, 'en', { numeric: true }));
  }

  /**
   * Интеграционная ветка плана со своим worktree. Своя ветка нужна именно с worktree: слияние
   * идёт внутри него, чтобы не чекаутить ветку в рабочем дереве человека (decision-49 п. 4).
   */
  private async ensureIntegrationBranch(plan: PlanState): Promise<void> {
    if (plan.integrationWorktree && (await this.pathExists(plan.integrationWorktree))) return;

    const branch = plan.integrationBranch ?? `plan/${slug(plan.taskId)}`;
    const base = (await this.deps.git(plan.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
    const branchExists = await this.deps
      .git(plan.projectPath, ['rev-parse', '--verify', '--quiet', branch])
      .then(() => true)
      .catch(() => false);

    const wt = await worktreeService.addWorktree(plan.projectPath, {
      branch,
      newBranch: !branchExists,
      ...(branchExists ? {} : { baseCommitOrBranch: base })
    });
    plan.integrationBranch = wt.branch || branch;
    plan.integrationWorktree = wt.path;
  }

  private pathExists(p: string): Promise<boolean> {
    return fs.access(p).then(() => true, () => false);
  }

  // ─────────────────────────────── Диспетчер ───────────────────────────────

  /** Один проход диспетчера: перечитать граф, запустить готовые узлы либо подвести итог. */
  private async dispatch(planId: string): Promise<void> {
    if (this.dispatching.has(planId)) return;
    this.dispatching.add(planId);
    try {
      for (;;) {
        const plan = this.plans.get(planId);
        if (!plan || plan.phase === 'finished' || plan.phase === 'failed') return;

        await this.refreshGraph(plan);
        // Узлы, чьи зависимости провалены или исчезли, блокируются сразу: иначе они остались бы
        // `pending` и план завершился бы, молча их потеряв.
        blockUnreachable(plan.nodes);
        const step = decidePlanStep({
          nodes: plan.nodes,
          maxParallel: plan.settings.maxParallel,
          ...(plan.settings.budgetUsd !== undefined ? { budgetUsd: plan.settings.budgetUsd } : {}),
          ...(plan.totalCostUsd !== undefined ? { totalCostUsd: plan.totalCostUsd } : {}),
          stopped: plan.stopped === true,
          approved: plan.approvedGraphHash !== undefined && plan.approvedGraphHash === graphHash(plan.nodes)
        });

        if (step.action === 'wait') {
          this.emitPlan(plan);
          return;
        }
        if (step.action === 'finish') {
          await this.finalize(plan, step.outcome, step.reason);
          return;
        }

        for (const taskId of step.taskIds) {
          const node = plan.nodes.find((n) => n.taskId === taskId);
          if (node) await this.startNode(plan, node);
        }
        this.emitPlan(plan, true);
        // Новый проход: занятые слоты изменились, а узлы могли упасть на старте.
      }
    } catch (err) {
      console.error(`[PlanService] Диспетчер плана ${planId} упал:`, err);
      const plan = this.plans.get(planId);
      if (plan) {
        plan.phase = 'failed';
        setReason(plan, err);
        this.emitPlan(plan, true);
      }
    } finally {
      this.dispatching.delete(planId);
    }
  }

  /**
   * Слот узла: движок и модель выбирает резолвер по назначению «узлы плана» — слот из настроек плана, роль
   * исполнителя, тир подзадачи, назначение, основная модель (decision-74, decision-75). `null` — цель
   * непригодна: причина уже записана в узел.
   */
  private async resolveNodeAgent(plan: PlanState, node: PlanNode): Promise<AgentSlotConfig | null> {
    const base = plan.settings.agent;
    const roleSlug = base?.roleSlug ?? NODE_ROLE;
    const role = await this.findRole(plan.projectPath, roleSlug);
    const resolved = await this.deps.models.resolve({
      purpose: 'plan.node',
      slot: targetFromSlot(base),
      role: targetFromRole(role),
      ...(node.modelTier ? { tierHint: node.modelTier } : {})
    });
    node.model = modelRouteView(resolved);
    if (resolved.problem) {
      node.state = 'failed';
      setReason(node, { error: resolved.problem.message, errorKey: resolved.problem.messageKey });
      node.reasonPurpose = resolved.purpose;
      node.finishedAt = Date.now();
      blockDependents(plan.nodes, node.taskId, new AppError('plans.blockedNotStarted', { id: node.taskId }));
      return null;
    }
    const fields = slotFieldsFromResolved(resolved);
    const providerConfig = { ...(base?.providerConfig ?? {}), ...(fields.providerConfig ?? {}) };
    return {
      ...(base ?? { name: node.title.slice(0, 40), roleSlug }),
      id: `plan-${node.taskId.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`,
      name: base?.name ?? node.title.slice(0, 40),
      engine: fields.engine,
      ...(Object.keys(providerConfig).length > 0 ? { providerConfig } : {}),
      ...(fields.modelTier ? { modelTier: fields.modelTier } : {})
    };
  }

  /** Запуск узла: обычная сессия «до готовности» от интеграционной ветки. */
  private async startNode(plan: PlanState, node: PlanNode): Promise<void> {
    node.reasonPurpose = undefined;
    const agent = await this.resolveNodeAgent(plan, node);
    if (!agent) return;

    const budgetLeft =
      plan.settings.budgetUsd !== undefined
        ? Math.max(0, plan.settings.budgetUsd - (plan.totalCostUsd ?? 0))
        : undefined;

    try {
      const session = await this.deps.fleet.startDoneLoop({
        projectPath: plan.projectPath,
        taskId: node.taskId,
        taskTitle: node.title,
        prompt: `Do subtask ${node.taskId} “${node.title}” from the plan of task ${plan.taskId}.`,
        agent,
        ...(plan.integrationBranch ? { baseBranch: plan.integrationBranch } : {}),
        useWorktrees: true,
        ...(plan.settings.maxIterations !== undefined ? { maxIterations: plan.settings.maxIterations } : {}),
        ...(plan.settings.checkIds ? { checkIds: plan.settings.checkIds } : {}),
        ...(budgetLeft !== undefined ? { budgetUsd: budgetLeft } : {})
      });
      node.swarmId = session.id;
      node.state = 'running';
      node.startedAt = Date.now();
      setReason(node, undefined);
    } catch (err) {
      node.state = 'failed';
      setReason(node, new AppError('plans.nodeStartFailed', { detail: causeOf(err) }));
      node.finishedAt = Date.now();
      blockDependents(plan.nodes, node.taskId, new AppError('plans.blockedNotStarted', { id: node.taskId }));
    }
  }

  /** Сессия узла завершилась: успех ведёт к слиянию, всё остальное — к блокировке зависимых. */
  private onSessionUpdate(session: SwarmSession): void {
    if (session.status === 'running' || session.status === 'preparing' || session.status === 'idle') return;
    for (const plan of this.plans.values()) {
      const node = plan.nodes.find((n) => n.swarmId === session.id);
      if (!node || node.state !== 'running') continue;

      node.costUsd = session.totalCostUsd;
      node.iterations = session.doneLoop?.iterations.length;
      node.branch = session.agents[0]?.worktreeBranch;
      node.finishedAt = Date.now();
      plan.totalCostUsd = (plan.architect.costUsd ?? 0) + plan.nodes.reduce((sum, n) => sum + (n.costUsd ?? 0), 0);

      if (session.status === 'completed' && session.doneLoop?.outcome === 'success') {
        node.state = 'completed';
        this.emitPlan(plan);
        void this.mergeNodeAndContinue(plan, node);
      } else {
        node.state = 'failed';
        if (session.error) setReason(node, { error: session.error, errorKey: session.errorKey });
        else if (session.doneLoop?.reason) setReason(node, session.doneLoop.reason);
        else setReason(node, new AppError('plans.nodeSessionEnded', { status: session.status }));
        const blocked = blockDependents(plan.nodes, node.taskId, new AppError('plans.blockedNotDone', { id: node.taskId }));
        this.notifyNodeFailed(plan, node, blocked.length);
        this.emitPlan(plan, true);
        void this.dispatch(plan.id);
      }
      return;
    }
  }

  private async mergeNodeAndContinue(plan: PlanState, node: PlanNode): Promise<void> {
    await this.withMergeLock(plan.id, () => this.mergeNode(plan, node));
    this.emitPlan(plan, true);
    void this.dispatch(plan.id);
  }

  /**
   * Слияния одного плана идут строго по очереди: интеграционный worktree один на план, и два
   * одновременных `git merge` в нём мешают друг другу — параллельные узлы завершаются почти
   * одновременно, и `merge --abort` одного обрывал бы слияние другого, оставляя дерево грязным
   * (найдено флаки-падением теста конфликта под полной нагрузкой, TASK-80.4).
   */
  private withMergeLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mergeQueues.get(planId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.mergeQueues.set(
      planId,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  /**
   * Слияние ветки узла в интеграционную — внутри её worktree, а не через `mergeWorktree`:
   * тот чекаутит целевую ветку в основном дереве проекта и не работает с веткой, занятой
   * worktree (decision-49 Context). Вызывать только под {@link withMergeLock}.
   */
  private async mergeNode(plan: PlanState, node: PlanNode): Promise<boolean> {
    if (!plan.integrationWorktree || !node.branch) {
      node.state = 'merged';
      setReason(node, node.branch ? undefined : new AppError('plans.noBranch'));
      return true;
    }
    node.state = 'merging';
    this.emitPlan(plan);

    const wt = plan.integrationWorktree;
    const git: GitRunner = (args, { cwd }) => this.deps.git(cwd, args);
    let prepared: PreparedIncoming | null = null;
    try {
      // Узлы плана — параллельные ветки: агенты могли завести одинаковые номера задач и решений (decision-76).
      prepared = await prepareIncomingForMerge(wt, node.branch, { approved: node.renumberApproved === true, git });
      if (prepared.status === 'needs-approval') {
        node.state = 'conflict';
        node.conflictFiles = [];
        node.renumberPending = prepared.preview.renumber.map(({ from, to }) => ({ from, to }));
        setReason(node, new AppError('plans.renumberNeeded', { list: prepared.preview.renumber.map((r) => `${r.from} → ${r.to}`).join(', ') }));
        void this.askAboutRenumber(plan, node, renumberHitlLines(prepared.preview));
        return false;
      }
      const message = mergeMessageWithRenumber(
        `plan(${plan.taskId}): ${node.taskId} — ${node.title}`,
        prepared.status === 'renumbered' ? prepared.preview.renumber : []
      );
      await this.deps.git(wt, ['merge', '--no-ff', '-m', message, prepared.mergeRef]);
      if (prepared.status === 'renumbered') await dropRenumberedBranch(wt, prepared.mergeRef, git);
      const head = (await this.deps.git(wt, ['rev-parse', 'HEAD'])).trim();
      node.state = 'merged';
      node.mergeCommit = head;
      node.conflictFiles = undefined;
      node.renumberPending = undefined;
      setReason(node, undefined);
      return true;
    } catch (err) {
      if (prepared?.status === 'renumbered') await dropRenumberedBranch(wt, prepared.mergeRef, git);
      const conflicts = await this.deps
        .git(wt, ['diff', '--name-only', '--diff-filter=U'])
        .then((out) => out.trim().split('\n').filter(Boolean))
        .catch(() => []);
      await this.deps.git(wt, ['merge', '--abort']).catch(() => undefined);
      node.state = 'conflict';
      node.conflictFiles = conflicts;
      setReason(
        node,
        conflicts.length > 0
          ? new AppError('plans.mergeConflict', { files: conflicts.join(', ') })
          : new AppError('plans.mergeFailed', { detail: causeOf(err) })
      );
      void this.askAboutConflict(plan, node);
      return false;
    }
  }

  /** Конфликт слияния — вопрос человеку (decision-10): разрешить и повторить, пропустить или остановить план. */
  private async askAboutConflict(plan: PlanState, node: PlanNode): Promise<void> {
    const patch = await this.deps
      .git(plan.integrationWorktree ?? plan.projectPath, ['diff', `HEAD...${node.branch}`, '--stat'])
      .catch(() => '');
    const request = {
      id: hitlService.newRequestId('plan'),
      sessionId: `plan-${plan.id}`,
      projectPath: plan.projectPath,
      type: 'question' as const,
      ...keyedHitlText(
        {
          code: 'plan_conflict',
          params: { task: node.taskId, files: (node.conflictFiles ?? []).join(', ') || '—' },
          lines: [
            { code: 'planNotMerged', params: { branch: node.branch ?? '', target: plan.integrationBranch ?? '' } },
            ...(node.conflictFiles?.length ? [{ code: 'planConflictFiles', params: { files: node.conflictFiles.join(', ') } }] : []),
            ...(patch ? [{ code: 'text', params: { text: `\n${patch.slice(0, CONFLICT_PATCH_LIMIT)}` } }] : [])
          ]
        },
        { options: ['retry', 'skip', 'stop'] }
      ),
      createdAt: Date.now(),
      origin: 'swarm' as const
    };

    try {
      const answer = await hitlService.request(request);
      // Окно и голос отвечают подписью варианта на своём языке — id ищется по словарям (TASK-202.8).
      const picked = answeredOption('plan_conflict', answer.text);
      const choice: ConflictResolution = picked === 'skip' || picked === 'stop' ? picked : 'retry';
      await this.resolveConflict(plan.id, node.taskId, answer.approved ? choice : 'skip');
    } catch (err) {
      console.warn(`[PlanService] Запрос по конфликту ${node.taskId} не получил ответа:`, err);
    }
  }

  /** Совпавшие номера backlog — вопрос человеку с планом замен (decision-76 п. 6): перенумеровать, пропустить, остановить. */
  private async askAboutRenumber(plan: PlanState, node: PlanNode, planLines: HitlTextLine[]): Promise<void> {
    const request = {
      id: hitlService.newRequestId('plan'),
      sessionId: `plan-${plan.id}`,
      projectPath: plan.projectPath,
      type: 'question' as const,
      ...keyedHitlText(
        { code: 'plan_renumber', params: { task: node.taskId, branch: node.branch ?? '' }, lines: planLines },
        { options: ['renumber', 'skip', 'stop'] }
      ),
      createdAt: Date.now(),
      origin: 'swarm' as const
    };
    try {
      const answer = await hitlService.request(request);
      const picked = answeredOption('plan_renumber', answer.text);
      const choice: ConflictResolution = picked === 'skip' || picked === 'stop' ? picked : 'renumber';
      await this.resolveConflict(plan.id, node.taskId, answer.approved ? choice : 'skip');
    } catch (err) {
      console.warn(`[PlanService] Запрос по номерам ${node.taskId} не получил ответа:`, err);
    }
  }

  /** Решение человека по конфликту слияния узла. */
  public async resolveConflict(
    planId: string,
    taskId: string,
    action: ConflictResolution
  ): Promise<{ success: boolean; error?: string }> {
    const plan = this.plans.get(planId);
    const node = plan?.nodes.find((n) => n.taskId === taskId);
    if (!plan || !node) return { success: false, ...appErrorFields(new AppError('plans.nodeNotFound')) };
    if (node.state !== 'conflict') return { success: false, ...appErrorFields(new AppError('plans.nodeNotInConflict')) };

    if (action === 'stop') {
      this.stopPlan(planId);
      return { success: true };
    }
    if (action === 'skip') {
      node.state = 'failed';
      setReason(node, new AppError('plans.skippedAfterConflict'));
      blockDependents(plan.nodes, node.taskId, new AppError('plans.blockedSkipped', { id: node.taskId }));
      this.emitPlan(plan, true);
      void this.dispatch(plan.id);
      return { success: true };
    }

    if (action === 'renumber') node.renumberApproved = true;
    node.state = 'completed';
    await this.withMergeLock(plan.id, () => this.mergeNode(plan, node));
    this.emitPlan(plan, true);
    void this.dispatch(plan.id);
    return { success: true };
  }

  // ─────────────────────────────── Итог плана ───────────────────────────────

  private async finalize(plan: PlanState, outcome: PlanOutcome, reason?: AppError): Promise<void> {
    plan.outcome = outcome;
    setReason(plan, reason);
    plan.completedAt = Date.now();

    try {
      await this.writeParentSummary(plan);
    } catch (err) {
      console.warn(`[PlanService] Не удалось записать итог плана в ${plan.taskId}:`, err);
    }
    // Фаза «завершён» — только после записи итога в задачу: кто ждёт завершения плана (UI, тесты),
    // должен видеть задачу уже с итогом.
    plan.phase = outcome === 'failed' ? 'failed' : 'finished';

    const progress = planProgress(plan.nodes);
    appEventBus.publish({
      type: 'swarm:finished',
      swarmId: plan.id,
      projectPath: plan.projectPath,
      name: `План ${plan.taskId}`,
      mode: 'plan',
      outcome: outcome === 'success' || outcome === 'partial' ? 'completed' : outcome === 'stopped' ? 'stopped' : 'failed',
      agentsTotal: progress.total,
      agentsFailed: progress.failed + progress.blocked,
      at: Date.now()
    });
    this.emitPlan(plan, true);
  }

  /** Сводка плана в родительской задаче и перевод её в `Review` (статус `Done` не ставится). */
  private async writeParentSummary(plan: PlanState): Promise<void> {
    const file = await findTaskFile(plan.projectPath, plan.taskId);
    if (!file) return;

    const progress = planProgress(plan.nodes);
    const rows = plan.nodes.map((node) => {
      const parts = [
        `- ${node.taskId} — ${node.title}: ${STATE_LABELS[node.state] ?? node.state}`,
        node.mergeCommit ? `коммит ${node.mergeCommit.slice(0, 7)}` : '',
        node.iterations ? `итераций ${node.iterations}` : '',
        node.costUsd ? `${node.costUsd.toFixed(2)} $` : '',
        node.reason ? `(${node.reason})` : ''
      ].filter(Boolean);
      return parts.join(', ');
    });

    const summary = [
      `План выполнен: ${OUTCOME_LABELS[plan.outcome ?? 'partial']}. Подзадач — ${progress.total}, влито — ${progress.merged}.`,
      plan.reason ? `\n${plan.reason}` : '',
      '',
      '**Подзадачи**',
      ...rows,
      '',
      plan.integrationBranch ? `**Интеграционная ветка**: \`${plan.integrationBranch}\` — слейте её сами, планировщик в базовую ветку не сливает.` : '',
      plan.totalCostUsd !== undefined ? `**Стоимость плана**: ${plan.totalCostUsd.toFixed(2)} $` : ''
    ]
      .filter((line) => line !== '')
      .join('\n');

    let body = applyFinalSummary(file.content, summary);
    const data = withUpdatedDate(normalizeFrontmatter(file.data));
    if (plan.outcome === 'success') {
      const backlogConfig = await readBacklogConfig(plan.projectPath);
      const review = findReviewStatus(backlogConfig.statuses);
      if (review) data.status = review;
    }
    body = body.endsWith('\n') ? body : `${body}\n`;
    await writeTaskFileAtomic(file.filePath, matter.stringify(body, data));
  }

  private notifyNodeFailed(plan: PlanState, node: PlanNode, blockedCount: number): void {
    appEventBus.publish({
      type: 'agent:failed',
      sessionId: `plan-${plan.id}`,
      projectPath: plan.projectPath,
      origin: 'swarm',
      engine: plan.settings.agent?.engine ?? 'api',
      agentId: node.taskId,
      agentName: node.title,
      at: Date.now(),
      error: `Subtask ${node.taskId} failed${blockedCount > 0 ? `, dependents blocked: ${blockedCount}` : ''}. ${node.reason ?? ''}`.trim()
    });
  }

  public async flush(): Promise<void> {
    await this.store.flush();
  }
}

const STATE_LABELS: Record<string, string> = {
  pending: 'не запускалась',
  running: 'выполняется',
  completed: 'выполнена, не слита',
  merging: 'сливается',
  merged: 'влита',
  conflict: 'конфликт слияния',
  failed: 'не выполнена',
  blocked: 'заблокирована',
  skipped: 'пропущена',
  missing: 'удалена из Backlog'
};

const OUTCOME_LABELS: Record<PlanOutcome, string> = {
  success: 'все подзадачи влиты',
  partial: 'выполнен частично',
  failed: 'провален',
  budget_exceeded: 'остановлен по бюджету',
  stopped: 'остановлен человеком'
};

export const planService = new PlanService();
