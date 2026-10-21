import { t } from '../i18n';
import { parsePairingHash, parseTelegramStartParam } from '../protocol/pairing';
import { isWebCryptoAvailable } from '../protocol/webCodec';
import { consumeLocationHash, readHostDefaults } from './hostDefaults';
import { createPageStore } from './pageStore';
import type { Platform } from './types';

/** Нужное подмножество Telegram WebApp API (`telegram-web-app.js`). */
interface TelegramWebApp {
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  disableVerticalSwipes?(): void;
  initDataUnsafe?: { start_param?: string; user?: { id?: number; first_name?: string } };
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  showScanQrPopup?(params: { text?: string }, callback: (text: string) => boolean | void): void;
  closeScanQrPopup?(): void;
}

function webApp(): TelegramWebApp | undefined {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

/**
 * Telegram Mini App. Сессия хранится в хранилище страницы WebView, но не в `CloudStorage`:
 * прежняя Mini App отправляла туда ключ и токен, то есть на серверы Telegram открытым текстом.
 */
export function createTelegramPlatform(): Platform {
  const tg = webApp();
  const hash = consumeLocationHash();
  const userId = tg?.initDataUnsafe?.user?.id;

  return {
    target: 'telegram',
    // Прежняя Mini App давала `tg_<id пользователя>` — оставляем, чтобы хост узнал устройство.
    deviceIdPrefix: userId ? `tg_${userId}` : 'tg',
    deviceName: tg?.initDataUnsafe?.user?.first_name || 'Telegram Mini App',
    store: createPageStore(),
    haptic(kind) {
      const h = tg?.HapticFeedback;
      if (!h) return;
      try {
        if (kind === 'success' || kind === 'warning' || kind === 'error') h.notificationOccurred(kind);
        else if (kind === 'selection') h.selectionChanged();
        else h.impactOccurred(kind);
      } catch {
        // старый клиент Telegram
      }
    },
    initialLink() {
      return { ...parseTelegramStartParam(tg?.initDataUnsafe?.start_param || ''), ...parsePairingHash(hash) };
    },
    pageHostAddress: () => window.location.origin,
    hostDefaults: () => readHostDefaults(),
    scanQr: tg?.showScanQrPopup
      ? () =>
          new Promise<string | null>((resolve) => {
            tg.showScanQrPopup!({ text: t().pairing.scanHint }, (text) => {
              tg.closeScanQrPopup?.();
              resolve(text || null);
              return true;
            });
          })
      : undefined,
    cryptoAvailable: () => isWebCryptoAvailable(),
    applyChrome() {
      if (!tg) return;
      tg.ready();
      tg.expand();
      // Свайп вниз закрывает Mini App — мешает жесту «потянуть для обновления».
      tg.disableVerticalSwipes?.();
      tg.setHeaderColor?.('#18181b');
      tg.setBackgroundColor?.('#18181b');
    }
  };
}
