import type { RemoteConnectionMode } from '../../../src/types/remote';
import { applyPairingLink, generateDeviceId, isValidHostKey, type HostProfile, type PairingLink } from './pairing';
import { setActiveProfile, updateProfile, upsertPairedProfile, type ProfileList } from './profiles';

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

export interface StartupInput extends Omit<InitialProfileInput, 'stored'> {
  list: ProfileList;
}

export interface Startup {
  list: ProfileList;
  /** Профиль для экрана сопряжения, если сопряжённых хостов ещё нет. */
  draft: HostProfile | null;
}

function hasPairingData(link: PairingLink): boolean {
  return Boolean(link.key || link.pin || link.hostKey || link.hostKeyFp);
}

/**
 * Старт клиента со списком профилей (TASK-140.2). Ссылка сопряжения (QR, hash, `start_param`) относится к профилю
 * того же хоста, а если такого нет — это новое сопряжение, а не замена открытого профиля. Адрес страницы — только
 * профилю хоста, который её раздал.
 */
export function resolveStartup(input: StartupInput): Startup {
  const { list, link, hostDefaults = {} } = input;
  const pageHostId = hostDefaults.hostId;
  const isPageHost = (p: HostProfile) => Boolean(input.pageHostAddress) && (!pageHostId || !p.hostId || p.hostId === pageHostId);

  if (list.profiles.length === 0) {
    const profile = resolveInitialProfile({ ...input, stored: null });
    if (profile.key || isValidHostKey(profile.hostKey)) return { list: upsertPairedProfile(list, profile, input.deviceIdPrefix, input.random), draft: null };
    return { list, draft: profile };
  }

  if (hasPairingData(link)) {
    const target = link.hostId
      ? list.profiles.find((p) => p.hostId === link.hostId && !p.viaHostId)
      : list.profiles.find((p) => Boolean(link.key) && p.key === link.key!.trim().toLowerCase());
    if (target) {
      const applied = { ...applyPairingLink(target, link), id: target.id };
      if (isPageHost(applied)) applied.lanAddress = input.pageHostAddress;
      return { list: updateProfile(setActiveProfile(list, target.id!), applied), draft: null };
    }
    const fresh = applyPairingLink(
      { hostId: '', key: '', mode: hostDefaults.mode || 'lan', deviceId: generateDeviceId(input.deviceIdPrefix, input.random) },
      link
    );
    if (!fresh.hostId && pageHostId) fresh.hostId = pageHostId;
    if (isPageHost(fresh)) fresh.lanAddress = input.pageHostAddress;
    return { list: upsertPairedProfile(list, fresh, input.deviceIdPrefix, input.random), draft: null };
  }

  // Страница хоста из списка — открыть его профиль и идти на адрес страницы.
  const pageProfile = pageHostId ? list.profiles.find((p) => p.hostId === pageHostId && !p.viaHostId) : undefined;
  if (pageProfile && input.pageHostAddress) {
    return { list: updateProfile(setActiveProfile(list, pageProfile.id!), { ...pageProfile, lanAddress: input.pageHostAddress }), draft: null };
  }
  return { list, draft: null };
}
