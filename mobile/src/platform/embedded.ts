import { parsePairingHash } from '../protocol/pairing';
import { isWebCryptoAvailable } from '../protocol/webCodec';
import { consumeLocationHash, readHostDefaults } from './hostDefaults';
import { createPageStore } from './pageStore';
import type { HapticKind, Platform } from './types';

const VIBRATION: Record<HapticKind, number | number[]> = {
  light: 8,
  selection: 5,
  medium: 14,
  heavy: 24,
  success: [10, 40, 10],
  warning: [20, 60, 20],
  error: [30, 50, 30, 50, 30]
};

/** Встроенный клиент, который раздаёт `remoteControlService` (браузер телефона). */
export function createEmbeddedPlatform(): Platform {
  const hash = consumeLocationHash();
  return {
    target: 'embedded',
    deviceIdPrefix: 'web',
    deviceName: 'Mobile Browser',
    store: createPageStore(),
    haptic(kind) {
      try {
        navigator.vibrate?.(VIBRATION[kind]);
      } catch {
        // нет вибрации — не страшно
      }
    },
    initialLink: () => parsePairingHash(hash),
    pageHostAddress: () => window.location.origin,
    hostDefaults: () => readHostDefaults(),
    cryptoAvailable: () => isWebCryptoAvailable()
  };
}
