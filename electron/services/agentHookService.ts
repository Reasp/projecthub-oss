/**
 * Хуки Codex CLI и Gemini CLI агентов ProjectHub (TASK-261, decision-226).
 *
 * Запуск агента получает токен на один процесс (`grant`). Скрипт хука движка присылает вход хука на тот же маршрут,
 * что и терминал (`POST /api/hooks/event`), но с этим токеном. Решение по вызову инструмента принимает сессия
 * разрешений агента — та же, что у Claude CLI (`claudeBridgeService.handleCliPermissionRequest`): политика роли и
 * проекта, карточка HITL, аудит. Вызов движка приводится к форме Claude Code (`policyToolCalls`).
 *
 * Рукопожатие: любое событие хука с токеном запуска отмечает, что хуки движка загружены. Запуск, в выводе которого
 * инструмент начался раньше рукопожатия, останавливается (`agentFleetService`).
 */
import crypto from 'node:crypto';
import { parseHookPayload, policyToolCalls, type HookProcessOutput } from './terminalHookProtocol.js';
import { AGENT_HOOK_TOKEN_PREFIX, type AgentHookEngine } from './agentEngineHooks.js';

export interface AgentHookDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface AgentHookDeps {
  /** Решение сессии разрешений агента по вызову в форме Claude Code. */
  decide(sessionId: string, request: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }): Promise<AgentHookDecision>;
  /** Итог вызова для аудита (строка `outcome`). */
  noteResult(toolUseId: string | undefined, isError: boolean, detail?: string): void;
}

interface AgentHookGrant {
  sessionId: string;
  engine: AgentHookEngine;
  /** Сколько событий хука пришло от этого запуска: больше нуля — рукопожатие состоялось. */
  events: number;
  /** Сколько вызовов инструментов прошло через PreToolUse этого запуска. */
  calls: number;
}

export interface AgentHookHandle {
  token: string;
  /** Пришло ли от запуска хоть одно событие хука. */
  handshake(): boolean;
  /** Сколько вызовов инструментов прошло через хук. */
  toolCalls(): number;
  revoke(): void;
}

const NONE: HookProcessOutput = { exitCode: 0, stdout: '', stderr: '' };

/** Отказ в формате движка: оба формата проверены вживую (codex-cli 0.167, gemini 0.67). */
export function agentHookDeny(engine: AgentHookEngine, reason: string): HookProcessOutput {
  if (engine === 'gemini') return { ...NONE, stdout: JSON.stringify({ decision: 'deny', reason }) };
  return {
    ...NONE,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  };
}

function defaultDeps(): AgentHookDeps {
  return {
    decide: async (sessionId, request) => (await import('./claudeBridgeService.js')).claudeBridgeService.handleCliPermissionRequest(sessionId, request),
    noteResult: (toolUseId, isError, detail) => {
      void import('./claudeBridgeService.js').then(({ claudeBridgeService }) => claudeBridgeService.noteCliToolResult(toolUseId, isError, detail));
    }
  };
}

export class AgentHookService {
  private grants = new Map<string, AgentHookGrant>();
  private readonly deps: AgentHookDeps;

  constructor(deps: Partial<AgentHookDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Токен на один запуск движка; `sessionId` — сессия разрешений агента (`prepareCliPermissions`). */
  public grant(sessionId: string, engine: AgentHookEngine): AgentHookHandle {
    const token = `${AGENT_HOOK_TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    const grant: AgentHookGrant = { sessionId, engine, events: 0, calls: 0 };
    this.grants.set(token, grant);
    return {
      token,
      handshake: () => grant.events > 0,
      toolCalls: () => grant.calls,
      revoke: () => {
        this.grants.delete(token);
      }
    };
  }

  /** Токен действующего запуска; сравнение за константное время. */
  public isAgentHookToken(presented: string): boolean {
    return this.grantOf(presented) !== null;
  }

  private grantOf(presented: string): AgentHookGrant | null {
    if (!presented || !presented.startsWith(AGENT_HOOK_TOKEN_PREFIX)) return null;
    const wanted = Buffer.from(presented, 'utf8');
    for (const [token, grant] of this.grants) {
      const have = Buffer.from(token, 'utf8');
      if (have.length === wanted.length && crypto.timingSafeEqual(have, wanted)) return grant;
    }
    return null;
  }

  /** Событие хука запуска. Не бросает: сбой разбора у вызова инструмента — отказ, у остальных событий — без решения. */
  public async handle(presented: string, body: unknown): Promise<HookProcessOutput> {
    const grant = this.grantOf(presented);
    if (!grant) return NONE;
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const engine = grant.engine;
    const rawEvent = b.payload && typeof b.payload === 'object' ? (b.payload as Record<string, unknown>).hook_event_name : undefined;
    const isPre = rawEvent === 'PreToolUse' || rawEvent === 'BeforeTool';
    const parsed = parseHookPayload(engine, b.payload);
    if (!parsed.ok) return isPre ? agentHookDeny(engine, `ProjectHub: ${parsed.error}`) : { ...NONE, stderr: `ProjectHub: ${parsed.error}` };
    const event = parsed.event;
    grant.events += 1;
    try {
      if (event.event === 'PreToolUse') {
        grant.calls += 1;
        const calls = policyToolCalls(event);
        for (const [index, call] of calls.entries()) {
          const decision = await this.deps.decide(grant.sessionId, {
            tool_name: call.tool,
            input: call.input,
            ...(index === 0 && event.toolUseId ? { tool_use_id: event.toolUseId } : {})
          });
          if (decision.behavior !== 'allow') return agentHookDeny(engine, decision.message || `ProjectHub: tool ${call.tool} is denied`);
        }
        return NONE;
      }
      if (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') {
        this.deps.noteResult(event.toolUseId, event.toolFailed, event.errorDetail);
      }
      return NONE;
    } catch (err) {
      const reason = `ProjectHub: the permission check failed (${err instanceof Error ? err.message : String(err)})`;
      return event.event === 'PreToolUse' ? agentHookDeny(engine, reason) : { ...NONE, stderr: reason };
    }
  }
}

export const agentHookService = new AgentHookService();
