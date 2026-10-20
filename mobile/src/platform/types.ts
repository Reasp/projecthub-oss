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
}
