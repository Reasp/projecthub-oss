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
  /** Имена вложений сообщения (TASK-289): сообщение из одних вложений тоже встаёт в очередь. */
  attachmentNames?: string[];
  /**
   * Сообщение уже в stdin процесса Claude Code (TASK-298): модель увидит его на ближайшей границе шага, и оно встанет в
   * ленту на своё место. После хода оно не отправляется повторно.
   */
  sentDuringTurn?: true;
}

export type StudioQueues<Opts = unknown> = Record<string, QueuedStudioMessage<Opts>[]>;

/** Очереди с новым сообщением в конце; та же ссылка, если нет ни текста, ни вложений, или очередь полна. */
export function enqueueMessage<Opts>(queues: StudioQueues<Opts>, sessionId: string, message: QueuedStudioMessage<Opts>): StudioQueues<Opts> {
  const current = queues[sessionId] ?? [];
  if ((!message.text.trim() && !message.attachmentNames?.length) || current.length >= STUDIO_QUEUE_MAX) return queues;
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

/** Сообщение очереди отдано процессу Claude Code во время хода (TASK-298). Та же ссылка, если его нет. */
export function markSentDuringTurn<Opts>(queues: StudioQueues<Opts>, sessionId: string, messageId: string): StudioQueues<Opts> {
  const current = queues[sessionId];
  if (!current?.some((m) => m.id === messageId && !m.sentDuringTurn)) return queues;
  return { ...queues, [sessionId]: current.map((m) => (m.id === messageId ? { ...m, sentDuringTurn: true as const } : m)) };
}

/**
 * Очистка очереди вкладки: уходят сообщения, ещё не отданные процессу; отданные остаются, пока их не снимет запрос
 * (TASK-298) — иначе модель получила бы реплику, которой нет ни в очереди, ни в ленте.
 */
export function clearUnsent<Opts>(queues: StudioQueues<Opts>, sessionId: string): StudioQueues<Opts> {
  const current = queues[sessionId];
  if (!current) return queues;
  const sent = current.filter((m) => m.sentDuringTurn);
  if (sent.length === current.length) return queues;
  return sent.length > 0 ? { ...queues, [sessionId]: sent } : clearQueue(queues, sessionId);
}

/**
 * Ход кончился, а отданные ему сообщения до модели не дошли (остановка, ошибка): они снова обычные сообщения очереди и
 * ждут отправки. Та же ссылка, если таких нет.
 */
export function returnUndelivered<Opts>(queues: StudioQueues<Opts>, sessionId: string): StudioQueues<Opts> {
  const current = queues[sessionId];
  if (!current?.some((m) => m.sentDuringTurn)) return queues;
  return {
    ...queues,
    [sessionId]: current.map((m) => {
      if (!m.sentDuringTurn) return m;
      const { sentDuringTurn: _sent, ...rest } = m;
      return rest;
    })
  };
}

/**
 * Лента после того, как реплика во время хода дошла до модели (TASK-298): ответ до неё остаётся законченным сообщением
 * (пустой — убирается), за ним — реплика и новое сообщение ответа. `null` — сообщения ответа в ленте уже нет.
 */
export function messagesWithDelivered<M extends { id: string; content?: string; thought?: string; toolCalls?: unknown[] }>(
  messages: readonly M[],
  assistantId: string,
  userMessage: M,
  nextAssistant: M
): M[] | null {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx === -1) return null;
  const current = messages[idx];
  const empty = !current.content?.trim() && !current.thought?.trim() && !current.toolCalls?.length;
  const before = empty ? messages.slice(0, idx) : messages.slice(0, idx + 1);
  return [...before, userMessage, nextAssistant, ...messages.slice(idx + 1)];
}
