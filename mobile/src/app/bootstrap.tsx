import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { migrateLegacyProfile, safeStorage } from '../platform/pageStore';
import type { Platform } from '../platform/types';
import { resolveInitialProfile } from '../protocol/bootstrap';
import type { HostProfile } from '../protocol/pairing';
import { RemoteClient, type SocketLike } from '../protocol/remoteClient';
import { createWebCodec } from '../protocol/webCodec';
import { App } from './App';
import { AppStore, type PrefsPort } from './appStore';
import { ServicesProvider, type AppServices } from './context';

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

function Root({ platform, initial }: { platform: Platform; initial: HostProfile }) {
  const [profile, setProfile] = useState(initial);
  const [client] = useState(
    () =>
      new RemoteClient({
        // Браузерный WebSocket совместим с SocketLike по поведению; типы обработчиков у DOM строже.
        socketFactory: (url) => new WebSocket(url) as unknown as SocketLike,
        codecFactory: createWebCodec,
        deviceName: platform.deviceName,
        // На HTTPS-странице (встроенный клиент через туннель, Mini App) ws:// в LAN — mixed content.
        secureOnly: typeof location !== 'undefined' && location.protocol === 'https:',
        onProfileChange: (p) => void platform.store.save(p)
      })
  );
  const [store] = useState(() => new AppStore(client, createPrefs()));

  const services = useMemo<AppServices>(
    () => ({
      platform,
      client,
      store,
      pair(next) {
        void platform.store.save(next);
        setProfile({ ...next });
      },
      async forget() {
        client.disconnect();
        await platform.store.clear();
        setProfile((prev) => ({ hostId: '', key: '', mode: 'lan', deviceId: prev.deviceId, lanAddress: platform.pageHostAddress() }));
      }
    }),
    [platform, client, store]
  );

  return (
    <ServicesProvider value={services}>
      <App profile={profile} />
    </ServicesProvider>
  );
}

/** Точка входа всех трёх целей: различается только платформа. */
export async function startApp(platform: Platform): Promise<void> {
  platform.applyChrome?.();
  const stored: HostProfile | null = await platform.store.load().catch(() => null);
  const storage = platform.store.kind === 'page' ? safeStorage() : null;
  const legacy = !stored && storage ? migrateLegacyProfile(storage) : null;
  const initial = resolveInitialProfile({
    stored,
    legacy,
    link: platform.initialLink(),
    pageHostAddress: platform.pageHostAddress(),
    hostDefaults: platform.hostDefaults(),
    deviceIdPrefix: platform.deviceIdPrefix
  });
  if (initial.key) await platform.store.save(initial).catch(() => undefined);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root platform={platform} initial={initial} />
    </StrictMode>
  );
}
