import { spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import { AppError } from '../../src/lib/appError';

/**
 * Разговор вкладки Agents Studio занят фоновой сессией Claude Code (`claude --bg`, TASK-301, decision-219). Пока фоновая
 * сессия жива, `claude -p --resume <id>` отказывает: в stream-json — `result` с `is_error` и
 * `startup_failure_reason: "session_held_by_background"`, в stderr — «That session is running in the background (<id>)»
 * (проверено на CLI 2.1.318). Состояние фоновых сессий берётся только из `claude agents --json`; остановка —
 * `claude stop <короткий id>` (полный id сессии CLI не принимает). Разбор — без Electron, покрыт unit-тестами.
 */

export const CLI_SESSION_HELD_REASON = 'session_held_by_background';

const HELD_TEXT_RE = /session is running in the background \(([0-9a-z][0-9a-z-]{0,63})\)/i;
const AGENT_ID_RE = /^[0-9a-z][0-9a-z-]{0,63}$/i;

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Короткий id фоновой сессии из текста отказа CLI; `null` — текст не про неё. */
export function cliBackgroundHoldInText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = HELD_TEXT_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * Отказ CLI из-за фоновой сессии в событии `result`: короткий id (пустая строка — CLI его не назвал); `null` — другое
 * событие. Признак — машинное поле `startup_failure_reason`, текст в `errors` — запасной путь для другой версии CLI.
 */
export function cliBackgroundHoldOf(event: unknown): string | null {
  const e = asRecord(event);
  if (e?.type !== 'result') return null;
  const errors = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === 'string') : [];
  const fromText = errors.map(cliBackgroundHoldInText).find((id) => id !== null) ?? null;
  if (e.startup_failure_reason === CLI_SESSION_HELD_REASON) return fromText ?? '';
  return fromText;
}

export function isCliAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value);
}

/** Запись `claude agents --json`. */
export interface CliAgentEntry {
  id: string;
  sessionId: string;
  kind: string;
  status?: string;
  state?: string;
}

/** Записи `claude agents --json`; не JSON-массив — `null`. Записи без короткого id или сессии отбрасываются. */
export function parseCliAgents(stdout: string): CliAgentEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: CliAgentEntry[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    if (!r || !isCliAgentId(r.id) || typeof r.sessionId !== 'string' || !r.sessionId) continue;
    out.push({
      id: r.id,
      sessionId: r.sessionId,
      kind: typeof r.kind === 'string' ? r.kind : '',
      ...(typeof r.status === 'string' ? { status: r.status } : {}),
      ...(typeof r.state === 'string' ? { state: r.state } : {})
    });
  }
  return out;
}

/** Фоновая сессия, которая держит разговор `cliSessionId`; интерактивные сессии терминала ход вкладки не блокируют. */
export function backgroundAgentOf(entries: readonly CliAgentEntry[], cliSessionId: string): CliAgentEntry | null {
  const wanted = cliSessionId.toLowerCase();
  return entries.find((e) => e.kind === 'background' && e.sessionId.toLowerCase() === wanted && e.state !== 'stopped') ?? null;
}

export interface CliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CliCommandRunner = (args: readonly string[], opts: { configDir: string; cwd: string; timeoutMs: number }) => Promise<CliCommandResult>;

const OUTPUT_MAX = 1_000_000;

/** Команда `claude …` под аккаунтом вкладки (`CLAUDE_CONFIG_DIR`); аргументы — только проверенные id и флаги. */
export const runClaudeCommand: CliCommandRunner = (args, opts) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: opts.configDir };
    delete env.ELECTRON_RUN_AS_NODE;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: `${stderr}${extra}` });
    };
    const child = spawn('claude', [...args], { cwd: opts.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid);
      finish(null, 'timeout');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < OUTPUT_MAX) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });

export type CliBackgroundStopResult = { ok: true; stopped: string | null } | { ok: false; error: AppError };

const COMMAND_TIMEOUT_MS = 30_000;
/** Сколько раз после `claude stop` проверить, что фоновая сессия ушла из `claude agents --json`. */
export const CLI_STOP_CHECKS = 10;
export const CLI_STOP_CHECK_MS = 500;

const detailOf = (r: CliCommandResult): string => (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`).slice(0, 500);

/**
 * Останавливает фоновую сессию, которая держит разговор `cliSessionId`: находит её в `claude agents --json`, вызывает
 * `claude stop <id>` и ждёт, пока она уйдёт из списка. Фоновой сессии уже нет — `stopped: null`, ход можно повторять.
 */
export async function stopCliBackgroundSession(
  opts: { configDir: string; cwd: string; cliSessionId: string },
  run: CliCommandRunner = runClaudeCommand,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<CliBackgroundStopResult> {
  const scope = { configDir: opts.configDir, cwd: opts.cwd, timeoutMs: COMMAND_TIMEOUT_MS };
  const list = async (): Promise<CliAgentEntry[] | AppError> => {
    const r = await run(['agents', '--json'], scope);
    const entries = r.code === 0 ? parseCliAgents(r.stdout) : null;
    return entries ?? new AppError('studio.cliBackgroundStopFailed', { detail: detailOf(r) });
  };
  const first = await list();
  if (first instanceof AppError) return { ok: false, error: first };
  const agent = backgroundAgentOf(first, opts.cliSessionId);
  if (!agent) return { ok: true, stopped: null };
  const stop = await run(['stop', agent.id], scope);
  if (stop.code !== 0) return { ok: false, error: new AppError('studio.cliBackgroundStopFailed', { detail: detailOf(stop) }) };
  for (let i = 0; i < CLI_STOP_CHECKS; i++) {
    const now = await list();
    if (now instanceof AppError) return { ok: false, error: now };
    if (!backgroundAgentOf(now, opts.cliSessionId)) return { ok: true, stopped: agent.id };
    await wait(CLI_STOP_CHECK_MS);
  }
  return { ok: false, error: new AppError('studio.cliBackgroundStillRunning', { id: agent.id }) };
}
