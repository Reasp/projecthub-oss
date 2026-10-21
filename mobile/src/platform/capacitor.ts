import { Capacitor, registerPlugin } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isCameraScanAvailable, scanQrWithCamera } from '../components/qrScanner';
import { isWebCryptoAvailable } from '../protocol/webCodec';
import { createCapacitorStore, createConfirmPort, createPushPort, type SecureStorePlugin } from './secureStore';
import { createNativeTts, createWebTts, type TtsPlugin } from './tts';
import type { HapticKind, Platform } from './types';

/**
 * Приложение iOS/Android на Capacitor. Интерфейс собран внутрь приложения и никогда не
 * загружается с ПК (п. 2.5.2 App Store Review Guidelines, decision-79 п. 10): с хоста приходят
 * только данные по протоколу. Нативные плагины: `PhSecureStore` (Keystore, TASK-140.8; Keychain —
 * TASK-140.6) и `@capacitor/haptics`.
 */

const PhSecureStore = registerPlugin<SecureStorePlugin>('PhSecureStore');
const PhTts = registerPlugin<TtsPlugin>('PhTts');

export function createCapacitorPlatform(): Platform {
  const native = Capacitor.isNativePlatform();
  const platformName = Capacitor.getPlatform();
  const secure = native && Capacitor.isPluginAvailable('PhSecureStore') ? PhSecureStore : null;
  return {
    target: 'capacitor',
    deviceIdPrefix: platformName === 'ios' ? 'ios' : platformName === 'android' ? 'android' : 'app',
    deviceName: platformName === 'ios' ? 'ProjectHub iOS' : platformName === 'android' ? 'ProjectHub Android' : 'ProjectHub App',
    store: createCapacitorStore(secure),
    haptic(kind: HapticKind) {
      if (!native) return;
      const run =
        kind === 'success'
          ? Haptics.notification({ type: NotificationType.Success })
          : kind === 'warning'
            ? Haptics.notification({ type: NotificationType.Warning })
            : kind === 'error'
              ? Haptics.notification({ type: NotificationType.Error })
              : kind === 'selection'
                ? Haptics.selectionChanged()
                : Haptics.impact({ style: kind === 'heavy' ? ImpactStyle.Heavy : kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
      run.catch(() => undefined);
    },
    // Ссылку сопряжения приложение получает только сканером или вставкой — не из адреса страницы.
    initialLink: () => ({}),
    pageHostAddress: () => undefined,
    scanQr: isCameraScanAvailable() ? scanQrWithCamera : undefined,
    hostDefaults: () => ({}),
    cryptoAvailable: () => isWebCryptoAvailable(),
    confirm: createConfirmPort(secure) ?? undefined,
    push: createPushPort(secure) ?? undefined,
    tts: native && Capacitor.isPluginAvailable('PhTts') ? createNativeTts(PhTts) : createWebTts()
  };
}
