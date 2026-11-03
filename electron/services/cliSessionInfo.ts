import { cliSessionName } from '../../src/lib/studioCliTitle.js';
import { isCliSessionUuid, runCliControlRequest } from './cliControlRequest';

/**
 * `/status`, `/help` и имя сессии вкладки Agents Studio (TASK-287, decision-208). Терминальные экраны CLI в `claude -p`
 * недоступны, но CLI отдаёт их данные SDK-хосту без хода модели:
 * - `get_status` — строки экрана `/status` (версия, сессия, аккаунт, модель, MCP, настройки) уже текстом;
 * - `initialize` — команды и скиллы, которые выполнит CLI без терминала, с описанием и подсказкой аргументов;
 * - `rename_session` с `source: 'host'` — имя сессии, которое CLI считает переименованием человеком: оно видно в `/resume`
 *   CLI и в терминале.
 */

export interface CliStatusRow {
  /** Нет — строка-предложение без подписи. */
  label?: string;
  value: string;
}

export interface CliStatusSection {
  title: string;
  rows: CliStatusRow[];
}

export interface CliStatus {
  sections: CliStatusSection[];
  /** Экран показывает сессию вкладки, а не новую: вкладка уже говорила с CLI и CLI нашёл её разговор. */
  tabSession: boolean;
}

export interface CliCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

export interface CliCommandList {
  commands: CliCommandInfo[];
  version?: string;
}

type Failure = { ok: false; reason: 'start' | 'timeout' | 'cli'; detail?: string };

const MAX_SECTIONS = 20;
const MAX_ROWS = 100;
const MAX_COMMANDS = 500;
const MAX_TEXT = 1000;

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Разделы экрана `/status` из ответа `get_status`; пустые строки и разделы отбрасываются. */
export function parseCliStatus(raw: unknown): CliStatusSection[] | null {
  const body = asRecord(raw);
  if (!body || !Array.isArray(body.sections)) return null;
  const sections: CliStatusSection[] = [];
  for (const item of body.sections.slice(0, MAX_SECTIONS)) {
    const section = asRecord(item);
    if (!section || !Array.isArray(section.rows)) continue;
    const rows: CliStatusRow[] = [];
    for (const r of section.rows.slice(0, MAX_ROWS)) {
      const row = asRecord(r);
      const value = text(row?.value);
      if (!row || !value) continue;
      const label = text(row.label, 200);
      rows.push(label ? { label, value } : { value });
    }
    if (rows.length) sections.push({ title: text(section.title, 200), rows });
  }
  return sections;
}

/** Команды CLI из ответа `initialize`: без имени, со служебным `__` в начале и повторы отбрасываются. */
export function parseCliCommands(raw: unknown): CliCommandList | null {
  const body = asRecord(raw);
  if (!body || !Array.isArray(body.commands)) return null;
  const seen = new Set<string>();
  const commands: CliCommandInfo[] = [];
  for (const item of body.commands.slice(0, MAX_COMMANDS)) {
    const cmd = asRecord(item);
    const name = text(cmd?.name, 200).trim();
    if (!cmd || !name || name.startsWith('__') || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, description: text(cmd.description).trim(), argumentHint: text(cmd.argumentHint, 300).trim() });
  }
  const version = text(body.claude_code_version, 50);
  return { commands, ...(version ? { version } : {}) };
}

export const STATUS_REQUEST_ID = 'projecthub-status';
export const COMMANDS_REQUEST_ID = 'projecthub-commands';
export const RENAME_REQUEST_ID = 'projecthub-rename';

interface Scope {
  configDir: string;
  cwd: string;
  addDirs?: readonly string[];
}

/**
 * Экран `/status` для вкладки. Вкладка с сессией CLI — `--resume` без записи в её файл; если CLI её разговор не нашёл
 * (другой аккаунт, удалённый файл), — экран новой сессии того же аккаунта и каталога.
 */
export async function runCliStatus(opts: Scope & { cliSessionId?: string }): Promise<{ ok: true; status: CliStatus } | Failure> {
  const ask = (resume?: string) =>
    runCliControlRequest({ ...opts, ...(resume ? { resume, persist: false } : {}), requestId: STATUS_REQUEST_ID, request: { subtype: 'get_status' } });
  const resume = isCliSessionUuid(opts.cliSessionId) ? opts.cliSessionId : undefined;
  let result = await ask(resume);
  let tabSession = !!resume;
  if (!result.ok && resume && result.reason === 'cli') {
    result = await ask();
    tabSession = false;
  }
  if (!result.ok) return result;
  const sections = parseCliStatus(result.response);
  return sections ? { ok: true, status: { sections, tabSession } } : { ok: false, reason: 'cli' };
}

/** Команды, которые CLI выполнит без терминала, — для `/help`. */
export async function runCliCommandList(opts: Scope): Promise<{ ok: true; list: CliCommandList } | Failure> {
  const result = await runCliControlRequest({ ...opts, requestId: COMMANDS_REQUEST_ID, request: { subtype: 'initialize' } });
  if (!result.ok) return result;
  const list = parseCliCommands(result.response);
  return list ? { ok: true, list } : { ok: false, reason: 'cli' };
}

/** Запрос переименования; `session_id` — CLI откажет, если `--resume` привёл в другую сессию. */
export function renameRequest(cliSessionId: string, name: string): Record<string, unknown> {
  return { subtype: 'rename_session', title: name, source: 'host', session_id: cliSessionId.toLowerCase() };
}

/** Имя сессии CLI вкладки: CLI дописывает его в файл сессии, `/resume` и терминал показывают его вместо первой реплики. */
export async function runCliRename(opts: Scope & { cliSessionId: string; name: string }): Promise<{ ok: true } | Failure> {
  const name = cliSessionName(opts.name);
  if (!isCliSessionUuid(opts.cliSessionId) || !name) return { ok: false, reason: 'cli' };
  const result = await runCliControlRequest({ ...opts, resume: opts.cliSessionId, requestId: RENAME_REQUEST_ID, request: renameRequest(opts.cliSessionId, name) });
  return result.ok ? { ok: true } : result;
}
