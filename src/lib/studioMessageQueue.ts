/**
 * Очередь сообщений вкладки Agents Studio (TASK-273). Сообщение, написанное во время ответа вкладки (с клавиатуры,
 * голосом, быстрой командой), раньше молча терялось; теперь оно встаёт в очередь и уходит после конца хода.
 * После остановки или ошибки очередь ждёт: человек отправляет следующее сам или очищает очередь.
 * Чистые функции без React и стора — покрыты unit-тестами.
 */

/** Сколько сообщений держит очередь одной вкладки: дальше новое не встаёт, чтобы голос в цикле не копил промпты. */
export const STUDIO_QUEUE_MAX = 20;

export interface QueuedStudioMessage<Opts = unknown> {
  id: string;
  text: string;
  /** Параметры исходной отправки (режим, конфиг запроса, участник) — без вкладки: она — ключ очереди. */
  opts: Opts;
  queuedAt: number;
}

export type StudioQueues<Opts = unknown> = Record<string, QueuedStudioMessage<Opts>[]>;

/** Очереди с новым сообщением в конце; та же ссылка, если текст пуст или очередь полна. */
export function enqueueMessage<Opts>(queues: StudioQueues<Opts>, sessionId: string, message: QueuedStudioMessage<Opts>): StudioQueues<Opts> {
  const current = queues[sessionId] ?? [];
  if (!message.text.trim() || current.length >= STUDIO_QUEUE_MAX) return queues;
  return { ...queues, [sessionId]: [...current, message] };
}

/** Очереди без сообщения; пустая очередь удаляется. Та же ссылка, если сообщения не было. */
export function removeQueuedMessage<Opts>(queues: StudioQueues<Opts>, sessionId: string, messageId: string): StudioQueues<Opts> {
  const current = queues[sessionId];
  if (!current?.some((m) => m.id === messageId)) return queues;
  const rest = current.filter((m) => m.id !== messageId);
  if (rest.length > 0) return { ...queues, [sessionId]: rest };
  const { [sessionId]: _dropped, ...others } = queues;
  return others;
}

/** Очереди без очереди вкладки; та же ссылка, если её не было. */
export function clearQueue<Opts>(queues: StudioQueues<Opts>, sessionId: string): StudioQueues<Opts> {
  if (!(sessionId in queues)) return queues;
  const { [sessionId]: _dropped, ...others } = queues;
  return others;
}

/**
 * Что отправить после конца хода вкладки: первое сообщение очереди — если ход закончился сам, а не остановкой
 * или ошибкой, и вкладка свободна.
 */
export function nextAfterTurn<Opts>(
  queue: QueuedStudioMessage<Opts>[] | undefined,
  turn: { ended: 'complete' | 'aborted' | 'error'; streaming: boolean }
): QueuedStudioMessage<Opts> | null {
  if (turn.ended !== 'complete' || turn.streaming) return null;
  return queue?.[0] ?? null;
}
