import type { HostProfile } from '../protocol/pairing';
import type { ProfileStore } from './types';

/** Нативный плагин `PhSecureStore`: Keystore на Android (TASK-140.8), Keychain на iOS (TASK-140.6). */
export interface SecureStorePlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

const STORE_KEY = 'ph_mobile_profile';

/**
 * Ключи и токены только в Keychain/Keystore. Без нативного плагина профиль живёт в памяти до
 * закрытия приложения — в хранилище WebView (localStorage, IndexedDB) он не пишется никогда.
 */
export function createCapacitorStore(secure: SecureStorePlugin | null | undefined): ProfileStore {
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
      // PIN одноразовый и не хранится нигде.
      const { pin: _pin, ...rest } = p;
      await secure.set({ key: STORE_KEY, value: JSON.stringify(rest) });
    },
    async clear() {
      await secure.remove({ key: STORE_KEY });
    }
  };
}
