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
