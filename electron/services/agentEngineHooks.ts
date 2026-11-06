/**
 * Хуки движков Codex CLI и Gemini CLI для агентов ProjectHub (TASK-261, decision-226).
 *
 * Чистый модуль без Electron: текст скрипта хука, аргументы `codex exec`, слияние `.gemini/settings.json` рабочего
 * каталога и разбор потоковых событий обоих CLI. Решения принимает ProjectHub (`agentHookService` → та же сессия
 * разрешений, что у Claude CLI), скрипт только пересылает вход хука.
 *
 * Проверено вживую на поддельной модели (codex-cli 0.167, gemini 0.67):
 * - Codex читает хуки из переопределений `-c hooks.<Событие>=[…]` только с `--dangerously-bypass-hook-trust`;
 *   без него хуки молча не выполняются (их нужно доверить по хэшу). `SessionStart` приходит после `turn.started`,
 *   но `PreToolUse` всегда раньше `item.started` команды.
 * - Gemini читает хуки из `.gemini/settings.json` рабочего каталога, если папка доверенная. `--skip-trust` выставляет
 *   доверие уже после чтения настроек, поэтому нужен `GEMINI_CLI_TRUST_WORKSPACE=true` в окружении. Системные
 *   настройки (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) не годятся: каталог должен принадлежать администратору. В headless
 *   режиме `default` инструменты оболочки и записи убраны из списка совсем — разрешает их только `yolo` под хуком.
 *   `SessionStart` приходит раньше события `init` потока.
 * - Оба движка передают хуку окружение своего процесса: токен — в переменной, в файлы не пишется.
 */
import type { AgentUsage } from './agentCost.js';

export type AgentHookEngine = 'codex' | 'gemini';

export const AGENT_HOOK_SCRIPT_FILE = 'projecthub-agent-hook.mjs';
export const AGENT_HOOK_URL_ENV = 'PROJECTHUB_AGENT_HOOK_URL';
export const AGENT_HOOK_TOKEN_ENV = 'PROJECTHUB_AGENT_HOOK_TOKEN';
/** Имя нашего обработчика в настройках Gemini: по нему он находится и снимается после запуска. */
export const GEMINI_AGENT_HOOK_NAME = 'projecthub-agent-hook';
/** Тайм-аут хука (с): решение человека ждёт дольше обычного тайм-аута движка (600 с у Codex, 60 с у Gemini). */
export const AGENT_HOOK_TIMEOUT_SEC = 3600;
/** Префикс токена хука агента: отличает его от токена хуков терминала. */
export const AGENT_HOOK_TOKEN_PREFIX = 'ph_ahook_';

/**
 * Скрипт хука агента. Политики нет: вход хука уходит ProjectHub, ответ печатается как есть.
 * Без токена — без решения: так файл, случайно оставшийся в проекте, не ломает ручной запуск CLI, а запуск
 * ProjectHub без рукопожатия всё равно останавливается. С токеном любой сбой связи — отказ вызова (fail-closed).
 * Хранится как `String.raw` без обратных кавычек и `${`.
 */
export const AGENT_HOOK_SCRIPT_SOURCE = String.raw`// Хук агента ProjectHub для Codex CLI и Gemini CLI (TASK-261, decision-226). Файл пишет ProjectHub, не правьте его.
// Аргумент: codex | gemini. Окружение: PROJECTHUB_AGENT_HOOK_URL, PROJECTHUB_AGENT_HOOK_TOKEN (на один запуск агента).
const engine = process.argv[2] === 'gemini' ? 'gemini' : 'codex';
const baseUrl = (process.env.PROJECTHUB_AGENT_HOOK_URL || '').replace(/\/+$/, '');
const token = process.env.PROJECTHUB_AGENT_HOOK_TOKEN || '';
const budgetMs = 3600 * 1000 - 15000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function isPre(eventName) {
  return eventName === 'PreToolUse' || eventName === 'BeforeTool';
}

function deny(reason) {
  if (engine === 'gemini') return { exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason: reason }) };
  return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) };
}

function finish(out) {
  if (out && out.stdout) process.stdout.write(String(out.stdout));
  if (out && out.stderr) process.stderr.write(String(out.stderr) + '\n');
  process.exitCode = out && typeof out.exitCode === 'number' ? out.exitCode : 0;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  const eventName = payload && typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!token || !baseUrl) {
    finish({ exitCode: 0 });
    return;
  }
  const failed = (reason) => finish(isPre(eventName) ? deny('ProjectHub: ' + reason + ' - the call is denied') : { exitCode: 0 });
  if (!payload || typeof payload !== 'object') {
    failed('the hook input is not JSON');
    return;
  }
  try {
    const res = await fetch(baseUrl + '/api/hooks/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ engine: engine, payload: payload, budgetMs: budgetMs }),
      signal: AbortSignal.timeout(budgetMs)
    });
    if (!res.ok) failed('HTTP ' + res.status);
    else finish(await res.json());
  } catch (err) {
    failed('no answer (' + ((err && err.cause && err.cause.code) || (err && err.name) || String(err)) + ')');
  }
}

try {
  await main();
} catch (err) {
  finish({ exitCode: 0, stderr: 'ProjectHub hook error: ' + (err && err.message ? err.message : String(err)) });
}
`;

/** Символы, которые оболочка (cmd.exe, sh, PowerShell) или TOML-литерал истолковали бы по-своему. */
const UNSAFE_PATH_CHARS = /["'`%!&|<>^$\r\n;]/;

/**
 * Команда хука: `node <скрипт> <движок>`. Путь — с прямыми слэшами; с пробелами — в двойных кавычках
 * (проверено вживую через `codex.cmd` с `shell: true`). Путь с символами оболочки — null.
 */
export function agentHookCommand(engine: AgentHookEngine, scriptPath: string): string | null {
  const normalized = scriptPath.replace(/\\/g, '/');
  if (!normalized || UNSAFE_PATH_CHARS.test(normalized)) return null;
  const quoted = /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return `node ${quoted} ${engine}`;
}

/** Аргумент для `spawn` с `shell: true`: в двойных кавычках, внутренние кавычки экранированы. */
function shellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Аргументы `codex exec` с хуками ProjectHub: `PreToolUse`, `PostToolUse`, `SessionStart` переопределениями `-c` и
 * `--dangerously-bypass-hook-trust` (без него Codex их не выполняет). Обход доверия касается и хуков пользователя и
 * доверенного проекта — их Codex выполнил бы и в терминале, после ревью.
 *
 * `shell: false` — для запуска без оболочки (`docker run` в контейнере участника, TASK-308): значения без кавычек.
 */
export function codexAgentHookArgs(command: string, timeoutSec = AGENT_HOOK_TIMEOUT_SEC, opts: { shell?: boolean } = {}): string[] {
  const quote = opts.shell === false ? (value: string) => value : shellArg;
  const handler = `{type='command',command='${command}',timeout=${Math.round(timeoutSec)}}`;
  const tool = (event: string) => quote(`hooks.${event}=[{matcher='.*',hooks=[${handler}]}]`);
  return [
    '--dangerously-bypass-hook-trust',
    '-c', tool('PreToolUse'),
    '-c', tool('PostToolUse'),
    '-c', quote(`hooks.SessionStart=[{hooks=[${handler}]}]`)
  ];
}

/** Нормализация текста скрипта для сверки: git на Windows с `core.autocrlf` отдаёт файл образа с CRLF. */
export function sameAgentHookScript(text: string): boolean {
  return text.replace(/\r\n/g, '\n') === AGENT_HOOK_SCRIPT_SOURCE;
}

const GEMINI_HOOK_EVENTS = ['BeforeTool', 'AfterTool', 'SessionStart'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOurGeminiHandler(handler: unknown): boolean {
  return isRecord(handler) && handler.name === GEMINI_AGENT_HOOK_NAME;
}

export type GeminiSettingsMerge = { ok: true; content: string | null } | { ok: false; error: string };

/** Убирает комментарии `//` и `/* *\/` вне строк: Gemini читает настройки с комментариями (strip-json-comments). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Ставит (`command`) или снимает (`null`) наш обработчик в `.gemini/settings.json` рабочего каталога. Чужие ключи и
 * хуки сохраняются. `content: null` — файл после снятия пуст и его можно удалить (если его создал ProjectHub).
 * Невалидный файл не перезаписывается: `ok: false`.
 */
export function mergeGeminiAgentHooks(current: string | null, command: string | null, timeoutSec = AGENT_HOOK_TIMEOUT_SEC): GeminiSettingsMerge {
  let root: Record<string, unknown> = {};
  if (current !== null && current.trim()) {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(current));
      if (!isRecord(parsed)) return { ok: false, error: 'the settings file is not a JSON object' };
      root = parsed;
    } catch (err) {
      return { ok: false, error: `the settings file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (root.hooks !== undefined && !isRecord(root.hooks)) return { ok: false, error: 'the "hooks" key is not an object' };
  const hooks: Record<string, unknown> = { ...((root.hooks as Record<string, unknown> | undefined) ?? {}) };
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((group) => (isRecord(group) && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isOurGeminiHandler(h)) } : group))
      .filter((group) => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.length === 0));
    if (cleaned.length) hooks[event] = cleaned;
    else delete hooks[event];
  }
  if (command) {
    const handler = { name: GEMINI_AGENT_HOOK_NAME, type: 'command', command, timeout: Math.round(timeoutSec * 1000) };
    for (const event of GEMINI_HOOK_EVENTS) {
      const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...existing, event === 'SessionStart' ? { hooks: [handler] } : { matcher: '.*', hooks: [handler] }];
    }
  }
  const next: Record<string, unknown> = { ...root };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  if (!command && Object.keys(next).length === 0) return { ok: true, content: null };
  return { ok: true, content: `${JSON.stringify(next, null, 2)}\n` };
}

/** Событие `codex exec --json`, которое означает начало вызова инструмента под хуком `PreToolUse`. */
export function isCodexToolStart(event: unknown): boolean {
  if (!isRecord(event) || event.type !== 'item.started' || !isRecord(event.item)) return false;
  return event.item.type === 'command_execution' || event.item.type === 'file_change' || event.item.type === 'mcp_tool_call';
}

export type GeminiStreamEvent =
  | { kind: 'init' }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'toolResult'; failed: boolean }
  | { kind: 'result'; ok: boolean; usage?: AgentUsage; error?: string }
  | { kind: 'other' };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Строка `gemini --output-format stream-json` (формат проверен вживую на 0.67). */
export function parseGeminiStreamLine(line: string): GeminiStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let e: unknown;
  try {
    e = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(e)) return null;
  switch (e.type) {
    case 'init':
      return { kind: 'init' };
    case 'message':
      return e.role === 'assistant' && typeof e.content === 'string' && e.content ? { kind: 'text', text: e.content } : { kind: 'other' };
    case 'tool_use':
      return { kind: 'tool', name: typeof e.tool_name === 'string' ? e.tool_name : '' };
    case 'tool_result':
      return { kind: 'toolResult', failed: e.status !== 'success' };
    case 'result': {
      const stats = isRecord(e.stats) ? e.stats : {};
      const input = num(stats.input_tokens);
      const output = num(stats.output_tokens);
      const cached = num(stats.cached);
      const usage: AgentUsage | undefined = input || output
        ? { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0, totalTokens: input + output + cached, costSource: 'unknown' }
        : undefined;
      const error = isRecord(e.error) && typeof e.error.message === 'string' ? e.error.message : undefined;
      return { kind: 'result', ok: e.status === 'success', ...(usage ? { usage } : {}), ...(error ? { error } : {}) };
    }
    default:
      return { kind: 'other' };
  }
}
