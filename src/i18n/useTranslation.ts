import { useProjectStore } from '../store/useProjectStore';
import { getDictionary } from './index';
import type { Language, TranslationDictionary } from './types';
import { appErrorText, appFailureText } from '../lib/appErrorText';

export function useTranslation(): {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TranslationDictionary;
} {
  const language = useProjectStore((state) => state.language);
  const setLanguage = useProjectStore((state) => state.setLanguage);
  const t = getDictionary(language);

  return { language, setLanguage, t };
}

/**
 * Текст ошибки из `invoke` на текущем языке интерфейса — для сторов и обработчиков вне React (TASK-202, decision-165):
 * без префикса Electron, по коду ошибки main, если он есть.
 */
export function ipcErrorText(err: unknown): string {
  return appErrorText(err, getDictionary(useProjectStore.getState().language).appErrors);
}

/** Результат `{ ok: false, error, errorKey }` на текущем языке интерфейса — для эффектов и обработчиков вне рендера. */
export function ipcFailureText(failure: { error?: string | null; errorKey?: unknown }): string {
  return appFailureText(failure, getDictionary(useProjectStore.getState().language).appErrors);
}
