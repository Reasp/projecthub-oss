import { decryptPayloadWeb, encryptPayloadWeb } from '../../../src/utils/remoteCryptoWeb';
import { createClientHandshake, webSessionV2Supported } from '../../../src/utils/remoteSessionV2';
import type { PacketCodec, SessionV2Port } from './remoteClient';

/**
 * Шифрование только средствами платформы (decision-79 п. 10): WebCrypto в браузере, WebView
 * Telegram и Capacitor. Своей криптобиблиотеки в клиенте нет.
 *
 * WebCrypto есть только в защищённом контексте (HTTPS, `localhost`, `capacitor://`). На странице
 * `http://<IP в LAN>` браузер его не даёт, и зашифрованная сессия невозможна — см. [[decision-80]].
 */
export function isWebCryptoAvailable(scope: { isSecureContext?: boolean; crypto?: Crypto } = globalThis): boolean {
  return Boolean(scope.crypto && scope.crypto.subtle && scope.isSecureContext !== false);
}

export function createWebCodec(keyHex: string): PacketCodec {
  return {
    encrypt: (packet) => encryptPayloadWeb(packet, keyHex),
    decrypt: (packet) => decryptPayloadWeb(packet, keyHex)
  };
}

/** Протокол v2 на WebCrypto ([[decision-111]]): X25519, Ed25519, HKDF и AES-GCM — всё из платформы. */
export function createWebSessionV2Port(): SessionV2Port {
  return {
    supported: () => webSessionV2Supported(),
    begin: () => createClientHandshake()
  };
}
