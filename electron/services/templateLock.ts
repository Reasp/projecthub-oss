/**
 * Lock-файл применённого шаблона и решение по трём версиям файла (decision-91; TASK-156).
 *
 * `.projecthub/template-lock.json` помнит, какой шаблон, какой версии и с какими настройками
 * применён к проекту, и хэш содержимого, которое шаблон дал каждому своему файлу. По этому хэшу
 * обновление отличает правку пользователя от изменения шаблона. Сами базовые версии лежат рядом
 * в `.projecthub/template-base.json.gz` — только для диффа «было в шаблоне → стало в шаблоне».
 *
 * Модуль чистый: чтение и запись файлов — в `projectInitService.ts`.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { InitAction, InitReason } from './initFoundation.js';

export const TEMPLATE_LOCK_PATH = '.projecthub/template-lock.json';
export const TEMPLATE_BASE_PATH = '.projecthub/template-base.json.gz';

/** Больше — базовая версия файла не сохраняется (дифф «было в шаблоне» не покажется). */
export const BASE_TEXT_MAX_BYTES = 512 * 1024;

export interface TemplateLockTemplate {
  /** id шаблона в каталоге (`builtin` — встроенный). */
  id: string;
  manifestId: string;
  name: string;
  version: string;
  /** Хэш содержимого шаблона, как в каталоге. */
  hash: string;
  origin: string;
  /** Репозиторий шаблона из git без учётных данных. */
  source?: string;
  /** Коммит шаблона из git. */
  commit?: string;
}

export interface TemplateLock {
  schema: 1;
  template: TemplateLockTemplate;
  placement: 'root' | 'subfolder';
  /** Каталог инфраструктуры относительно корня проекта (`''` — корень). */
  infraDir: string;
  features: Record<string, boolean>;
  sets: Record<string, boolean>;
  gitHooks: boolean;
  appliedAt: string;
  /** Путь файла от корня проекта → sha256 содержимого, которое дал шаблон. */
  files: Record<string, string>;
  /** Секция правил шаблона → sha256 её текста. */
  rules: Record<string, string>;
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Путь из lock-файла можно предложить удалить, только если он относительный, внутри проекта и
 * не служебный: lock-файл коммитится и правится руками, ему нельзя верить на слово.
 */
export function isSafeLockPath(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false;
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) return false;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  const top = parts[0].toLowerCase();
  return top !== '.git' && top !== 'backlog' && !(top === '.projecthub' && parts[1]?.toLowerCase() !== 'infra');
}

function boolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
}

function hashMap(value: unknown, keyOk: (key: string) => boolean): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key, v]) => keyOk(key) && typeof v === 'string' && HASH_RE.test(v))
  ) as Record<string, string>;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Разбор lock-файла; битый или чужой формат — `null` (проект обновляется как без lock-файла). */
export function parseTemplateLock(text: string | null): TemplateLock | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = r.template as Record<string, unknown> | undefined;
  if (r.schema !== 1 || !t || typeof t !== 'object' || !str(t.id)) return null;
  const infraDir = str(r.infraDir).replace(/\/+$/, '');
  if (infraDir && !isSafeLockPath(infraDir)) return null;
  const template: TemplateLockTemplate = {
    id: str(t.id),
    manifestId: str(t.manifestId),
    name: str(t.name),
    version: str(t.version),
    hash: str(t.hash),
    origin: str(t.origin)
  };
  if (str(t.source)) template.source = str(t.source);
  if (str(t.commit)) template.commit = str(t.commit);
  return {
    schema: 1,
    template,
    placement: r.placement === 'root' ? 'root' : 'subfolder',
    infraDir,
    features: boolMap(r.features),
    sets: boolMap(r.sets),
    gitHooks: r.gitHooks === true,
    appliedAt: str(r.appliedAt),
    files: hashMap(r.files, isSafeLockPath),
    rules: hashMap(r.rules, (key) => /^[A-Za-z0-9_-]{1,64}$/.test(key))
  };
}

export function renderTemplateLock(lock: TemplateLock): string {
  const sorted = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ ...lock, files: sorted(lock.files), rules: sorted(lock.rules) }, null, 2)}\n`;
}

/** URL репозитория без логина и токена: lock-файл коммитится. */
export function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

// ---------------------------------------------------------------------------------------
// Решение по трём версиям
// ---------------------------------------------------------------------------------------

export interface ThreeWayDecision {
  action: InitAction;
  options: InitAction[];
  reason: InitReason;
  backupOnReplace?: boolean;
}

/**
 * Что делать с файлом шаблона по трём хэшам: `project` — файл в проекте (`null` — его нет),
 * `next` — что даёт шаблон сейчас, `base` — что шаблон дал при прошлом применении
 * (`undefined` — lock-файла нет или файл в нём не записан).
 *
 * - пользователь файл не менял — обновить (с резервной копией);
 * - шаблон файл не менял — не трогать;
 * - менялись оба — конфликт, по умолчанию оставить: решает человек по диффу;
 * - пользователь удалил файл шаблона — не возвращать без спроса.
 */
export function threeWayDecision(project: string | null, next: string, base: string | undefined): ThreeWayDecision {
  if (project === next) return { action: 'skip', options: ['skip'], reason: 'up-to-date' };
  if (project === null) {
    return base === undefined
      ? { action: 'create', options: ['create', 'skip'], reason: 'template-file' }
      : { action: 'skip', options: ['create', 'skip'], reason: 'user-deleted' };
  }
  if (base === undefined) return { action: 'skip', options: ['replace', 'skip'], reason: 'template-changed', backupOnReplace: true };
  if (project === base) return { action: 'replace', options: ['replace', 'skip'], reason: 'template-updated', backupOnReplace: true };
  if (next === base) return { action: 'skip', options: ['replace', 'skip'], reason: 'user-modified', backupOnReplace: true };
  return { action: 'skip', options: ['replace', 'skip'], reason: 'conflict', backupOnReplace: true };
}

// ---------------------------------------------------------------------------------------
// Базовые версии для диффа
// ---------------------------------------------------------------------------------------

/** Текст ли это: без NUL в первых 8 КБ и не больше предела. */
export function isStorableText(buf: Buffer): boolean {
  if (buf.length > BASE_TEXT_MAX_BYTES) return false;
  return !buf.subarray(0, 8192).includes(0);
}

export function encodeBase(files: Record<string, string>): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ schema: 1, files }), 'utf-8'));
}

export function decodeBase(buf: Buffer | null): Record<string, string> {
  if (!buf) return {};
  try {
    const parsed = JSON.parse(zlib.gunzipSync(buf).toString('utf-8')) as { schema?: number; files?: Record<string, unknown> };
    if (parsed.schema !== 1 || !parsed.files || typeof parsed.files !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed.files).filter(([key, value]) => isSafeLockPath(key) && typeof value === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}
