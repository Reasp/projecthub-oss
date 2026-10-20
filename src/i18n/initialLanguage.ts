/**
 * Язык интерфейса при запуске (TASK-59): выбранный пользователем, иначе язык системы, иначе английский.
 * Атрибут `lang` у `<html>` следует за языком: по нему браузер выбирает переносы, проверку орфографии
 * и голос экранного диктора.
 *
 * Чистый модуль — покрыт unit-тестами.
 */
import type { Language } from './types';

export const LANGUAGE_STORAGE_KEY = 'projecthub_lang';

const SUPPORTED: readonly Language[] = ['en', 'ru'];

function asLanguage(value: string | null | undefined): Language | undefined {
  const base = value?.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.find((lang) => lang === base);
}

/** `stored` — значение из localStorage; `systemLanguages` — `navigator.languages` по порядку предпочтения. */
export function resolveInitialLanguage(stored: string | null | undefined, systemLanguages: readonly string[]): Language {
  const own = stored === 'en' || stored === 'ru' ? stored : undefined;
  if (own) return own;
  for (const system of systemLanguages) {
    const lang = asLanguage(system);
    if (lang) return lang;
  }
  return 'en';
}
