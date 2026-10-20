import crypto from 'node:crypto';
import type { AIToolCall } from '../../src/types/electron';
import type { StudioMode, StudioModelSelection } from '../../src/types/remote';
import { studioChunkForPhone } from '../../src/utils/studioRemote.js';

/**
 * Мост Agents Studio ↔ телефон (TASK-140.10, decision-83).
 *
 * Сессиями Agents Studio владеет окно ProjectHub (стор рендерера): оно пишет их на диск, показывает вкладки и
 * держит поток. Поэтому промпт с телефона не запускает агента в обход окна, а уходит окну запросом
 * `aiStudio:remoteRequest` — окно ведёт сессию как свою, и она сразу видна на ПК вживую. Обратно мост
 * пересылает поток любой сессии Studio (начатой на ПК или с телефона) подписчикам — Remote Control шлёт его
 * сопряжённым телефонам в сокращённом виде (`studioChunkForPhone`).
 *
 * Модуль без Electron: окно внедряется (`setWindowGetter`), поэтому всё проверяется unit-тестами.
 */

export type StudioRemoteRequest =
  | {
      kind: 'send';
      projectPath: string;
      sessionId?: string;
      text: string;
      selection?: StudioModelSelection;
      mode?: StudioMode;
      deviceName: string;
    }
  | { kind: 'abort' | 'clear'; projectPath: string; sessionId: string };

export interface StudioRemoteReply {
  ok: boolean;
  sessionId?: string;
  error?: string;
}

export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

type Listener = (event: string, data: Record<string, unknown>) => void;

export const NO_WINDOW_ERROR = 'Окно ProjectHub на компьютере закрыто — Agents Studio недоступна. Откройте ProjectHub.';
export const WINDOW_TIMEOUT_ERROR = 'Окно ProjectHub не ответило. Проверьте, что ProjectHub на компьютере не завис.';

export class StudioRemoteBridge {
  private getWindow: () => WindowLike | null = () => null;
  private listeners = new Set<Listener>();
  /** sessionId → projectPath сессий, в которых сейчас идёт ответ. */
  private running = new Map<string, string>();
  private pending = new Map<string, { resolve: (r: StudioRemoteReply) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly replyTimeoutMs = 15_000) {}

  setWindowGetter(fn: () => WindowLike | null): void {
    this.getWindow = fn;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private emit(event: string, data: Record<string, unknown>): void {
    for (const l of this.listeners) {
      try {
        l(event, data);
      } catch {
        // подписчик не должен ронять поток Agents Studio
      }
    }
  }

  // ── поток Agents Studio (вызывает обработчик `ai:streamChat`) ──

  streamStarted(projectPath: string, sessionId: string): void {
    this.running.set(sessionId, projectPath);
    this.emit('studio:started', { projectPath, sessionId });
  }

  streamChunk(projectPath: string, sessionId: string, chunk: { text?: string; toolCall?: AIToolCall }): void {
    const c = studioChunkForPhone(chunk);
    if (c) this.emit('studio:chunk', { projectPath, sessionId, ...c });
  }

  /** Конец ответа; повторный вызов (ошибка после завершения) ничего не шлёт. */
  streamEnded(projectPath: string, sessionId: string, error?: string): void {
    if (!this.running.delete(sessionId)) return;
    if (error) this.emit('studio:error', { projectPath, sessionId, error: String(error).slice(0, 2000) });
    else this.emit('studio:complete', { projectPath, sessionId });
  }

  // ── запросы к окну ──

  request(req: StudioRemoteRequest): Promise<StudioRemoteReply> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: NO_WINDOW_ERROR });
    const requestId = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: WINDOW_TIMEOUT_ERROR });
      }, this.replyTimeoutMs);
      this.pending.set(requestId, { resolve, timer });
      try {
        win.webContents.send('aiStudio:remoteRequest', { requestId, ...req });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** Ответ окна (`aiStudio:remoteReply`); чужой или просроченный `requestId` игнорируется. */
  resolve(requestId: unknown, reply: unknown): boolean {
    if (typeof requestId !== 'string') return false;
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const r = (reply || {}) as Partial<StudioRemoteReply>;
    entry.resolve({
      ok: r.ok === true,
      ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
      ...(typeof r.error === 'string' ? { error: r.error.slice(0, 500) } : {})
    });
    return true;
  }
}

export const studioRemoteBridge = new StudioRemoteBridge();
