import type { AISession } from '../types/electron';

/**
 * Вкладка-ответвление `/fork` и `/branch` (TASK-283, decision-204): копия ленты, агента, дерева, задачи и контекста
 * исходной вкладки. Разговор CLI тот же, но с `claudeCliForkPending`: первый ход уйдёт с `--fork-session` и получит
 * свою сессию, исходная сессия CLI не меняется. У вкладки без сессии CLI ответвлять нечего — `null`.
 */
export function forkedSession(source: AISession, fork: { id: string; title: string; now: number }): AISession | null {
  if (!source.claudeCliSessionId) return null;
  return {
    id: fork.id,
    title: fork.title,
    createdAt: fork.now,
    messages: (source.messages || []).map((m) => ({ ...m, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((tc) => ({ ...tc })) } : {}) })),
    claudeCliSessionId: source.claudeCliSessionId,
    ...(source.claudeCliCwd ? { claudeCliCwd: source.claudeCliCwd } : {}),
    claudeCliForkPending: true,
    // Ответвление откаченной вкладки (TASK-284) начинается с того же места разговора.
    ...(source.claudeCliForkPending && source.claudeCliResumeAt ? { claudeCliResumeAt: source.claudeCliResumeAt } : {}),
    ...(source.agent ? { agent: { ...source.agent } } : {}),
    ...(source.worktree ? { worktree: { ...source.worktree } } : {}),
    ...(source.activeTaskId ? { activeTaskId: source.activeTaskId } : {}),
    ...(source.contextParts ? { contextParts: { ...source.contextParts } } : {}),
    ...(source.lastSelection ? { lastSelection: { ...source.lastSelection } } : {}),
    ...(source.lastMode ? { lastMode: source.lastMode } : {})
  };
}

/** Место вкладки-ответвления — сразу за исходной. */
export function insertAfter(sessions: AISession[], sourceId: string, fork: AISession): AISession[] {
  const idx = sessions.findIndex((s) => s.id === sourceId);
  if (idx === -1) return [...sessions, fork];
  return [...sessions.slice(0, idx + 1), fork, ...sessions.slice(idx + 1)];
}
