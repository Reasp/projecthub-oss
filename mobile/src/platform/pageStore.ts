import type { HostProfile } from '../protocol/pairing';
import { emptyProfileList, migrateSingleProfile, normalizeProfileList, storableList } from '../protocol/profiles';
import type { ProfileStore } from './types';

/**
 * Профили в хранилище страницы — для встроенного клиента и Mini App, как у прежних клиентов.
 * В приложении Capacitor не используется: там ключи только в Keychain/Keystore (decision-79 п. 2).
 * С TASK-140.2 хранится список профилей (`ph_mobile_profiles`); прежний единственный профиль
 * (`ph_mobile_profile`) переносится в список при первом чтении.
 */
export const PROFILE_LIST_KEY = 'ph_mobile_profiles';
export const PROFILE_KEY = 'ph_mobile_profile';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Перенос сопряжения прежних клиентов, чтобы обновление ProjectHub не требовало сопрягать
 * телефон заново: встроенный клиент хранил `ph_remote_device_id`/`ph_remote_device_token`,
 * Mini App — JSON `ph_tg_session`. Старые ключи после переноса удаляются.
 */
export function migrateLegacyProfile(storage: StorageLike): Partial<HostProfile> | null {
  const tg = storage.getItem('ph_tg_session');
  const webId = storage.getItem('ph_remote_device_id');
  const webToken = storage.getItem('ph_remote_device_token');
  let result: Partial<HostProfile> | null = null;

  if (tg) {
    try {
      const s = JSON.parse(tg) as Record<string, string>;
      result = {
        deviceId: s.deviceId || undefined,
        deviceToken: s.deviceToken || undefined,
        key: s.key || undefined,
        hostId: s.hostId || undefined,
        relayUrl: s.relay || undefined,
        mode: s.mode === 'relay' ? 'relay' : 'lan'
      };
    } catch {
      // повреждённая запись — просто удаляем
    }
  } else if (webId) {
    result = { deviceId: webId, deviceToken: webToken || undefined };
  }

  for (const k of ['ph_tg_session', 'ph_remote_device_id', 'ph_remote_device_token']) storage.removeItem(k);
  return result;
}

function readJson(storage: StorageLike, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createPageStore(storage: StorageLike | null = safeStorage()): ProfileStore {
  return {
    kind: storage ? 'page' : 'memory',
    async load() {
      if (!storage) return emptyProfileList();
      const stored = readJson(storage, PROFILE_LIST_KEY);
      if (stored) return normalizeProfileList(stored);
      const list = migrateSingleProfile(readJson(storage, PROFILE_KEY) as HostProfile | null);
      if (list.profiles.length > 0) {
        try {
          storage.setItem(PROFILE_LIST_KEY, JSON.stringify(storableList(list)));
          storage.removeItem(PROFILE_KEY);
        } catch {
          // квота — перенесём при следующем сохранении
        }
      }
      return list;
    },
    async save(list) {
      if (!storage) return;
      try {
        // PIN одноразовый и в хранилище не попадает.
        storage.setItem(PROFILE_LIST_KEY, JSON.stringify(storableList(list)));
      } catch {
        // квота/приватный режим — работаем без сохранения
      }
    },
    async clear() {
      storage?.removeItem(PROFILE_LIST_KEY);
      storage?.removeItem(PROFILE_KEY);
    }
  };
}

export { safeStorage };
