/**
 * Терминальные сессии CLI-агентов для дерева флота (TASK-174, decision-129 п. 1). Хост узнаёт о сессии Claude Code,
 * Codex или Antigravity только по событиям хуков (decision-54): здесь помнится ключ сессии, проект, последний
 * инструмент и время. Без Electron: память процесса, тесты подставляют часы.
 */

import type { OverviewTerminalInput } from '../../src/utils/fleetOverview.js';
import type { AppErrorKey } from '../../src/lib/appError.js';

/** Без событий дольше — сессия считается простаивающей: CLI закрыли без Stop или человек думает. */
export const TERMINAL_IDLE_AFTER_MS = 15 * 60_000;
/** Сессии без событий дольше суток забываются. */
export const TERMINAL_FORGET_AFTER_MS = 24 * 60 * 60_000;
const MAX_SESSIONS = 200;

export interface TerminalActivity {
  /** Ключ сессии, как у HITL: `terminal-<движок>-<id>`. */
  sessionId: string;
  projectPath: string;
  engine: string;
  agentName: string;
  role?: string;
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop';
  tool?: string;
  /** Короткая подпись инструмента: команда или путь. */
  summary?: string;
  /** Только для Stop: проверки проекта не прошли (английский текст и код). */
  failed?: string;
  failedKey?: AppErrorKey;
}

interface Entry extends OverviewTerminalInput {
  projectPath: string;
  stopped: boolean;
}

export class TerminalSessionTracker {
  private sessions = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  public record(a: TerminalActivity): void {
    const at = this.now();
    const prev = this.sessions.get(a.sessionId);
    const stopped = a.event === 'Stop';
    const detail = a.failed ?? (a.tool ? `${a.tool}${a.summary ? `: ${a.summary}` : ''}` : prev?.detail);
    const entry: Entry = {
      id: a.sessionId,
      projectPath: a.projectPath,
      engine: a.engine,
      agentName: a.agentName || prev?.agentName || a.engine,
      ...(a.role ?? prev?.role ? { role: a.role ?? prev?.role } : {}),
      state: a.failed ? 'failed' : stopped ? 'idle' : 'running',
      updatedAt: at,
      ...(detail ? { detail } : {}),
      ...(a.failed && a.failedKey ? { detailKey: a.failedKey } : {}),
      stopped
    };
    // Новая запись — в конец Map: старые вытесняются первыми.
    this.sessions.delete(a.sessionId);
    this.sessions.set(a.sessionId, entry);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    // Состояние PreToolUse→PostToolUse не меняется: дерево не перерисовывается на каждый инструмент.
    if (!prev || prev.state !== entry.state || prev.projectPath !== entry.projectPath) this.emit();
  }

  /** Сессии проекта; работающая без событий дольше 15 минут показывается простаивающей. */
  public list(projectPath: string): OverviewTerminalInput[] {
    const now = this.now();
    const out: OverviewTerminalInput[] = [];
    for (const [key, e] of this.sessions) {
      if (now - e.updatedAt > TERMINAL_FORGET_AFTER_MS) {
        this.sessions.delete(key);
        continue;
      }
      if (!samePath(e.projectPath, projectPath)) continue;
      const state = e.state === 'running' && now - e.updatedAt > TERMINAL_IDLE_AFTER_MS ? 'idle' : e.state;
      out.push({
        id: e.id,
        engine: e.engine,
        agentName: e.agentName,
        ...(e.role ? { role: e.role } : {}),
        state,
        updatedAt: e.updatedAt,
        ...(e.detail ? { detail: e.detail } : {})
      });
    }
    return out;
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // подписчик не роняет хук терминала
      }
    }
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

export const terminalSessionTracker = new TerminalSessionTracker();
