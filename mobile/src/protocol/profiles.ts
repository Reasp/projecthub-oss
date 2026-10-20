import type { FederationHost, RemoteEnrollment } from '../../../src/types/remote';
import { sanitizeEndpoints } from '../../../src/utils/remoteEndpoints';
import { generateDeviceId, type HostProfile } from './pairing';

/**
 * Несколько хостов в одном телефоне (TASK-140.2, [[decision-111]]). Каждое сопряжение по QR — своё: свой `deviceId`,
 * ключи и токен, хосты разных сопряжений друг друга не видят (рабочий ПК компании и личный ПК не объединяются в одну
 * федерацию). Хост из каталога федерации становится отдельным профилем того же сопряжения со своим токеном.
 * Чистый модуль: хранение — в `platform/*`, экраны — в `app/`.
 */

export const PROFILE_LIST_VERSION = 1;

export interface ProfileList {
  version: number;
  activeId: string | null;
  profiles: HostProfile[];
}

type Random = () => number;

function randomTail(random: Random, n = 10): string {
  let tail = '';
  while (tail.length < n) tail += Math.floor(random() * 36).toString(36);
  return tail.slice(0, n);
}

export function newProfileId(random: Random = Math.random): string {
  return `p_${randomTail(random)}`;
}

export function newPairingId(random: Random = Math.random): string {
  return `g_${randomTail(random)}`;
}

export function emptyProfileList(): ProfileList {
  return { version: PROFILE_LIST_VERSION, activeId: null, profiles: [] };
}

function isProfileLike(value: unknown): value is HostProfile {
  const v = value as Partial<HostProfile> | null;
  return Boolean(v && typeof v === 'object' && typeof v.deviceId === 'string' && v.deviceId && typeof v.key === 'string');
}

/** У каждого профиля есть `id` и `pairingId`; у профилей без них (старые записи) — выдаются. */
function withIds(profile: HostProfile, random: Random): HostProfile {
  const id = profile.id || newProfileId(random);
  return { ...profile, id, pairingId: profile.pairingId || `g_${id.slice(2)}` };
}

/** Разбор сохранённого списка: повреждённые записи отбрасываются, активный — существующий или первый. */
export function normalizeProfileList(raw: unknown, random: Random = Math.random): ProfileList {
  const v = raw as Partial<ProfileList> | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.profiles)) return emptyProfileList();
  const profiles = v.profiles.filter(isProfileLike).map((p) => withIds(p, random));
  const activeId = profiles.some((p) => p.id === v.activeId) ? (v.activeId as string) : (profiles[0]?.id ?? null);
  return { version: PROFILE_LIST_VERSION, activeId, profiles };
}

/** Прежний единственный профиль становится первым в списке: повторное сопряжение не нужно. */
export function migrateSingleProfile(single: HostProfile | null | undefined, random: Random = Math.random): ProfileList {
  if (!isProfileLike(single)) return emptyProfileList();
  const profile = withIds(single, random);
  return { version: PROFILE_LIST_VERSION, activeId: profile.id!, profiles: [profile] };
}

export function activeProfile(list: ProfileList): HostProfile | null {
  return list.profiles.find((p) => p.id === list.activeId) ?? null;
}

export function setActiveProfile(list: ProfileList, id: string): ProfileList {
  return list.profiles.some((p) => p.id === id) ? { ...list, activeId: id } : list;
}

/** Профиль изменил клиент (токен, права, адреса, закреплённый ключ хоста) — заменить по `id`. */
export function updateProfile(list: ProfileList, profile: HostProfile): ProfileList {
  if (!profile.id || !list.profiles.some((p) => p.id === profile.id)) return list;
  return { ...list, profiles: list.profiles.map((p) => (p.id === profile.id ? { ...profile } : p)) };
}

/**
 * Сопряжение по QR или ссылке. Тот же хост (по `hostId`) — обновить его профиль: повторный QR этого ПК. Другой хост —
 * новый профиль с новым сопряжением и своим `deviceId`: второй QR не заменяет первый, а два ПК не узнают, что
 * телефон один и тот же.
 */
export function upsertPairedProfile(list: ProfileList, profile: HostProfile, deviceIdPrefix: string, random: Random = Math.random): ProfileList {
  const same = profile.id
    ? list.profiles.find((p) => p.id === profile.id)
    : profile.hostId
      ? list.profiles.find((p) => p.hostId === profile.hostId && !p.viaHostId)
      : undefined;
  if (same) {
    const merged = { ...profile, id: same.id, pairingId: same.pairingId, deviceId: same.deviceId, viaHostId: undefined };
    return { ...list, activeId: same.id!, profiles: list.profiles.map((p) => (p.id === same.id ? merged : p)) };
  }
  const id = newProfileId(random);
  // Первый профиль сохраняет `deviceId`, под которым уже мог сопрягаться; следующие получают свой.
  const deviceId = list.profiles.length === 0 && profile.deviceId ? profile.deviceId : generateDeviceId(deviceIdPrefix, random);
  const fresh: HostProfile = {
    ...profile,
    id,
    pairingId: newPairingId(random),
    deviceId,
    viaHostId: undefined,
    // Токен и права выдаются хостом под конкретный `deviceId` — с новым `deviceId` их нет.
    ...(deviceId !== profile.deviceId ? { deviceToken: undefined, rights: undefined } : {})
  };
  return { ...list, activeId: id, profiles: [...list.profiles, fresh] };
}

/**
 * Хост из каталога федерации со своим токеном (`federation_enroll`): профиль того же сопряжения, что и ПК, через
 * который он получен. Общего ключа v1 у такого профиля нет — только ключ хоста для v2.
 */
export function addFederatedProfile(list: ProfileList, parent: HostProfile, enrollment: RemoteEnrollment, random: Random = Math.random): ProfileList {
  const existing = list.profiles.find((p) => p.pairingId === parent.pairingId && p.hostId === enrollment.hostId);
  const base: HostProfile = {
    hostId: enrollment.hostId,
    machineName: enrollment.machineName,
    key: '',
    hostKey: enrollment.hostKey,
    mode: enrollment.relayUrl && !enrollment.endpoints?.length ? 'relay' : 'lan',
    endpoints: sanitizeEndpoints(enrollment.endpoints ?? []),
    ...(enrollment.relayUrl ? { relayUrl: enrollment.relayUrl } : {}),
    deviceId: enrollment.deviceId,
    deviceToken: enrollment.deviceToken,
    rights: enrollment.rights,
    pairingId: parent.pairingId,
    viaHostId: parent.hostId,
    id: existing?.id ?? newProfileId(random)
  };
  if (existing) return { ...list, profiles: list.profiles.map((p) => (p.id === existing.id ? base : p)) };
  return { ...list, profiles: [...list.profiles, base] };
}

/** Удаление профиля стирает его ключи и токен на телефоне; активным становится первый оставшийся. */
export function removeProfile(list: ProfileList, id: string): ProfileList {
  const profiles = list.profiles.filter((p) => p.id !== id);
  const activeId = list.activeId === id ? (profiles[0]?.id ?? null) : list.activeId;
  return { ...list, activeId, profiles };
}

/** Профили одного сопряжения — только их видит каталог федерации на экране. */
export function pairingProfiles(list: ProfileList, pairingId: string | undefined): HostProfile[] {
  return pairingId ? list.profiles.filter((p) => p.pairingId === pairingId) : [];
}

export type CatalogEntryState = 'connected' | 'enrollable' | 'unpaired';

export interface CatalogEntry {
  host: FederationHost;
  state: CatalogEntryState;
  /** Профиль этого хоста в том же сопряжении, если он уже есть. */
  profileId?: string;
}

/**
 * Каталог федерации активного хоста для экрана: хост уже есть в этом сопряжении, к нему можно получить доступ через
 * активный ПК, или ПК с ним не сопряжён. Профили других сопряжений сюда не попадают, даже с тем же `hostId`.
 */
export function catalogEntries(list: ProfileList, active: HostProfile | null, hosts: FederationHost[]): CatalogEntry[] {
  if (!active) return [];
  const own = pairingProfiles(list, active.pairingId);
  return hosts
    .filter((h) => h.hostId && h.hostId !== active.hostId)
    .map((host) => {
      const profile = own.find((p) => p.hostId === host.hostId);
      if (profile) return { host, state: 'connected' as const, profileId: profile.id };
      return { host, state: host.enrollable ? ('enrollable' as const) : ('unpaired' as const) };
    });
}

/** Профиль без секретов одноразового сопряжения — для записи в хранилище. */
export function storableList(list: ProfileList): ProfileList {
  return {
    version: PROFILE_LIST_VERSION,
    activeId: list.activeId,
    profiles: list.profiles.map((p) => {
      const { pin: _pin, ...rest } = p;
      return rest;
    })
  };
}
