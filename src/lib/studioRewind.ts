import type { AIMessage, AISession, CliRewindPoint } from '../types/electron';

/**
 * `/rewind` во вкладке Agents Studio (TASK-284, decision-205): какие реплики ленты — какие точки разговора CLI, и какой
 * станет вкладка после отката разговора.
 */

const norm = (text: string) => text.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();

/**
 * Точка отката → реплика ленты. Реплика из переписки CLI (`/resume`) узнаётся по id `cli-<uuid>`, остальные — по тексту.
 * Сопоставление идёт с конца: лента может начинаться позже разговора CLI (ответвление, `/resume` в непустую вкладку),
 * а конец у них общий. Команды, которые Studio выполнила сама (`/btw`, `/fork`), в ленту не попадают.
 */
export function matchRewindPoints(messages: readonly AIMessage[], points: readonly CliRewindPoint[]): Map<string, string> {
  const result = new Map<string, string>();
  const users = messages.filter((m) => m.role === 'user');
  let j = users.length - 1;
  for (let i = points.length - 1; i >= 0 && j >= 0; i--) {
    const point = points[i];
    const want = norm(point.text);
    let k = j;
    while (k >= 0 && users[k].id !== `cli-${point.uuid}` && norm(users[k].content) !== want) k--;
    if (k < 0) continue;
    result.set(point.uuid, users[k].id);
    j = k - 1;
  }
  return result;
}

/**
 * Вкладка после отката разговора к точке: лента до реплики точки, следующий ход — ответвление разговора CLI до записи
 * перед ней (`--resume-session-at --fork-session`), исходная сессия CLI не меняется. Откат к первой реплике — новый
 * разговор. `feed` — лента до точки, если реплику не нашли в ленте вкладки (её дочитали из файла сессии).
 */
export function rewoundSession(session: AISession, point: CliRewindPoint, messageId: string | undefined, feed?: AIMessage[]): AISession {
  const index = messageId ? session.messages.findIndex((m) => m.id === messageId) : -1;
  const messages = index >= 0 ? session.messages.slice(0, index) : (feed ?? session.messages);
  const { claudeCliForkPending: _pending, claudeCliResumeAt: _at, ...rest } = session;
  if (!point.keepUuid || !session.claudeCliSessionId) return { ...rest, messages, claudeCliSessionId: undefined };
  return { ...rest, messages, claudeCliForkPending: true, claudeCliResumeAt: point.keepUuid };
}

/** Лента из файла сессии CLI до реплики точки (без неё). */
export function feedBeforePoint(history: readonly AIMessage[], point: CliRewindPoint): AIMessage[] | undefined {
  const index = history.findIndex((m) => m.id === `cli-${point.uuid}`);
  return index >= 0 ? history.slice(0, index) : undefined;
}
