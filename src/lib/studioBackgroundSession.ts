import type { AIMessage, CliTranscriptMessage } from '../types/electron';
import { asAppErrorKey } from './appError';

/**
 * Разговор вкладки Claude Code занят фоновой сессией CLI (TASK-301, decision-219): карточка с действиями вместо строки
 * CLI и реплики фоновой сессии в ленте перед повтором хода. Чистый модуль без React.
 */

export const CLI_BACKGROUND_HOLD_CODE = 'studio.cliSessionInBackground';

/** Короткий id фоновой сессии из ошибки ответа; `null` — ошибка другая. */
export function backgroundHoldOf(message: Pick<AIMessage, 'role' | 'providerError'>): string | null {
  if (message.role !== 'assistant') return null;
  const key = asAppErrorKey(message.providerError?.messageKey);
  if (key?.code !== CLI_BACKGROUND_HOLD_CODE) return null;
  const id = key.params?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

/**
 * Лента с репликами, которые фоновая сессия дописала в разговор, пока вкладка его не вела: реплики файла сессии новее
 * последнего сообщения вкладки перед упавшей репликой встают перед ней. Уже показанные (тот же id) не повторяются.
 * Нет упавшей реплики или время в ленте не разобрать — лента без изменений: иначе весь разговор попал бы в неё дважды.
 */
export function withBackgroundReplies(messages: readonly AIMessage[], failedAssistantId: string, transcript: readonly CliTranscriptMessage[]): AIMessage[] {
  const failedIdx = messages.findIndex((m) => m.id === failedAssistantId);
  if (failedIdx <= 0) return [...messages];
  let userIdx = -1;
  for (let i = failedIdx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return [...messages];
  const previous = messages[userIdx - 1];
  const since = previous ? Date.parse(previous.timestamp) : 0;
  if (!Number.isFinite(since)) return [...messages];
  const known = new Set(messages.map((m) => m.id));
  const added: AIMessage[] = transcript
    .filter((m) => !known.has(m.id) && Date.parse(m.timestamp) > since)
    .map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp }));
  if (added.length === 0) return [...messages];
  return [...messages.slice(0, userIdx), ...added, ...messages.slice(userIdx)];
}
