import crypto from 'node:crypto';

/**
 * Шифрование push по RFC 8291 (Message Encryption for Web Push, кодировка `aes128gcm` из RFC 8188) — TASK-140.3,
 * [[decision-115]]. Ключ получателя P-256 и секрет `auth` создаёт телефон при включении push для этого ПК; хост
 * шифрует каждое уведомление новым эфемерным ключом. Шлюз, сервер UnifiedPush, FCM и APNs видят только шифртекст.
 * Только `node:crypto`, своей криптографии нет.
 */

const RECORD_SIZE = 4096;
/** Наибольший открытый текст одной записи UnifiedPush (AND_3: тело до 4096 байт, открытый текст до 3993). */
export const WEB_PUSH_MAX_PLAINTEXT = 3993;

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

export interface WebPushKeys {
  /** Открытый ключ получателя: несжатая точка P-256, 65 байт. */
  uaPublic: Buffer;
  /** Секрет аутентификации, 16 байт. */
  authSecret: Buffer;
}

/** Ключи из base64url, как их присылает телефон; неверная длина — `null`. */
export function parseWebPushKeys(p256dh: unknown, auth: unknown): WebPushKeys | null {
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04 || authSecret.length !== 16) return null;
  try {
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(uaPublic);
  } catch {
    // Точка не на кривой.
    return null;
  }
  return { uaPublic, authSecret };
}

function deriveKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  return {
    cek: hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
    nonce: hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12)
  };
}

/**
 * Одна запись `aes128gcm`: заголовок (соль, размер записи, эфемерный открытый ключ отправителя) и шифртекст.
 * `salt` и `senderPrivate` — только для проверки по вектору RFC 8291.
 */
export function encryptWebPush(keys: WebPushKeys, plaintext: Buffer, fixed: { salt?: Buffer; senderPrivate?: Buffer } = {}): Buffer {
  if (plaintext.length > WEB_PUSH_MAX_PLAINTEXT) throw new Error(`Push больше ${WEB_PUSH_MAX_PLAINTEXT} байт`);
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.senderPrivate) ecdh.setPrivateKey(fixed.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ?? crypto.randomBytes(16);
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(keys.uaPublic), keys.authSecret, keys.uaPublic, asPublic, salt);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // Последняя (и единственная) запись: разделитель 0x02 без дополнения.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Расшифровка записи — для тестов и поддельного телефона; на устройстве то же делает код ОС. */
export function decryptWebPush(message: Buffer, uaPrivate: Buffer, keys: WebPushKeys): Buffer {
  if (message.length < 21 + 65 + 17) throw new Error('Слишком короткое сообщение');
  const salt = message.subarray(0, 16);
  const idLen = message[20];
  const asPublic = message.subarray(21, 21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(asPublic), keys.authSecret, keys.uaPublic, asPublic, salt);
  const data = message.subarray(21 + idLen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const padded = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x02) throw new Error('Неверный разделитель записи');
  return padded.subarray(0, end);
}
