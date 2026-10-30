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
// Режим вкладки и plan mode (TASK-272)
// ---------------------------------------------------------------------------

export type StudioCliMode = 'agent' | 'chat' | 'architect';

/** Аргументы режима вкладки для `claude -p`: architect — plan mode CLI, остальные — режим по умолчанию. */
export function cliModeArgs(mode: StudioCliMode | undefined): string[] {
  return mode === 'architect' ? ['--permission-mode', 'plan'] : [];
}

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
