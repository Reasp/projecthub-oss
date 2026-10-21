import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Language } from '../i18n';
import type { Platform } from '../platform/types';
import type { HostProfile } from '../protocol/pairing';
import type { ProfileList } from '../protocol/profiles';
import type { RemoteClient, RpcMethod } from '../protocol/remoteClient';
import type { AppState, AppStore } from './appStore';
import type { HostPool, HostSummary, OverviewSnapshot } from './hostPool';
import type { InboxActions } from './inboxActions';
import type { VoiceController } from './voiceController';

export interface AppServices {
  platform: Platform;
  client: RemoteClient;
  store: AppStore;
  /** Фоновые соединения к остальным хостам (статус и ожидающие решения в переключателе). */
  pool: HostPool;
  /** Действия «Входящих» над записью любого ПК: уходят тому ПК, с которого пришла запись (TASK-140.5). */
  inbox: InboxActions;
  /** Все сопряжённые хосты телефона (TASK-140.2). */
  profiles: ProfileList;
  /** Сопряжение по QR или ссылке: тот же хост обновляется, другой добавляется в список. */
  pair(profile: HostProfile): void;
  /** Открыть экран сопряжения для ещё одного компьютера. */
  addHost(): void;
  /** Закрыть экран добавления и вернуться к открытому хосту. */
  cancelAdd(): void;
  /** Открыть другой хост из списка. */
  switchHost(profileId: string): void;
  /** Получить доступ к соседу по федерации через открытый хост и открыть его. */
  enrollHost(hostId: string): Promise<boolean>;
  /** Забыть хост: стереть его ключ и токен на телефоне (по умолчанию — открытый). */
  forget(profileId?: string): Promise<void>;
  /** Голосовой режим (TASK-179): команды компьютерам флота голосом, ответы голосом. */
  voice: VoiceController;
  /** Сменить язык интерфейса и запомнить выбор (TASK-140.15). */
  setLanguage(lang: Language): void;
  /** RPC нужному ПК: открытому — его соединением, остальным — соединением пула (знакомство ПК, TASK-186). */
  rpcTo<T = unknown>(profileId: string, method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
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

/** Статусы фоновых хостов по `id` профиля; ссылка меняется только при изменении. */
export function useHostSummaries(): Record<string, HostSummary> {
  const { pool } = useServices();
  return useSyncExternalStore(pool.subscribe, pool.getSummaries);
}

/** Снимки дерева фоновых ПК и время последней связи (TASK-174): ссылки меняются только при изменении. */
export function usePoolOverviews(): Record<string, OverviewSnapshot> {
  const { pool } = useServices();
  return useSyncExternalStore(pool.subscribe, pool.getOverviews);
}

export function useLastSeen(): Record<string, number> {
  const { pool } = useServices();
  return useSyncExternalStore(pool.subscribe, pool.getLastSeen);
}

export function useHaptic(): Platform['haptic'] {
  return useServices().platform.haptic;
}
