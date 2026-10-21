/**
 * Язык мобильного клиента (TASK-140.15). Словари разбиты по разделам (`ns/*.ts`): у каждого `en` и `ru` одной формы,
 * полноту `ru` проверяет тип. Строки с числами и подстановками — функции.
 *
 * Язык при запуске — выбранный в настройках, иначе язык системы, иначе английский (как на ПК, TASK-59). Текст, уже
 * отданный в состояние (тост, ошибка соединения), остаётся на языке момента создания; экраны берут строки через
 * `useT()` (`./react`) и перерисовываются при смене языка.
 *
 * Модуль без React и DOM-зависимостей, кроме атрибута `lang` у `<html>`: его импортируют и протокольные модули.
 */
import { resolveInitialLanguage } from '../../../src/i18n/initialLanguage';
import * as agents from './ns/agents';
import * as common from './ns/common';
import * as docs from './ns/docs';
import * as inbox from './ns/inbox';
import * as models from './ns/models';
import * as pairing from './ns/pairing';
import * as processes from './ns/processes';
import * as shell from './ns/shell';
import * as store from './ns/store';
import * as studio from './ns/studio';
import * as tasks from './ns/tasks';

export type Language = 'en' | 'ru';
export const LANGUAGES: readonly Language[] = ['en', 'ru'];
/** Название языка на нём самом — так его находят в списке, даже не понимая текущий язык интерфейса. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ru: 'Русский' };
/** Ключ выбора в несекретных настройках страницы (`ph_mobile_pref:<ключ>`). */
export const LANGUAGE_PREF = 'lang';

const NS = { agents, common, docs, inbox, models, pairing, processes, shell, store, studio, tasks };

export type Dict = { [K in keyof typeof NS]: (typeof NS)[K]['en'] };

function build(lang: Language): Dict {
  return Object.fromEntries(Object.entries(NS).map(([name, ns]) => [name, ns[lang]])) as Dict;
}

const DICTS: Record<Language, Dict> = { en: build('en'), ru: build('ru') };

let current: Language = 'en';
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

/** Словарь текущего языка. */
export function t(): Dict {
  return DICTS[current];
}

export function dictFor(lang: Language): Dict {
  return DICTS[lang];
}

export function setLanguage(lang: Language): void {
  if (!LANGUAGES.includes(lang)) return;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  if (lang === current) return;
  current = lang;
  for (const listener of listeners) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `stored` — сохранённый выбор, `system` — `navigator.languages` по порядку предпочтения. */
export function initLanguage(stored: string | null | undefined, system: readonly string[]): Language {
  const lang = resolveInitialLanguage(stored, system);
  setLanguage(lang);
  return lang;
}
