import crypto from 'node:crypto';
import { AppError } from '../../src/lib/appError.js';
import { detectSecrets } from './secretPatterns.js';
import { PROFILE_PASSWORD_MIN, isProfileSectionId, type ProfileSectionId, type SectionChange } from '../../src/lib/profileSections.js';

/**
 * Профиль ProjectHub — переносимая часть состояния (TASK-224, [[decision-175]] п. 3–4, 6): формат файла, шифрование
 * паролем, вырезание секретов и слияние разделов. Чистый модуль без Electron и диска — его же берёт перенос профиля
 * с домашнего хоста по федерации ([[TASK-225]]).
 *
 * - Документ — JSON с версией и разделами; у раздела своё время изменения.
 * - Файл — конверт `projecthub-profile-encrypted`: scrypt (N = 2^15, r = 8, p = 1) → ключ AES-256-GCM.
 * - Секретов в профиле нет никогда: поля с именами ключей и токенов вырезаются, строки, похожие на секрет, — тоже.
 * - Слияние по ключам: объекты — по полям, списки записей — по `id`/`key`/`slug`/`name`, скаляры — сторона с более
 *   свежим разделом.
 */

export const PROFILE_FORMAT = 'projecthub-profile';
export const PROFILE_VERSION = 1;
export const PROFILE_FILE_FORMAT = 'projecthub-profile-encrypted';
export const PROFILE_FILE_EXTENSION = 'phprofile';

export { PROFILE_SECTIONS, PROFILE_PASSWORD_MIN, isProfileSectionId, type ProfileSectionId, type SectionChange } from '../../src/lib/profileSections.js';

export interface ProfileSection {
  /** Время изменения раздела на машине-источнике (ISO): по нему решается спор скалярных настроек. */
  updatedAt: string;
  data: unknown;
}

export interface ProfileDocument {
  format: typeof PROFILE_FORMAT;
  version: number;
  exportedAt: string;
  /** Версия ProjectHub, которая сделала профиль. */
  appVersion?: string;
  sections: Partial<Record<ProfileSectionId, ProfileSection>>;
}

/** Раздел ролей: файлы `<userData>/roles/` по имени. */
export interface RolesSectionData {
  files: Record<string, string>;
}

/** Проект из списка: без локального пути, с адресом remote для клонирования. */
export interface ProfileProject {
  name: string;
  remote: string;
}

// ─────────────────────────── Секреты ───────────────────────────

/** Имена полей, значения которых не покидают машину ни при каком разделе. */
const SECRET_KEY_RE = /^(api[-_]?key|apikeys?|token|tokens|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|secret|secrets|client[-_]?secret|password|passphrase|private[-_]?key|authorization|auth[-_]?header|cookie|session[-_]?key|webhook[-_]?secret|bot[-_]?token)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Копия значения без секретов: поля с именами ключей и токенов удаляются, строки, в которых сканер секретов что-то
 * находит, — тоже. Второе ловит ключ, сохранённый в поле с неожиданным именем (старые установки, decision-175 п. 3).
 */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      const clean = stripSecrets(v);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  if (typeof value === 'string' && detectSecrets(value).length > 0) return undefined;
  return value;
}

/** Профиль без секретов: защита на выходе, даже если сборщик раздела что-то пропустил. */
export function sanitizeProfile(doc: ProfileDocument): ProfileDocument {
  const sections: ProfileDocument['sections'] = {};
  for (const [id, section] of Object.entries(doc.sections)) {
    if (!isProfileSectionId(id) || !section) continue;
    sections[id] = { updatedAt: section.updatedAt, data: stripSecrets(section.data) };
  }
  return { ...doc, sections };
}

// ─────────────────────────── Шифрование ───────────────────────────

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 };

interface EncryptedEnvelope {
  format: typeof PROFILE_FILE_FORMAT;
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(password.normalize('NFC'), salt, SCRYPT.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
}

export function encryptProfile(doc: ProfileDocument, password: string): string {
  if (password.length < PROFILE_PASSWORD_MIN) throw new AppError('profile.passwordTooShort', { min: PROFILE_PASSWORD_MIN });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(sanitizeProfile(doc)), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    format: PROFILE_FILE_FORMAT,
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function parseEnvelope(text: string): EncryptedEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('profile.notProfileFile');
  }
  const e = raw as Partial<EncryptedEnvelope> | null;
  if (!e || typeof e !== 'object' || e.format !== PROFILE_FILE_FORMAT) throw new AppError('profile.notProfileFile');
  if (e.v !== 1 || e.cipher !== 'aes-256-gcm' || e.kdf?.name !== 'scrypt') throw new AppError('profile.unsupportedFile');
  const { N, r, p, salt } = e.kdf;
  // Параметры KDF из файла ограничены: чужой файл не должен занять память и процессор на минуты.
  const sane = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 17 && (N & (N - 1)) === 0 && r === 8 && Number.isInteger(p) && p >= 1 && p <= 4;
  if (!sane || typeof salt !== 'string' || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.data !== 'string') {
    throw new AppError('profile.corruptFile');
  }
  return e as EncryptedEnvelope;
}

function parseDocument(json: string): ProfileDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AppError('profile.corruptFile');
  }
  const doc = raw as Partial<ProfileDocument> | null;
  if (!doc || typeof doc !== 'object' || doc.format !== PROFILE_FORMAT) throw new AppError('profile.corruptFile');
  if (typeof doc.version !== 'number' || doc.version > PROFILE_VERSION) throw new AppError('profile.newerVersion', { version: String(doc.version) });
  const sections: ProfileDocument['sections'] = {};
  if (doc.sections && typeof doc.sections === 'object') {
    for (const [id, s] of Object.entries(doc.sections)) {
      if (!isProfileSectionId(id) || !s || typeof s !== 'object') continue;
      const section = s as Partial<ProfileSection>;
      sections[id] = { updatedAt: typeof section.updatedAt === 'string' ? section.updatedAt : '', data: section.data };
    }
  }
  return sanitizeProfile({
    format: PROFILE_FORMAT,
    version: doc.version,
    exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
    ...(typeof doc.appVersion === 'string' ? { appVersion: doc.appVersion } : {}),
    sections
  });
}

/** Расшифровка файла профиля. Неверный пароль и битый файл — `AppError`, ничего не меняется. */
export function decryptProfile(text: string, password: string): ProfileDocument {
  const e = parseEnvelope(text);
  const key = deriveKey(password, Buffer.from(e.kdf.salt, 'base64'), e.kdf);
  const iv = Buffer.from(e.iv, 'base64');
  const tag = Buffer.from(e.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new AppError('profile.corruptFile');
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]);
  } catch {
    // GCM не отличает неверный пароль от подмены данных: и то и другое — отказ проверки тега.
    throw new AppError('profile.wrongPassword');
  }
  return parseDocument(plain.toString('utf8'));
}

/** Профиль из канала федерации ([[TASK-225]]): тот же документ без шифрования паролем, секреты вырезаются снова. */
export function profileFromJson(value: unknown): ProfileDocument {
  return parseDocument(JSON.stringify(value));
}

// ─────────────────────────── Слияние ───────────────────────────

const ID_FIELDS = ['id', 'key', 'slug', 'name'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Поле, которое однозначно называет запись в каждом из списков (внутри списка без повторов). */
function idField(...lists: unknown[][]): string | null {
  const all = lists.flat();
  if (all.length === 0 || !all.every(isPlainObject)) return null;
  for (const field of ID_FIELDS) {
    const unique = lists.every((list) => {
      const ids = list.map((x) => (x as Record<string, unknown>)[field]);
      return ids.every((id) => typeof id === 'string' && id) && new Set(ids).size === ids.length;
    });
    if (unique) return field;
  }
  return null;
}

/**
 * Слияние значения по ключам. Объекты — по полям (поле есть только с одной стороны — берётся оно), списки записей с
 * общим полем-идентификатором — объединение по нему, остальное (скаляры, списки без идентификатора) — входящее,
 * если `incomingWins`, иначе своё.
 */
export function mergeValue(local: unknown, incoming: unknown, incomingWins: boolean): unknown {
  if (local === undefined) return incoming;
  if (incoming === undefined) return local;
  if (isPlainObject(local) && isPlainObject(incoming)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
      out[key] = mergeValue(local[key], incoming[key], incomingWins);
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(incoming)) {
    const field = idField(local, incoming);
    if (field) {
      const out: unknown[] = [];
      const seen = new Set<string>();
      const byId = new Map(incoming.map((x) => [(x as Record<string, string>)[field], x] as const));
      for (const item of local) {
        const id = (item as Record<string, string>)[field];
        seen.add(id);
        out.push(byId.has(id) ? mergeValue(item, byId.get(id), incomingWins) : item);
      }
      for (const item of incoming) if (!seen.has((item as Record<string, string>)[field])) out.push(item);
      return out;
    }
  }
  return incomingWins ? incoming : local;
}

export interface SectionPlan {
  id: ProfileSectionId;
  change: SectionChange;
  /** Входящий раздел новее своего: спорные скаляры берутся из него. */
  incomingNewer: boolean;
  merged: unknown;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function mergeRoles(local: RolesSectionData | undefined, incoming: RolesSectionData, incomingWins: boolean): RolesSectionData {
  const files: Record<string, string> = { ...(local?.files ?? {}) };
  for (const [name, content] of Object.entries(incoming.files ?? {})) {
    if (!(name in files) || incomingWins) files[name] = content;
  }
  return { files };
}

/** Что даст импорт раздела: `local` — раздел этой машины (или `undefined`), `incoming` — из профиля. */
export function planSection(id: ProfileSectionId, local: ProfileSection | undefined, incoming: ProfileSection): SectionPlan {
  const localTime = Date.parse(local?.updatedAt ?? '') || 0;
  const incomingTime = Date.parse(incoming.updatedAt) || 0;
  const incomingNewer = incomingTime > localTime;
  const merged =
    id === 'roles'
      ? mergeRoles(local?.data as RolesSectionData | undefined, (incoming.data ?? { files: {} }) as RolesSectionData, incomingNewer)
      : mergeValue(local?.data, incoming.data, incomingNewer);
  const change: SectionChange = local?.data === undefined ? 'new' : stable(merged) === stable(local.data) ? 'same' : 'changed';
  return { id, change, incomingNewer, merged };
}

/** Проекты профиля, которых нет на этой машине: сравнение по адресу remote без схемы, `.git` и регистра хоста. */
export function missingProjects(incoming: ProfileProject[], localRemotes: string[]): ProfileProject[] {
  const known = new Set(localRemotes.map(normalizeRemote));
  return incoming.filter((p) => !known.has(normalizeRemote(p.remote)));
}

export function normalizeRemote(remote: string): string {
  const r = remote.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(r);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`;
  try {
    const u = new URL(r);
    return `${u.hostname.toLowerCase()}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return r;
  }
}

/** Адрес remote, который можно клонировать: https или ssh, без учётных данных в адресе. */
export function isCloneableRemote(remote: string): boolean {
  const r = remote.trim();
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(r)) return true;
  try {
    const u = new URL(r);
    return (u.protocol === 'https:' || u.protocol === 'ssh:') && !u.password && (u.protocol === 'ssh:' || !u.username);
  } catch {
    return false;
  }
}
