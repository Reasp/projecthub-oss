import type { AIProviderConfig } from '../types/electron';
import { claudeEngineOf } from './connections';

/**
 * Слеш-команды Claude Code, которые Agents Studio выполнить не может (TASK-230). Studio запускает CLI без терминала
 * (`claude -p`), и встроенные интерактивные команды CLI отвечает «isn't available in this environment»: `/resume` ждёт
 * выбора в интерактивном списке, `/remote-control` и настройки — живой процесс с терминалом. Studio перехватывает их
 * до отправки: `/resume` — свой выбор сессии, остальное — продолжение разговора в терминале ProjectHub.
 */

export type StudioCliCommand = { kind: 'resume'; cliSessionId?: string } | { kind: 'terminal'; command: string };

/**
 * Встроенные команды CLI, которым нужен интерактивный терминал. Список сверен с Claude Code 2.1.312: `claude -p "/X"`
 * отвечает «/X isn't available in this environment.» без хода модели. Команды, которые в `-p` работают (`/mcp`,
 * `/model`, `/context`, `/cost`, `/compact`, `/review`), уходят в CLI как есть. Команду, которой здесь нет и которую
 * CLI отклонит, ловит {@link unavailableCliCommand} по ответу.
 */
const TERMINAL_ONLY = new Set([
  'remote-control',
  'login',
  'logout',
  'config',
  'doctor',
  'ide',
  'terminal-setup',
  'theme',
  'vim',
  'permissions',
  'hooks',
  'status',
  'help',
  'memory',
  'plugin',
  'add-dir',
  'export',
  'rewind',
  'exit',
  'bug',
  'feedback',
  'upgrade',
  'install-github-app',
  'privacy-settings',
  'release-notes',
  'statusline',
  'bashes'
]);

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Команда терминала, которую можно передать CLI аргументом при старте (`claude /remote-control`): интерактивный
 * Claude Code выполняет слеш-команду из позиционного аргумента без кавычек (проверено на 2.1.312). Только из списка —
 * в командную строку не попадает ничего, кроме известного имени.
 */
export function isTerminalOnlyCommand(name: unknown): name is string {
  return typeof name === 'string' && TERMINAL_ONLY.has(name);
}

/** Запрос вкладки уходит в Claude Code CLI (подписка), а не в API или другой провайдер. */
export function goesToClaudeCli(config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): boolean {
  return config.provider === 'anthropic' && claudeEngineOf(config) === 'claude-cli';
}

export function studioCliCommand(text: string, config: Pick<AIProviderConfig, 'provider' | 'apiKey' | 'engine'>): StudioCliCommand | null {
  if (!goesToClaudeCli(config)) return null;
  const match = /^\/([a-z][a-z-]*)(?:\s+(\S+))?/i.exec(text.trim());
  if (!match || (text.trim().length > match[0].length && !/^\s/.test(text.trim().slice(match[0].length)))) return null;
  const name = match[1].toLowerCase();
  if (name === 'resume') {
    // `/resume <id>` — сразу эта сессия, без списка; другой аргумент (поиск CLI) — список.
    const arg = match[2];
    return arg && SESSION_ID_RE.test(arg) ? { kind: 'resume', cliSessionId: arg.toLowerCase() } : { kind: 'resume' };
  }
  return TERMINAL_ONLY.has(name) ? { kind: 'terminal', command: name } : null;
}

/**
 * Ответ CLI на встроенную команду, которой нет в режиме без терминала: «/X isn't available in this environment.».
 * Возвращает имя команды — Studio заменяет английский ответ своим текстом и предлагает терминал.
 */
export function unavailableCliCommand(reply: string | undefined): string | null {
  const match = /^\/([a-z][a-z-]*) isn't available in this environment\.?$/i.exec((reply || '').trim());
  return match ? match[1].toLowerCase() : null;
}
