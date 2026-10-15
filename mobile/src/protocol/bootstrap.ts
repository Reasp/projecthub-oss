import type { RemoteConnectionMode } from '../../../src/types/remote';
import { applyPairingLink, generateDeviceId, type HostProfile, type PairingLink } from './pairing';

export interface InitialProfileInput {
  stored: HostProfile | null;
  /** Сопряжение прежнего клиента (`migrateLegacyProfile`), если своего профиля ещё нет. */
  legacy?: Partial<HostProfile> | null;
  link: PairingLink;
  /** Адрес хоста, раздавшего страницу (встроенный клиент, Mini App). */
  pageHostAddress?: string;
  hostDefaults?: { hostId?: string; relayUrl?: string; mode?: RemoteConnectionMode };
  deviceIdPrefix: string;
  random?: () => number;
}

/**
 * Профиль при старте клиента: сохранённый → перенесённый со старого клиента → значения хоста,
 * раздавшего страницу → ссылка сопряжения (она важнее всего, её только что отсканировали).
 */
export function resolveInitialProfile(input: InitialProfileInput): HostProfile {
  const { stored, legacy, link, hostDefaults = {} } = input;
  const base: HostProfile = stored
    ? { ...stored }
    : {
        hostId: legacy?.hostId || '',
        key: legacy?.key || '',
        mode: legacy?.mode || 'lan',
        relayUrl: legacy?.relayUrl,
        deviceId: legacy?.deviceId || generateDeviceId(input.deviceIdPrefix, input.random),
        deviceToken: legacy?.deviceToken
      };

  if (!base.hostId && hostDefaults.hostId) base.hostId = hostDefaults.hostId;
  if (!base.relayUrl && hostDefaults.relayUrl) base.relayUrl = hostDefaults.relayUrl;
  if (!stored && !legacy?.mode && hostDefaults.mode) base.mode = hostDefaults.mode;

  const profile = applyPairingLink(base, link);
  // Страницу раздал сам хост — LAN Direct идёт на тот же адрес, что и страница: голый IP из
  // ссылки с HTTPS-страницы дал бы mixed content (ws:// из https://).
  if (input.pageHostAddress) profile.lanAddress = input.pageHostAddress;
  return profile;
}
