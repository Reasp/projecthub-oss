/**
 * Метка задачи, заведённой агентом и ещё не подтверждённой человеком (TASK-153, decision-89).
 *
 * Чистый модуль без Electron/React: общий для рендерера (бейдж и кнопка «Подтвердить») и main-процесса
 * (политика `agentTaskPolicy.ts`, автозапуск назначенных задач).
 */
export const AGENT_CREATED_LABEL = 'agent-created';

const isAgentCreatedLabel = (label: unknown) => String(label ?? '').trim().toLowerCase() === AGENT_CREATED_LABEL;

/** Задача ждёт подтверждения человека: стоит метка `agent-created`. */
export function isAwaitingApproval(labels: readonly unknown[] | null | undefined): boolean {
  return (labels ?? []).some(isAgentCreatedLabel);
}

/** Метки без `agent-created`: для показа рядом с отдельным бейджем и для подтверждения. */
export function withoutApprovalLabel<T extends string>(labels: readonly T[]): T[] {
  return labels.filter((l) => !isAgentCreatedLabel(l));
}

/** Ключ автора для сравнения: `agent:Manager ` и `agent:manager` — один агент. */
export function reporterKey(reporter: unknown): string {
  return String(reporter ?? '').trim().toLowerCase();
}

/** Один и тот же автор задачи. Пустой автор ни с кем не совпадает: «подтвердить все» без автора не сработает. */
export function sameReporter(a: unknown, b: unknown): boolean {
  const key = reporterKey(a);
  return key !== '' && key === reporterKey(b);
}

interface PendingTaskLike {
  labels?: readonly unknown[] | null;
  reporter?: unknown;
}

/** Задачи, которые ждут подтверждения человека. */
export function pendingAgentTasks<T extends PendingTaskLike>(tasks: readonly T[]): T[] {
  return tasks.filter((t) => isAwaitingApproval(t.labels));
}

/** Неподтверждённые задачи этого автора: для «Подтвердить все задачи этого агента». */
export function pendingTasksOfReporter<T extends PendingTaskLike>(tasks: readonly T[], reporter: unknown): T[] {
  return pendingAgentTasks(tasks).filter((t) => sameReporter(t.reporter, reporter));
}

/**
 * Неподтверждённые задачи по авторам: больше задач — выше, при равенстве — по имени. Задачи без автора
 * (метку поставили руками) в группы не попадают: подтверждать их пачкой не от чьего имени.
 */
export function pendingByReporter<T extends PendingTaskLike>(tasks: readonly T[]): Array<{ reporter: string; tasks: T[] }> {
  const groups = new Map<string, { reporter: string; tasks: T[] }>();
  for (const task of pendingAgentTasks(tasks)) {
    const key = reporterKey(task.reporter);
    if (!key) continue;
    const group = groups.get(key) ?? { reporter: String(task.reporter).trim(), tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.tasks.length - a.tasks.length || a.reporter.localeCompare(b.reporter));
}
