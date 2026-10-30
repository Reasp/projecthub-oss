/**
 * Список вызовов инструментов сообщения Agents Studio (TASK-103, decision-47 п. 7) — чистые функции без React.
 *
 * Один вызов приходит несколькими чанками `toolCall` с одним `id`: намерение модели (`pending`),
 * карточка с диффом, вывод команды (`running`), итог. Строка вызова обновляется на месте, а не
 * дописывается новой — иначе в списке шагов один вызов занимал бы несколько строк.
 */
import type { AIToolCall } from '../types/electron';

export function upsertToolCall(list: AIToolCall[] | undefined, call: AIToolCall): AIToolCall[] {
  const current = list ?? [];
  const idx = call.id ? current.findIndex((tc) => tc.id === call.id) : -1;
  if (idx === -1) return [...current, call];
  const next = [...current];
  // Поля прежних чанков (дифф карточки, вывод) сохраняются, пока новый чанк их не заменит.
  next[idx] = { ...current[idx], ...call };
  return next;
}

/**
 * ExitPlanMode основного агента выполнен — человек утвердил план, Claude CLI вышел из plan mode (TASK-272).
 * Отклонённый план приходит результатом с ошибкой, ExitPlanMode подагента режим вкладки не меняет.
 */
export function isApprovedPlanExit(call: AIToolCall | undefined): boolean {
  return Boolean(call && call.name === 'ExitPlanMode' && call.status === 'done' && !call.parentId);
}
