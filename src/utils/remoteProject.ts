import type { RemoteStudioSessionSummary } from '../types/remote';
import type { OverviewSession } from './fleetOverview';

/**
 * Экран проекта удалённого ПК (TASK-229): строки сессий и статусы задач по ответам RPC его хоста. Без React и Electron.
 */

/** Статусы Backlog.md для смены из карточки — в порядке процесса (decision-162); свой статус задачи остаётся в списке. */
export const REMOTE_TASK_STATUSES = ['To Do', 'In Progress', 'InProgress(Human)', 'Review', 'Review(Human)', 'Done'];

export function taskStatusOptions(current: string): string[] {
  return current && !REMOTE_TASK_STATUSES.includes(current) ? [...REMOTE_TASK_STATUSES, current] : REMOTE_TASK_STATUSES;
}

/** Сессия Studio из `studio_list_sessions` как строка сводки — её открывает тот же вид удалённой сессии. */
export function studioSessionRow(summary: RemoteStudioSessionSummary): OverviewSession {
  return {
    kind: 'studio',
    id: summary.id,
    title: summary.title,
    state: summary.running ? 'running' : 'idle',
    updatedAt: summary.updatedAt,
    ...(summary.preview ? { detail: summary.preview } : {})
  };
}

/** Открытые вкладки Studio хоста — сверху по свежести, закрытые (история) — отдельно, тоже по свежести. */
export function splitStudioSessions(sessions: readonly RemoteStudioSessionSummary[]): {
  open: RemoteStudioSessionSummary[];
  history: RemoteStudioSessionSummary[];
} {
  const byRecent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  return { open: byRecent.filter((s) => !s.archived), history: byRecent.filter((s) => s.archived) };
}

/** Название новой сессии до ответа хоста: начало промпта одной строкой. */
export function pendingSessionTitle(prompt: string, max = 60): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
