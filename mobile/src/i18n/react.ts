import { useSyncExternalStore } from 'react';
import { dictFor, getLanguage, subscribeLanguage, type Dict, type Language } from './index';

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** Словарь текущего языка; компонент перерисуется при смене языка. */
export function useT(): Dict {
  return dictFor(useLanguage());
}
