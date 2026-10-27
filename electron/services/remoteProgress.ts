import type { SwarmSession } from './swarmTypes.js';
import { hostText, type HostText } from '../i18n/hostText.js';

/**
 * Ход агента на экране блокировки телефона (TASK-140.7, [[decision-121]] п. 1): что показать о рое и когда слать push.
 * Без Electron и сети — отправку делает `RemotePushService.onProgress`.
 */

export type ProgressState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface AgentProgress {
  swarmId: string;
  title: string;
  state: ProgressState;
  /** Фаза на языке хоста: «iteration 2 of 5 — checks», «agents working: 2 of 3». */
  step: string;
  /** 0–100 для цикла «до готовности»; `undefined` — неопределённый прогресс. */
  percent?: number;
  iteration?: number;
  maxIterations?: number;
  projectPath: string;
}

/** Не чаще раза в 20 секунд на рой, кроме смены состояния или итерации. */
export const PROGRESS_MIN_INTERVAL_MS = 20_000;

function stateOf(status: SwarmSession['status'], waiting: boolean): ProgressState {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'stopped' || status === 'interrupted') return 'stopped';
  return waiting ? 'waiting' : 'running';
}

export function progressFromSession(session: SwarmSession, waiting = false, tx: HostText['progress'] = hostText('en').progress): AgentProgress {
  const state = stateOf(session.status, waiting);
  const title = [session.taskId, session.taskTitle].filter(Boolean).join(' · ') || tx.agent;
  const base = { swarmId: session.id, title, state, projectPath: session.projectPath };
  const loop = session.doneLoop;
  if (loop) {
    const max = Math.max(1, loop.settings.maxIterations);
    const iteration = Math.min(max, Math.max(1, loop.currentIteration || loop.iterations.length || 1));
    // Идущая итерация засчитывается наполовину: полоса не стоит на месте весь ход агента.
    const done = state === 'done' ? max : iteration - (state === 'running' || state === 'waiting' ? 0.5 : 0);
    const phase = state === 'waiting' ? tx.waiting : tx.phases[loop.phase] ?? loop.phase;
    return {
      ...base,
      step: state === 'done' ? tx.doneIn(iteration, max) : tx.iteration(iteration, max, phase),
      percent: Math.round((Math.max(0, done) / max) * 100),
      iteration,
      maxIterations: max
    };
  }
  const total = session.agents.length;
  const active = session.agents.filter((a) => ['running', 'pending', 'preparing'].includes(a.status)).length;
  const failed = session.agents.filter((a) => a.status === 'failed').length;
  let step: string;
  if (state === 'waiting') step = tx.waiting;
  else if (state === 'done') step = total > 1 ? tx.doneOf(total - failed, total) : tx.done;
  else if (state === 'failed') step = session.error ? tx.failedWith(session.error.slice(0, 120)) : tx.failed;
  else if (state === 'stopped') step = tx.stopped;
  else step = total > 1 ? tx.agentsRunning(active, total) : tx.agentRunning;
  return { ...base, step, ...(state === 'done' ? { percent: 100 } : {}) };
}

/** Решает, слать ли push хода: смена состояния, итерации или фазы — сразу, остальное — не чаще интервала. */
export class ProgressThrottle {
  private last = new Map<string, { at: number; key: string; state: ProgressState; iteration?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  shouldSend(p: AgentProgress): boolean {
    const now = this.now();
    const key = `${p.state}|${p.iteration ?? ''}|${p.step}|${p.percent ?? ''}`;
    const prev = this.last.get(p.swarmId);
    const changed = !prev || prev.state !== p.state || prev.iteration !== p.iteration;
    if (prev && prev.key === key) return false;
    if (!changed && now - prev!.at < PROGRESS_MIN_INTERVAL_MS) return false;
    this.last.set(p.swarmId, { at: now, key, state: p.state, iteration: p.iteration });
    // Завершённые рои забываются, чтобы карта не росла.
    if (p.state === 'done' || p.state === 'failed' || p.state === 'stopped') {
      for (const [id, v] of this.last) if (now - v.at > 3_600_000) this.last.delete(id);
    }
    return true;
  }
}
