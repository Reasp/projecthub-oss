import crypto from 'node:crypto';
import {
  HandshakeError,
  INFO_CLIENT_TO_HOST,
  INFO_HOST_TO_CLIENT,
  KEY_BYTES,
  NONCE_BYTES,
  ReplayGuard,
  SESSION_PROTOCOL_V2,
  base64UrlToBytes,
  buildTranscript,
  bytesToBase64Url,
  decodeFixed,
  decodeJson,
  encodeJson,
  isAllZero,
  isSessionFrameV2,
  nonceForSeq,
  parseClientHello,
  type ServerHelloV2,
  type SessionFrameV2
} from './remoteSessionV2.js';

/**
 * Сторона хоста протокола v2 ([[decision-111]]) на `node:crypto`. Всё синхронно: хост рассылает события
 * многим клиентам подряд, и счётчик каждого пакета должен совпасть с порядком отправки.
 */

/** SPKI DER открытого ключа EC P-256 = этот префикс + несжатая точка (65 байт). */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

/** Несжатая точка (65 байт) открытого ключа P-256 из PEM или KeyObject — в QR и `server_hello` едет она. */
export function p256RawPublicKey(publicKey: string | crypto.KeyObject): Buffer {
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
  const der = key.export({ type: 'spki', format: 'der' });
  if (der.length !== P256_SPKI_PREFIX.length + KEY_BYTES || !der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) {
    throw new Error('key is not EC P-256');
  }
  return der.subarray(P256_SPKI_PREFIX.length);
}

/** Новый долгосрочный ключ сессий хоста ECDSA P-256: PEM PKCS#8 для хранилища секретов. */
export function generateSessionSigningKey(): { privateKeyPem: string; hostKeyRaw: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), hostKeyRaw: p256RawPublicKey(publicKey) };
}

/** Отпечаток ключа хоста — то же, что `hostKeyFingerprint` клиента, но синхронно. */
export function hostKeyFingerprintNode(hostKeyRaw: Uint8Array): string {
  return bytesToBase64Url(crypto.createHash('sha256').update(hostKeyRaw).digest().subarray(0, 12));
}

function hkdf(shared: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(info, 'utf8'), 32));
}

/** Сессия хоста: шифрует ключом «хост → клиент», принимает только пакеты с растущим `seq`. */
export class NodeSessionV2 {
  private sendSeq = 0;
  private readonly guard = new ReplayGuard();

  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer
  ) {}

  seal(packet: unknown): SessionFrameV2 {
    const seq = ++this.sendSeq;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonceForSeq(seq));
    const ct = Buffer.concat([cipher.update(encodeJson(packet)), cipher.final(), cipher.getAuthTag()]);
    return { e2ee: 2, seq, ct: bytesToBase64Url(ct) };
  }

  open(frame: unknown): unknown {
    if (!isSessionFrameV2(frame)) throw new HandshakeError('malformed', 'not a v2 frame');
    const seq = this.guard.check(frame.seq);
    const data = base64UrlToBytes(frame.ct);
    if (data.length < 16) throw new HandshakeError('decrypt');
    let plain: Buffer;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, nonceForSeq(seq));
      decipher.setAuthTag(data.subarray(data.length - 16));
      plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    } catch {
      throw new HandshakeError('decrypt');
    }
    this.guard.commit(seq);
    return decodeJson(plain);
  }
}

export interface HostIdentity {
  hostId: string;
  /** PEM PKCS#8 приватного ключа сессий хоста (ECDSA P-256). */
  privateKeyPem: string;
  /** Его открытый ключ — несжатая точка (65 байт). */
  hostKeyRaw: Uint8Array;
}

/**
 * Ответ хоста на `client_hello`: эфемерный ECDH P-256, подпись транскрипта и ключи сессии. `deviceId` — тот, под
 * которым хост знает это соединение (из URL сокета или `fromClientId` релея), он входит в транскрипт.
 */
export function respondToClientHello(hello: unknown, deviceId: string, identity: HostIdentity): { serverHello: ServerHelloV2; session: NodeSessionV2 } {
  const { clientEph, clientNonce } = parseClientHello(hello);
  const { privateKey: ephPrivate, publicKey: ephPublic } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const hostEph = p256RawPublicKey(ephPublic);
  const hostNonce = crypto.randomBytes(NONCE_BYTES);

  let shared: Buffer;
  try {
    // Разбор SPKI проверяет, что точка клиента лежит на кривой.
    const peer = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(clientEph)]), format: 'der', type: 'spki' });
    shared = crypto.diffieHellman({ privateKey: ephPrivate, publicKey: peer });
  } catch {
    throw new HandshakeError('weak_key');
  }
  if (isAllZero(shared)) throw new HandshakeError('weak_key');

  const transcript = buildTranscript({
    hostId: identity.hostId,
    deviceId,
    hostKey: identity.hostKeyRaw,
    clientEph,
    hostEph,
    clientNonce,
    hostNonce
  });
  const sig = crypto.sign('sha256', transcript, { key: identity.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  const salt = crypto.createHash('sha256').update(transcript).digest();
  const session = new NodeSessionV2(hkdf(shared, salt, INFO_HOST_TO_CLIENT), hkdf(shared, salt, INFO_CLIENT_TO_HOST));

  return {
    serverHello: {
      type: 'server_hello',
      v: SESSION_PROTOCOL_V2,
      hostId: identity.hostId,
      hostKey: bytesToBase64Url(identity.hostKeyRaw),
      eph: bytesToBase64Url(hostEph),
      nonce: bytesToBase64Url(hostNonce),
      sig: bytesToBase64Url(sig)
    },
    session
  };
}

/** Проверка, что значение — открытый ключ сессий хоста в base64url (для ответов `enroll_device`). */
export function isHostKey(value: unknown): value is string {
  try {
    decodeFixed(value, KEY_BYTES, 'hostKey');
    return true;
  } catch {
    return false;
  }
}
