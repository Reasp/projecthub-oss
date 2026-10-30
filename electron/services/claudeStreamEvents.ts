/**
 * Разбор событий stream-json Claude Code CLI без побочных эффектов (TASK-271).
 *
 * Событие `user` несёт результаты инструментов (`tool_result`) по `tool_use_id`: их пишет аудит HITL
 * (TASK-57) и показывает лента Agents Studio — вывод шага, как под вызовом инструмента в терминале.
 */
import path from 'node:path';

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

// ---------------------------------------------------------------------------
// Потоковый текст (TASK-273)
// ---------------------------------------------------------------------------

/** Флаг `claude -p`: события `stream_event` с дельтами текста и рассуждений по мере генерации. */
export const CLI_PARTIAL_MESSAGES_FLAG = '--include-partial-messages';

export type CliStreamChannel = 'text' | 'thinking';

export interface CliStreamPiece {
  channel: CliStreamChannel;
  text: string;
  /** Первый кусок нового блока: лента начинает его новым абзацем, как в терминале. */
  newBlock: boolean;
}

interface StreamedBlock {
  channel: CliStreamChannel;
  text: string;
  /** Блок уже сверен с целым блоком события `assistant`. */
  final: boolean;
}

/**
 * Дельты `stream_event` основного агента и сверка с целыми блоками `assistant`. С `--include-partial-messages`
 * CLI 2.1.314 сначала шлёт дельты блока (`content_block_delta`), затем тот же блок целиком событием `assistant`
 * с тем же `message.id`: целый блок отдаёт в ленту только то, чего не было в дельтах. Без дельт (старый CLI,
 * блок без потока) целый блок уходит как раньше. События подагентов (`parent_tool_use_id`) сюда не передаются.
 */
export class CliPartialMessages {
  private messageId = '';
  private blocks = new Map<number, StreamedBlock>();

  /** Кусок ленты из `stream_event`; `null` — событие без текста (старт сообщения, JSON инструмента, подпись). */
  onStreamEvent(event: unknown): CliStreamPiece | null {
    const e = (event as { event?: unknown } | null)?.event as
      | { type?: unknown; index?: unknown; message?: { id?: unknown }; content_block?: { type?: unknown }; delta?: { type?: unknown; text?: unknown; thinking?: unknown } }
      | undefined;
    if (!e) return null;
    if (e.type === 'message_start') {
      this.messageId = typeof e.message?.id === 'string' ? e.message.id : '';
      this.blocks.clear();
      return null;
    }
    const index = typeof e.index === 'number' ? e.index : -1;
    if (e.type === 'content_block_start') {
      const kind = e.content_block?.type;
      if (kind === 'text' || kind === 'thinking') this.blocks.set(index, { channel: kind, text: '', final: false });
      return null;
    }
    if (e.type !== 'content_block_delta') return null;
    const channel: CliStreamChannel | null = e.delta?.type === 'text_delta' ? 'text' : e.delta?.type === 'thinking_delta' ? 'thinking' : null;
    if (!channel) return null;
    const value = channel === 'text' ? e.delta?.text : e.delta?.thinking;
    if (typeof value !== 'string' || !value) return null;
    let block = this.blocks.get(index);
    if (!block || block.channel !== channel) {
      block = { channel, text: '', final: false };
      this.blocks.set(index, block);
    }
    const newBlock = block.text === '';
    block.text += value;
    return { channel, text: value, newBlock };
  }

  /**
   * Часть целого блока `assistant`, которой не было в дельтах. Целый блок сверяется с первым ещё не сверенным
   * блоком того же канала: CLI шлёт блоки по порядку. Расхождение с уже показанным текстом не дублируется.
   */
  finalPiece(messageId: unknown, channel: CliStreamChannel, text: string): CliStreamPiece | null {
    if (!text) return null;
    const block = messageId === this.messageId && this.messageId
      ? [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b).find((b) => b.channel === channel && !b.final)
      : undefined;
    if (!block) return { channel, text, newBlock: true };
    block.final = true;
    if (!text.startsWith(block.text)) return null;
    const rest = text.slice(block.text.length);
    return rest ? { channel, text: rest, newBlock: block.text === '' } : null;
  }
}

// ---------------------------------------------------------------------------
// Режим вкладки и plan mode (TASK-272)
// ---------------------------------------------------------------------------

export type StudioCliMode = 'agent' | 'chat' | 'architect';

/** Аргументы режима вкладки для `claude -p`: architect — plan mode CLI, остальные — режим по умолчанию. */
export function cliModeArgs(mode: StudioCliMode | undefined): string[] {
  return mode === 'architect' ? ['--permission-mode', 'plan'] : [];
}

// ---------------------------------------------------------------------------
// Ответвление разговора: /fork, /branch и /btw (TASK-283)
// ---------------------------------------------------------------------------

/**
 * `branch` — вкладка-ответвление: первый ход продолжает историю в новой сессии CLI, исходная не меняется.
 * `side` — побочный вопрос `/btw`: ответвление без записи сессии на диск (проверено на 2.1.314).
 */
export type CliForkKind = 'branch' | 'side';

/** Аргументы продолжения разговора для `claude -p`; без сессии побочный вопрос всё равно не пишется на диск. */
export function cliResumeArgs(cliSessionId: string | undefined, fork: CliForkKind | undefined): string[] {
  const args = cliSessionId ? ['--resume', cliSessionId, ...(fork ? ['--fork-session'] : [])] : [];
  if (fork === 'side') args.push('--no-session-persistence');
  return args;
}

/** Системная пометка побочного вопроса: в CLI `/btw` отвечает по разговору, без инструментов. */
export const CLI_SIDE_QUESTION_PROMPT =
  'This is a side question (/btw) about the conversation so far. Answer briefly from what you already know; tools are unavailable, and the answer is not added to the main conversation.';

export const CLI_EXIT_PLAN_TOOL = 'ExitPlanMode';

/** Сколько текста плана уходит в карточку утверждения. */
export const CLI_PLAN_MAX = 20_000;

/**
 * Файл плана самого Claude Code: `<CLAUDE_CONFIG_DIR>/plans/<имя>.md` без подкаталогов. В plan mode CLI 2.1.314 пишет
 * план туда и затем вызывает `ExitPlanMode {}` — CLI сам подставляет в запрос `plan` и `planFilePath` из этого файла.
 */
export function isCliPlanFile(filePath: unknown, configDir: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof filePath !== 'string' || !filePath.trim() || !configDir?.trim()) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(filePath)) return false;
  const norm = (v: string) => (platform === 'win32' ? p.resolve(v).toLowerCase() : p.resolve(v));
  const plansDir = norm(p.join(configDir, 'plans'));
  const file = norm(filePath);
  return p.dirname(file) === plansDir && /\.md$/i.test(file) && p.basename(file).length > 3;
}

/**
 * Каталог аккаунта Claude Code по пути разговора из входа хука (`transcript_path`):
 * `<CLAUDE_CONFIG_DIR>/projects/<каталог запуска>/<id>.jsonl`, у подагента глубже. Хук терминала не знает
 * `CLAUDE_CONFIG_DIR` процесса CLI (TASK-282) — каталог берётся отсюда. Иначе пустая строка.
 */
export function cliConfigDirOfTranscript(transcriptPath: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath.trim())) return '';
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(transcriptPath)) return '';
  const parts = p.resolve(transcriptPath).split(p.sep);
  const at = parts.lastIndexOf('projects');
  // После `projects` — каталог запуска и хотя бы файл разговора; до него — сам каталог аккаунта.
  if (at < 1 || parts.length - at < 3) return '';
  return parts.slice(0, at).join(p.sep) || p.sep;
}

/** Текст плана из ввода `ExitPlanMode`; пустая строка, если модель плана не передала. */
export function planTextOf(input: Record<string, unknown> | undefined): string {
  const plan = input?.plan;
  return typeof plan === 'string' ? plan.trim().slice(0, CLI_PLAN_MAX) : '';
}

/** Смена режима разрешений CLI в ответе permission_prompt. */
export interface CliSetModePermission {
  type: 'setMode';
  mode: 'default';
  destination: 'session';
}

export type CliPlanDecision =
  | {
      behavior: 'allow';
      updatedInput: Record<string, unknown>;
      /** CLI выходит из плана в обычный режим: правки снова идут через одобрение ProjectHub, а не auto-accept. */
      updatedPermissions: CliSetModePermission[];
    }
  | { behavior: 'deny'; message: string };

/**
 * Ответ CLI на `ExitPlanMode`: утверждение — выход из плана в режим `default` (проверено на claude 2.1.314),
 * отказ — модель остаётся в плане и дорабатывает его по комментарию.
 */
export function planDecision(approved: boolean, input: Record<string, unknown>, comment?: string): CliPlanDecision {
  if (approved) {
    return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] };
  }
  const note = comment?.trim();
  return { behavior: 'deny', message: `The user rejected the plan${note ? `: ${note}` : ''}. Stay in plan mode and revise the plan.` };
}

// ---------------------------------------------------------------------------
// Подагенты (TASK-272)
// ---------------------------------------------------------------------------

export const CLI_SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task'];

/** Вызов, внутри которого работает подагент; `null` — событие основного агента. */
export function parentToolUseIdOf(event: unknown): string | null {
  const parent = (event as { parent_tool_use_id?: unknown } | null)?.parent_tool_use_id;
  return typeof parent === 'string' && parent ? parent : null;
}

export interface CliSubagentUpdate {
  /** id вызова `Agent`/`Task` — он же id подагента в Studio. */
  toolUseId: string;
  name?: string;
  task?: string;
  status?: 'running' | 'completed' | 'failed';
  progress?: string;
  output?: string;
}

const SUBAGENT_TEXT_MAX = 2000;

function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Запуск подагента из вызова `Agent`/`Task` основного агента. */
export function subagentFromToolUse(id: string, name: string, input: Record<string, unknown> | undefined): CliSubagentUpdate | null {
  if (!id || !CLI_SUBAGENT_TOOL_NAMES.includes(name)) return null;
  return {
    toolUseId: id,
    name: clipText(input?.subagent_type, 120) ?? 'general-purpose',
    task: clipText(input?.description, 300) ?? clipText(input?.prompt, 300) ?? '',
    status: 'running'
  };
}

/** Системные события подагента CLI: `task_started`, `task_progress`, `task_notification`. */
export function subagentFromSystemEvent(event: unknown): CliSubagentUpdate | null {
  const e = event as { type?: unknown; subtype?: unknown; tool_use_id?: unknown; description?: unknown; subagent_type?: unknown; last_tool_name?: unknown; status?: unknown; summary?: unknown } | null;
  if (e?.type !== 'system' || typeof e.tool_use_id !== 'string' || !e.tool_use_id) return null;
  const toolUseId = e.tool_use_id;
  switch (e.subtype) {
    case 'task_started':
      return {
        toolUseId,
        status: 'running',
        ...(clipText(e.subagent_type, 120) ? { name: clipText(e.subagent_type, 120) } : {}),
        ...(clipText(e.description, 300) ? { task: clipText(e.description, 300) } : {})
      };
    case 'task_progress': {
      const description = clipText(e.description, 300);
      const tool = clipText(e.last_tool_name, 80);
      const progress = description && tool ? `${description} · ${tool}` : description ?? tool;
      return progress ? { toolUseId, progress } : null;
    }
    case 'task_notification': {
      const status = e.status === 'completed' ? 'completed' : e.status === 'failed' || e.status === 'killed' || e.status === 'error' ? 'failed' : undefined;
      const output = clipText(e.summary, SUBAGENT_TEXT_MAX);
      if (!status && !output) return null;
      return { toolUseId, ...(status ? { status } : {}), ...(output ? { output } : {}) };
    }
    default:
      return null;
  }
}

/** Итог подагента по `tool_result` его вызова у основного агента. */
export function subagentFromToolResult(result: CliToolResult): CliSubagentUpdate {
  return {
    toolUseId: result.toolUseId,
    status: result.isError ? 'failed' : 'completed',
    ...(clipText(result.text, SUBAGENT_TEXT_MAX) ? { output: clipText(result.text, SUBAGENT_TEXT_MAX) } : {})
  };
}

/** Текст подагента — в его строку прогресса, а не в ответ основного агента. */
export function subagentProgressFromText(toolUseId: string, text: string): CliSubagentUpdate | null {
  const progress = clipText(text.split(/\r?\n/).find((l) => l.trim()) ?? '', 300);
  return progress ? { toolUseId, progress } : null;
}

export interface SubagentRecord {
  id: string;
  parentSessionId: string;
  projectPath: string;
  name: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  progress?: string;
  output?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * Применяет обновление к записи подагента. Завершённый подагент не возвращается в `running`
 * (поздний `task_progress` после итога), пустые поля обновления прежние значения не стирают.
 */
export function applySubagentUpdate(
  prev: SubagentRecord | undefined,
  upd: CliSubagentUpdate,
  base: { parentSessionId: string; projectPath: string; now: number }
): SubagentRecord {
  const current: SubagentRecord = prev ?? {
    id: upd.toolUseId,
    parentSessionId: base.parentSessionId,
    projectPath: base.projectPath,
    name: upd.name ?? 'general-purpose',
    task: upd.task ?? '',
    status: 'running',
    startedAt: base.now
  };
  const finished = current.status !== 'running';
  const status = finished ? current.status : upd.status ?? current.status;
  return {
    ...current,
    // Имя по умолчанию уточняется, когда CLI сообщит настоящий `subagent_type`.
    ...(upd.name && current.name === 'general-purpose' ? { name: upd.name } : {}),
    ...(upd.task && !current.task ? { task: upd.task } : {}),
    ...(upd.progress && !finished ? { progress: upd.progress } : {}),
    ...(upd.output ? { output: upd.output } : {}),
    status,
    ...(status !== 'running' && !current.completedAt ? { completedAt: base.now } : {})
  };
}
