/**
 * Инструменты памяти проекта для агентов (TASK-76, decision-51 п. 3–4).
 *
 * Одна реализация для всех поверхностей: встроенный MCP-сервер (Claude CLI, внешние MCP-клиенты) и
 * общий исполнитель инструментов API-агента. Здесь — каталог инструментов (описания и JSON-схемы),
 * разбор аргументов, приведение пути сессии (часто worktree агента) к корню зарегистрированного
 * проекта и запись в аудит. Реестр проектов и аудит внедряются, поэтому модуль тестируется без
 * Electron; боевые зависимости собирает `memoryToolDeps.ts`.
 */
import { findOwningProject } from './pathGuard.js';
import { MEMORY_LIMITS, MEMORY_TYPES, type MemoryDraft } from './memoryFormat.js';
import {
  MemoryError,
  deleteMemoryFact,
  searchMemory,
  writeMemoryFact,
  type MemoryEntry
} from './memoryStore.js';
import type { HitlEngine, HitlOrigin, HitlRequest } from './hitlTypes.js';

export const MEMORY_TOOL_PREFIX = 'memory_';
export const MEMORY_TOOL_NAMES = ['memory_write', 'memory_search', 'memory_delete'] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

/** Правило в аудите для записей и удалений памяти. */
export const MEMORY_AUDIT_RULE = 'memory';

const DESCRIPTIONS: Record<MemoryToolName, string> = {
  memory_write:
    'Save a fact to project memory (backlog/memory) so that later sessions and other agents know it. '
    + 'Save what is not obvious: what was tried and why it did not work, environment traps, agreements with the human. '
    + 'Do not save what is already in the code, tasks and ADRs, and never save secrets. '
    + 'If a similar fact exists, the write is rejected with its id: update that fact with replace.',
  memory_search: 'Find facts in project memory by query words (title, description, fact text).',
  memory_delete: 'Delete an outdated or wrong fact from project memory by id (mem-N).'
};

/** Определения в формате Anthropic tools (`input_schema`) — их же получает MCP-сервер как описания. */
export const MEMORY_TOOL_DEFINITIONS: ReadonlyArray<{ name: MemoryToolName; description: string; input_schema: Record<string, unknown> }> = [
  {
    name: 'memory_write',
    description: DESCRIPTIONS.memory_write,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `Short fact title (up to ${MEMORY_LIMITS.title} characters)` },
        description: { type: 'string', description: `One line: what the fact is about and when it is needed (up to ${MEMORY_LIMITS.description} characters)` },
        body: { type: 'string', description: `The fact itself; for project and feedback — lines "Why:" and "How to apply:" (up to ${MEMORY_LIMITS.body} characters)` },
        type: { type: 'string', enum: [...MEMORY_TYPES], description: 'project — about the project and environment, feedback — how to work, reference — where to find things' },
        replace: { type: 'string', description: 'id of the fact (mem-N) to replace entirely' }
      },
      required: ['title', 'description', 'body', 'type']
    }
  },
  {
    name: 'memory_search',
    description: DESCRIPTIONS.memory_search,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for' },
        limit: { type: 'number', description: 'How many facts to return (1–10, default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_delete',
    description: DESCRIPTIONS.memory_delete,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Fact id, for example mem-3' } },
      required: ['id']
    }
  }
];

export function memoryToolDescription(name: MemoryToolName): string {
  return DESCRIPTIONS[name];
}

/** Кто вызывает инструмент: для корня проекта, аудита и поля `author` факта. */
export interface MemoryToolContext {
  /** Путь сессии: корень проекта или worktree агента внутри него. */
  sessionPath: string;
  sessionId: string;
  origin: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  /** Участник команды, чей агент пишет память по сети (TASK-195). */
  memberId?: string;
  /** Задача сессии — пишется в `source` факта. */
  taskId?: string;
}

export interface MemoryToolDeps {
  /** Корни зарегистрированных проектов. */
  listProjectRoots(): Promise<string[]>;
  recordAutoDecision(info: Omit<HitlRequest, 'id' | 'createdAt'>, decision: 'allow' | 'deny', rule: string, detail?: string): string;
}

export interface MemoryToolResult {
  text: string;
  isError: boolean;
}

/** Корень зарегистрированного проекта, внутри которого лежит путь сессии; иначе null. */
export async function resolveMemoryProjectRoot(sessionPath: string, deps: Pick<MemoryToolDeps, 'listProjectRoots'>): Promise<string | null> {
  if (typeof sessionPath !== 'string' || !sessionPath.trim()) return null;
  return findOwningProject(await deps.listProjectRoots(), sessionPath);
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function authorOf(ctx: MemoryToolContext): string | undefined {
  const parts = [ctx.engine, ctx.role || ctx.agentName].filter(Boolean);
  return parts.length > 0 ? parts.join('/').slice(0, MEMORY_LIMITS.author) : undefined;
}

function formatFact(f: MemoryEntry): string {
  return [`### ${f.id}: ${f.title}`, `${f.description} (${f.type}, ${f.updated ?? f.created}${f.source ? `, ${f.source}` : ''})`, '', f.body].join('\n');
}

/** Текст отказа для модели: причина и что делать дальше, без значений секретов. */
export function memoryErrorText(err: MemoryError): string {
  switch (err.code) {
    case 'secret_detected':
      return `Not saved: the fact looks like it contains a secret (${(err.details.secretKinds ?? []).join(', ')}). Remove the value and describe the fact without it.`;
    case 'duplicate':
      return `Not saved: a similar fact already exists — ${err.details.duplicateOf} “${err.details.duplicateTitle}”. Update it: memory_write with replace: "${err.details.duplicateOf}".`;
    case 'invalid_draft':
      return `Not saved: ${(err.details.issues ?? []).map((i) => (i.field ? `${i.field}: ${i.code}` : i.code)).join(', ')}.`;
    case 'not_found':
      return `Fact not found: ${err.message}`;
    case 'invalid_project':
      return 'Memory is unavailable: the session path does not belong to a registered ProjectHub project.';
    default:
      return err.message;
  }
}

/** Выполняет инструмент памяти. Ошибки не бросает — возвращает текст для модели с `isError`. */
export async function callMemoryTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MemoryToolContext,
  deps: MemoryToolDeps
): Promise<MemoryToolResult> {
  if (!isMemoryToolName(name)) return { text: `Unknown memory tool: ${name}`, isError: true };

  const root = await resolveMemoryProjectRoot(ctx.sessionPath, deps);
  const audit = (decision: 'allow' | 'deny', title: string, filePath?: string, detail?: string) =>
    deps.recordAutoDecision(
      {
        sessionId: ctx.sessionId,
        projectPath: root ?? ctx.sessionPath,
        type: 'file_write',
        title,
        origin: ctx.origin,
        engine: ctx.engine,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
        ...(ctx.memberId ? { memberId: ctx.memberId } : {}),
        ...(ctx.role ? { role: ctx.role } : {}),
        tool: name,
        ...(filePath ? { filePath } : {})
      },
      decision,
      MEMORY_AUDIT_RULE,
      detail
    );

  if (!root) {
    if (name !== 'memory_search') audit('deny', `${name}: invalid_project`, undefined, 'invalid_project');
    return { text: memoryErrorText(new MemoryError('invalid_project', 'invalid_project')), isError: true };
  }

  try {
    if (name === 'memory_search') {
      const query = str(args.query).trim();
      if (!query) return { text: 'No query given (query).', isError: true };
      const limitRaw = Number(args.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(10, Math.floor(limitRaw)) : 5;
      const found = await searchMemory(root, query, limit);
      if (found.length === 0) return { text: 'Nothing found in project memory.', isError: false };
      return { text: found.map(formatFact).join('\n\n'), isError: false };
    }

    if (name === 'memory_delete') {
      const id = str(args.id).trim();
      const { relativePath } = await deleteMemoryFact(root, id);
      audit('allow', `memory_delete: ${id.toLowerCase()}`, relativePath);
      return { text: `Deleted: ${id.toLowerCase()} (${relativePath}).`, isError: false };
    }

    const type = str(args.type).trim();
    const draft: MemoryDraft = {
      title: str(args.title),
      description: str(args.description),
      body: str(args.body),
      // Неизвестный тип отклонит проверка черновика с понятным кодом invalid_type
      type: type as MemoryDraft['type'],
      ...(ctx.taskId ? { source: ctx.taskId.toLowerCase() } : { source: 'session' }),
      ...(authorOf(ctx) ? { author: authorOf(ctx) } : {})
    };
    const replace = str(args.replace).trim() || undefined;
    const result = await writeMemoryFact(root, draft, { replace });
    audit('allow', `memory_write: ${result.fact.id}${result.replaced ? ' (updated)' : ''}`, result.relativePath);
    return {
      text: `${result.replaced ? 'Updated' : 'Saved'}: ${result.fact.id} (${result.relativePath}).`,
      isError: false
    };
  } catch (err) {
    if (err instanceof MemoryError) {
      if (name !== 'memory_search') audit('deny', `${name}: ${err.code}`, undefined, err.code);
      return { text: memoryErrorText(err), isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Project memory error: ${message}`, isError: true };
  }
}

/**
 * Инструкция агенту, у которого есть запись в память: одна для всех движков, `toolPrefix` — как
 * инструменты видны движку (`memory_` у API-агента, `mcp__projecthub-hitl__memory_` у Claude CLI).
 */
export function buildMemoryInstructions(toolPrefix = MEMORY_TOOL_PREFIX): string {
  return [
    `Project memory is written with the ${toolPrefix}write tool. Save there non-obvious conclusions that will help in later sessions: `
      + 'what was tried and why it did not work, environment traps, agreements with the human. '
      + `Do not duplicate code, tasks and ADRs, do not save secrets. Before writing you can look for a similar fact with ${toolPrefix}search.`
  ].join('\n');
}
