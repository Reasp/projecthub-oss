import fs from 'node:fs/promises';
import path from 'node:path';
import { controlArgs, controlRequestLine, controlResponseFor, runCliControlRequest } from './cliControlRequest';

/**
 * `/memory` во вкладке Agents Studio (TASK-286, decision-207). Терминальный диалог CLI в `claude -p` недоступен, но CLI
 * отдаёт его строки SDK-хосту запросом `get_memory_dialog` протокола control_request: файлы инструкций (CLAUDE.md
 * пользователя, проекта, `.claude/CLAUDE.md`, CLAUDE.local.md), папки автопамяти и сами записи памяти — по своим правилам
 * поиска, с учётом `CLAUDE_CONFIG_DIR` аккаунта и каталога вкладки. Хода модели нет: CLI отвечает за ~1 с и завершается,
 * когда закрыт stdin; файл сессии не создаётся (проверено на 2.1.314).
 */

export type CliMemoryFileKind = 'user' | 'project' | 'project-alt' | 'local' | 'other';
export type CliMemoryFolderKind = 'auto' | 'team' | 'agent';
export type CliMemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface CliMemoryFileRow {
  kind: CliMemoryFileKind;
  path: string;
  /** Подпись строки, как в терминальном диалоге (английский текст CLI). */
  label: string;
  description: string;
  exists: boolean;
}

export interface CliMemoryFolderRow {
  kind: CliMemoryFolderKind;
  path: string;
  label: string;
  description: string;
}

export interface CliMemoryEntry {
  /** Путь относительно папки автопамяти (`MEMORY.md` — индекс). */
  name: string;
  path: string;
  description: string | null;
  type: CliMemoryType | null;
  modifiedMs: number;
}

export interface CliMemoryDialog {
  files: CliMemoryFileRow[];
  folders: CliMemoryFolderRow[];
  memories: CliMemoryEntry[];
  /** Автопамять: включена ли и текст статуса CLI. Нет — CLI старее поля. */
  autoMemory?: { enabled: boolean; status: string };
}

export type CliMemoryDialogResult = { ok: true; dialog: CliMemoryDialog } | { ok: false; reason: 'start' | 'timeout' | 'cli'; detail?: string };

const FILE_KINDS = new Set<CliMemoryFileKind>(['user', 'project', 'project-alt', 'local', 'other']);
const FOLDER_KINDS = new Set<CliMemoryFolderKind>(['auto', 'team', 'agent']);
const MEMORY_TYPES = new Set<CliMemoryType>(['user', 'feedback', 'project', 'reference']);
const MAX_ROWS = 300;
const MAX_TEXT = 500;

export const MEMORY_DIALOG_REQUEST_ID = 'projecthub-memory-dialog';

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const absPath = (v: unknown): string | null => (typeof v === 'string' && v.length < 4096 && path.isAbsolute(v) && !v.includes('\0') ? v : null);

/** Строки диалога из ответа `get_memory_dialog`; строки с неизвестным видом или относительным путём отбрасываются. */
export function parseMemoryDialog(raw: unknown): CliMemoryDialog | null {
  const body = asRecord(raw);
  if (!body || !Array.isArray(body.files)) return null;
  const files: CliMemoryFileRow[] = [];
  for (const item of body.files.slice(0, MAX_ROWS)) {
    const row = asRecord(item);
    const p = absPath(row?.path);
    if (!row || !p || !FILE_KINDS.has(row.kind as CliMemoryFileKind)) continue;
    files.push({ kind: row.kind as CliMemoryFileKind, path: p, label: text(row.label), description: text(row.description), exists: row.exists === true });
  }
  const folders: CliMemoryFolderRow[] = [];
  for (const item of Array.isArray(body.folders) ? body.folders.slice(0, MAX_ROWS) : []) {
    const row = asRecord(item);
    const p = absPath(row?.path);
    if (!row || !p || !FOLDER_KINDS.has(row.kind as CliMemoryFolderKind)) continue;
    folders.push({ kind: row.kind as CliMemoryFolderKind, path: p, label: text(row.label), description: text(row.description) });
  }
  const memories: CliMemoryEntry[] = [];
  for (const item of Array.isArray(body.memories) ? body.memories.slice(0, MAX_ROWS) : []) {
    const row = asRecord(item);
    const p = absPath(row?.path);
    if (!row || !p || typeof row.name !== 'string' || !row.name) continue;
    memories.push({
      name: text(row.name),
      path: p,
      description: typeof row.description === 'string' ? text(row.description) : null,
      type: MEMORY_TYPES.has(row.type as CliMemoryType) ? (row.type as CliMemoryType) : null,
      modifiedMs: typeof row.modified_ms === 'number' && Number.isFinite(row.modified_ms) ? Math.floor(row.modified_ms) : 0
    });
  }
  const auto = asRecord(body.auto_memory);
  return {
    files,
    folders,
    memories,
    ...(auto ? { autoMemory: { enabled: auto.enabled === true, status: text(auto.status) } } : {})
  };
}

/** Строка stdin CLI: запрос диалога `/memory`. */
export function memoryDialogRequestLine(): string {
  return controlRequestLine(MEMORY_DIALOG_REQUEST_ID, { subtype: 'get_memory_dialog' });
}

/**
 * Ответ на запрос диалога в строке stdout CLI: `undefined` — строка не про него, `null` — CLI ответил ошибкой
 * (старый CLI не знает запроса) или ответ не разобран.
 */
export function memoryDialogResponse(line: string): CliMemoryDialog | null | undefined {
  const answer = controlResponseFor(line, MEMORY_DIALOG_REQUEST_ID);
  return answer ? parseMemoryDialog(answer.response) : answer;
}

/** Аргументы CLI; каталоги `/add-dir` вкладки — как у её хода, чтобы CLI искал инструкции там же. */
export function memoryDialogArgs(addDirs: readonly string[], quote: (v: string) => string): string[] {
  return controlArgs({ addDirs }, quote);
}

const samePath = (a: string, b: string): boolean => {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

/** Файл, который диалог разрешает открыть и сохранить: строка файла инструкций или запись автопамяти. */
export function memoryDialogFile(dialog: CliMemoryDialog, file: string): { exists: boolean } | null {
  if (!path.isAbsolute(file)) return null;
  const row = dialog.files.find((f) => samePath(f.path, file));
  if (row) return { exists: row.exists };
  const memory = dialog.memories.find((m) => samePath(m.path, file));
  return memory ? { exists: true } : null;
}

/** Папка из строк диалога — её можно открыть в проводнике. */
export function memoryDialogFolder(dialog: CliMemoryDialog, dir: string): boolean {
  return path.isAbsolute(dir) && dialog.folders.some((f) => samePath(f.path, dir));
}

/** Диалог `/memory` CLI под аккаунтом вкладки (`CLAUDE_CONFIG_DIR`) в её каталоге. */
export async function runCliMemoryDialog(opts: { configDir: string; cwd: string; addDirs?: readonly string[] }): Promise<CliMemoryDialogResult> {
  const result = await runCliControlRequest({ ...opts, requestId: MEMORY_DIALOG_REQUEST_ID, request: { subtype: 'get_memory_dialog' } });
  if (!result.ok) return result;
  const dialog = parseMemoryDialog(result.response);
  return dialog ? { ok: true, dialog } : { ok: false, reason: 'cli' };
}

/** Содержимое файла памяти; отсутствующий файл — пустой текст (диалог разрешает создать CLAUDE.md пользователя и проекта). */
export async function readMemoryFile(file: string): Promise<{ ok: true; content: string; exists: boolean } | { ok: false; reason: 'tooLarge' | 'io' }> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { ok: false, reason: 'io' };
    if (stat.size > 2_000_000) return { ok: false, reason: 'tooLarge' };
    return { ok: true, content: await fs.readFile(file, 'utf8'), exists: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, content: '', exists: false };
    return { ok: false, reason: 'io' };
  }
}

export async function saveMemoryFile(file: string, content: string): Promise<{ ok: boolean }> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
