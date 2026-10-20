import type { RemoteConnectionMode } from '../../../src/types/remote';
import type { PairingLink } from '../protocol/pairing';
import type { ProfileList } from '../protocol/profiles';

export type ClientTarget = 'embedded' | 'telegram' | 'capacitor';

export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error';

/** Хранилище профилей хостов (TASK-140.2): у каждого свои ключи и токен устройства. */
export interface ProfileStore {
  /**
   * `keychain` — Keychain/Keystore (приложение), `page` — хранилище страницы (браузер, Mini App),
   * `memory` — только до закрытия: в приложении без нативного плагина ключи на диск не пишутся.
   */
  readonly kind: 'keychain' | 'page' | 'memory';
  /** Список профилей; прежний единственный профиль переносится в список при первом чтении. */
  load(): Promise<ProfileList>;
  save(list: ProfileList): Promise<void>;
  clear(): Promise<void>;
}

/** Значения хоста, отдавшего страницу (встроенный клиент и Mini App), — их подставляет сам хост. */
export interface HostDefaults {
  hostId?: string;
  relayUrl?: string;
  mode?: RemoteConnectionMode;
}

/** Почему подпись подтверждения не получилась: отмена человеком или ключ, который больше не годится. */
export type ConfirmErrorCode = 'cancelled' | 'lockout' | 'invalidated' | 'no_key' | 'unavailable' | 'failed';

/**
 * Ключ подтверждения решений HITL биометрией (TASK-140.6, [[decision-112]] п. 4, [[decision-114]]): ECDSA P-256 в
 * Keystore/Secure Enclave, свой у каждого сопряжения (`id` — `deviceId` профиля). Закрытая часть не выходит из ОС.
 */
export interface ConfirmPort {
  /** Есть ли сильная биометрия: без неё ключ не создаётся. */
  status(): Promise<{ available: boolean; reason?: string }>;
  /** Новый ключ сопряжения; прежний с тем же `id` заменяется. SPKI DER в base64url или `null`, если биометрии нет. */
  createKey(id: string): Promise<string | null>;
  /** Подпись строки после биометрии; ошибка — `ConfirmError`. Подпись DER в base64url. */
  sign(id: string, payload: string, prompt: { title: string; subtitle?: string; description?: string }): Promise<string>;
  deleteKey(id: string): Promise<void>;
}

export interface Platform {
  target: ClientTarget;
  deviceIdPrefix: string;
  deviceName: string;
  store: ProfileStore;
  haptic(kind: HapticKind): void;
  /** Ссылка сопряжения, с которой открыли клиент (hash, `start_param`). */
  initialLink(): PairingLink;
  /** Адрес хоста, раздавшего страницу; у приложения его нет — интерфейс собран внутри (п. 2.5.2). */
  pageHostAddress(): string | undefined;
  hostDefaults(): HostDefaults;
  /** Сканер QR, если платформа его даёт. */
  scanQr?: () => Promise<string | null>;
  /** Есть ли WebCrypto (защищённый контекст). */
  cryptoAvailable(): boolean;
  /** Тёмные цвета шапки и фона у оболочки (Telegram). */
  applyChrome?: () => void;
  /** Подпись решений `high` биометрией — только в приложении с нативным плагином. */
  confirm?: ConfirmPort;
}
