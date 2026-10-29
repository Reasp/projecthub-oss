import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Сессии Claude Code рабочей папки (TASK-230): `<CLAUDE_CONFIG_DIR>/projects/<папка>/<id>.jsonl`, где имя папки — путь
 * рабочей папки, в котором каждый символ, кроме латинских букв и цифр, заменён на `-` (`f:\ProjectHub` →
 * `f--ProjectHub`). Agents Studio показывает их по `/resume`: режим `claude -p` своей командой выбора не умеет.
 */

export interface CliSessionSummary {
  id: string;
  /** Время последнего изменения файла сессии, мс. */
  updatedAt: number;
  /** Первая реплика человека — до 160 символов; пусто, если её не нашлось в начале файла. */
  title: string;
}

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const HEAD_BYTES = 256 * 1024;
const MAX_SESSIONS = 50;

export function isCliSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Первая реплика человека в начале файла сессии: служебные строки (`isMeta`, команды CLI) пропускаются. */
export function firstUserPrompt(head: string): string {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'user' || entry.isMeta === true) continue;
    const content = entry.message?.content;
    // Служебные части (`<ide_opened_file>`, напоминания CLI) идут отдельными элементами массива — их пропускаем,
    // а не всю реплику: заголовок — текст человека после них.
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text.trim() : ''))
            .filter((part) => part && !part.startsWith('<'))
            .join(' ')
        : '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean.startsWith('<')) continue;
    return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
  }
  return '';
}

/** Длиннее — Claude Code обрезает имя до 200 символов и дописывает `-<хэш пути>`. */
const MAX_DIR_NAME = 200;

/**
 * Имена папок сессий рабочего каталога среди `names`; регистр буквы диска и путей на Windows не важен. Для длинного
 * пути хэш Claude Code не повторяем: подходят все папки с тем же обрезанным началом и `-` после него.
 */
export function matchSessionDirs(names: readonly string[], cwd: string): string[] {
  const want = encodeProjectDir(cwd).toLowerCase();
  if (want.length <= MAX_DIR_NAME) {
    const exact = names.find((n) => n.toLowerCase() === want);
    return exact ? [exact] : [];
  }
  const prefix = `${want.slice(0, MAX_DIR_NAME)}-`;
  return names.filter((n) => n.toLowerCase().startsWith(prefix) && /^[a-z0-9]+$/i.test(n.slice(prefix.length)));
}

export async function listCliSessions(configDir: string, cwd: string): Promise<CliSessionSummary[]> {
  const root = path.join(configDir, 'projects');
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const dirs = matchSessionDirs(names, cwd).map((n) => path.join(root, n));
  const files = (
    await Promise.all(dirs.map(async (dir) => (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => SESSION_FILE_RE.test(n)).map((name) => ({ dir, name }))))
  ).flat();
  const stats = await Promise.all(
    files.map(async ({ dir, name }) => {
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      return stat?.isFile() ? { dir, name, mtime: stat.mtimeMs } : null;
    })
  );
  const recent = stats.filter((s): s is { dir: string; name: string; mtime: number } => s !== null).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
  return Promise.all(
    recent.map(async ({ dir, name, mtime }) => {
      let head = '';
      const handle = await fs.open(path.join(dir, name), 'r').catch(() => null);
      if (handle) {
        try {
          const buffer = Buffer.alloc(HEAD_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
          head = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      }
      return { id: SESSION_FILE_RE.exec(name)![1], updatedAt: mtime, title: firstUserPrompt(head) };
    })
  );
}
