import type { AISession } from '../types/electron';

/**
 * Имя сессии Claude Code из заголовка вкладки Agents Studio (TASK-287, decision-208). Сессии из Studio в `/resume` CLI
 * и в терминале были подписаны первой репликой: заголовок вкладки до CLI не доходил. Теперь заголовок, который задал
 * человек (переименование вкладки, `/fork <имя>`, `/rename` CLI), уходит в CLI запросом `rename_session`; вкладка
 * помнит, какое имя какой сессии CLI уже передано, и не повторяет его.
 */

/** Имя сессии CLI: CLI сам длину не ограничивает, `/resume` показывает начало строки. */
export const CLI_SESSION_NAME_MAX = 200;

/** Одна строка без управляющих символов; пустая — передавать нечего. */
export function cliSessionName(title: unknown): string {
  if (typeof title !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- управляющие символы и переводы строки в имени сессии CLI не нужны
  return title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CLI_SESSION_NAME_MAX);
}

/**
 * Имя, которое нужно передать CLI для вкладки, или `null`: заголовок задал не человек, у вкладки ещё нет сессии CLI,
 * ответвление ещё не получило свою сессию или это имя этой сессии уже передано.
 */
export function cliTitleToSync(session: Pick<AISession, 'title' | 'titleByUser' | 'claudeCliSessionId' | 'claudeCliTitle' | 'claudeCliForkPending'>): string | null {
  if (!session.titleByUser || !session.claudeCliSessionId || session.claudeCliForkPending) return null;
  const name = cliSessionName(session.title);
  if (!name) return null;
  const sent = session.claudeCliTitle;
  return sent && sent.sessionId === session.claudeCliSessionId && sent.title === name ? null : name;
}
