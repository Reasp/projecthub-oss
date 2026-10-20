/**
 * Протокол сессии Remote Control v2 ([[TASK-140.2]], [[decision-111]]): рукопожатие на эфемерных ключах ECDH P-256,
 * подпись транскрипта ECDSA P-256-ключом хоста, направленные ключи AES-256-GCM через HKDF-SHA256 и монотонные
 * счётчики против повтора. P-256, а не X25519/Ed25519: Ed25519 в WebCrypto есть только с Chrome 137, а WebView
 * многих телефонов старше — клиент тихо оставался бы на v1 (decision-111, Context).
 *
 * Модуль общий для хоста и клиента и не зависит от Electron, Node и DOM: здесь формат сообщений, транскрипт,
 * nonce, защита от повтора и клиентская сторона на WebCrypto (браузер, WebView, Mini App; в Node — тот же
 * `globalThis.crypto`). Сторона хоста на `node:crypto` — `remoteSessionV2Node.ts`: синхронная, чтобы порядок
 * отправки событий совпадал с порядком счётчиков.
 *
 * Обмен:
 *   клиент → `client_hello {v:2, eph, nonce}` открытым текстом (только публичные значения);
 *   хост  → `server_hello {v:2, hostId, hostKey, eph, nonce, sig}`, `sig` — ECDSA P-256 по транскрипту;
 *   дальше оба шлют только `{e2ee:2, seq, ct}`; первым зашифрованным пакетом клиент шлёт прежний `handshake`.
 */

export const SESSION_PROTOCOL_V1 = 1;
export const SESSION_PROTOCOL_V2 = 2;
/** Версии сессии, которые понимает хост; объявляются в `handshake_ack.protocols`. */
export const HOST_SESSION_PROTOCOLS: readonly number[] = [SESSION_PROTOCOL_V2, SESSION_PROTOCOL_V1];

const LABEL = 'projecthub-remote-v2';
const TRANSCRIPT_LABEL = `${LABEL} handshake`;
export const INFO_CLIENT_TO_HOST = `${LABEL} c2h`;
export const INFO_HOST_TO_CLIENT = `${LABEL} h2c`;

/** Длины в байтах: открытые ключи P-256 — несжатая точка (65 байт), подпись — r‖s (64 байта). */
export const KEY_BYTES = 65;
export const NONCE_BYTES = 32;
export const SIGNATURE_BYTES = 64;
const SHARED_BYTES = 32;
/** Отпечаток ключа хоста для ссылки Telegram: 96 бит — 16 символов base64url. */
export const FINGERPRINT_BYTES = 12;

export interface ClientHelloV2 {
  type: 'client_hello';
  v: 2;
  /** Эфемерный ECDH P-256-ключ клиента (несжатая точка), base64url. */
  eph: string;
  nonce: string;
}

export interface ServerHelloV2 {
  type: 'server_hello';
  v: 2;
  hostId: string;
  /** Долгосрочный ECDSA P-256-ключ сессий хоста (несжатая точка, base64url) — тот же, что в QR. */
  hostKey: string;
  eph: string;
  nonce: string;
  /** ECDSA P-256 / SHA-256-подпись транскрипта (r‖s). */
  sig: string;
}

export interface SessionFrameV2 {
  e2ee: 2;
  seq: number;
  /** Шифртекст с тегом GCM в конце, base64url. */
  ct: string;
}

export type HandshakeErrorCode =
  | 'malformed'
  | 'no_pin'
  | 'bad_signature'
  | 'host_key_mismatch'
  | 'host_id_mismatch'
  | 'weak_key'
  | 'replay'
  | 'decrypt';

export class HandshakeError extends Error {
  constructor(public readonly code: HandshakeErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'HandshakeError';
  }
}

// ── кодирование ──

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new HandshakeError('malformed', 'not base64url');
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url фиксированной длины в байтах, иначе `malformed`. */
export function decodeFixed(value: unknown, bytes: number, what: string): Uint8Array {
  if (typeof value !== 'string') throw new HandshakeError('malformed', `${what}: not a string`);
  const out = base64UrlToBytes(value);
  if (out.length !== bytes) throw new HandshakeError('malformed', `${what}: expected ${bytes} bytes`);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Транскрипт рукопожатия: метка протокола и все поля обеих сторон, каждое с длиной (u16 BE). `deviceId`
 * в транскрипте не даёт релею подменить, какому клиенту адресован ответ хоста.
 */
export function buildTranscript(t: {
  hostId: string;
  deviceId: string;
  hostKey: Uint8Array;
  clientEph: Uint8Array;
  hostEph: Uint8Array;
  clientNonce: Uint8Array;
  hostNonce: Uint8Array;
}): Uint8Array {
  const parts = [encoder.encode(TRANSCRIPT_LABEL), encoder.encode(t.hostId), encoder.encode(t.deviceId), t.hostKey, t.clientEph, t.hostEph, t.clientNonce, t.hostNonce];
  let total = 0;
  for (const p of parts) {
    if (p.length > 0xffff) throw new HandshakeError('malformed', 'transcript field too long');
    total += 2 + p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out[off] = p.length >> 8;
    out[off + 1] = p.length & 0xff;
    out.set(p, off + 2);
    off += 2 + p.length;
  }
  return out;
}

/** Nonce AES-GCM из счётчика: 4 нулевых байта и 8 байт `seq` (big-endian). Ключи направленные, поэтому nonce не повторяется. */
export function nonceForSeq(seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new HandshakeError('malformed', 'bad seq');
  const out = new Uint8Array(12);
  const hi = Math.floor(seq / 0x1_0000_0000);
  const lo = seq >>> 0;
  out[4] = hi >>> 24;
  out[5] = (hi >>> 16) & 0xff;
  out[6] = (hi >>> 8) & 0xff;
  out[7] = hi & 0xff;
  out[8] = lo >>> 24;
  out[9] = (lo >>> 16) & 0xff;
  out[10] = (lo >>> 8) & 0xff;
  out[11] = lo & 0xff;
  return out;
}

/** Общий секрет из нулей — признак негодного ключа собеседника: такую сессию не открываем. */
export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
  return acc === 0;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

/**
 * Защита от повтора: принимается только `seq` больше последнего принятого. Пакет, который не расшифровался,
 * счётчик не двигает — иначе подделка с большим `seq` отрезала бы настоящие пакеты.
 */
export class ReplayGuard {
  private last = 0;
  check(seq: unknown): number {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new HandshakeError('malformed', 'bad seq');
    if (seq <= this.last) throw new HandshakeError('replay', `seq ${seq} <= ${this.last}`);
    return seq;
  }
  commit(seq: number): void {
    if (seq > this.last) this.last = seq;
  }
  get lastSeq(): number {
    return this.last;
  }
}

export function parseClientHello(value: unknown): { clientEph: Uint8Array; clientNonce: Uint8Array } {
  const v = value as Partial<ClientHelloV2> | null;
  if (!v || v.type !== 'client_hello' || v.v !== SESSION_PROTOCOL_V2) throw new HandshakeError('malformed', 'not a v2 client_hello');
  return { clientEph: decodeFixed(v.eph, KEY_BYTES, 'eph'), clientNonce: decodeFixed(v.nonce, NONCE_BYTES, 'nonce') };
}

export function parseServerHello(value: unknown): {
  hostId: string;
  hostKey: Uint8Array;
  hostEph: Uint8Array;
  hostNonce: Uint8Array;
  sig: Uint8Array;
} {
  const v = value as Partial<ServerHelloV2> | null;
  if (!v || v.type !== 'server_hello' || v.v !== SESSION_PROTOCOL_V2) throw new HandshakeError('malformed', 'not a v2 server_hello');
  if (typeof v.hostId !== 'string' || !v.hostId) throw new HandshakeError('malformed', 'hostId');
  return {
    hostId: v.hostId,
    hostKey: decodeFixed(v.hostKey, KEY_BYTES, 'hostKey'),
    hostEph: decodeFixed(v.eph, KEY_BYTES, 'eph'),
    hostNonce: decodeFixed(v.nonce, NONCE_BYTES, 'nonce'),
    sig: decodeFixed(v.sig, SIGNATURE_BYTES, 'sig')
  };
}

export function isSessionFrameV2(value: unknown): value is SessionFrameV2 {
  const v = value as Partial<SessionFrameV2> | null;
  return Boolean(v && v.e2ee === 2 && typeof v.seq === 'number' && typeof v.ct === 'string');
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

// ── клиент на WebCrypto ──

type Subtle = SubtleCrypto;

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function defaultSubtle(): Subtle {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto недоступен');
  return subtle;
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Отпечаток ключа хоста: первые 12 байт SHA-256 в base64url (ссылка Telegram, где полный ключ не помещается). */
export async function hostKeyFingerprint(hostKey: string, subtle: Subtle = defaultSubtle()): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', buf(decodeFixed(hostKey, KEY_BYTES, 'hostKey'))));
  return bytesToBase64Url(digest.slice(0, FINGERPRINT_BYTES));
}

let supportCache: Promise<boolean> | null = null;

/**
 * Даёт ли платформа ECDH и ECDSA P-256 в WebCrypto (есть во всех браузерах и WebView с 2014 года; нет только вне
 * защищённого контекста). Без них клиент остаётся на v1 — решает сам клиент по своим возможностям, а не по ответу
 * хоста, поэтому посредник не может навязать v1.
 */
export function webSessionV2Supported(subtle?: Subtle): Promise<boolean> {
  if (!subtle && supportCache) return supportCache;
  const check = (async () => {
    try {
      const s = subtle ?? defaultSubtle();
      const pair = (await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
      const raw = new Uint8Array(await s.exportKey('raw', pair.publicKey));
      await s.importKey('raw', buf(raw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return true;
    } catch {
      return false;
    }
  })();
  if (!subtle) supportCache = check;
  return check;
}

async function hkdfKey(subtle: Subtle, shared: Uint8Array, salt: Uint8Array, info: string, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(encoder.encode(info)) }, ikm, 256);
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * Сессия клиента: шифрует ключом «клиент → хост», расшифровывает ключом «хост → клиент». Операции идут
 * цепочкой: WebCrypto асинхронен, и без очереди пакет с меньшим `seq` мог бы уйти позже большего и быть
 * отброшен как повтор.
 */
export class WebSessionV2 {
  private sendSeq = 0;
  private readonly guard = new ReplayGuard();
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly subtle: Subtle,
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey
  ) {}

  seal(packet: unknown): Promise<SessionFrameV2> {
    const seq = ++this.sendSeq;
    const run = this.sendChain.then(async () => {
      const ct = new Uint8Array(await this.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonceForSeq(seq)), tagLength: 128 }, this.sendKey, buf(encodeJson(packet))));
      return { e2ee: 2 as const, seq, ct: bytesToBase64Url(ct) };
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  open(frame: unknown): Promise<unknown> {
    const run = this.recvChain.then(async () => {
      if (!isSessionFrameV2(frame)) throw new HandshakeError('malformed', 'not a v2 frame');
      const seq = this.guard.check(frame.seq);
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(
          await this.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonceForSeq(seq)), tagLength: 128 }, this.recvKey, buf(base64UrlToBytes(frame.ct)))
        );
      } catch {
        throw new HandshakeError('decrypt');
      }
      this.guard.commit(seq);
      return decodeJson(plain);
    });
    this.recvChain = run.catch(() => undefined);
    return run;
  }
}

/** Чего клиент ждёт от хоста: ключ из QR (`hostKey`) или его отпечаток из ссылки Telegram (`hostKeyFp`). */
export interface HostExpectation {
  deviceId: string;
  hostId?: string;
  hostKey?: string;
  hostKeyFp?: string;
}

export interface ClientHandshakeResult {
  session: WebSessionV2;
  /** Подтверждённый ключ хоста — клиент закрепляет его в профиле. */
  hostKey: string;
  hostId: string;
}

export interface ClientHandshake {
  hello: ClientHelloV2;
  finish(serverHello: unknown, expect: HostExpectation): Promise<ClientHandshakeResult>;
}

/**
 * Начало рукопожатия на клиенте. Без закреплённого ключа хоста (`hostKey` или `hostKeyFp`) v2 не завершается:
 * подпись, проверенная ключом из того же ответа, ничего бы не доказывала.
 */
export async function createClientHandshake(subtle: Subtle = defaultSubtle(), random: (n: number) => Uint8Array = randomBytes): Promise<ClientHandshake> {
  const eph = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const clientEph = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const clientNonce = random(NONCE_BYTES);
  const hello: ClientHelloV2 = { type: 'client_hello', v: SESSION_PROTOCOL_V2, eph: bytesToBase64Url(clientEph), nonce: bytesToBase64Url(clientNonce) };

  return {
    hello,
    async finish(serverHello, expect) {
      const s = parseServerHello(serverHello);
      if (expect.hostId && s.hostId !== expect.hostId) throw new HandshakeError('host_id_mismatch');
      const hostKey = bytesToBase64Url(s.hostKey);
      if (expect.hostKey) {
        if (!bytesEqual(decodeFixed(expect.hostKey, KEY_BYTES, 'pinned hostKey'), s.hostKey)) throw new HandshakeError('host_key_mismatch');
      } else if (expect.hostKeyFp) {
        if ((await hostKeyFingerprint(hostKey, subtle)) !== expect.hostKeyFp) throw new HandshakeError('host_key_mismatch');
      } else {
        throw new HandshakeError('no_pin');
      }

      const transcript = buildTranscript({
        hostId: s.hostId,
        deviceId: expect.deviceId,
        hostKey: s.hostKey,
        clientEph,
        hostEph: s.hostEph,
        clientNonce,
        hostNonce: s.hostNonce
      });
      let ok: boolean;
      try {
        const verifyKey = await subtle.importKey('raw', buf(s.hostKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, buf(s.sig), buf(transcript));
      } catch {
        ok = false;
      }
      if (!ok) throw new HandshakeError('bad_signature');

      let shared: Uint8Array;
      try {
        // Импорт проверяет, что точка лежит на кривой: чужая «точка» вне кривой отклоняется здесь.
        const peer = await subtle.importKey('raw', buf(s.hostEph), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, SHARED_BYTES * 8));
      } catch {
        throw new HandshakeError('weak_key');
      }
      if (isAllZero(shared)) throw new HandshakeError('weak_key');
      const salt = new Uint8Array(await subtle.digest('SHA-256', buf(transcript)));
      const sendKey = await hkdfKey(subtle, shared, salt, INFO_CLIENT_TO_HOST, 'encrypt');
      const recvKey = await hkdfKey(subtle, shared, salt, INFO_HOST_TO_CLIENT, 'decrypt');
      return { session: new WebSessionV2(subtle, sendKey, recvKey), hostKey, hostId: s.hostId };
    }
  };
}
