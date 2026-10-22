/**
 * Заголовок вкладки Agents Studio по умолчанию (TASK-204, правило 25). Новая вкладка получает заголовок на языке
 * интерфейса и флаг `autoTitle`; первый промпт заменяет такой заголовок своим началом. Прежде автозаголовок
 * узнавал вкладку по русской строке и затирал переименованную «Диалог про …».
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { AISession } from '../types/electron';

/** Заголовки по умолчанию, сохранённые до флага `autoTitle`. */
const LEGACY_DEFAULT_TITLE = /^(Новый диалог|Диалог \d+)$/;

const AUTO_TITLE_MAX = 28;

/** Заголовок вкладки ещё не задан человеком и не взят из промпта. */
export function isAutoSessionTitle(session: Pick<AISession, 'title' | 'autoTitle'>): boolean {
  return session.autoTitle === true || LEGACY_DEFAULT_TITLE.test(session.title);
}

/** Заголовок, сохранённый до флага: «Новый диалог» / «Диалог N» — на язык интерфейса и с флагом `autoTitle`. */
export function localizeLegacyTitle<T extends Pick<AISession, 'title' | 'autoTitle'>>(session: T, labels: { newChat: string; chatN: string }): T {
  if (session.autoTitle || !LEGACY_DEFAULT_TITLE.test(session.title)) return session;
  const n = /^Диалог (\d+)$/.exec(session.title)?.[1];
  return { ...session, title: n ? labels.chatN.replace('{n}', n) : labels.newChat, autoTitle: true };
}

/** Заголовок из первого промпта: одна строка, не длиннее 28 символов. */
export function titleFromPrompt(text: string): string {
  const cleaned = text.replace(/[\n\r]+/g, ' ').trim();
  return cleaned.length > AUTO_TITLE_MAX ? `${cleaned.slice(0, AUTO_TITLE_MAX - 2)}...` : cleaned;
}
