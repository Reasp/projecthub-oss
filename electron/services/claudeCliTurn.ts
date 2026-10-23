/**
 * Один ход модели через Claude Code CLI по подписке (TASK-134.1, decision-74).
 *
 * Ход — это чтение проекта и рассуждение без записи: план архитектора, ревью кандидата. API-путь делает
 * его одним запросом `streamChat`; у пользователя подписки API-ключа нет, поэтому тот же ход идёт в CLI.
 * Запуск облегчён так же, как одноразовый запрос ([[decision-35]] п. 2): без MCP-серверов, навыков и
 * сохранения сессии. Отличия — рабочий каталог проекта (CLI читает его `CLAUDE.md`), встроенные
 * инструменты только чтения и системный промпт Claude Code, к которому дописывается промпт роли.
 *
 * Чистый модуль без Electron и процессов — покрыт unit-тестами.
 */
import { ProviderError, classifyClaudeCliError, parseClaudeCliErrorEvent, type ProviderErrorContext } from './providerErrors.js';

/** Инструменты хода: прочитать файл и найти по проекту. Записи, команд и сети нет. */
export const CLAUDE_CLI_TURN_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

export interface TurnMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface ClaudeCliTurnInput {
  /** Модель или алиас CLI; без значения CLI берёт свою модель по умолчанию. */
  model?: string;
  messages: readonly TurnMessage[];
  /** Файл с промптом роли и контекстом задачи: многострочный аргумент через `cmd.exe` обрезал бы команду. */
  systemPromptFile?: string;
  /** Аргументы усилия рассуждений (`claudeCliEffortArgs`). */
  effortArgs?: readonly string[];
}

export interface ClaudeCliTurnCommand {
  args: string[];
  stdin: string;
}

export interface ClaudeCliTurnResult {
  text: string;
  /** Оценка CLI по прайс-листу API; на подписке деньги не списываются. */
  listCostUsd?: number;
}

/**
 * Диалог одним текстом для stdin: сессия CLI не сохраняется, поэтому повторный запрос (план не прошёл
 * проверку) несёт прошлые сообщения с собой.
 */
export function flattenTurnMessages(messages: readonly TurnMessage[]): string {
  const dialog = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim());
  if (dialog.length === 0) return '';
  const last = dialog[dialog.length - 1];
  if (dialog.length === 1) return last.content;
  const earlier = dialog
    .slice(0, -1)
    .map((m) => `### ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content.trim()}`)
    .join('\n\n');
  return [
    'This request continues an earlier conversation. Earlier messages:',
    earlier,
    '### Current user message',
    last.content
  ].join('\n\n');
}

export function buildClaudeCliTurnCommand(input: ClaudeCliTurnInput): ClaudeCliTurnCommand {
  const stdin = flattenTurnMessages(input.messages);
  if (!stdin.trim()) throw new Error('Empty request: the turn has no user message.');
  const model = input.model?.trim();
  const args = [
    '-p',
    ...(model && model !== 'default' ? ['--model', model] : []),
    ...(input.effortArgs ?? []),
    '--output-format',
    'json',
    '--strict-mcp-config',
    `--tools=${CLAUDE_CLI_TURN_TOOLS.join(',')}`,
    '--no-session-persistence',
    '--disable-slash-commands',
    ...(input.systemPromptFile ? ['--append-system-prompt-file', input.systemPromptFile] : [])
  ];
  return { args, stdin };
}

/**
 * Разбирает ответ `claude -p --output-format json`.
 *
 * @throws `ProviderError` со снимком, если CLI сообщил об ошибке API (лимит подписки, модель не найдена);
 *   обычную ошибку — если вывод не является ожидаемым JSON.
 */
export function parseClaudeCliTurnOutput(stdout: string, ctx: ProviderErrorContext = {}): ClaudeCliTurnResult {
  const trimmed = stdout.trim();
  // CLI иногда печатает предупреждения перед JSON — берём последний объект верхнего уровня
  const start = trimmed.lastIndexOf('\n{') >= 0 ? trimmed.lastIndexOf('\n{') + 1 : trimmed.indexOf('{');
  if (start < 0) throw new Error(`Claude CLI returned non-JSON output: ${trimmed.slice(0, 200)}`);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Claude CLI returned invalid JSON: ${trimmed.slice(0, 200)}`, { cause: err });
  }

  const apiError = parseClaudeCliErrorEvent(data);
  if (apiError) throw new ProviderError(classifyClaudeCliError(apiError, ctx));
  if (data.is_error === true) {
    const detail = typeof data.result === 'string' && data.result ? data.result : String(data.subtype ?? 'unknown error');
    throw new Error(`Claude CLI: ${detail}`);
  }
  if (typeof data.result !== 'string') throw new Error('Claude CLI returned no response text');

  return {
    text: data.result.trim(),
    ...(typeof data.total_cost_usd === 'number' ? { listCostUsd: data.total_cost_usd } : {})
  };
}
