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
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ')
        : '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean.startsWith('<')) continue;
    return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
  }
  return '';
}

/** Папка сессий рабочего каталога; регистр буквы диска и путей на Windows не важен. */
async function sessionsDir(configDir: string, cwd: string): Promise<string | null> {
  const root = path.join(configDir, 'projects');
  const want = encodeProjectDir(cwd);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return null;
  }
  const exact = names.find((n) => n === want) ?? names.find((n) => n.toLowerCase() === want.toLowerCase());
  return exact ? path.join(root, exact) : null;
}

export async function listCliSessions(configDir: string, cwd: string): Promise<CliSessionSummary[]> {
  const dir = await sessionsDir(configDir, cwd);
  if (!dir) return [];
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => SESSION_FILE_RE.test(n));
  const stats = await Promise.all(
    files.map(async (name) => {
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      return stat?.isFile() ? { name, mtime: stat.mtimeMs } : null;
    })
  );
  const recent = stats.filter((s): s is { name: string; mtime: number } => s !== null).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
  return Promise.all(
    recent.map(async ({ name, mtime }) => {
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
