/**
 * Вид шага агента в ленте Agents Studio (TASK-271) — чистые функции без React.
 *
 * Инструменты приходят под двумя наборами имён: Claude Code CLI (`Bash`, `Edit`, `Write`, `Read`, `Grep`,
 * `Glob`, `Task`/`Agent`, `WebFetch`, `TodoWrite`, `mcp__сервер__инструмент`) и API-путь Studio
 * (`run_command`, `write_file`, `read_file`, `list_dir`, `search_rag`). Вид задаёт иконку и подпись шага,
 * краткая цель — то, что CLI пишет в скобках после имени инструмента.
 */
import type { AgentUsage, AIToolCall } from '../types/electron';
import { agentInputTokens, formatTokens, formatUsd } from '../utils/swarmFormat';

export type AgentToolKind =
  | 'shell'
  | 'edit'
  | 'write'
  | 'read'
  | 'search'
  | 'list'
  | 'agent'
  | 'web'
  | 'todo'
  | 'plan'
  | 'question'
  | 'mcp'
  | 'other';

const KIND_BY_NAME: Record<string, AgentToolKind> = {
  // Claude Code CLI
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  KillBash: 'shell',
  PowerShell: 'shell',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'list',
  Task: 'agent',
  Agent: 'agent',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
  TodoRead: 'todo',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'question',
  // API-путь Agents Studio
  run_command: 'shell',
  bash: 'shell',
  write_file: 'write',
  edit_file: 'edit',
  read_file: 'read',
  list_dir: 'list',
  search_rag: 'search',
  ask_question: 'question'
};

export function toolKind(name: string): AgentToolKind {
  if (Object.prototype.hasOwnProperty.call(KIND_BY_NAME, name)) return KIND_BY_NAME[name];
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Имя шага: инструменты MCP — «сервер · инструмент», как в CLI, без префикса `mcp__`. */
export function toolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return rest || name;
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}

const SUBJECT_MAX = 160;

function str(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function oneLine(value: string): string {
  const line = value.trim().split(/\r?\n/, 1)[0];
  const more = line.length < value.trim().length;
  if (line.length > SUBJECT_MAX) return `${line.slice(0, SUBJECT_MAX - 1)}…`;
  return more ? `${line} …` : line;
}

/** Краткая цель шага: команда, путь, шаблон поиска, адрес, описание подагента. */
export function toolSubject(name: string, args: Record<string, unknown> | undefined): string | undefined {
  let subject: string | undefined;
  switch (toolKind(name)) {
    case 'shell':
      subject = str(args, 'command', 'bash_id', 'shell_id');
      break;
    case 'edit':
    case 'write':
    case 'read':
      subject = str(args, 'file_path', 'filePath', 'notebook_path', 'path');
      break;
    case 'search': {
      const pattern = str(args, 'pattern', 'query');
      const where = str(args, 'path', 'glob');
      subject = pattern && where ? `${pattern} · ${where}` : pattern;
      break;
    }
    case 'list':
      subject = str(args, 'path', 'dirPath', 'dir');
      break;
    case 'agent': {
      const description = str(args, 'description');
      const type = str(args, 'subagent_type');
      subject = description && type ? `${type}: ${description}` : description ?? type;
      break;
    }
    case 'web':
      subject = str(args, 'url', 'query');
      break;
    default:
      subject = undefined;
  }
  return subject ? oneLine(subject) : undefined;
}

export interface GroupedSteps {
  /** Шаги основного агента в порядке вызова. */
  top: AIToolCall[];
  /** Шаги подагента по id его вызова `Agent`/`Task` (TASK-272). */
  children: Record<string, AIToolCall[]>;
}

/** Шаги подагентов — внутрь шага их вызова; шаг с неизвестным родителем остаётся сверху, чтобы не пропасть. */
export function groupSubagentSteps(toolCalls: AIToolCall[] | undefined): GroupedSteps {
  const list = toolCalls ?? [];
  const ids = new Set(list.map((tc) => tc.id));
  const top: AIToolCall[] = [];
  const children: Record<string, AIToolCall[]> = {};
  for (const tc of list) {
    if (tc.parentId && tc.parentId !== tc.id && ids.has(tc.parentId)) {
      (children[tc.parentId] ??= []).push(tc);
    } else {
      top.push(tc);
    }
  }
  return { top, children };
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Форма «в процессе» («Running tests»), которую CLI показывает у текущего пункта. */
  activeForm?: string;
}

const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/** Пункты плана из аргументов `TodoWrite`; `null`, если аргументы не похожи на план. */
export function parseTodos(args: Record<string, unknown> | undefined): TodoItem[] | null {
  const raw = args?.todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const entry of raw as unknown[]) {
    const e = entry as { content?: unknown; status?: unknown; activeForm?: unknown } | null;
    if (!e || typeof e.content !== 'string' || !e.content.trim()) continue;
    const status = TODO_STATUSES.includes(e.status as TodoStatus) ? (e.status as TodoStatus) : 'pending';
    items.push({
      content: e.content.trim(),
      status,
      ...(typeof e.activeForm === 'string' && e.activeForm.trim() ? { activeForm: e.activeForm.trim() } : {})
    });
  }
  return items;
}

/** Текущий план ответа: каждый `TodoWrite` заменяет список целиком, значит действует последний. */
export function latestTodos(toolCalls: AIToolCall[] | undefined): TodoItem[] | null {
  if (!toolCalls) return null;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i];
    // План подагента — его собственный, не план ответа (TASK-272).
    if (tc.name !== 'TodoWrite' || tc.parentId) continue;
    const todos = parseTodos(tc.args);
    if (todos) return todos;
  }
  return null;
}

export function todoProgress(items: TodoItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.status === 'completed').length, total: items.length };
}

export interface TurnUsageView {
  /** Вход с кэшем — как в сводке Swarm. */
  input: string;
  output: string;
  /** `undefined`, если стоимость неизвестна (модели нет в таблице цен или токены оценены). */
  cost?: string;
  estimated: boolean;
}

/** Строка расхода хода под ответом; `null`, если показывать нечего. */
export function turnUsageView(usage: AgentUsage | undefined): TurnUsageView | null {
  if (!usage) return null;
  const hasCost = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd);
  if (!(usage.totalTokens > 0) && !hasCost) return null;
  return {
    // Сохранённые до TASK-56 сообщения могли прийти без полей кэша.
    input: formatTokens(agentInputTokens({ ...usage, cacheReadTokens: usage.cacheReadTokens || 0, cacheCreationTokens: usage.cacheCreationTokens || 0 })),
    output: formatTokens(usage.outputTokens || 0),
    ...(hasCost ? { cost: formatUsd(usage.costUsd) } : {}),
    estimated: Boolean(usage.estimated)
  };
}
