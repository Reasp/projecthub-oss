import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { migrateLegacyProfile, safeStorage } from '../platform/pageStore';
import type { Platform } from '../platform/types';
import { resolveStartup } from '../protocol/bootstrap';
import { generateDeviceId, type HostProfile } from '../protocol/pairing';
import {
  activeProfile,
  addFederatedProfile,
  emptyProfileList,
  removeProfile,
  setActiveProfile,
  updateProfile,
  upsertPairedProfile,
  type ProfileList
} from '../protocol/profiles';
import { RemoteClient, type SocketLike } from '../protocol/remoteClient';
import { createWebCodec, createWebSessionV2Port } from '../protocol/webCodec';
import { App } from './App';
import { AppStore, type PrefsPort } from './appStore';
import { ServicesProvider, type AppServices } from './context';
import { HostPool } from './hostPool';

/** Несекретные настройки интерфейса (выбранный проект) — в хранилище страницы. Ключи сюда не пишутся. */
function createPrefs(): PrefsPort {
  const storage = safeStorage();
  return {
    get: (key) => {
      try {
        return storage?.getItem(`ph_mobile_pref:${key}`) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        storage?.setItem(`ph_mobile_pref:${key}`, value);
      } catch {
        // приватный режим
      }
    }
  };
}

/**
 * Ключ подтверждения создаётся один раз на `deviceId` за запуск (TASK-140.6): перебор адресов при сопряжении не
 * должен плодить ключи, а хост запомнит тот, что пришёл с PIN или ключом из QR.
 */
const confirmKeys = new Map<string, Promise<string | null>>();

function confirmKeyFor(platform: Platform): ((deviceId: string) => Promise<string | null>) | undefined {
  const confirm = platform.confirm;
  if (!confirm) return undefined;
  return (deviceId) => {
    let key = confirmKeys.get(deviceId);
    if (!key) {
      key = confirm.createKey(deviceId);
      confirmKeys.set(deviceId, key);
    }
    return key;
  };
}

function makeClient(platform: Platform, onProfileChange: (p: HostProfile) => void): RemoteClient {
  return new RemoteClient({
    // Браузерный WebSocket совместим с SocketLike по поведению; типы обработчиков у DOM строже.
    socketFactory: (url) => new WebSocket(url) as unknown as SocketLike,
    codecFactory: createWebCodec,
    v2: createWebSessionV2Port(),
    deviceName: platform.deviceName,
    // На HTTPS-странице (встроенный клиент через туннель, Mini App) ws:// в LAN — mixed content.
    secureOnly: typeof location !== 'undefined' && location.protocol === 'https:',
    confirmKey: confirmKeyFor(platform),
    onProfileChange
  });
}

/** Что открыть: профиль из списка или черновик сопряжения. `seq` растёт при каждом явном действии человека. */
interface Target {
  profile: HostProfile;
  seq: number;
  adding: boolean;
}

function freshDraft(platform: Platform): HostProfile {
  return { hostId: '', key: '', mode: 'lan', deviceId: generateDeviceId(platform.deviceIdPrefix) };
}

function Root({ platform, initial, draft }: { platform: Platform; initial: ProfileList; draft: HostProfile | null }) {
  const [list, setList] = useState(initial);
  const listRef = useRef(list);
  const commit = useCallback(
    (next: ProfileList) => {
      listRef.current = next;
      setList(next);
      void platform.store.save(next).catch(() => undefined);
    },
    [platform]
  );
  const [target, setTarget] = useState<Target>(() => ({ profile: activeProfile(initial) ?? draft ?? freshDraft(platform), seq: 0, adding: false }));

  // Клиент открытого хоста: изменения профиля (токен, адреса, закреплённый ключ) — в список по `id`.
  const [client] = useState(() =>
    makeClient(platform, (p) => {
      if (p.id) commit(updateProfile(listRef.current, p));
    })
  );
  const [store] = useState(() => new AppStore(client, createPrefs(), undefined, platform.confirm ?? null));
  const [pool] = useState(
    () =>
      new HostPool(
        (onChange) => makeClient(platform, onChange),
        (p) => commit(updateProfile(listRef.current, p))
      )
  );

  useEffect(() => {
    pool.sync(list.profiles, target.adding ? null : (target.profile.id ?? null));
  }, [pool, list, target]);

  // Фоновые соединения — только пока интерфейс на экране.
  useEffect(() => {
    const onVisibility = () => (document.visibilityState === 'hidden' ? pool.pause() : pool.resume());
    document.addEventListener('visibilitychange', onVisibility);
    pool.resume();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      pool.pause();
    };
  }, [pool]);

  // Имя компьютера в профиль — переключателю оно нужно и без связи.
  useEffect(
    () =>
      store.subscribe(() => {
        const status = store.getState().status;
        const current = activeProfile(listRef.current);
        if (status?.machineName && current && current.hostId === status.hostId && current.machineName !== status.machineName) {
          commit(updateProfile(listRef.current, { ...current, machineName: status.machineName }));
        }
      }),
    [store, commit]
  );

  const open = useCallback(
    (profile: HostProfile, adding = false) => {
      store.reset();
      setTarget((prev) => ({ profile, seq: prev.seq + 1, adding }));
    },
    [store]
  );

  const services = useMemo<AppServices>(
    () => ({
      platform,
      client,
      store,
      pool,
      profiles: list,
      pair(next) {
        const updated = upsertPairedProfile(listRef.current, next, platform.deviceIdPrefix);
        commit(updated);
        open(activeProfile(updated)!);
      },
      addHost() {
        open(freshDraft(platform), true);
      },
      cancelAdd() {
        const current = activeProfile(listRef.current);
        if (current) open(current);
      },
      switchHost(profileId) {
        const next = setActiveProfile(listRef.current, profileId);
        commit(next);
        const profile = activeProfile(next);
        if (profile) open(profile);
      },
      async enrollHost(hostId) {
        const parent = activeProfile(listRef.current);
        if (!parent) return false;
        const res = await store.enrollFederationHost(hostId);
        if (!res) return false;
        const withHost = addFederatedProfile(listRef.current, parent, res);
        const added = withHost.profiles.find((p) => p.pairingId === parent.pairingId && p.hostId === res.hostId);
        commit(added ? setActiveProfile(withHost, added.id!) : withHost);
        store.showToast(`Доступ к «${res.machineName}» получен`, 'success');
        if (added) open(added);
        return true;
      },
      async forget(profileId) {
        const id = profileId ?? listRef.current.activeId;
        if (!id) return;
        const wasActive = id === listRef.current.activeId;
        const removed = listRef.current.profiles.find((p) => p.id === id);
        const next = removeProfile(listRef.current, id);
        // Ключ подтверждения принадлежит сопряжению: забытый компьютер им больше не проверит ничего.
        if (removed?.deviceId && platform.confirm) {
          confirmKeys.delete(removed.deviceId);
          void platform.confirm.deleteKey(removed.deviceId);
        }
        commit(next);
        if (!wasActive) return;
        client.disconnect();
        const profile = activeProfile(next);
        open(profile ?? { ...freshDraft(platform), lanAddress: platform.pageHostAddress() });
      }
    }),
    [platform, client, store, pool, list, commit, open]
  );

  return (
    <ServicesProvider value={services}>
      <App profile={target.profile} seq={target.seq} adding={target.adding} />
    </ServicesProvider>
  );
}

/** Точка входа всех трёх целей: различается только платформа. */
export async function startApp(platform: Platform): Promise<void> {
  platform.applyChrome?.();
  const stored: ProfileList = await platform.store.load().catch(() => emptyProfileList());
  const storage = platform.store.kind === 'page' ? safeStorage() : null;
  const legacy = stored.profiles.length === 0 && storage ? migrateLegacyProfile(storage) : null;
  const { list, draft } = resolveStartup({
    list: stored,
    legacy,
    link: platform.initialLink(),
    pageHostAddress: platform.pageHostAddress(),
    hostDefaults: platform.hostDefaults(),
    deviceIdPrefix: platform.deviceIdPrefix
  });
  if (list.profiles.length > 0) await platform.store.save(list).catch(() => undefined);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root platform={platform} initial={list} draft={draft} />
    </StrictMode>
  );
}
