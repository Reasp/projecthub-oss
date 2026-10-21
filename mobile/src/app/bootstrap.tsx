import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { initLanguage, LANGUAGE_PREF, setLanguage, t, type Language } from '../i18n';
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
import { InboxActions } from './inboxActions';
import { watchLaunchScreen } from './launchScreen';
import { VoiceController } from './voiceController';
import { capabilitiesFor } from '../protocol/models';
import type { VoiceHost, VoiceLang } from '../protocol/voiceCommands';

/** Несекретные настройки интерфейса (выбранный проект) — в хранилище страницы. Ключи сюда не пишутся. */
/** Язык речи голосового режима — отдельно от языка интерфейса. */
const VOICE_LANG_PREF = 'voice:lang';
const VOICE_WAKE_PREF = 'voice:wake';

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
  const [prefs] = useState(createPrefs);
  const [store] = useState(() => new AppStore(client, prefs, undefined, platform.confirm ?? null, platform.push ?? null));
  const [pool] = useState(
    () =>
      new HostPool(
        (onChange) => makeClient(platform, onChange),
        (p) => commit(updateProfile(listRef.current, p)),
        undefined,
        prefs
      )
  );

  // Время последней связи открытого ПК — для строки «был в сети» на экране «Компьютеры» (TASK-174).
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = target.adding ? null : (target.profile.id ?? null);
  useEffect(() => {
    const seen = () => {
      if (activeIdRef.current && client.getSnapshot().state === 'ready') pool.markSeen(activeIdRef.current);
    };
    const offEvents = client.onEvent(seen);
    const offState = client.subscribe(seen);
    return () => {
      offEvents();
      offState();
    };
  }, [client, pool]);

  const [inbox] = useState(() => new InboxActions(store, pool));

  // Голосовой режим (TASK-179): ПК флота — из профилей, снимков открытого ПК и пула; RPC — соединением нужного ПК.
  const [voice] = useState(() => {
    const isActive = (id: string) => id === activeIdRef.current;
    const hosts = (): VoiceHost[] => {
      const st = store.getState();
      const out: VoiceHost[] = [];
      for (const p of listRef.current.profiles) {
        if (!p.id) continue;
        if (isActive(p.id)) {
          const overview = st.overview;
          out.unshift({
            id: p.id,
            name: overview?.machineName || st.status?.machineName || p.machineName || p.hostId,
            ready: st.conn.state === 'ready',
            write: capabilitiesFor(st.conn.rights, st.conn.readOnly).write,
            overview
          });
        } else {
          const overview = pool.getOverviews()[p.id]?.overview ?? null;
          out.push({
            id: p.id,
            name: overview?.machineName || p.machineName || p.hostId,
            ready: pool.isReady(p.id),
            write: overview ? overview.actions === 'full' : capabilitiesFor(p.rights, false).write,
            overview
          });
        }
      }
      return out;
    };
    const wake = prefs.get(VOICE_WAKE_PREF) === '1';
    const saved = prefs.get(VOICE_LANG_PREF);
    const lang: VoiceLang = saved === 'ru' || saved === 'en' ? saved : (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
    return new VoiceController(
      {
        hosts,
        activeHostId: () => activeIdRef.current,
        rpc: (id, method, params) => (isActive(id) ? client.rpc(method, params) : pool.rpc(id, method, params)),
        onHostEvent(listener) {
          const offActive = client.onEvent((event, data) => activeIdRef.current && listener(activeIdRef.current, event, data));
          const offPool = pool.onHostEvent(listener);
          return () => {
            offActive();
            offPool();
          };
        },
        tts: platform.tts ?? null
      },
      lang,
      wake
    );
  });
  useEffect(
    () =>
      voice.subscribe(() => {
        const { lang, wake } = voice.getState();
        prefs.set(VOICE_LANG_PREF, lang);
        prefs.set(VOICE_WAKE_PREF, wake ? '1' : '0');
      }),
    [voice, prefs]
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

  // Launch Screen приложения уходит, когда ПК ответил (без сохранённого ПК — сразу после заставки).
  const waitHost = initial.profiles.length > 0;
  useEffect(() => watchLaunchScreen(waitHost, () => store.getState().conn.state), [store, waitHost]);

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

  // Нажатие push: открыть ПК, с которого пришло уведомление (TASK-140.3).
  useEffect(() => {
    const push = platform.push;
    if (!push) return;
    const go = (instance: string) => {
      if (instance === listRef.current.activeId) return;
      const next = setActiveProfile(listRef.current, instance);
      const profile = activeProfile(next);
      if (!profile || profile.id !== instance) return;
      commit(next);
      open(profile);
    };
    void push.takeLaunchTarget().then((t) => t && go(t.instance));
    const offLaunch = push.onLaunchTarget((t) => go(t.instance));
    // Дистрибьютор сменил адрес открытого ПК — регистрируемся заново, иначе push перестанут доходить.
    const offEndpoint = push.onEndpointChanged((instance, endpoint) => {
      const profile = activeProfile(listRef.current);
      if (endpoint && profile?.id === instance && store.getState().push?.enabled) {
        void store.enablePush(instance, profile.machineName || store.getState().status?.machineName || 'ProjectHub');
      }
    });
    return () => {
      offLaunch();
      offEndpoint();
    };
  }, [platform, commit, open, store]);

  const services = useMemo<AppServices>(
    () => ({
      platform,
      client,
      store,
      pool,
      inbox,
      voice,
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
        store.showToast(t().shell.enrolled(res.machineName), 'success');
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
        // Push с забытого ПК больше не нужен: дистрибьютор удалит адрес, ПК получит 410 и снимет регистрацию.
        if (removed?.id && platform.push) void platform.push.unregister(removed.id);
        commit(next);
        if (!wasActive) return;
        client.disconnect();
        const profile = activeProfile(next);
        open(profile ?? { ...freshDraft(platform), lanAddress: platform.pageHostAddress() });
      },
      setLanguage(lang: Language) {
        setLanguage(lang);
        createPrefs().set(LANGUAGE_PREF, lang);
      },
      rpcTo(profileId, method, params) {
        return profileId === activeIdRef.current ? client.rpc(method, params) : pool.rpc(profileId, method, params);
      }
    }),
    [platform, client, store, pool, inbox, voice, list, commit, open]
  );

  return (
    <ServicesProvider value={services}>
      <App profile={target.profile} seq={target.seq} adding={target.adding} />
    </ServicesProvider>
  );
}

/** Точка входа всех трёх целей: различается только платформа. */
export async function startApp(platform: Platform): Promise<void> {
  initLanguage(createPrefs().get(LANGUAGE_PREF), typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
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
