import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';
import {
  PROMPT_ATTACHMENT_MAX_BYTES,
  cliAttachmentForm,
  isPreviewableImage,
  isPromptAttachmentPath,
  mimeFromName,
  promptWithFileList,
  sanitizePromptAttachments,
  type PromptAttachment
} from '../../src/lib/promptAttachments.js';
import { attachmentRelPath, sanitizeAttachmentName, writeAttachmentFile } from './studioAttachments.js';

/**
 * Вложения в промпт вкладки Agents Studio на ПК (TASK-289, decision-210): запись файла в каталог вложений вкладки,
 * превью и сборка хода. Claude Code получает картинки и PDF content-блоками user-сообщения `--input-format stream-json`,
 * остальные файлы и другие движки — путями в тексте промпта.
 */

/** Каталог внутри проекта (сам проект или его дерево); иначе — корень проекта. */
export function workDirInProject(projectPath: string, cwd: unknown): string {
  const root = path.resolve(projectPath);
  if (typeof cwd !== 'string' || !cwd.trim()) return root;
  const abs = path.resolve(cwd);
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? root : abs;
}

/** Абсолютный путь файла вложения; `null`, если путь не из каталога вложений проекта. */
export function attachmentAbsPath(projectPath: string, relPath: unknown): string | null {
  if (!isPromptAttachmentPath(relPath)) return null;
  const root = path.resolve(projectPath);
  const abs = path.resolve(root, ...relPath.split('/'));
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

const SAFE_TO_OPEN = /\.(png|jpe?g|gif|webp|bmp|pdf|txt|md|json|csv|log)$/i;

/** Открыть системной программой можно только картинку, PDF или текст — не исполняемый файл и не скрипт. */
export function isSafeToOpenAttachment(absPath: string): boolean {
  return SAFE_TO_OPEN.test(absPath);
}

/** Путь вложения для агента: от его рабочего каталога, если файл внутри; иначе абсолютный. */
export function attachmentPathForAgent(projectPath: string, workDir: string, relPath: string): string {
  const abs = path.resolve(path.resolve(projectPath), ...relPath.split('/'));
  const rel = path.relative(path.resolve(workDir), abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.split(path.sep).join('/');
}

export interface SaveAttachmentInput {
  name: unknown;
  mime: unknown;
  /** Содержимое в base64. */
  data: unknown;
}

/** Записать вложение в каталог вложений `workDir`; путь в ответе — от корня проекта. */
export async function saveStudioAttachment(projectPath: string, workDir: string, input: SaveAttachmentInput, now = new Date()): Promise<PromptAttachment> {
  const data = typeof input.data === 'string' ? input.data : '';
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new AppError('attachments.invalidUpload', { detail: 'data' });
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) throw new AppError('attachments.invalidUpload', { detail: 'data' });
  if (bytes.length > PROMPT_ATTACHMENT_MAX_BYTES) throw new AppError('attachments.tooLarge', { mb: PROMPT_ATTACHMENT_MAX_BYTES / 1024 / 1024 });
  const name = sanitizeAttachmentName(input.name);
  const mime = typeof input.mime === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mime) ? input.mime.toLowerCase() : mimeFromName(name);
  const written = await writeAttachmentFile(workDir, attachmentRelPath(now, name), bytes);
  const dirRel = path.relative(path.resolve(projectPath), path.resolve(workDir)).split(path.sep).join('/');
  const projectRel = dirRel ? `${dirRel}/${written}` : written;
  if (!isPromptAttachmentPath(projectRel)) throw new AppError('attachments.outsideFolder');
  // Подпись — исходное имя; метка времени и суффикс от совпадения имён остаются только в пути.
  return { path: projectRel, name, mime, size: bytes.length };
}

/** Превью картинки-вложения data URL; `null` — не картинка, нет файла или путь не из каталога вложений. */
export async function attachmentPreviewDataUrl(projectPath: string, relPath: unknown, mime: unknown): Promise<string | null> {
  const abs = attachmentAbsPath(projectPath, relPath);
  const type = typeof mime === 'string' && mime ? mime : mimeFromName(String(relPath));
  if (!abs || !isPreviewableImage(type)) return null;
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat?.isFile() || stat.size > PROMPT_ATTACHMENT_MAX_BYTES) return null;
  const bytes = await fsp.readFile(abs);
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/** Content-блок user-сообщения Claude CLI (`--input-format stream-json`). */
export type CliContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title: string };

/**
 * Content user-сообщения хода Claude Code: текст (с путями файлов, которые не уходят блоком), затем картинки и PDF.
 * Пропавший файл — ошибка хода: молча отправить промпт без картинки, на которую он ссылается, хуже.
 */
export async function cliUserContent(text: string, attachments: readonly PromptAttachment[], projectPath: string, workDir: string): Promise<CliContentBlock[]> {
  const blocks: CliContentBlock[] = [];
  const listed: string[] = [];
  for (const a of attachments) {
    const abs = attachmentAbsPath(projectPath, a.path);
    if (!abs) throw new AppError('attachments.outsideFolder');
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new AppError('attachments.notFound', { path: a.path });
    const form = cliAttachmentForm({ mime: a.mime, size: stat.size });
    if (form === 'path') {
      listed.push(attachmentPathForAgent(projectPath, workDir, a.path));
      continue;
    }
    const data = (await fsp.readFile(abs)).toString('base64');
    blocks.push(
      form === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: a.mime, data } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: a.name }
    );
  }
  const body = promptWithFileList(text, listed);
  return body ? [{ type: 'text', text: body }, ...blocks] : blocks;
}

/** Строка stdin для `claude -p --input-format stream-json`: одно user-сообщение. */
export function cliUserMessageLine(content: readonly CliContentBlock[]): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/** Реплики для API-провайдеров: вложения — путями в тексте, агент открывает их своими инструментами. */
export function messagesWithAttachmentPaths<T extends { role: string; content: string; attachments?: PromptAttachment[] }>(
  messages: readonly T[],
  projectPath: string,
  workDir: string
): T[] {
  return messages.map((m) => {
    const list = m.role === 'user' ? sanitizePromptAttachments(m.attachments) : [];
    if (list.length === 0) return m;
    return { ...m, content: promptWithFileList(m.content, list.map((a) => attachmentPathForAgent(projectPath, workDir, a.path))) };
  });
}
