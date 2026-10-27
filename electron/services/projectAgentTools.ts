/**
 * Инструменты задач и документов проекта для агентов во встроенном MCP ProjectHub
 * (decision-78, п. 12; TASK-136.6). Агенту проекта с основой не нужен ни Node, ни
 * `npx backlog.md`: задачи, документы, решения и поиск по документации идут через ProjectHub.
 *
 * Запись — только в зарегистрированный проект (инвариант 2 decision-5): путь сессии приводится к
 * корню проекта через реестр, файлы — только внутри `backlog/`. Реестр, аудит и поиск внедряются,
 * поэтому модуль тестируется без Electron; боевые зависимости — в `projectAgentToolDeps.ts`.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import { findOwningProject, assertInsideProject } from './pathGuard.js';
import { createBacklogTaskFile } from './backlogTaskCreate.js';
import { findTaskFile } from './taskFileLookup.js';
import {
  applyCriteria,
  applyDescription,
  applyFinalSummary,
  applyImplementationNote,
  normalizeFrontmatter,
  parseTaskBody,
  taskNumberFromName,
  withUpdatedDate
} from './backlogTaskFormat.js';
import { parseBacklogConfig } from './backlogConfigService.js';
import { matchStatus } from '../../src/utils/taskStatus.js';
import { createProjectDoc, listProjectDocs } from './docsService.js';
import {
  agentReporter,
  assigneeList,
  canAgentChangeAssignee,
  countAgentTasksLastDay,
  decideTaskCreate,
  isAwaitingApproval,
  preserveApprovalLabel,
  resolveTaskCreateMode,
  withApprovalLabel,
  type AgentTaskLimits
} from './agentTaskPolicy.js';
import type { HitlEngine, HitlOrigin, HitlRequest, HitlTextLine, RolePermissions } from './hitlTypes.js';
import { keyedHitlText } from './hitlText.js';
import type { AgentTaskCreatedInfo } from './agentTaskNotify.js';
import type { RagSearchResult } from '../../src/types/electron';
import { createDocInBranch, readDocInBranch, updateDocInBranch, type DocBranchEnv } from './docBranches.js';
import { callDocBranchTool, isDocBranchToolName, listBranchDocs, type DocBranchChange } from './docBranchTools.js';
import { keepFrontmatterFormatting } from './docSectionMerge.js';
import { editionRegistry } from '../extensions/editionRegistry.js';

export const PROJECT_TOOL_NAMES = [
  'task_list',
  'task_view',
  'task_create',
  'task_update',
  'doc_list',
  'doc_view',
  'doc_create',
  'doc_update',
  'docs_search',
  'doc_branch_open',
  'doc_branch_list',
  'doc_branch_diff',
  'doc_branch_resolve',
  'doc_branch_propose',
  'doc_branch_merge',
  'doc_branch_close'
] as const;
export type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];

export function isProjectToolName(name: string): name is ProjectToolName {
  return (PROJECT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Инструмент модуля редакции (decision-153): встроенный с тем же именем важнее. */
function editionTool(name: string) {
  return isProjectToolName(name) ? undefined : editionRegistry.agentTool(name);
}

/** Встроенный инструмент проекта или инструмент модуля редакции: проверки и аудит — внутри `callProjectTool`. */
export function isAgentProjectTool(name: string): boolean {
  return isProjectToolName(name) || Boolean(editionTool(name));
}

/** Правило в аудите для записей задач и документов. */
export const PROJECT_TOOLS_AUDIT_RULE = 'project-tools';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
const numList = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

export const PROJECT_TOOL_DEFINITIONS: ReadonlyArray<{ name: ProjectToolName; description: string; input_schema: Record<string, unknown> }> = [
  {
    name: 'task_list',
    description: 'Lists the project tasks (backlog/tasks): id, status, title, labels. Before starting new work, check whether a task for it already exists.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Only tasks with this status' },
        query: { type: 'string', description: 'Words to search for in the title, description and labels' },
        limit: { type: 'number', description: 'How many tasks to return (default 50)' }
      }
    }
  },
  {
    name: 'task_view',
    description: 'The whole task: frontmatter, description, acceptance criteria, notes and final summary.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Task id, for example TASK-12 or TASK-12.3' } }, required: ['id'] }
  },
  {
    name: 'task_create',
    description:
      'Creates a Backlog.md task (status To Do). The description is Markdown with short ### sections (Why, Goal, Constraints). '
      + 'Keep the title short and put details in the description. A task created by an agent gets the agent-created label and waits '
      + 'for human approval: auto-start does not pick it up until a human approves it. Tasks are limited per session and per day.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'Description in Markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority' },
        type: { type: 'string', description: 'Type: feature, bug, task, docs, chore…' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Verifiable acceptance criteria' },
        parentTaskId: { type: 'string', description: 'Parent task id: a subtask TASK-N.M is created under it' },
        milestone: { type: 'string', description: 'Milestone' },
        assignee: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assignees: a person or agent:<role>@<host>. Set only when asked to'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'task_update',
    description:
      'Updates a task: status (To Do → In Progress → Review → Done; finished work goes to Review), title, description, '
      + 'labels, criteria (add, check), a progress note, the final summary.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id' },
        status: { type: 'string', description: 'New status from the project config.yml' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'The whole new description' },
        labels: { type: 'array', items: { type: 'string' }, description: 'The full label list (only a human removes the agent-created label)' },
        assignee: {
          type: 'array',
          items: { type: 'string' },
          description: 'The full assignee list. Only a human can assign an agent to an approved task'
        },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        addCriteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria to add' },
        checkCriteria: { type: 'array', items: { type: 'number' }, description: 'Mark the criteria with these numbers as done (1-based)' },
        uncheckCriteria: { type: 'array', items: { type: 'number' }, description: 'Uncheck the criteria with these numbers' },
        appendNotes: { type: 'string', description: 'Note to append to Implementation Notes' },
        finalSummary: { type: 'string', description: 'The whole Final Summary of the work' }
      },
      required: ['id']
    }
  },
  {
    name: 'doc_list',
    description: 'Project documents (backlog/docs) and decisions (backlog/decisions): id, title, section, status.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['doc', 'decision', 'all'], description: 'What to list (default all)' },
        section: { type: 'string', description: 'Only this section (and its subsections), for example "Architecture"' },
        branch: { type: 'string', description: 'Documentation branch (db-N): only documents changed in it' }
      }
    }
  },
  {
    name: 'doc_view',
    description: 'The whole document or decision by id (doc-N, decision-N). With branch, the version from that documentation branch.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'doc-N or decision-N' },
        branch: { type: 'string', description: 'Documentation branch (db-N)' }
      },
      required: ['id']
    }
  },
  {
    name: 'doc_create',
    description:
      'Creates a document (kind: doc) or an architecture decision record, ADR (kind: decision), in Backlog.md format. '
      + 'A section is required: look at the existing ones with doc_list and pick a fitting one. '
      + 'A decision has the sections ## Context, ## Decision, ## Consequences. Links: [[decision-N]], [[doc-N]], [[TASK-N]].',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['doc', 'decision'] },
        title: { type: 'string', description: 'Title' },
        section: { type: 'string', description: 'Section of the documentation tree, levels separated by /, for example "Architecture/Agents"' },
        content: { type: 'string', description: 'Markdown text (without frontmatter)' },
        docType: { type: 'string', enum: ['guide', 'readme', 'specification', 'other'], description: 'Document type (for kind: doc)' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'deprecated'], description: 'Decision status (for kind: decision)' },
        tags: { type: 'array', items: { type: 'string' } },
        branch: { type: 'string', description: 'Documentation branch (db-N): create the document there instead of the main documentation' }
      },
      required: ['kind', 'title', 'section']
    }
  },
  {
    name: 'doc_update',
    description:
      'Updates a document or decision by id. The section, id and other frontmatter fields are kept unless you change them explicitly. '
      + 'With branch, the edit goes to that documentation branch and reaches the main documentation only after it is accepted.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'doc-N or decision-N' },
        content: { type: 'string', description: 'The whole new text (without frontmatter)' },
        title: { type: 'string' },
        section: { type: 'string' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'deprecated'] },
        tags: { type: 'array', items: { type: 'string' } },
        branch: { type: 'string', description: 'Documentation branch (db-N)' }
      },
      required: ['id']
    }
  },
  {
    name: 'docs_search',
    description: 'Searches the project documentation, decisions, tasks and memory. Call it before answering how the project works.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query' },
        limit: { type: 'number', description: 'How many results (1–20, default 8)' }
      },
      required: ['query']
    }
  },
  {
    name: 'doc_branch_open',
    description:
      'Opens a documentation branch (decision-151): your own copy of the documents and decisions that other agents do not see until it '
      + 'is accepted. Edit it with doc_create/doc_update and branch. Open one when you change existing documents in parallel '
      + 'with other agents or want to show an edit to a human before it is accepted. The working tree and worktrees are not changed.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What changes in the documentation, briefly' },
        task: { type: 'string', description: 'The task this edit is for (TASK-N)' }
      },
      required: ['title']
    }
  },
  {
    name: 'doc_branch_list',
    description: 'Open and proposed documentation branches of the project: id, status, author, number of changed documents.',
    input_schema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include merged and closed branches' } } }
  },
  {
    name: 'doc_branch_diff',
    description:
      'What the branch changes compared with the main documentation: documents, changed sections and fields, conflicts with edits in the main documentation '
      + '(a section changed differently on both sides).',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'db-N' },
        full: { type: 'boolean', description: 'Also show the text of the sections changed in the branch' }
      },
      required: ['branch']
    }
  },
  {
    name: 'doc_branch_resolve',
    description:
      'Brings the current main documentation into the branch (like sync_base_branch). Different sections merge on their own; if one section changed '
      + 'differently, a conflict comes back with the section key and three versions. Call again with resolutions: for each key, '
      + 'take: ours (main), theirs (branch), both (one after the other) or text (your own section text, including its heading).',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'db-N' },
        resolutions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              doc: { type: 'string', description: 'Document id (doc-N, decision-N)' },
              key: { type: 'string', description: 'Part key from the conflict' },
              take: { type: 'string', enum: ['ours', 'theirs', 'both', 'text'] },
              text: { type: 'string', description: 'Part text for take: text' }
            },
            required: ['doc', 'key', 'take']
          }
        }
      },
      required: ['branch']
    }
  },
  {
    name: 'doc_branch_propose',
    description:
      'Proposes merging the branch: a human (or a role allowed to merge) sees the diff in ProjectHub and on the phone and accepts it '
      + 'as a whole or document by document. Describe what changed and why.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'db-N' },
        message: { type: 'string', description: 'What changed and why' }
      },
      required: ['branch']
    }
  },
  {
    name: 'doc_branch_merge',
    description:
      'Merges the branch into the main documentation: as a whole or only docs. Role permission permissions.docMerge: allow merges at once, '
      + 'ask (default) sends a card to a human, deny refuses. On a conflict without resolutions nothing is written.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'db-N' },
        docs: { type: 'array', items: { type: 'string' }, description: 'Only these documents (ids)' },
        resolutions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              doc: { type: 'string' },
              key: { type: 'string' },
              take: { type: 'string', enum: ['ours', 'theirs', 'both', 'text'] },
              text: { type: 'string' }
            },
            required: ['doc', 'key', 'take']
          }
        }
      },
      required: ['branch']
    }
  },
  {
    name: 'doc_branch_close',
    description: 'Closes the documentation branch without merging (its edits are discarded).',
    input_schema: { type: 'object', properties: { branch: { type: 'string', description: 'db-N' } }, required: ['branch'] }
  }
];

export interface ProjectToolContext {
  /** Путь сессии: корень проекта или worktree агента внутри него. */
  sessionPath: string;
  sessionId: string;
  origin: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  /** Slug роли: автор задачи `agent:<slug>` (`role` у агентов Swarm — отображаемое имя). */
  roleSlug?: string;
  /** Права роли сессии: `taskCreate` задаёт режим заведения задач (decision-89). */
  permissions?: RolePermissions;
  /** Участник команды, чей агент вызывает инструмент по сети (TASK-195): ему и адресуется HITL, он же — в аудите. */
  memberId?: string;
}

export interface ProjectToolDeps {
  listProjectRoots(): Promise<string[]>;
  recordAutoDecision(info: Omit<HitlRequest, 'id' | 'createdAt'>, decision: 'allow' | 'deny', rule: string, detail?: string): string;
  searchDocs(projectRoot: string, query: string, limit: number): Promise<RagSearchResult[]>;
  /**
   * Карточка HITL для режима `ask` (decision-89): `true` — человек одобрил. Без зависимости режим `ask`
   * отказывает — спросить некого.
   */
  requestApproval?(request: Omit<HitlRequest, 'id' | 'createdAt'>): Promise<boolean>;
  /** Задача создана и ждёт подтверждения человека: уведомить его по матрице каналов (decision-89). */
  onAgentTaskPending?(info: AgentTaskCreatedInfo): void;
  /** Лимиты из настройки (TASK-155); без зависимости — `AGENT_TASK_LIMITS`. */
  getAgentTaskLimits?(): Promise<AgentTaskLimits>;
  /** git и время для веток документации (decision-151); в тестах — свой каталог временных файлов. */
  docBranchEnv?: DocBranchEnv;
  /** Ветка документации изменилась: обновить окно документации и телефон. */
  onDocBranchChanged?(info: DocBranchChange): void;
  now?(): number;
}

/** Сколько задач завела каждая сессия: лимит `AGENT_TASK_LIMITS.perSession` (decision-89). */
const sessionTaskCounts = new Map<string, number>();

/** Для тестов: сбросить счётчики задач сессий. */
export function resetAgentTaskCounters(): void {
  sessionTaskCounts.clear();
}

export interface ProjectToolResult {
  text: string;
  isError: boolean;
}

const fmString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return String(value);
};

function parseFile(raw: string) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const parsed = matter(raw.replace(/\r\n/g, '\n'));
  return { eol, data: { ...parsed.data } as Record<string, unknown>, content: parsed.content };
}

function serializeFile(content: string, data: Record<string, unknown>, eol: string): string {
  const text = matter.stringify(content, normalizeFrontmatter(data));
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

function taskIdOf(data: Record<string, unknown>, file: string): string {
  const fromFm = fmString(data.id);
  if (fromFm) return fromFm.toUpperCase().replace(/^TASK-/i, 'TASK-');
  const n = taskNumberFromName(path.basename(file, '.md'));
  return n !== null ? `TASK-${n}` : path.basename(file, '.md');
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  labels: string[];
  description: string;
  reporter?: string;
  created?: string;
}

async function readTasks(root: string): Promise<TaskRow[]> {
  const dir = path.join(root, 'backlog', 'tasks');
  if (!existsSync(dir)) return [];
  const rows: TaskRow[] = [];
  for (const file of await fs.readdir(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const { data, content } = parseFile(await fs.readFile(path.join(dir, file), 'utf-8'));
      rows.push({
        id: taskIdOf(data, file),
        title: fmString(data.title) ?? file,
        status: fmString(data.status) ?? 'To Do',
        labels: Array.isArray(data.labels) ? data.labels.map((l) => fmString(l) ?? '').filter(Boolean) : [],
        description: parseTaskBody(content).description,
        reporter: fmString(data.reporter),
        created: fmString(data.created_date)
      });
    } catch {
      // битый файл задачи не должен прятать остальные
    }
  }
  const num = (id: string) => (id.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  return rows.sort((a, b) => {
    const [x, y] = [num(a.id), num(b.id)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
    return 0;
  });
}

async function projectStatuses(root: string): Promise<string[]> {
  try {
    return parseBacklogConfig(await fs.readFile(path.join(root, 'backlog', 'config.yml'), 'utf-8')).statuses;
  } catch {
    return parseBacklogConfig(null).statuses;
  }
}

async function findDoc(root: string, id: string) {
  const wanted = id.trim().toLowerCase();
  return (await listProjectDocs(root)).find((doc) => doc.id.toLowerCase() === wanted) ?? null;
}

/** Правка документа аргументами `doc_update` — одна и та же в основной и в ветке документации. */
function applyDocUpdate(raw: string, args: Record<string, unknown>, isDecision: boolean): { text: string; changes: string[] } {
  const { eol, data, content } = parseFile(raw);
  const changes: string[] = [];
  if (str(args.title).trim()) {
    data.title = str(args.title).trim();
    changes.push('title');
  }
  if (str(args.section).trim()) {
    data.section = str(args.section).trim();
    changes.push('section');
  }
  if (str(args.status).trim() && isDecision) {
    data.status = str(args.status).trim();
    changes.push('status');
  }
  if (args.tags !== undefined) {
    data.tags = strList(args.tags);
    changes.push('tags');
  }
  let body = content;
  if (args.content !== undefined) {
    body = `\n${str(args.content).replace(/^\s*---[\s\S]*?---\s*/, '').trim()}\n`;
    changes.push('text');
  }
  if (changes.length === 0) return { text: raw, changes };
  // Даты и прочие значения frontmatter — строками (правило 16), раздел и id — как были.
  for (const key of Object.keys(data)) if (data[key] instanceof Date) data[key] = fmString(data[key]);
  // Неизменённые поля — строками исходного файла: иначе сериализатор переписывает кавычки всего frontmatter.
  return { text: keepFrontmatterFormatting(raw, serializeFile(body, data, eol)), changes };
}

/** Корень зарегистрированного проекта, внутри которого лежит путь сессии; иначе null. */
export async function resolveProjectToolRoot(sessionPath: string, deps: Pick<ProjectToolDeps, 'listProjectRoots'>): Promise<string | null> {
  if (typeof sessionPath !== 'string' || !sessionPath.trim()) return null;
  return findOwningProject(await deps.listProjectRoots(), sessionPath);
}

const WRITE_TOOLS = new Set<ProjectToolName>([
  'task_create',
  'task_update',
  'doc_create',
  'doc_update',
  'doc_branch_open',
  'doc_branch_resolve',
  'doc_branch_propose',
  'doc_branch_merge',
  'doc_branch_close'
]);

/** Описания инструментов для MCP: встроенные и модулей редакции, без перекрытия имён. */
export function projectToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  const extra = editionRegistry
    .agentTools()
    .filter((t) => !isProjectToolName(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  return [...PROJECT_TOOL_DEFINITIONS, ...extra];
}

/** Выполняет инструмент. Ошибки не бросает — возвращает текст для модели с `isError`. */
export async function callProjectTool(name: string, args: Record<string, unknown>, ctx: ProjectToolContext, deps: ProjectToolDeps): Promise<ProjectToolResult> {
  const extra = editionTool(name);
  if (!isProjectToolName(name) && !extra) return { text: `Unknown tool: ${name}`, isError: true };
  const root = await resolveProjectToolRoot(ctx.sessionPath, deps);
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
      PROJECT_TOOLS_AUDIT_RULE,
      detail
    );

  const writes = extra ? extra.write : WRITE_TOOLS.has(name as ProjectToolName);
  if (!root) {
    if (writes) audit('deny', `${name}: invalid_project`, undefined, 'invalid_project');
    return { text: 'Project unavailable: the session path does not belong to a project registered in ProjectHub.', isError: true };
  }

  if (extra) {
    try {
      return await extra.handler(args, { root, ctx, audit, ...(deps.requestApproval ? { requestApproval: deps.requestApproval } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (writes) audit('deny', `${name}: error`, undefined, message);
      return { text: `Error: ${message}`, isError: true };
    }
  }
  if (!isProjectToolName(name)) return { text: `Unknown tool: ${name}`, isError: true };

  try {
    if (isDocBranchToolName(name)) return await callDocBranchTool(name, args, { root, ctx, deps, audit });
    switch (name) {
      case 'task_list': {
        const status = str(args.status).trim().toLowerCase();
        const query = str(args.query).trim().toLowerCase();
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 50;
        const rows = (await readTasks(root))
          .filter((t) => !status || t.status.toLowerCase() === status)
          .filter((t) => !query || `${t.title}\n${t.description}\n${t.labels.join(' ')}`.toLowerCase().includes(query));
        if (rows.length === 0) return { text: 'No tasks found.', isError: false };
        const lines = rows.slice(0, limit).map((t) => `${t.id} [${t.status}] ${t.title}${t.labels.length ? ` (${t.labels.join(', ')})` : ''}`);
        if (rows.length > limit) lines.push(`… and ${rows.length - limit} more`);
        return { text: lines.join('\n'), isError: false };
      }

      case 'task_view': {
        const match = await findTaskFile(root, str(args.id));
        if (!match) return { text: `Task ${str(args.id)} not found.`, isError: true };
        return { text: await fs.readFile(match.filePath, 'utf-8'), isError: false };
      }

      case 'task_create': {
        const title = str(args.title).trim();
        if (!title) return { text: 'Missing title.', isError: true };
        const assignee = assigneeList(args.assignee);
        const labels = strList(args.labels);

        // Политика заведения задач агентами (decision-89): режим роли, лимиты, подтверждение человеком.
        const sessionKey = `${root}\n${ctx.sessionId}`;
        const decision = decideTaskCreate({
          mode: resolveTaskCreateMode(ctx),
          sessionCount: sessionTaskCounts.get(sessionKey) ?? 0,
          dayCount: countAgentTasksLastDay(await readTasks(root), deps.now?.() ?? Date.now()),
          ...(deps.getAgentTaskLimits ? { limits: await deps.getAgentTaskLimits() } : {})
        });
        if (decision.action === 'deny') {
          audit('deny', `task_create: ${title}`, undefined, decision.reason);
          return { text: decision.message, isError: true };
        }
        let approvedByHuman = false;
        if (decision.action === 'ask') {
          const body = [str(args.description).trim(), ...strList(args.acceptanceCriteria).map((c) => `- [ ] ${c}`)].filter(Boolean).join('\n');
          const lines: HitlTextLine[] = [
            { code: 'taskTitle', params: { title } },
            ...(assignee.length ? [{ code: 'taskAssignee', params: { list: assignee.join(', ') } }] : []),
            ...(labels.length ? [{ code: 'taskLabels', params: { list: labels.join(', ') } }] : []),
            ...(body ? [{ code: 'text', params: { text: `\n${body}` } }] : [])
          ];
          const approved = deps.requestApproval
            ? await deps
                .requestApproval({
                  sessionId: ctx.sessionId,
                  projectPath: root,
                  type: 'file_write',
                  ...keyedHitlText({ code: 'task_create', target: title, lines }),
                  origin: ctx.origin,
                  engine: ctx.engine,
                  ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
                  ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
                  ...(ctx.memberId ? { memberId: ctx.memberId } : {}),
                  ...(ctx.role ? { role: ctx.role } : {}),
                  tool: name
                })
                .catch(() => false)
            : false;
          if (!approved) {
            if (!deps.requestApproval) audit('deny', `task_create: ${title}`, undefined, 'no-approver');
            return { text: 'The human did not approve the task, so it was not created. Describe it in your reply if it is still needed.', isError: true };
          }
          approvedByHuman = true;
        }

        const created = await createBacklogTaskFile(root, {
          title,
          description: str(args.description),
          // Одобренная в карточке задача уже подтверждена: человек видел её целиком.
          labels: approvedByHuman ? labels : withApprovalLabel(labels),
          reporter: agentReporter(ctx),
          ...(assignee.length ? { assignee } : {}),
          ...(str(args.priority) ? { priority: str(args.priority) } : {}),
          ...(str(args.type) ? { type: str(args.type) } : {}),
          ...(str(args.milestone) ? { milestone: str(args.milestone) } : {}),
          ...(str(args.parentTaskId) ? { parentTaskId: str(args.parentTaskId) } : {}),
          acceptanceCriteria: strList(args.acceptanceCriteria)
        });
        if (!created) return { text: 'Could not create the task (details are in the ProjectHub log).', isError: true };
        sessionTaskCounts.set(sessionKey, (sessionTaskCounts.get(sessionKey) ?? 0) + 1);
        const rel = path.relative(root, created.filePath).split(path.sep).join('/');
        const pending = isAwaitingApproval(created.labels);
        // В режиме ask решение человека уже записал сам HITL; здесь — авто-решение политики.
        if (!approvedByHuman) audit('allow', `task_create: ${created.id}`, rel, pending ? 'awaiting-approval' : undefined);
        if (pending) {
          deps.onAgentTaskPending?.({ projectPath: root, sessionId: ctx.sessionId, reporter: agentReporter(ctx), id: created.id, title: created.title });
        }
        return {
          text: pending
            ? `Created: ${created.id} "${created.title}" (${rel}). The task is awaiting human approval (label agent-created): `
              + 'auto-start will not pick it up until it is approved.'
            : `Created: ${created.id} "${created.title}" (${rel}), approved by a human.`,
          isError: false
        };
      }

      case 'task_update': {
        const match = await findTaskFile(root, str(args.id));
        if (!match) return { text: `Task ${str(args.id)} not found.`, isError: true };
        const filePath = assertInsideProject(path.join(root, 'backlog'), match.filePath);
        const { eol, data, content } = parseFile(await fs.readFile(filePath, 'utf-8'));
        const changes: string[] = [];

        if (str(args.status).trim()) {
          const statuses = await projectStatuses(root);
          const status = matchStatus(statuses, str(args.status).trim());
          if (!status) return { text: `Status "${str(args.status)}" is not in the project config.yml. Allowed: ${statuses.join(', ')}.`, isError: true };
          data.status = status;
          changes.push(`status → ${status}`);
        }
        if (str(args.title).trim()) {
          data.title = str(args.title).trim();
          changes.push('title');
        }
        const previousLabels = Array.isArray(data.labels) ? data.labels.map((l) => fmString(l) ?? '').filter(Boolean) : [];
        if (args.labels !== undefined) {
          // Метку agent-created снимает только человек (decision-89).
          data.labels = preserveApprovalLabel(previousLabels, strList(args.labels));
          changes.push('labels');
        }
        if (args.assignee !== undefined) {
          const previous = Array.isArray(data.assignee) ? data.assignee.map((a) => fmString(a) ?? '').filter(Boolean) : assigneeList(fmString(data.assignee));
          const next = assigneeList(args.assignee);
          const labelsNow = Array.isArray(data.labels) ? (data.labels as unknown[]).map((l) => fmString(l) ?? '') : previousLabels;
          if (!canAgentChangeAssignee({ labels: labelsNow, previous, next })) {
            audit('deny', `task_update: ${taskIdOf(data, filePath)}`, undefined, 'agent-assignee-on-approved-task');
            return {
              text: 'Only a human can assign an agent to an approved task (decision-89). '
                + 'Create a new task with this assignee (it will wait for approval) or ask a human.',
              isError: true
            };
          }
          data.assignee = next;
          changes.push('assignee');
        }
        if (str(args.priority).trim()) {
          data.priority = str(args.priority).trim().toLowerCase();
          changes.push('priority');
        }

        let body = content;
        if (args.description !== undefined) {
          body = applyDescription(body, str(args.description));
          changes.push('description');
        }
        const add = strList(args.addCriteria);
        const check = numList(args.checkCriteria);
        const uncheck = numList(args.uncheckCriteria);
        if (add.length || check.length || uncheck.length) {
          const criteria = parseTaskBody(body).criteria.map((c) => ({ ...c }));
          for (const n of check) if (criteria[n - 1]) criteria[n - 1].completed = true;
          for (const n of uncheck) if (criteria[n - 1]) criteria[n - 1].completed = false;
          for (const text of add) criteria.push({ text, completed: false });
          body = applyCriteria(body, criteria);
          changes.push('criteria');
        }
        if (str(args.appendNotes).trim()) {
          body = applyImplementationNote(body, str(args.appendNotes).trim());
          changes.push('note');
        }
        if (str(args.finalSummary).trim()) {
          body = applyFinalSummary(body, str(args.finalSummary).trim());
          changes.push('final summary');
        }
        if (changes.length === 0) return { text: 'Nothing to change: no fields were passed.', isError: true };

        await fs.writeFile(filePath, serializeFile(body, withUpdatedDate(data), eol), 'utf-8');
        const id = taskIdOf(data, filePath);
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        audit('allow', `task_update: ${id}`, rel, changes.join(', '));
        return { text: `Updated: ${id} (${changes.join(', ')}).`, isError: false };
      }

      case 'doc_list': {
        const kind = str(args.kind) || 'all';
        const section = str(args.section).trim().toLowerCase();
        if (str(args.branch).trim()) return await listBranchDocs(root, str(args.branch), deps.docBranchEnv);
        const docs = (await listProjectDocs(root))
          .filter((d) => kind === 'all' || d.category === kind)
          .filter((d) => !section || (d.section ?? '').toLowerCase().startsWith(section));
        if (docs.length === 0) return { text: 'No documents found.', isError: false };
        return {
          text: docs.map((d) => `${d.id} — ${d.title}${d.section ? ` [${d.section}]` : ''}${d.status ? ` (${d.status})` : ''}`).join('\n'),
          isError: false
        };
      }

      case 'doc_view': {
        if (str(args.branch).trim()) {
          const inBranch = await readDocInBranch(root, str(args.branch), str(args.id), deps.docBranchEnv);
          if (!inBranch) return { text: `Document ${str(args.id)} is not in branch ${str(args.branch)}.`, isError: true };
          return { text: inBranch.content, isError: false };
        }
        const doc = await findDoc(root, str(args.id));
        if (!doc) return { text: `Document ${str(args.id)} not found.`, isError: true };
        return { text: await fs.readFile(doc.filePath, 'utf-8'), isError: false };
      }

      case 'doc_create': {
        const kind = str(args.kind) === 'decision' ? 'decision' : 'doc';
        const title = str(args.title).trim();
        const section = str(args.section).trim();
        if (!title) return { text: 'Missing title.', isError: true };
        if (!section) return { text: 'Missing section: look at the existing ones with doc_list.', isError: true };
        const docType = str(args.docType);
        const params = {
          type: kind,
          title,
          section,
          content: str(args.content) || undefined,
          tags: strList(args.tags),
          ...(kind === 'decision' && str(args.status) ? { status: str(args.status) as 'proposed' } : {}),
          ...(kind === 'doc' && docType ? { docType: docType as 'guide' } : {})
        } as const;
        const branch = str(args.branch).trim();
        if (branch) {
          const inBranch = await createDocInBranch(root, branch, params, deps.docBranchEnv);
          audit('allow', `doc_create: ${inBranch.docId} in ${branch}`, inBranch.path, `branch ${branch}`);
          deps.onDocBranchChanged?.({ projectPath: root, branchId: branch, event: 'updated' });
          return {
            text: `Created in branch ${branch}: ${inBranch.docId} "${inBranch.title}" (${inBranch.path}). `
              + 'The number becomes final once the branch is accepted: if the main documentation takes it first, the branch yields (decision-76).',
            isError: false
          };
        }
        const created = await createProjectDoc(root, params);
        audit('allow', `doc_create: ${created.id}`, created.fileRelative);
        return { text: `Created: ${created.id} "${created.title}" (${created.fileRelative}).`, isError: false };
      }

      case 'doc_update': {
        const branch = str(args.branch).trim();
        if (branch) {
          let changes: string[] = [];
          const updated = await updateDocInBranch(
            root,
            branch,
            str(args.id),
            (raw) => {
              const next = applyDocUpdate(raw, args, /^decision-/i.test(str(args.id).trim()));
              changes = next.changes;
              return next.text;
            },
            deps.docBranchEnv
          );
          if (changes.length === 0) return { text: 'Nothing to change: no fields were passed.', isError: true };
          audit('allow', `doc_update: ${updated.docId} in ${branch}`, updated.path, `branch ${branch}: ${changes.join(', ')}`);
          deps.onDocBranchChanged?.({ projectPath: root, branchId: branch, event: 'updated' });
          return { text: `Updated in branch ${branch}: ${updated.docId} (${changes.join(', ')}).`, isError: false };
        }
        const doc = await findDoc(root, str(args.id));
        if (!doc) return { text: `Document ${str(args.id)} not found.`, isError: true };
        const filePath = assertInsideProject(path.join(root, 'backlog'), doc.filePath);
        const next = applyDocUpdate(await fs.readFile(filePath, 'utf-8'), args, doc.category === 'decision');
        if (next.changes.length === 0) return { text: 'Nothing to change: no fields were passed.', isError: true };
        await fs.writeFile(filePath, next.text, 'utf-8');
        audit('allow', `doc_update: ${doc.id}`, doc.fileRelative, next.changes.join(', '));
        return { text: `Updated: ${doc.id} (${next.changes.join(', ')}).`, isError: false };
      }

      case 'docs_search': {
        const query = str(args.query).trim();
        if (!query) return { text: 'Missing query.', isError: true };
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.floor(limitRaw)) : 8;
        const results = await deps.searchDocs(root, query, limit);
        if (results.length === 0) return { text: 'Nothing found.', isError: false };
        return {
          text: results
            .slice(0, limit)
            .map((r) => `### ${r.fileRelative}${r.heading ? ` — ${r.heading}` : ''} (${r.category}, ${r.type})\n${r.snippet.trim()}`)
            .join('\n\n'),
          isError: false
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WRITE_TOOLS.has(name)) audit('deny', `${name}: error`, undefined, message);
    return { text: `Error: ${message}`, isError: true };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}
