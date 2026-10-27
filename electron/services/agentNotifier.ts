import type { NoteContext } from './remoteInboxService.js';

/**
 * Точка вызова `projecthub_notify` (TASK-140.5, [[decision-117]] п. 8) для встроенного MCP и tool-loop API-агента.
 * Отправителя регистрирует Remote Control при старте: так MCP-сервер и исполнитель инструментов не тянут его за собой.
 */

export type AgentNotifier = (ctx: NoteContext, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;

let notifier: AgentNotifier | null = null;

export function setAgentNotifier(fn: AgentNotifier | null): void {
  notifier = fn;
}

export function notifyHuman(ctx: NoteContext, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  if (!notifier) return Promise.resolve({ isError: true, text: 'ProjectHub: the phone Inbox is not available in this process.' });
  return notifier(ctx, args);
}
