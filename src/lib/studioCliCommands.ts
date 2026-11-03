import type { AIProviderConfig } from '../types/electron';
import { claudeEngineOf } from './connections';
import { addDirArgument } from './studioAddDir';

/**
 * Слеш-команды Claude Code, которые Agents Studio выполнить не может (TASK-230). Studio запускает CLI без терминала
 * (`claude -p`), и встроенные интерактивные команды CLI отвечает «isn't available in this environment»: `/resume` ждёт
 * выбора в интерактивном списке, `/remote-control` и настройки — живой процесс с терминалом. Studio перехватывает их
 * до отправки: `/resume` — свой выбор сессии, `/plan` — plan mode вкладки (TASK-282), `/fork` и `/btw` — ответвление
 * разговора (TASK-283), `/rewind` — откат к реплике (TASK-284), `/add-dir` — каталог вкладки (TASK-285), `/memory` — файлы
 * памяти CLI (TASK-286), остальное — продолжение разговора в терминале ProjectHub.
 */

export type StudioCliCommand =
  | { kind: 'resume'; cliSessionId?: string }
  | { kind: 'addDir'; path: string }
  | { kind: 'plan'; prompt?: string }
  | { kind: 'fork'; title?: string }
  | { kind: 'btw'; question: string }
  | { kind: 'rewind' }
  | { kind: 'memory' }
  | { kind: 'terminal'; command: string };

/**
 * Встроенные команды CLI, которым нужен интерактивный терминал. Список сверен с Claude Code 2.1.314 (TASK-282):
 * `claude -p "/X"` отвечает «/X isn't available in this environment.» без хода модели; `doctor`, `color`, `focus` и
 * `reload-plugins` CLI сам относит к терминальным (`terminal_slash_commands` события init). Команды, которые в `-p`
 * работают (`/mcp`, `/model`, `/context`, `/cost`, `/usage`, `/compact`, `/review`, `/effort`), уходят в CLI как есть.
 * `login`, `logout`, `upgrade` и подобные вживую не проверялись — они меняют аккаунт или установку. Команду, которой
 * здесь нет и которую CLI отклонит, ловит {@link unavailableCliCommand} по ответу.
 */
const TERMINAL_ONLY = new Set([
  'remote-control',
  'remote-env',
  'mobile',
  'desktop',
  'teleport',
  'chrome',
  'voice',
  'keybindings',
  'sandbox',
  'skills',
  'workflows',
  'tasks',
  'copy',
  'focus',
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
  'plugin',
  'export',
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
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();
  if (name === 'resume') {
    // `/resume <id>` — сразу эта сессия, без списка; другой аргумент (поиск CLI) — список.
    const arg = rest.split(/\s+/)[0];
    return arg && SESSION_ID_RE.test(arg) ? { kind: 'resume', cliSessionId: arg.toLowerCase() } : { kind: 'resume' };
  }
  // `/plan [задача]` в CLI включает plan mode сессии; в Studio это режим architect (decision-196).
  if (name === 'plan') return rest ? { kind: 'plan', prompt: rest } : { kind: 'plan' };
  // `/fork [имя]` и `/branch [имя]` (TASK-283) — вкладка-ответвление; `/btw <вопрос>` — побочный вопрос без записи.
  if (name === 'fork' || name === 'branch') return rest ? { kind: 'fork', title: rest.slice(0, 120) } : { kind: 'fork' };
  if (name === 'btw') return { kind: 'btw', question: rest };
  // `/rewind` (TASK-284) — свой выбор точки отката: разговор и, по подтверждению, файлы.
  if (name === 'rewind') return { kind: 'rewind' };
  // `/add-dir [путь]` (TASK-285) — каталог вкладки для `--add-dir`; без пути — выбор каталога в диалоге.
  if (name === 'add-dir') return { kind: 'addDir', path: addDirArgument(rest) };
  // `/memory` (TASK-286) — файлы памяти CLI вкладки во встроенном редакторе; аргументов у команды нет.
  if (name === 'memory') return { kind: 'memory' };
  // `/config key=value` CLI выполняет и без терминала, без аргументов — открывает экран настроек.
  if (name === 'config' && rest) return null;
  return TERMINAL_ONLY.has(name) ? { kind: 'terminal', command: name } : null;
}

/**
 * Ответ CLI на встроенную команду, которой нет в режиме без терминала: «/X isn't available in this environment.»
 * (у `/focus` в 2.1.314 — «isn't available here yet»).
 * Возвращает имя команды — Studio заменяет английский ответ своим текстом и предлагает терминал.
 */
export function unavailableCliCommand(reply: string | undefined): string | null {
  const match = /^\/([a-z][a-z-]*) isn't available (?:in this environment|here yet)\.?$/i.exec((reply || '').trim());
  return match ? match[1].toLowerCase() : null;
}
