/**
 * Разбор событий stream-json Claude Code CLI без побочных эффектов (TASK-271).
 *
 * Событие `user` несёт результаты инструментов (`tool_result`) по `tool_use_id`: их пишет аудит HITL
 * (TASK-57) и показывает лента Agents Studio — вывод шага, как под вызовом инструмента в терминале.
 */

export interface CliToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/** Сколько текста результата уходит в ленту: длинный вывод (Read большого файла) не раздувает сообщение. */
export const CLI_TOOL_RESULT_MAX = 8000;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((c) => {
      const t = (c as { text?: unknown } | null)?.text;
      return typeof t === 'string' ? t : '';
    })
    .join(' ');
}

/** Результаты инструментов из события `user`; у других событий — пустой список. */
export function cliToolResults(event: unknown): CliToolResult[] {
  const content = (event as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: CliToolResult[] = [];
  for (const raw of content as unknown[]) {
    const item = raw as { type?: unknown; content?: unknown; tool_use_id?: unknown; is_error?: unknown } | null;
    if (item?.type !== 'tool_result') continue;
    out.push({ toolUseId: String(item.tool_use_id ?? ''), text: resultText(item.content), isError: Boolean(item.is_error) });
  }
  return out;
}

/** Текст результата для ленты: обрезан по `CLI_TOOL_RESULT_MAX` с пометкой о числе отброшенных символов. */
export function clipToolResult(text: string, max = CLI_TOOL_RESULT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (+${text.length - max} chars)`;
}
