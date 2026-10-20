import type { HostProfile } from '../protocol/pairing';
import { emptyProfileList, migrateSingleProfile, normalizeProfileList, storableList, type ProfileList } from '../protocol/profiles';
import type { ConfirmErrorCode, ConfirmPort, ProfileStore } from './types';

/** Нативный плагин `PhSecureStore`: Keystore на Android (TASK-140.8), Keychain на iOS (TASK-140.6). */
export interface SecureStorePlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  /** Ключ подтверждения с биометрией (TASK-140.6); у сборок до него методов нет. */
  confirmStatus?(): Promise<{ available: boolean; reason?: string }>;
  createConfirmKey?(opts: { id: string }): Promise<{ publicKey: string }>;
  signConfirm?(opts: { id: string; payload: string; title: string; subtitle?: string; description?: string }): Promise<{ signature: string }>;
  deleteConfirmKey?(opts: { id: string }): Promise<void>;
}

export class ConfirmError extends Error {
  constructor(
    readonly code: ConfirmErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = 'ConfirmError';
  }
}

const CONFIRM_CODES: readonly ConfirmErrorCode[] = ['cancelled', 'lockout', 'invalidated', 'no_key', 'unavailable', 'failed'];

/** Код ошибки плагина Capacitor (`call.reject(message, code)`) в `ConfirmError`. */
export function toConfirmError(err: unknown): ConfirmError {
  if (err instanceof ConfirmError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const known = CONFIRM_CODES.find((c) => c === code);
  if (known) return new ConfirmError(known);
  if (code === 'unsupported' || code === 'no_lock' || code === 'not_enrolled' || code === 'no_hardware') return new ConfirmError('unavailable');
  return new ConfirmError('failed', err instanceof Error ? err.message : undefined);
}

/** Порт подтверждения поверх плагина; `null`, если у сборки нет методов ключа подтверждения. */
export function createConfirmPort(secure: SecureStorePlugin | null | undefined): ConfirmPort | null {
  if (!secure?.confirmStatus || !secure.createConfirmKey || !secure.signConfirm || !secure.deleteConfirmKey) return null;
  const plugin = secure as Required<SecureStorePlugin>;
  return {
    status: () => plugin.confirmStatus().catch(() => ({ available: false, reason: 'unavailable' })),
    async createKey(id) {
      try {
        return (await plugin.createConfirmKey({ id })).publicKey || null;
      } catch {
        // Нет биометрии или блокировки экрана: устройство сопрягается без ключа, `high` — только на ПК.
        return null;
      }
    },
    async sign(id, payload, prompt) {
      try {
        const { signature } = await plugin.signConfirm({ id, payload, ...prompt });
        if (!signature) throw new ConfirmError('failed');
        return signature;
      } catch (err) {
        throw toConfirmError(err);
      }
    },
    deleteKey: (id) => plugin.deleteConfirmKey({ id }).catch(() => undefined)
  };
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
