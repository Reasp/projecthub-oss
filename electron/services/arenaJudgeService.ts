/**
 * Автосудья Swarm Arena (decision-12, TASK-61).
 *
 * Оркестрация поверх чистых модулей: `arenaChecks` (что запускать и как разбирать вывод),
 * `arenaScoring` (как считать балл) и `reviewerPrompt` (о чём спрашивать ревьюера). Здесь —
 * только побочные эффекты: запуск проверок в worktree кандидатов, метрики диффа, вызов LLM и
 * сборка `JudgeState`. Слияние сюда не входит: финальное решение принимает человек, а авто-мердж
 * выполняет `agentFleetService` по вердикту `autoMergeDecision`.
 *
 * Сервис ничего не знает про `agentFleetService` (иначе получился бы цикл импортов): состояние
 * сессии он меняет напрямую, а наружу сообщает через хуки `onUpdate`/`log`.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { checkDetailOf, executeCheck } from './checkRunner.js';
import { AppError } from '../../src/lib/appError.js';
import { visualArtifactService } from './visualArtifactService.js';
import type { AIMessage } from './aiAgentService.js';
import { loadRoles } from './roleService.js';
import { modelCallService } from './modelCallService.js';
import { describeResolvedModel, type ResolvedModel } from './modelRouter.js';
import { reviewerSlotTarget, targetFromRole } from './modelTarget.js';
import { findTaskFile } from './taskFileLookup.js';
import { parseTaskBody, stripCriterionPrefix } from './backlogTaskFormat.js';
import { fetchDiffImpact } from './gitNexusClient.js';
import { loadArenaConfig } from './arenaConfig.js';
import { summarizeCheckResult } from './arenaChecks.js';
import { autoMergeDecision, recommendCandidate, scoreCandidates, type CandidateScoreInput } from './arenaScoring.js';
import { buildReviewerPrompt, parseReviewerResponse } from './reviewerPrompt.js';
import { securityScoreInput, securitySummaryText } from './slotSecurity.js';
import { maskSecretsInPatch } from './diffSecretScan.js';
import type { ArenaConfig, CheckDefinition, CheckRunResult, JudgeState, ReviewerVerdict } from './arenaTypes.js';
import type { AgentSlotState, SwarmSession } from './swarmTypes.js';
import { providerErrorInfoOf } from './providerErrors.js';

/** Сколько ждать ответа ревьюера, прежде чем признать отзыв несостоявшимся. */
export const REVIEWER_TIMEOUT_MS = 5 * 60 * 1000;

export interface JudgeHooks {
  /** Состояние сессии изменилось — отдать его в UI и на диск. */
  onUpdate: (agentId?: string) => void;
  /** Строка в лог конкретного агента арены. */
  log: (agent: AgentSlotState, line: string) => void;
}

export interface RunJudgeOptions {
  /** Прогонять проверки заново, даже если у кандидата уже есть результаты. */
  rerunChecks?: boolean;
  /** Не спрашивать ревьюера (быстрый прогон только объективных метрик). */
  skipReview?: boolean;
}

/** Кандидаты, которых имеет смысл судить: с рабочим деревом и завершённой работой. */
export function judgeableAgents(session: SwarmSession): AgentSlotState[] {
  return session.agents.filter(
    (a) => (a.status === 'completed' || a.status === 'failed' || a.status === 'budget_exceeded') && !a.worktreeMissing
  );
}

/**
 * Модули, затронутые диффом: два первых сегмента пути каждого файла. Считается локально по
 * патчу и не зависит от GitNexus — метрика локальности должна работать в любом проекте.
 */
export function modulesFromPatch(patch: string): string[] {
  const modules = new Set<string>();
  for (const line of (patch ?? '').split('\n')) {
    if (!line.startsWith('diff --git')) continue;
    const parts = line.split(' ');
    const file = parts[2]?.replace(/^a\//, '');
    if (!file) continue;
    const segments = file.split('/');
    modules.add(segments.length > 1 ? segments.slice(0, Math.min(2, segments.length - 1)).join('/') : '.');
  }
  return [...modules];
}

/** Файлы, изменённые кандидатом (для частичной сборки результата и отображения). */
export function filesFromPatch(patch: string): string[] {
  const files: string[] = [];
  for (const line of (patch ?? '').split('\n')) {
    if (!line.startsWith('diff --git')) continue;
    const file = line.split(' ')[2]?.replace(/^a\//, '');
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/** Выполняет задачи пачками по `limit` — проверки нескольких кандидатов не должны съесть машину. */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length || 1)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export class ArenaJudgeService {
  /** Отмена прогона по swarmId (остановка сессии, закрытие приложения). */
  private controllers = new Map<string, AbortController>();

  public isRunning(swarmId: string): boolean {
    return this.controllers.has(swarmId);
  }

  public cancelJudge(swarmId: string): boolean {
    const controller = this.controllers.get(swarmId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  public cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  public loadConfig(projectPath: string): Promise<ArenaConfig> {
    return loadArenaConfig(projectPath);
  }

  /**
   * Полный прогон судьи по сессии: проверки → метрики диффа → ревью → скоринг → рекомендация.
   * Ошибка на любом кандидате не роняет прогон: она оседает в его результатах, остальные судятся.
   */
  public async runJudge(session: SwarmSession, hooks: JudgeHooks, options: RunJudgeOptions = {}): Promise<JudgeState> {
    if (this.controllers.has(session.id)) {
      return session.judge ?? { status: 'running' };
    }
    const controller = new AbortController();
    this.controllers.set(session.id, controller);

    const judge: JudgeState = { status: 'running', startedAt: Date.now(), stage: 'checks' };
    session.judge = judge;
    hooks.onUpdate();

    try {
      const config = await this.loadConfig(session.projectPath);
      judge.weights = config.weights;

      const candidates = judgeableAgents(session);
      if (candidates.length === 0) {
        judge.status = 'done';
        judge.finishedAt = Date.now();
        judge.error = 'Нет завершённых кандидатов с рабочим деревом';
        return judge;
      }

      await this.runAllChecks(session, candidates, config, hooks, controller.signal, options.rerunChecks === true);
      if (controller.signal.aborted) return this.markCancelled(judge);

      judge.stage = 'diff';
      hooks.onUpdate();
      await this.collectDiffMetrics(session, candidates, hooks);
      if (controller.signal.aborted) return this.markCancelled(judge);

      const criteria = await this.loadAcceptanceCriteria(session);

      if (config.reviewer.enabled && options.skipReview !== true) {
        judge.stage = 'review';
        hooks.onUpdate();
        await this.runReviews(session, candidates, config, criteria, hooks, controller.signal);
      } else {
        for (const agent of candidates) {
          agent.review = { agentId: agent.id, status: 'skipped' };
        }
      }
      if (controller.signal.aborted) return this.markCancelled(judge);

      judge.stage = 'scoring';
      this.score(session, candidates, config);

      const scores = candidates.map((a) => a.score!).filter(Boolean);
      const recommendation = recommendCandidate(scores);
      judge.recommendedAgentId = recommendation.agentId;

      const checksByAgent: Record<string, CheckRunResult[]> = {};
      for (const agent of candidates) checksByAgent[agent.id] = agent.checks ?? [];
      const securityByAgent = Object.fromEntries(candidates.map((a) => [a.id, securityScoreInput(a.security)]));
      const auto = autoMergeDecision(scores, checksByAgent, config.autoMerge, securityByAgent);
      judge.autoMerge = {
        enabled: config.autoMerge.enabled,
        attempted: false,
        merged: false,
        ...(auto.agentId ? { agentId: auto.agentId } : {}),
        reason: auto.reason
      };

      judge.status = 'done';
      judge.stage = undefined;
      judge.finishedAt = Date.now();
      return judge;
    } catch (err) {
      judge.status = 'failed';
      judge.stage = undefined;
      judge.finishedAt = Date.now();
      judge.error = err instanceof Error ? err.message : String(err);
      console.error('[ArenaJudge] Прогон судьи завершился ошибкой:', err);
      return judge;
    } finally {
      this.controllers.delete(session.id);
      hooks.onUpdate();
    }
  }

  private markCancelled(judge: JudgeState): JudgeState {
    judge.status = 'cancelled';
    judge.stage = undefined;
    judge.finishedAt = Date.now();
    return judge;
  }

  // ───────────────────────────────── Проверки ─────────────────────────────────

  private async runAllChecks(
    session: SwarmSession,
    candidates: AgentSlotState[],
    config: ArenaConfig,
    hooks: JudgeHooks,
    signal: AbortSignal,
    rerun: boolean
  ): Promise<void> {
    const enabled = config.checks.filter((c) => c.enabled !== false);
    if (enabled.length === 0) {
      for (const agent of candidates) {
        if (!agent.checks || rerun) agent.checks = [];
      }
      hooks.onUpdate();
      return;
    }

    interface Job {
      agent: AgentSlotState;
      result: CheckRunResult;
      workdir?: string;
      timeoutMs?: number;
      command: string;
      portStrategy?: 'fixed' | 'auto';
      port?: number;
      artifacts?: CheckDefinition['artifacts'];
    }
    const jobs: Job[] = [];
    // Артефакты ui-smoke этого прогона судьи — отдельный каталог на кандидата (decision-55 п. 5).
    const judgeRun = `judge-${Date.now()}`;
    const scope = visualArtifactService.swarmScope(session.id);

    for (const agent of candidates) {
      if (agent.checks && agent.checks.length > 0 && !rerun) continue;
      const workdir = agent.worktreePath || session.projectPath;
      const usable = existsSync(workdir);
      agent.checks = enabled.map((def) => ({
        id: def.id,
        kind: def.kind,
        name: def.name,
        command: def.command,
        status: usable ? ('pending' as const) : ('skipped' as const),
        blocking: def.blocking !== false,
        ...(usable ? {} : checkDetailOf(new AppError('processes.cwdNotFound', { path: workdir })))
      }));
      if (!usable) {
        hooks.log(agent, `[Судья] Проверки пропущены: каталог ${workdir} не найден.`);
        continue;
      }
      agent.checks.forEach((result, i) => {
        jobs.push({
          agent,
          result,
          workdir,
          command: enabled[i].command,
          timeoutMs: enabled[i].timeoutMs,
          portStrategy: enabled[i].portStrategy,
          port: enabled[i].port,
          artifacts: enabled[i].artifacts
        });
      });
    }

    hooks.onUpdate();
    if (jobs.length === 0) return;

    await runWithConcurrency(
      jobs.map((job) => async () => {
        if (signal.aborted) {
          job.result.status = 'skipped';
          job.result.detail = 'Прогон судьи отменён';
          return;
        }
        const running = executeCheck(job.result, job, job.workdir!, signal, {
          artifacts: { scope, agentId: job.agent.id, run: judgeRun }
        });
        hooks.onUpdate(job.agent.id);
        hooks.log(job.agent, `[Судья] Проверка «${job.result.name}»: ${job.command}`);
        await running;

        hooks.log(job.agent, `[Судья] «${job.result.name}» → ${summarizeCheckResult(job.result)}`);
        hooks.onUpdate(job.agent.id);
      }),
      config.maxConcurrentChecks
    );
  }

  // ──────────────────────────── Метрики диффа ────────────────────────────

  private async collectDiffMetrics(
    session: SwarmSession,
    candidates: AgentSlotState[],
    hooks: JudgeHooks
  ): Promise<void> {
    const repoName = path.basename(path.normalize(session.projectPath));
    for (const agent of candidates) {
      const patch = agent.diffSummary?.patch;
      if (!agent.diffSummary) continue;
      agent.diffSummary.modules = modulesFromPatch(patch ?? '');

      const workdir = agent.worktreePath || session.projectPath;
      if (!existsSync(workdir)) continue;
      try {
        const impact = await fetchDiffImpact({ cwd: workdir, baseRef: session.baseBranch, repo: repoName });
        if (impact?.changedSymbols !== undefined) {
          agent.diffSummary.dependentSymbols = impact.changedSymbols;
          agent.diffSummary.affectedProcesses = impact.affectedProcesses;
          agent.diffSummary.riskLevel = impact.riskLevel;
          hooks.log(
            agent,
            `[Судья] GitNexus: задето символов ${impact.changedSymbols}` +
              (impact.affectedProcesses !== undefined ? `, потоков выполнения ${impact.affectedProcesses}` : '') +
              (impact.riskLevel ? `, риск ${impact.riskLevel}` : '')
          );
        }
      } catch (err) {
        console.warn('[ArenaJudge] Не удалось получить impact из GitNexus:', err);
      }
    }
    hooks.onUpdate();
  }

  /** Критерии приёмки задачи Backlog.md — по ним ревьюер выносит вердикты (AC #3). */
  private async loadAcceptanceCriteria(session: SwarmSession): Promise<string[]> {
    if (!session.taskId) return [];
    try {
      const file = await findTaskFile(session.projectPath, session.taskId);
      if (!file) return [];
      const { criteria } = parseTaskBody(file.content);
      return criteria.map((c) => stripCriterionPrefix(c.text)).filter(Boolean);
    } catch (err) {
      console.warn('[ArenaJudge] Не удалось прочитать критерии приёмки задачи:', err);
      return [];
    }
  }

  // ───────────────────────────── LLM-ревьюер ─────────────────────────────

  private async runReviews(
    session: SwarmSession,
    candidates: AgentSlotState[],
    config: ArenaConfig,
    criteria: string[],
    hooks: JudgeHooks,
    signal: AbortSignal
  ): Promise<void> {
    const role = await this.resolveReviewerRole(session.projectPath, config.reviewer.roleSlug);
    // Модель выбирает резолвер (TASK-134.4, decision-99): `arena.reviewer` проекта → роль → назначение
    // «Арена: ревьюер» → основная модель. Claude Code по подписке тоже годится — ход идёт через CLI.
    const resolved = await modelCallService.resolve({
      purpose: 'arena.reviewer',
      slot: reviewerSlotTarget(config.reviewer, role),
      role: targetFromRole(role)
    });
    const reviewerModel = resolved.model ?? describeResolvedModel(resolved);
    if (resolved.problem) {
      for (const agent of candidates) {
        agent.review = { agentId: agent.id, status: 'failed', model: reviewerModel, error: resolved.problem.message, errorKey: resolved.problem.messageKey };
        hooks.log(agent, `[Судья] Ревьюер недоступен: ${resolved.problem.message}`);
        hooks.onUpdate(agent.id);
      }
      return;
    }
    // API-путь — с нулевой температурой: ответ ревьюера разбирается как структура.
    const reviewer: ResolvedModel = resolved.config ? { ...resolved, config: { ...resolved.config, temperature: 0 } } : resolved;

    for (const agent of candidates) {
      if (signal.aborted) return;
      agent.review = { agentId: agent.id, status: 'running', model: reviewerModel };
      hooks.onUpdate(agent.id);

      const prompt = buildReviewerPrompt({
        taskId: session.taskId,
        taskTitle: session.taskTitle,
        prompt: session.prompt,
        criteria,
        agentName: agent.config.name,
        agentRole: agent.config.role,
        // Значения секретов стороннему LLM не отдаём: сканер уже нашёл их — маскируем (decision-56 п. 6).
        diffPatch: agent.security?.secrets.length ? maskSecretsInPatch(agent.diffSummary?.patch ?? '') : agent.diffSummary?.patch ?? '',
        securitySummary: securitySummaryText(agent.security),
        diffSummary: agent.diffSummary
          ? {
              filesChanged: agent.diffSummary.filesChanged,
              insertions: agent.diffSummary.insertions,
              deletions: agent.diffSummary.deletions
            }
          : undefined,
        checks: agent.checks ?? []
      });

      const startedAt = Date.now();
      try {
        const { text, costUsd } = await this.askReviewer(session, agent, prompt, reviewer, role, signal);
        const parsed = parseReviewerResponse(text, criteria);
        const verdict: ReviewerVerdict = {
          agentId: agent.id,
          status: parsed.ok ? 'done' : 'failed',
          model: reviewerModel,
          durationMs: Date.now() - startedAt,
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(parsed.summary ? { summary: parsed.summary } : {}),
          ...(parsed.overall !== undefined ? { overall: parsed.overall } : {}),
          criteria: parsed.criteria,
          findings: parsed.findings,
          risks: parsed.risks,
          ...(parsed.ok ? {} : { error: parsed.parseError, raw: text.slice(0, 4000) })
        };
        agent.review = verdict;
        hooks.log(
          agent,
          parsed.ok
            ? `[Судья] Ревью получено: замечаний ${parsed.findings.length}, критериев оценено ${parsed.criteria.length}.`
            : `[Судья] Ревью не разобрано: ${parsed.parseError}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const providerError = signal.aborted ? undefined : providerErrorInfoOf(err);
        agent.review = {
          agentId: agent.id,
          status: signal.aborted ? 'skipped' : 'failed',
          model: reviewerModel,
          durationMs: Date.now() - startedAt,
          error: message,
          ...(providerError ? { providerError } : {})
        };
        hooks.log(agent, `[Судья] Ревьюер недоступен: ${message}`);
      }
      hooks.onUpdate(agent.id);
    }
  }

  private async resolveReviewerRole(projectPath: string, slug: string) {
    try {
      const { roles } = await loadRoles(projectPath);
      return roles.find((r) => r.slug === slug);
    } catch (err) {
      console.warn(`[ArenaJudge] Роль "${slug}" не загрузилась:`, err);
      return undefined;
    }
  }

  /**
   * Один ход LLM-ревьюера. Ревьюер только читает: инструменты записи и команд ему не даются,
   * `projectPath` указывает на worktree кандидата, а сам дифф уже в промпте.
   */
  private async askReviewer(
    session: SwarmSession,
    agent: AgentSlotState,
    prompt: string,
    resolved: ResolvedModel,
    role: { slug?: string; systemPrompt?: string } | undefined,
    signal: AbortSignal
  ): Promise<{ text: string; costUsd?: number }> {
    const messages: AIMessage[] = [
      { id: `msg-${Date.now()}`, role: 'user', content: prompt, timestamp: new Date().toISOString() }
    ];
    const { text, costUsd } = await modelCallService.turn({
      purpose: 'arena.reviewer',
      resolved,
      sessionId: `judge-${agent.id}`,
      projectPath: agent.worktreePath || session.projectPath,
      messages,
      ...(role?.systemPrompt ? { roleSystemPrompt: role.systemPrompt } : {}),
      ...(role?.slug ? { roleSlug: role.slug } : {}),
      ...(session.taskId ? { taskId: session.taskId } : {}),
      timeoutMs: REVIEWER_TIMEOUT_MS,
      signal
    });
    return { text, ...(costUsd !== undefined ? { costUsd } : {}) };
  }

  // ─────────────────────────────── Скоринг ───────────────────────────────

  private score(session: SwarmSession, candidates: AgentSlotState[], config: ArenaConfig): void {
    const inputs: CandidateScoreInput[] = candidates.map((agent) => ({
      agentId: agent.id,
      checks: agent.checks ?? [],
      ...(agent.review?.criteria ? { criteria: agent.review.criteria } : {}),
      ...(agent.review?.overall !== undefined ? { reviewOverall: agent.review.overall } : {}),
      ...(agent.review?.findings ? { reviewFindings: agent.review.findings } : {}),
      reviewFailed: agent.review?.status === 'failed' || agent.review?.status === 'skipped',
      ...(agent.diffSummary
        ? {
            diff: {
              filesChanged: agent.diffSummary.filesChanged,
              insertions: agent.diffSummary.insertions,
              deletions: agent.diffSummary.deletions,
              modules: agent.diffSummary.modules?.length,
              dependents: agent.diffSummary.dependentSymbols
            }
          }
        : {}),
      ...(typeof (agent.metrics.usage?.costUsd ?? agent.metrics.costUsd) === 'number'
        ? { costUsd: agent.metrics.usage?.costUsd ?? agent.metrics.costUsd }
        : {}),
      ...(typeof agent.metrics.durationMs === 'number' ? { durationMs: agent.metrics.durationMs } : {}),
      ...(agent.security ? { security: securityScoreInput(agent.security) } : {})
    }));

    const scores = scoreCandidates(inputs, config.weights);
    for (const score of scores) {
      const agent = candidates.find((a) => a.id === score.agentId);
      if (agent) agent.score = score;
    }
    // Кандидаты вне выборки (прерванные, без worktree) не должны показывать устаревший балл.
    for (const agent of session.agents) {
      if (!candidates.includes(agent)) agent.score = undefined;
    }
  }
}

export const arenaJudgeService = new ArenaJudgeService();
