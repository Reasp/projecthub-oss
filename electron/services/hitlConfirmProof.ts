import crypto from 'node:crypto';
import type { HitlRisk } from './hitlTypes.js';

/**
 * Подтверждение решения HITL биометрией (TASK-140.4, [[decision-112]] п. 4). Устройство при сопряжении по QR
 * регистрирует открытый ключ подтверждения: ECDSA P-256, закрытая часть живёт в Keystore/Secure Enclave и требует
 * биометрию на каждую подпись (нативная часть — [[TASK-140.6]]). Решение `high` устройство подписывает этим ключом,
 * хост проверяет подпись. Слова клиента «я проверил отпечаток» хост не принимает: без подписи — не биометрия.
 */

const LABEL = 'projecthub-hitl-confirm-v1';
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function fromBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}

/** Что подписывает устройство: хост, запрос, решение и класс — подпись не переносится на другой запрос или решение. */
export function confirmProofPayload(hostId: string, requestId: string, decision: 'allow' | 'deny', risk: HitlRisk): Buffer {
  return Buffer.from([LABEL, hostId, requestId, decision, risk].join('\n'), 'utf8');
}

/** Открытый ключ подтверждения: SPKI DER ECDSA P-256 в base64url (несжатая точка). Иное — `null`. */
export function parseConfirmKey(value: unknown): crypto.KeyObject | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const der = fromBase64Url(value);
  if (!der || der.length !== P256_SPKI_PREFIX.length + 65 || !der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' ? key : null;
  } catch {
    return null;
  }
}

/**
 * Проверка подписи. Подпись — DER (Android Keystore, Secure Enclave) или 64 байта r‖s (WebCrypto); обе формы
 * ECDSA SHA-256.
 */
export function verifyConfirmProof(confirmKey: unknown, payload: Buffer, signature: unknown): boolean {
  const key = parseConfirmKey(confirmKey);
  if (!key || typeof signature !== 'string') return false;
  const sig = fromBase64Url(signature);
  if (!sig || sig.length < 64 || sig.length > 80) return false;
  try {
    return crypto.verify('sha256', payload, { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig);
  } catch {
    return false;
  }
}
