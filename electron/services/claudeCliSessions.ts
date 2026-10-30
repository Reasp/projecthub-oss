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

/** Реплика разговора CLI для ленты вкладки после `/resume` (TASK-282): только текст, без вызовов инструментов. */
export interface CliTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Сколько последних реплик разговора показывает вкладка: длинная сессия CLI не раздувает файл вкладки. */
export const CLI_TRANSCRIPT_LIMIT = 200;
/** Читается хвост файла сессии: в начале длинной сессии — то, что модель всё равно уже сжала. */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

export function humanText(content: unknown): string {
  if (typeof content === 'string') return content.trim().startsWith('<') ? '' : content.trim();
  if (!Array.isArray(content)) return '';
  // Результаты инструментов и служебные части CLI (`<system-reminder>`, `<ide_opened_file>`) — не реплика человека.
  return content
    .map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text.trim() : ''))
    .filter((part) => part && !part.startsWith('<'))
    .join('\n\n');
}

/**
 * Реплики человека и текст ответов модели из файла сессии CLI. Блоки одного ответа (`message.id`) CLI пишет отдельными
 * строками — они склеиваются. Разговоры подагентов (`isSidechain`), служебные строки (`isMeta`), сводки сжатия,
 * заглушки CLI (`<synthetic>`) и результаты инструментов пропускаются. Последние {@link CLI_TRANSCRIPT_LIMIT} реплик.
 */
export function cliTranscriptMessages(text: string, limit = CLI_TRANSCRIPT_LIMIT): CliTranscriptMessage[] {
  const out: CliTranscriptMessage[] = [];
  const byMessageId = new Map<string, CliTranscriptMessage>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; uuid?: unknown; timestamp?: unknown; isMeta?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; message?: { id?: unknown; model?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true) continue;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString();
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : `cli-${out.length}`;
    if (entry.type === 'user') {
      const content = humanText(entry.message?.content);
      if (content) out.push({ id: `cli-${uuid}`, role: 'user', content, timestamp });
      continue;
    }
    // Заглушки самого CLI («No response requested.» после прерванного хода) — не ответ модели.
    if (entry.message?.model === '<synthetic>') continue;
    const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const content = parts
      .map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
    if (!content) continue;
    const messageId = typeof entry.message?.id === 'string' ? entry.message.id : '';
    const previous = messageId ? byMessageId.get(messageId) : undefined;
    if (previous) {
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }
    const message: CliTranscriptMessage = { id: `cli-${uuid}`, role: 'assistant', content, timestamp };
    out.push(message);
    if (messageId) byMessageId.set(messageId, message);
  }
  return out.slice(-limit);
}

/**
 * Хвост файла сессии CLI `sessionId` рабочего каталога `cwd` (до `maxBytes`); `null`, если файла нет. Хвост мог начаться
 * посреди строки — первую неполную строку отбрасывают парсеры (JSON не разберётся).
 */
export async function readCliSessionTail(configDir: string, cwd: string, sessionId: string, maxBytes = TRANSCRIPT_TAIL_BYTES): Promise<string | null> {
  if (!isCliSessionId(sessionId)) return null;
  const root = path.join(configDir, 'projects');
  const names = await fs.readdir(root).catch(() => [] as string[]);
  for (const dir of matchSessionDirs(names, cwd)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    const handle = await fs.open(file, 'r').catch(() => null);
    if (!handle) continue;
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  return null;
}

/** Реплики сессии CLI `sessionId` рабочего каталога `cwd`; пусто, если файла нет. */
export async function readCliSessionMessages(configDir: string, cwd: string, sessionId: string): Promise<CliTranscriptMessage[]> {
  const text = await readCliSessionTail(configDir, cwd, sessionId);
  return text === null ? [] : cliTranscriptMessages(text);
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
