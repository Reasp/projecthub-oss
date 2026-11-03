import type { StudioMode } from '../types/remote';

/**
 * Режим вкладки Agents Studio (TASK-291, decision-212): agent, chat или architect (plan mode Claude Code). Режим — свойство
 * вкладки, как в CLI — свойство сессии: меню режима и `/plan` меняют только свою вкладку.
 */

export const DEFAULT_STUDIO_MODE: StudioMode = 'agent';

/**
 * Текущий режим вкладки. Без своего поля (вкладки до TASK-291) — режим последнего промпта, кроме plan: `lastMode`
 * писался только при отправке, поэтому после утверждённого плана в нём оставался architect. Plan — временное состояние:
 * CLI и сам после `--resume` начинает в обычном режиме (зонд CLI 2.1.317).
 */
export function sessionMode(session: { mode?: StudioMode; lastMode?: StudioMode } | undefined): StudioMode {
  if (session?.mode) return session.mode;
  return session?.lastMode === 'chat' ? 'chat' : DEFAULT_STUDIO_MODE;
}

/** Вкладка с новым режимом; тот же объект, если режим не меняется (селекторы не перерисовываются зря). */
export function withSessionMode<T extends { mode?: StudioMode; lastMode?: StudioMode }>(session: T, mode: StudioMode): T {
  return session.mode === mode ? session : { ...session, mode };
}
