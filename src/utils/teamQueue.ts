import type { RemoteQueueItem, RemoteQueueView, RemoteTaskSummary } from '../types/remote';
import type { AppErrorLabels } from '../i18n/appErrorText';
import { appFailureText } from '../lib/appErrorText';

/**
 * Клиент участника общего хоста (TASK-142.5, decision-84 п. 3, 6): чистые правила для телефона и ПК в hub-режиме —
 * чья задача, где она в очереди слияния, что ждёт моего ревью, почему задачу вернули.
 */

/** Исполнитель-человек задачи без `@`; агенты (`agent:…`) — инструменты участника, не владельцы. */
export function taskHolder(task: Pick<RemoteTaskSummary, 'assignee'>): string | undefined {
  const human = (task.assignee ?? []).map((a) => a.trim()).find((a) => a && !a.toLowerCase().startsWith('agent:'));
  return human ? human.replace(/^@+/, '') : undefined;
}

export function isMyTask(task: Pick<RemoteTaskSummary, 'assignee'>, me: string | undefined): boolean {
  return Boolean(me) && taskHolder(task) === me;
}

const ACTIVE = new Set(['queued', 'building', 'checking', 'review', 'merging']);

export interface TaskQueueState {
  /** Элемент задачи, который сейчас в очереди, и его место (1 — первый). */
  active?: RemoteQueueItem & { position: number };
  /** Последний завершённый заход задачи: слита, возвращена, снята. */
  last?: RemoteQueueItem;
}

export function taskQueueState(view: RemoteQueueView | null | undefined, taskId: string): TaskQueueState {
  if (!view) return {};
  const id = taskId.toUpperCase();
  const index = view.active.findIndex((i) => i.taskId.toUpperCase() === id && ACTIVE.has(i.status));
  const last = [...view.finished].filter((i) => i.taskId.toUpperCase() === id).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  return {
    ...(index >= 0 ? { active: { ...view.active[index], position: index + 1 } } : {}),
    ...(last ? { last } : {})
  };
}

/** Элементы, ждущие ревью, которые могу одобрить я: не мои (или мои, если проект разрешил самоодобрение). */
export function reviewableByMe(view: RemoteQueueView | null | undefined, me: string | undefined): RemoteQueueItem[] {
  if (!view || !me) return [];
  return view.active.filter((i) => i.status === 'review' && (i.authorId !== me || view.settings.allowSelfReview));
}

/** Мои элементы в очереди с местом: автору видно, сколько перед ним. */
export function myQueueItems(view: RemoteQueueView | null | undefined, me: string | undefined): Array<RemoteQueueItem & { position: number }> {
  if (!view || !me) return [];
  return view.active.map((i, idx) => ({ ...i, position: idx + 1 })).filter((i) => i.authorId === me);
}

/**
 * Почему задачу вернули: причина очереди, конфликт, упавшие проверки, неотмеченные критерии, секреты, слова ревьюера —
 * по строке на причину, как в заметке задачи. Причина очереди — по коду на языке клиента (`labels`), без кода — текст хоста.
 */
export function returnReasons(item: RemoteQueueItem, labels: AppErrorLabels): string[] {
  const out: string[] = [];
  if (item.report) out.push(appFailureText({ error: item.report, errorKey: item.reportKey }, labels));
  if (item.conflicts?.length) out.push(`${item.base}: ${item.conflicts.join(', ')}`);
  for (const c of item.checks ?? []) {
    if (c.blocking && /^(failed|timeout|error)$/.test(c.status)) out.push(`${c.name}${c.summary ? `: ${c.summary}` : ''}`);
  }
  if (item.criteria?.missing.length) out.push(...item.criteria.missing);
  if (item.secrets) out.push(item.secrets);
  if (item.review && !item.review.approved && item.review.comment) out.push(`${item.review.by}: ${item.review.comment}`);
  return [...new Set(out)];
}

/** Почему очередь на паузе — на языке клиента. */
export function pausedReason(paused: { reason: string; reasonKey?: unknown }, labels: AppErrorLabels): string {
  return appFailureText({ error: paused.reason, errorKey: paused.reasonKey }, labels);
}
