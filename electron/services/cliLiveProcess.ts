import { createHash } from 'node:crypto';
import { parseControlResponse } from './cliBackgroundTasks.js';

/**
 * Постоянный процесс Claude Code на вкладку Agents Studio (TASK-298, decision-215). `claude -p --input-format stream-json`
 * не выходит, пока открыт stdin: ходы вкладки идут в одном процессе, реплика во время хода уходит в stdin сразу и попадает
 * модели на ближайшей границе шага, модель и режим меняются запросами `set_model`/`set_permission_mode`. Остальные
 * параметры запуска (аккаунт, каталог, инструменты, `--add-dir`, effort, системный промпт, HITL) входят в подпись
 * запуска: другая подпись — новый процесс с `--resume`. Модуль без Electron — покрыт unit-тестами.
 */

/** Простой вкладки, после которого процесс закрывается; следующий ход запустит его снова с `--resume`. */
export const CLI_LIVE_IDLE_MS = 10 * 60_000;
/** Сколько ждать итога хода после `interrupt`, прежде чем убить процесс. */
export const CLI_INTERRUPT_GRACE_MS = 5_000;
/** Сколько ждать выхода после закрытия stdin. */
export const CLI_CLOSE_GRACE_MS = 5_000;
/**
 * Пауза после конца последней фоновой задачи: CLI сам начинает прогон-пробуждение (новый `system/init`), и ход ждёт его
 * ответ. Не начал за паузу — ход закончен.
 */
export const CLI_WAKE_GRACE_MS = 3_000;
/** CLI повторяет в stdout реплику, которую взял в работу: так видно, когда сообщение посреди хода дошло до модели. */
export const CLI_REPLAY_FLAG = '--replay-user-messages';

/** Флаги, значения которых процесс меняет запросами, а не перезапуском. */
const SWITCHABLE_FLAGS = new Set(['--model', '--permission-mode']);

/**
 * Подпись запуска: аргументы без модели и режима разрешений плюс то, что CLI читает только при старте (аккаунт, каталог,
 * текст системного промпта, файлы HITL). Совпала — ход идёт в живом процессе.
 */
export function cliLaunchSignature(args: readonly string[], extras: readonly (string | undefined | null)[]): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (SWITCHABLE_FLAGS.has(args[i])) {
      i++;
      continue;
    }
    kept.push(args[i]);
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify(kept));
  for (const extra of extras) hash.update(`\0${extra ?? ''}`);
  return hash.digest('hex');
}

/** Режим разрешений процесса без plan mode: с `--dangerously-skip-permissions` — обход, иначе обычный. */
export function cliBasePermissionMode(args: readonly string[]): string {
  return args.includes('--dangerously-skip-permissions') ? 'bypassPermissions' : 'default';
}

/** Запросы, которые переводят живой процесс на модель и режим хода. */
export function cliSwitchRequests(
  current: { model: string | null; permissionMode: string | null; baseMode: string },
  wanted: { model: string | null; plan: boolean }
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (current.model !== wanted.model) out.push({ subtype: 'set_model', model: wanted.model ?? 'default' });
  if (wanted.plan && current.permissionMode !== 'plan') out.push({ subtype: 'set_permission_mode', mode: 'plan' });
  if (!wanted.plan && current.permissionMode === 'plan') out.push({ subtype: 'set_permission_mode', mode: current.baseMode });
  return out;
}

/** `total_cost_usd` в `result` копится за жизнь процесса: стоимость хода — разность с прошлым итогом. */
export function cliCostDelta(total: unknown, previousTotal: number): { delta: number | undefined; total: number } {
  if (typeof total !== 'number' || !Number.isFinite(total)) return { delta: undefined, total: previousTotal };
  if (total < previousTotal) return { delta: total, total };
  return { delta: Math.max(0, total - previousTotal), total };
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** uuid реплики, которую CLI повторил, взяв в работу (`--replay-user-messages`). */
export function replayedUserUuid(event: unknown): string | null {
  const e = asRecord(event);
  return e?.type === 'user' && e.isReplay === true && typeof e.uuid === 'string' ? e.uuid : null;
}

/** Состояние реплики с uuid в очереди CLI: `queued`, `started`, `completed`, `cancelled`. */
export function commandLifecycle(event: unknown): { uuid: string; state: string } | null {
  const e = asRecord(event);
  if (e?.type !== 'command_lifecycle' || typeof e.command_uuid !== 'string' || typeof e.state !== 'string') return null;
  return { uuid: e.command_uuid, state: e.state };
}

/** Строка stdin с репликой пользователя и её uuid. */
export function cliUserLineWithUuid(content: unknown, uuid: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid })}\n`;
}

interface ReadableLike {
  on(event: 'data', fn: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

/** То, что модулю нужно от процесса (ChildProcess или заглушка в тестах). */
export interface CliChildLike {
  pid?: number;
  exitCode: number | null;
  stdin: { write(data: string, encoding?: BufferEncoding): boolean; end(): void; on(event: 'error', fn: (err: Error) => void): unknown };
  stdout: ReadableLike;
  stderr: ReadableLike;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

/** Получатель событий текущего хода. */
export interface CliTurnSink {
  /** Событие stream-json, кроме ответов на запросы; у `result` — стоимость именно этого прогона модели. */
  onEvent(event: Record<string, unknown>, meta: { costUsd?: number }): void;
  /** Строка stdout, которая не JSON. */
  onRawLine?(line: string): void;
  onStderr?(text: string): void;
  /** Процесс вышел посреди хода. */
  onClose(code: number | null, info: { stderr: string; stdinError: string | null }): void;
  /** Сбой запуска или чтения потока. */
  onFailure(err: Error): void;
}

export interface CliLiveProcessOptions {
  signature: string;
  configDir: string;
  workDir: string;
  model: string | null;
  permissionMode: string | null;
  baseMode: string;
  killTree: () => void;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

const STDERR_TAIL_MAX = 64_000;
const LINE_BUFFER_MAX = 8_000_000;

export class CliLiveProcess {
  readonly signature: string;
  readonly configDir: string;
  readonly workDir: string;
  readonly baseMode: string;
  model: string | null;
  permissionMode: string | null;
  /** Сессия CLI, в которой идёт разговор процесса (`session_id` событий). */
  cliSessionId: string | null = null;
  exited = false;

  private readonly child: CliChildLike;
  private readonly killTree: () => void;
  private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  private sink: CliTurnSink | null = null;
  private pending = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private buffer = '';
  private stderrTail = '';
  private stdinError: string | null = null;
  private stdinOpen = true;
  private totalCost = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitListeners: (() => void)[] = [];

  constructor(child: CliChildLike, opts: CliLiveProcessOptions) {
    this.child = child;
    this.signature = opts.signature;
    this.configDir = opts.configDir;
    this.workDir = opts.workDir;
    this.model = opts.model;
    this.permissionMode = opts.permissionMode;
    this.baseMode = opts.baseMode;
    this.killTree = opts.killTree;
    this.timers = opts.timers ?? { setTimeout, clearTimeout };

    // Ошибка на потоке без обработчика роняет main-процесс; итог по stdin решает 'close'.
    child.stdin.on('error', (err) => {
      this.stdinError = err.message;
    });
    child.stdout.on('error', (err) => this.sink?.onFailure(err));
    child.stderr.on('error', (err) => this.sink?.onFailure(err));
    child.stdout.on('data', (d) => this.onStdout(typeof d === 'string' ? d : d.toString('utf-8')));
    child.stderr.on('data', (d) => {
      const text = typeof d === 'string' ? d : d.toString('utf-8');
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX);
      this.sink?.onStderr?.(text);
    });
    child.on('error', (err) => {
      const sink = this.sink;
      this.markExited();
      sink?.onFailure(err);
    });
    child.on('close', (code) => {
      const sink = this.sink;
      const info = { stderr: this.stderrTail, stdinError: this.stdinError };
      this.markExited();
      sink?.onClose(code, info);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Идёт ли в процессе ход вкладки. */
  get busy(): boolean {
    return this.sink !== null;
  }

  /** Ход вкладки начинается: события идут ему. */
  attach(sink: CliTurnSink): void {
    this.clearIdle();
    this.sink = sink;
    this.stderrTail = '';
    this.stdinError = null;
  }

  /** Ход кончился; процесс остаётся ждать следующего. */
  detach(sink: CliTurnSink): void {
    if (this.sink === sink) this.sink = null;
  }

  /** Пишет строку в stdin; `false` — процесс уже не принимает ввод. */
  write(line: string): boolean {
    if (this.exited || !this.stdinOpen) return false;
    try {
      this.child.stdin.write(line, 'utf-8');
      return true;
    } catch (err) {
      this.stdinError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Служебный запрос `control_request`; ответ — тело `response`, ошибка CLI или таймаут — исключение. */
  request(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.stdinOpen) {
        reject(new Error('Claude Code process input is closed'));
        return;
      }
      const requestId = `ph_${++this.seq}`;
      const timer = this.timers.setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('Claude Code did not answer the control request'));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`)) {
        this.timers.clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(this.stdinError ?? 'Claude Code process input is closed'));
      }
    });
  }

  /** Закрыть процесс после простоя. */
  scheduleIdleClose(ms: number, onIdle: () => void): void {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      if (!this.busy) onIdle();
    }, ms);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Мягкое закрытие: конец stdin, CLI выходит сам; не вышел — дерево процессов убивается. */
  close(graceMs = CLI_CLOSE_GRACE_MS): void {
    this.clearIdle();
    if (this.exited) return;
    if (this.stdinOpen) {
      this.stdinOpen = false;
      try {
        this.child.stdin.end();
      } catch {
        /* процесс уже вышел */
      }
    }
    if (!this.killTimer) {
      this.killTimer = this.timers.setTimeout(() => this.kill(), graceMs);
      (this.killTimer as { unref?: () => void }).unref?.();
    }
  }

  kill(): void {
    this.clearIdle();
    if (this.exited) return;
    this.stdinOpen = false;
    this.killTree();
  }

  onExit(fn: () => void): void {
    if (this.exited) fn();
    else this.exitListeners.push(fn);
  }

  private clearIdle(): void {
    if (this.idleTimer) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.stdinOpen = false;
    this.sink = null;
    this.clearIdle();
    if (this.killTimer) this.timers.clearTimeout(this.killTimer);
    this.killTimer = null;
    for (const p of this.pending.values()) {
      this.timers.clearTimeout(p.timer);
      p.reject(new Error('Claude Code process exited'));
    }
    this.pending.clear();
    const listeners = this.exitListeners;
    this.exitListeners = [];
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.warn('[cliLiveProcess] exit listener failed:', err);
      }
    }
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > LINE_BUFFER_MAX) this.buffer = '';
  }

  private onLine(line: string): void {
    if (!line.startsWith('{')) {
      this.sink?.onRawLine?.(line);
      return;
    }
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      this.sink?.onRawLine?.(line);
      return;
    }
    if (!event) return;
    const control = parseControlResponse(event);
    if (control) {
      const pending = this.pending.get(control.requestId);
      if (pending) {
        this.pending.delete(control.requestId);
        this.timers.clearTimeout(pending.timer);
        if (control.ok) pending.resolve(control.response);
        else pending.reject(new Error(control.error));
      }
      return;
    }
    if (typeof event.session_id === 'string' && event.session_id) this.cliSessionId = event.session_id;
    if (event.type === 'system' && (event.subtype === 'init' || event.subtype === 'status') && typeof event.permissionMode === 'string') {
      this.permissionMode = event.permissionMode;
    }
    const meta: { costUsd?: number } = {};
    if (event.type === 'result') {
      const { delta, total } = cliCostDelta(event.total_cost_usd, this.totalCost);
      this.totalCost = total;
      if (delta !== undefined) meta.costUsd = delta;
    }
    this.sink?.onEvent(event, meta);
  }
}
