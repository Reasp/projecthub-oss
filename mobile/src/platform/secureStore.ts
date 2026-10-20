import type { HostProfile } from '../protocol/pairing';
import { emptyProfileList, migrateSingleProfile, normalizeProfileList, storableList, type ProfileList } from '../protocol/profiles';
import type { ProfileStore } from './types';

/** Нативный плагин `PhSecureStore`: Keystore на Android (TASK-140.8), Keychain на iOS (TASK-140.6). */
export interface SecureStorePlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
}

/** Список профилей (TASK-140.2) и прежний единственный профиль — его переносим при первом чтении. */
const LIST_KEY = 'ph_mobile_profiles';
const LEGACY_KEY = 'ph_mobile_profile';

function parse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Ключи и токены только в Keychain/Keystore. Без нативного плагина профили живут в памяти до
 * закрытия приложения — в хранилище WebView (localStorage, IndexedDB) они не пишутся никогда.
 */
export function createCapacitorStore(secure: SecureStorePlugin | null | undefined): ProfileStore {
  if (!secure) {
    let memory: ProfileList = emptyProfileList();
    return {
      kind: 'memory',
      load: async () => memory,
      save: async (list) => {
        memory = storableList(list);
      },
      clear: async () => {
        memory = emptyProfileList();
      }
    };
  }
  return {
    kind: 'keychain',
    async load() {
      const stored = parse((await secure.get({ key: LIST_KEY })).value);
      if (stored) return normalizeProfileList(stored);
      const legacy = parse((await secure.get({ key: LEGACY_KEY })).value) as HostProfile | null;
      if (!legacy) return emptyProfileList();
      const list = migrateSingleProfile(legacy);
      // Перенос один раз: список записан — старую запись удаляем.
      await secure.set({ key: LIST_KEY, value: JSON.stringify(storableList(list)) });
      await secure.remove({ key: LEGACY_KEY });
      return list;
    },
    async save(list) {
      // PIN одноразовый и не хранится нигде.
      await secure.set({ key: LIST_KEY, value: JSON.stringify(storableList(list)) });
    },
    async clear() {
      await secure.remove({ key: LIST_KEY });
      await secure.remove({ key: LEGACY_KEY });
    }
  };
}
