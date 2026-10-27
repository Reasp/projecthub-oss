import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';

/**
 * Вложения в промпт Agents Studio с телефона (TASK-140.6, [[decision-114]] п. 5). Фото и файлы приходят частями по
 * тому же зашифрованному каналу, что и RPC, и сохраняются в проект на хосте: агент читает их обычным путём, как любой
 * файл проекта. Каталог `.projecthub/attachments/` сам себя исключает из git — снимок экрана не уедет в коммит.
 */

export const ATTACHMENT_DIR = '.projecthub/attachments';
/** Файл целиком — до 15 МБ; фото телефон уменьшает до отправки. */
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
/** Часть — до 768 КБ: кадр через туннель и релей остаётся небольшим, прогресс виден. */
export const ATTACHMENT_CHUNK_MAX = 768 * 1024;
/** Незаконченная загрузка живёт 10 минут. */
export const ATTACHMENT_TTL_MS = 10 * 60_000;
/** Одновременных загрузок на устройство. */
export const ATTACHMENT_MAX_UPLOADS = 6;
/** Вложений в одном промпте. */
export const ATTACHMENT_MAX_PER_PROMPT = 10;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Имя файла без каталогов и символов, которые запрещены в Windows; расширение сохраняется. */
export function sanitizeAttachmentName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  let clean = Array.from(base, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '_' : ch))
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) clean = 'file';
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  let stem = ext ? clean.slice(0, dot) : clean;
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return `${stem.slice(0, 80 - ext.length)}${ext}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `.projecthub/attachments/2026-10-20/153012-photo.jpg` — по местному времени хоста. */
export function attachmentRelPath(now: Date, name: string): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ATTACHMENT_DIR}/${day}/${time}-${sanitizeAttachmentName(name)}`;
}

const REL_PATH = /^\.projecthub\/attachments\/\d{4}-\d{2}-\d{2}\/[^/\\]{1,120}$/;

/** Путь, который телефон прислал в `studio_send`: только файл внутри каталога вложений. */
export function isAttachmentRelPath(value: unknown): value is string {
  return typeof value === 'string' && REL_PATH.test(value) && !value.includes('..');
}

/** Промпт с перечнем вложений: агент видит пути и открывает файлы сам. */
export function promptWithAttachments(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) return body;
  const list = ['Attachments from the phone (files in the project):', ...paths.map((p) => `- ${p}`)].join('\n');
  return body ? `${body}\n\n${list}` : list;
}

export interface AttachmentChunk {
  uploadId: string;
  name: string;
  size: number;
  offset: number;
  /** Часть файла в base64. */
  data: string;
}

export type AttachmentPutResult = { done: false; received: number } | { done: true; path: string; size: number };

interface Upload {
  projectPath: string;
  name: string;
  size: number;
  parts: Buffer[];
  received: number;
  touchedAt: number;
}

export interface AttachmentDeps {
  now(): number;
  /** Записать файл; вернуть итоговый относительный путь (при совпадении имени — с суффиксом). */
  write(projectPath: string, relPath: string, data: Buffer): Promise<string>;
}

/** Разбор части: ошибка — текст для телефона. */
export function parseAttachmentChunk(params: Record<string, unknown>): AttachmentChunk {
  const uploadId = typeof params.uploadId === 'string' ? params.uploadId : '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) throw new Error('uploadId is required');
  const size = Number(params.size);
  if (!Number.isInteger(size) || size <= 0) throw new Error('size is required');
  if (size > ATTACHMENT_MAX_BYTES) throw new AppError('attachments.tooLarge', { mb: ATTACHMENT_MAX_BYTES / 1024 / 1024 });
  const offset = Number(params.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset is required');
  const data = typeof params.data === 'string' ? params.data : '';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('data must be base64');
  return { uploadId, name: sanitizeAttachmentName(params.name), size, offset, data };
}

/**
 * Загрузки с телефона: части идут по порядку, файл пишется на диск только целиком. Незаконченные загрузки
 * убираются через `ATTACHMENT_TTL_MS`.
 */
export class AttachmentUploads {
  private uploads = new Map<string, Upload>();

  constructor(private readonly deps: AttachmentDeps) {}

  private sweep(): void {
    const now = this.deps.now();
    for (const [key, u] of this.uploads) if (now - u.touchedAt > ATTACHMENT_TTL_MS) this.uploads.delete(key);
  }

  async put(deviceId: string, projectPath: string, chunk: AttachmentChunk): Promise<AttachmentPutResult> {
    this.sweep();
    const key = `${deviceId}\n${chunk.uploadId}`;
    let upload = this.uploads.get(key);
    if (!upload) {
      if (chunk.offset !== 0) throw new AppError('attachments.uploadNotFound');
      const mine = [...this.uploads.keys()].filter((k) => k.startsWith(`${deviceId}\n`)).length;
      if (mine >= ATTACHMENT_MAX_UPLOADS) throw new AppError('attachments.tooManyUploads');
      upload = { projectPath, name: chunk.name, size: chunk.size, parts: [], received: 0, touchedAt: this.deps.now() };
      this.uploads.set(key, upload);
    }
    if (upload.projectPath !== projectPath || upload.size !== chunk.size) throw new Error('The upload belongs to another file');
    if (chunk.offset !== upload.received) throw new Error(`Expected a chunk at offset ${upload.received}`);
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.length === 0 || bytes.length > ATTACHMENT_CHUNK_MAX) throw new Error('Invalid chunk size');
    if (upload.received + bytes.length > upload.size) {
      this.uploads.delete(key);
      throw new Error('The file is larger than its declared size');
    }
    upload.parts.push(bytes);
    upload.received += bytes.length;
    upload.touchedAt = this.deps.now();
    if (upload.received < upload.size) return { done: false, received: upload.received };
    this.uploads.delete(key);
    const rel = attachmentRelPath(new Date(this.deps.now()), upload.name);
    const written = await this.deps.write(projectPath, rel, Buffer.concat(upload.parts));
    return { done: true, path: written, size: upload.size };
  }

  /** Отзыв устройства или выключение Remote Control — незаконченные загрузки устройства не нужны. */
  dropDevice(deviceId: string): void {
    for (const key of [...this.uploads.keys()]) if (key.startsWith(`${deviceId}\n`)) this.uploads.delete(key);
  }
}

/**
 * Запись вложения в проект: каталог с `.gitignore` из `*`, существующий файл не перезаписывается — к имени
 * добавляется `-1`, `-2`…
 */
export async function writeAttachmentFile(projectPath: string, relPath: string, data: Buffer): Promise<string> {
  const root = path.resolve(projectPath);
  const dirRoot = path.join(root, ...ATTACHMENT_DIR.split('/'));
  await fsp.mkdir(dirRoot, { recursive: true });
  await fsp.writeFile(path.join(dirRoot, '.gitignore'), '# Attachments from the phone (ProjectHub) — not for git\n*\n', { flag: 'wx' }).catch(() => undefined);
  const parsed = path.posix.parse(relPath);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? relPath : `${parsed.dir}/${parsed.name}-${i}${parsed.ext}`;
    const abs = path.resolve(root, ...candidate.split('/'));
    if (!abs.startsWith(dirRoot + path.sep)) throw new Error('The attachment path is outside the attachments folder');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    try {
      await fsp.writeFile(abs, data, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not pick a free attachment file name');
}

/** Пути вложений из `studio_send`: только существующие файлы каталога вложений этого проекта. */
export async function resolvePromptAttachments(projectPath: string, value: unknown): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  if (value.length > ATTACHMENT_MAX_PER_PROMPT) throw new AppError('attachments.tooMany', { count: ATTACHMENT_MAX_PER_PROMPT });
  const out: string[] = [];
  for (const rel of value) {
    if (!isAttachmentRelPath(rel)) throw new Error('The attachment is outside the attachments folder');
    const stat = await fsp.stat(path.resolve(projectPath, ...rel.split('/'))).catch(() => null);
    if (!stat?.isFile()) throw new AppError('attachments.notFound', { path: rel });
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}
