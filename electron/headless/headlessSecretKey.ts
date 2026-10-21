import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Шифр секретов ph-agent без `safeStorage` (TASK-130, [[decision-119]] п. 3): AES-256-GCM, ключ 32 байта под защитой
 * ОС. Порядок поиска ключа: systemd credentials → `PH_AGENT_KEY_FILE` → `<данные>/secret.key` (на Windows — DPAPI,
 * на Linux и macOS — права 0600). Формат шифртекста: `v1` | iv(12) | tag(16) | данные.
 */

const MAGIC = Buffer.from('v1');
const IV = 12;
const TAG = 16;

export interface KeySource {
  kind: 'systemd-credential' | 'key-file' | 'dpapi' | 'file-0600';
  path: string;
}

export function sealSecret(key: Buffer, plain: string): Buffer {
  const iv = crypto.randomBytes(IV);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

export function openSecret(key: Buffer, sealed: Buffer): string {
  if (sealed.length < MAGIC.length + IV + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Неизвестный формат секрета');
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV);
  const tag = sealed.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV + TAG)), decipher.final()]).toString('utf8');
}

function readKey(file: string): Buffer {
  const raw = fs.readFileSync(file);
  // Ключ в файле — 32 байта или их base64/hex текстом (так удобнее передавать через systemd-creds).
  if (raw.length === 32) return raw;
  const text = raw.toString('utf8').trim();
  const fromHex = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : null;
  const key = fromHex ?? Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error(`Ключ ${file} должен быть 32 байта (raw, hex или base64)`);
  return key;
}

/** DPAPI текущего пользователя через PowerShell: ключ на диске зашифрован, расшифровать его может только этот пользователь. */
function dpapi(op: 'Protect' | 'Unprotect', data: Buffer): Buffer {
  const script =
    `Add-Type -AssemblyName System.Security; $in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `$out=[Security.Cryptography.ProtectedData]::${op}($in,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($out))`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: data.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  if (res.status !== 0) throw new Error(`DPAPI ${op} не удался: ${(res.stderr || res.error?.message || '').trim().slice(0, 200)}`);
  return Buffer.from(res.stdout.trim(), 'base64');
}

/**
 * Ключ шифрования секретов. Нет ключа — создаётся новый (секреты прошлого ключа станут нечитаемыми, их отложит в
 * резерв `secretStorageService`).
 */
export function loadOrCreateSecretKey(dataDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { key: Buffer; source: KeySource } {
  const credential = env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'ph-agent.key') : '';
  if (credential && fs.existsSync(credential)) return { key: readKey(credential), source: { kind: 'systemd-credential', path: credential } };
  if (env.PH_AGENT_KEY_FILE) return { key: readKey(env.PH_AGENT_KEY_FILE), source: { kind: 'key-file', path: env.PH_AGENT_KEY_FILE } };

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'secret.key');
  if (platform === 'win32') {
    if (fs.existsSync(file)) return { key: dpapi('Unprotect', fs.readFileSync(file)), source: { kind: 'dpapi', path: file } };
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, dpapi('Protect', key));
    return { key, source: { kind: 'dpapi', path: file } };
  }
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o077;
    if (mode !== 0) fs.chmodSync(file, 0o600);
    return { key: readKey(file), source: { kind: 'file-0600', path: file } };
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // каталог создан не нами — права оставляем
  }
  return { key, source: { kind: 'file-0600', path: file } };
}
