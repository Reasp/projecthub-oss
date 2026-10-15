import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Platform } from '../platform/types';
import type { HostProfile } from '../protocol/pairing';
import type { RemoteClient } from '../protocol/remoteClient';
import type { AppState, AppStore } from './appStore';

export interface AppServices {
  platform: Platform;
  client: RemoteClient;
  store: AppStore;
  /** Новый профиль (после сопряжения) — сохранить и подключиться. */
  pair(profile: HostProfile): void;
  /** Забыть хост: стереть ключ и токен на телефоне. */
  forget(): Promise<void>;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ value, children }: { value: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('ServicesProvider не подключён');
  return value;
}

/** Срез состояния стора; селектор должен возвращать стабильные ссылки (поля состояния, а не новые объекты). */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useHaptic(): Platform['haptic'] {
  return useServices().platform.haptic;
}
