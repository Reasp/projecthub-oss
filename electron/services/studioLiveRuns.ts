import type { AgentLaunchContext, LiveAgentRun } from '../extensions/editionRegistry';

/**
 * Идущие ответы Agents Studio для ограничений запуска (decision-135, ограничение «сессии Studio не учитываются
 * лимитом одновременных агентов»): лимит участника общего хоста и бюджеты видят их рядом с агентами флота.
 * Запись появляется, когда ограничения пропустили промпт, и уходит по концу ответа — `onComplete`/`onError`
 * (их же вызывает отмена). Ответ, чей конец не пришёл, перестаёт считаться, когда сессия больше не активна.
 */
const runs = new Map<string, LiveAgentRun>();
const STARTUP_GRACE_MS = 10_000;

export const studioLiveRuns = {
  start(ctx: AgentLaunchContext, sessionId: string, startedAt: number): void {
    runs.set(sessionId, {
      startedAt,
      projectPath: ctx.projectPath,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      engine: ctx.engine,
      ...(ctx.model ? { model: ctx.model } : {}),
      origin: 'studio',
      ...(ctx.memberId ? { memberId: ctx.memberId } : {}),
      sessionId,
      agentId: sessionId,
      status: 'running'
    });
  },

  finish(sessionId: string): void {
    runs.delete(sessionId);
  },

  /**
   * `isActive` — сессия ещё идёт (`claudeBridgeService.isSessionActive`): страховка от потерянного конца ответа. Сессия
   * регистрируется в мосте чуть позже записи, поэтому первые секунды запись считается и без него.
   */
  list(isActive: (sessionId: string) => boolean, now = Date.now()): LiveAgentRun[] {
    for (const [id, run] of [...runs.entries()]) if (!isActive(id) && now - run.startedAt > STARTUP_GRACE_MS) runs.delete(id);
    return [...runs.values()];
  },

  /** Только для тестов. */
  clear(): void {
    runs.clear();
  }
};
