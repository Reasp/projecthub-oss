import type { AIProviderConfig } from '../types/electron';
import { claudeEngineOf } from './connections';

/**
 * Слеш-команды Claude Code, которые Agents Studio выполнить не может (TASK-230). Studio запускает CLI без терминала
 * (`claude -p`), и встроенные интерактивные команды CLI отвечает «isn't available in this environment»: `/resume` ждёт
 * выбора в интерактивном списке, `/remote-control` и настройки — живой процесс с терминалом. Studio перехватывает их
 * до отправки: `/resume` — свой выбор сессии, остальное — продолжение разговора в терминале ProjectHub.
 */

export type StudioCliCommand = { kind: 'resume' } | { kind: 'terminal'; command: string };

/** Встроенные команды CLI, которым нужен интерактивный терминал. */
const TERMINAL_ONLY = new Set(['remote-control', 'login', 'logout', 'config', 'doctor', 'ide', 'terminal-setup', 'theme', 'vim', 'permissions']);

/** Запрос вкладки уходит в Claude Code CLI (подписка), а не в API или другой провайдер. */
export function goesToClaudeCli(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): boolean {
  return config.provider === 'anthropic' && claudeEngineOf(config) === 'claude-cli';
}

export function studioCliCommand(text: string, config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): StudioCliCommand | null {
  if (!goesToClaudeCli(config)) return null;
  const match = /^\/([a-z][a-z-]*)(?:\s|$)/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === 'resume') return { kind: 'resume' };
  return TERMINAL_ONLY.has(name) ? { kind: 'terminal', command: name } : null;
}
