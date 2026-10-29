/**
 * Манифест обновления файлом и его подпись Ed25519 (TASK-147.4, [[decision-189]]). Чистый модуль без диска и окружения:
 * его используют и приложение (проверка перед установкой), и `scripts/release/sign-update.mjs` (подпись при выпуске),
 * поэтому каноническая форма у них одна.
 */
import crypto from 'node:crypto';

export const UPDATE_FORMAT = 'projecthub-update/1';
export const UPDATE_MANIFEST_SUFFIX = '.update.json';

/** JSON с ключами по алфавиту на всех уровнях и без пробелов — то, что подписывается. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Id ключа: первые 16 hex SHA-256 от SPKI DER открытого ключа. */
export function updateKeyId(publicKey) {
  const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Сравнение версий X.Y.Z: <0, 0, >0; неверная версия — `null`. */
export function compareVersions(a, b) {
  const x = VERSION_RE.exec(String(a ?? ''));
  const y = VERSION_RE.exec(String(b ?? ''));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Имя файла установщика без каталогов и служебных символов. */
export function isPlainFileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name === '.' || name === '..') return false;
  // Управляющие символы — по коду, а не в регулярном выражении.
  return !/[\\/:*?"<>|]/.test(name) && ![...name].some((ch) => ch.charCodeAt(0) < 32);
}

/**
 * Тип установщика по платформе: NSIS `.exe` на Windows, `.dmg` на macOS, `.AppImage` на Linux. Portable-exe и архивы
 * не подходят: они не заменяют установленное приложение, после перезапуска открылась бы старая версия.
 */
export const INSTALLER_EXTENSIONS = { win32: '.exe', darwin: '.dmg', linux: '.AppImage' };

/** Поля манифеста без подписи; ошибка — исключение с понятным текстом для выпускающего. */
export function buildUpdateManifest({ version, platform, arch, file, size, sha256, releasedAt }) {
  if (!VERSION_RE.test(String(version))) throw new Error('version must be X.Y.Z');
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('platform must be win32, darwin or linux');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('arch must be x64 or arm64');
  if (!isPlainFileName(file)) throw new Error('file must be a plain file name');
  if (!file.toLowerCase().endsWith(INSTALLER_EXTENSIONS[platform].toLowerCase())) throw new Error(`file must be a ${INSTALLER_EXTENSIONS[platform]} installer for ${platform}`);
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive integer');
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('sha256 must be 64 lowercase hex characters');
  return { format: UPDATE_FORMAT, version, platform, arch, file, size, sha256, releasedAt: releasedAt ?? new Date().toISOString() };
}

/** Подписанный манифест: поля плюс `keyId` и `signature` (base64 подписи канонической формы без `signature`). */
export function signUpdateManifest(fields, privateKey) {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  const unsigned = { ...fields, keyId: updateKeyId(crypto.createPublicKey(key)) };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key).toString('base64');
  return { ...unsigned, signature };
}

const FIELDS = ['format', 'version', 'platform', 'arch', 'file', 'size', 'sha256', 'releasedAt', 'keyId', 'signature'];

/**
 * Проверка манифеста до установки. Возвращает `{ ok: true, manifest }` или `{ ok: false, code, params }` — код ошибки
 * `update.*` из словаря `appErrorText`. Файл установщика (размер, хэш) проверяет вызывающий.
 *
 * @param {unknown} raw
 * @param {{ trustedKeys: Array<{ id: string, publicKey: string }>, currentVersion: string, platform: string, arch: string }} ctx
 */
export function verifyUpdateManifest(raw, ctx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'update.manifestInvalid' };
  const m = raw;
  if (m.format !== UPDATE_FORMAT || Object.keys(m).some((k) => !FIELDS.includes(k))) return { ok: false, code: 'update.manifestInvalid' };
  let fields;
  try {
    fields = buildUpdateManifest(m);
  } catch {
    return { ok: false, code: 'update.manifestInvalid' };
  }
  if (typeof m.releasedAt !== 'string' || typeof m.keyId !== 'string' || typeof m.signature !== 'string') return { ok: false, code: 'update.manifestInvalid' };
  if (ctx.trustedKeys.length === 0) return { ok: false, code: 'update.noTrustedKeys' };
  const trusted = ctx.trustedKeys.find((k) => k.id === m.keyId);
  if (!trusted) return { ok: false, code: 'update.untrustedKey', params: { keyId: String(m.keyId).slice(0, 32) } };
  let valid;
  try {
    const { signature, ...unsigned } = m;
    valid = crypto.verify(null, Buffer.from(canonicalJson(unsigned), 'utf8'), crypto.createPublicKey(trusted.publicKey), Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'update.badSignature' };
  if (m.platform !== ctx.platform || m.arch !== ctx.arch) {
    return { ok: false, code: 'update.wrongPlatform', params: { target: `${m.platform}-${m.arch}`, current: `${ctx.platform}-${ctx.arch}` } };
  }
  const cmp = compareVersions(m.version, ctx.currentVersion);
  if (cmp === null || cmp <= 0) return { ok: false, code: 'update.notNewer', params: { version: fields.version, current: String(ctx.currentVersion) } };
  return { ok: true, manifest: { ...fields, keyId: m.keyId, signature: m.signature } };
}
