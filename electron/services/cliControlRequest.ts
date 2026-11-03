import { spawn } from 'node:child_process';
import path from 'node:path';
import treeKill from 'tree-kill';

/**
 * Запросы control_request к Claude Code без хода модели (TASK-286, TASK-287; decision-207, decision-208). CLI в режиме
 * `claude -p --input-format stream-json` отвечает SDK-хосту на служебные запросы — строки диалогов `/memory` и `/status`,
 * список команд (`initialize`), переименование сессии (`rename_session`) — и завершается, когда закрыт stdin. Квота не
 * тратится; файл сессии без `--resume` не создаётся.
 */

export type CliControlResult = { ok: true; response: unknown } | { ok: false; reason: 'start' | 'timeout' | 'cli'; detail?: string };

const CONTROL_TIMEOUT_MS = 30_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function isCliSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** Строка stdin CLI: запрос с id. */
export function controlRequestLine(requestId: string, request: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}

/**
 * Ответ на запрос в строке stdout CLI: `undefined` — строка не про него, `null` — CLI ответил ошибкой (старый CLI не знает
 * запроса), иначе — тело ответа (у запросов без данных — пустой объект).
 */
export function controlResponseFor(line: string, requestId: string): { response: unknown } | null | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const ev = asRecord(event);
  const response = asRecord(ev?.response);
  if (ev?.type !== 'control_response' || response?.request_id !== requestId) return undefined;
  return response.subtype === 'success' ? { response: response.response ?? {} } : null;
}

/**
 * Аргументы CLI для служебного запроса. Каталоги `/add-dir` вкладки — как у её хода, чтобы CLI искал инструкции и скиллы
 * там же. `resume` — сессия вкладки: `/status` показывает её имя и id; `persist: false` (`--no-session-persistence`)
 * не даёт CLI дописать в её файл запись о запуске.
 */
export function controlArgs(opts: { addDirs?: readonly string[]; resume?: string; persist?: boolean }, quote: (v: string) => string): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (opts.resume && isCliSessionUuid(opts.resume)) {
    args.push('--resume', opts.resume.toLowerCase());
    if (opts.persist === false) args.push('--no-session-persistence');
  }
  // Каталог уходит в командную строку оболочки: кавычка или `%` в пути её бы сломали — такой каталог пропускается.
  for (const dir of (opts.addDirs ?? []).slice(0, 20)) if (path.isAbsolute(dir) && !/["%\0\r\n]/.test(dir)) args.push('--add-dir', quote(dir));
  return args;
}

const quoteShellArg = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/** Один служебный запрос к CLI под аккаунтом вкладки (`CLAUDE_CONFIG_DIR`) в её каталоге. */
export function runCliControlRequest(opts: {
  configDir: string;
  cwd: string;
  addDirs?: readonly string[];
  resume?: string;
  persist?: boolean;
  requestId: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<CliControlResult> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const finish = (result: CliControlResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* stdin уже закрыт */
      }
      if (child.pid && child.exitCode === null) setTimeout(() => child.exitCode === null && child.pid && treeKill(child.pid), 5_000).unref();
      resolve(result);
    };
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: opts.configDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('claude', controlArgs(opts, quoteShellArg), {
      cwd: opts.cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid);
      finish({ ok: false, reason: 'timeout' });
    }, opts.timeoutMs ?? CONTROL_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const answer = controlResponseFor(line, opts.requestId);
        if (answer === undefined) continue;
        finish(answer ? { ok: true, response: answer.response } : { ok: false, reason: 'cli' });
      }
      if (buffer.length > 8_000_000) buffer = '';
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.stdin.on('error', () => { /* CLI завершился раньше — итог по close */ });
    child.on('error', (err) => finish({ ok: false, reason: 'start', detail: err.message }));
    child.on('close', () => finish({ ok: false, reason: 'cli', ...(stderr.trim() ? { detail: stderr.trim().slice(0, 500) } : {}) }));
    child.stdin.write(controlRequestLine(opts.requestId, opts.request));
  });
}
