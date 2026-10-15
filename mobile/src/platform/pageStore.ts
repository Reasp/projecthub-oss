import type { HostProfile } from '../protocol/pairing';
import type { ProfileStore } from './types';

/**
 * Профиль в хранилище страницы — для встроенного клиента и Mini App, как у прежних клиентов.
 * В приложении Capacitor не используется: там ключи только в Keychain/Keystore (decision-79 п. 2).
 */
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

export function createPageStore(storage: StorageLike | null = safeStorage()): ProfileStore {
  return {
    kind: storage ? 'page' : 'memory',
    async load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(PROFILE_KEY);
        return raw ? (JSON.parse(raw) as HostProfile) : null;
      } catch {
        return null;
      }
    },
    async save(profile) {
      if (!storage) return;
      // PIN одноразовый и в хранилище не попадает.
      const { pin: _pin, ...rest } = profile;
      try {
        storage.setItem(PROFILE_KEY, JSON.stringify(rest));
      } catch {
        // квота/приватный режим — работаем без сохранения
      }
    },
    async clear() {
      storage?.removeItem(PROFILE_KEY);
    }
  };
}

export { safeStorage };
