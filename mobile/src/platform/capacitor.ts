import type { HostProfile } from '../protocol/pairing';
import { isWebCryptoAvailable } from '../protocol/webCodec';
import type { HapticKind, Platform, ProfileStore } from './types';

/**
 * Приложение iOS/Android на Capacitor. Интерфейс собран внутрь приложения и никогда не
 * загружается с ПК (п. 2.5.2 App Store Review Guidelines, decision-79 п. 10): с хоста приходят
 * только данные по протоколу. Нативные плагины подключает [[TASK-140.6]]; до этого модуль
 * обращается к ним через `window.Capacitor.Plugins` и без них работает в урезанном режиме.
 */

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  Plugins?: {
    Haptics?: {
      impact(opts: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>;
      notification(opts: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }): Promise<void>;
      selectionChanged?(): Promise<void>;
    };
    /** Keychain (iOS) / Keystore (Android) — плагин TASK-140.6. */
    PhSecureStore?: {
      get(opts: { key: string }): Promise<{ value: string | null }>;
      set(opts: { key: string; value: string }): Promise<void>;
      remove(opts: { key: string }): Promise<void>;
    };
    [name: string]: unknown;
  };
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

const STORE_KEY = 'ph_mobile_profile';

/**
 * Ключи и токены только в Keychain/Keystore. Без нативного плагина профиль живёт в памяти до
 * закрытия приложения — в хранилище WebView (localStorage, IndexedDB) он не пишется никогда.
 */
export function createCapacitorStore(cap: CapacitorGlobal | undefined = capacitor()): ProfileStore {
  const secure = cap?.Plugins?.PhSecureStore;
  if (!secure) {
    let memory: HostProfile | null = null;
    return {
      kind: 'memory',
      load: async () => memory,
      save: async (p) => {
        const { pin: _pin, ...rest } = p;
        memory = { ...rest };
      },
      clear: async () => {
        memory = null;
      }
    };
  }
  return {
    kind: 'keychain',
    async load() {
      const { value } = await secure.get({ key: STORE_KEY });
      if (!value) return null;
      try {
        return JSON.parse(value) as HostProfile;
      } catch {
        return null;
      }
    },
    async save(p) {
      const { pin: _pin, ...rest } = p;
      await secure.set({ key: STORE_KEY, value: JSON.stringify(rest) });
    },
    async clear() {
      await secure.remove({ key: STORE_KEY });
    }
  };
}

export function createCapacitorPlatform(): Platform {
  const cap = capacitor();
  const haptics = cap?.Plugins?.Haptics;
  const platformName = cap?.getPlatform?.() ?? 'web';
  return {
    target: 'capacitor',
    deviceIdPrefix: platformName === 'ios' ? 'ios' : platformName === 'android' ? 'android' : 'app',
    deviceName: platformName === 'ios' ? 'ProjectHub iOS' : platformName === 'android' ? 'ProjectHub Android' : 'ProjectHub App',
    store: createCapacitorStore(cap),
    haptic(kind: HapticKind) {
      if (!haptics) return;
      const run =
        kind === 'success' || kind === 'warning' || kind === 'error'
          ? haptics.notification({ type: kind.toUpperCase() as 'SUCCESS' | 'WARNING' | 'ERROR' })
          : kind === 'selection' && haptics.selectionChanged
            ? haptics.selectionChanged()
            : haptics.impact({ style: kind === 'heavy' ? 'HEAVY' : kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
      run.catch(() => undefined);
    },
    // Ссылку сопряжения приложение получает только сканером или вставкой — не из адреса страницы.
    initialLink: () => ({}),
    pageHostAddress: () => undefined,
    hostDefaults: () => ({}),
    cryptoAvailable: () => isWebCryptoAvailable()
  };
}
