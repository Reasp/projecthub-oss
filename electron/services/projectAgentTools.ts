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
import type { HitlEngine, HitlOrigin, HitlRequest } from './hitlTypes.js';
import type { RagSearchResult } from '../../src/types/electron';

export const PROJECT_TOOL_NAMES = [
  'task_list',
  'task_view',
  'task_create',
  'task_update',
  'doc_list',
  'doc_view',
  'doc_create',
  'doc_update',
  'docs_search'
] as const;
export type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];

export function isProjectToolName(name: string): name is ProjectToolName {
  return (PROJECT_TOOL_NAMES as readonly string[]).includes(name);
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
    description: 'Список задач проекта (backlog/tasks): id, статус, заголовок, метки. Перед новой работой проверь, нет ли уже задачи под неё.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Только задачи с этим статусом' },
        query: { type: 'string', description: 'Слова для поиска в заголовке, описании и метках' },
        limit: { type: 'number', description: 'Сколько задач вернуть (по умолчанию 50)' }
      }
    }
  },
  {
    name: 'task_view',
    description: 'Задача целиком: frontmatter, описание, критерии приёмки, заметки и итог.',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'id задачи, например TASK-12 или TASK-12.3' } }, required: ['id'] }
  },
  {
    name: 'task_create',
    description:
      'Создать задачу Backlog.md (статус To Do). Описание — Markdown с короткими разделами ### (Почему, Цель, Ограничения). '
      + 'Заголовок короткий: детали — в описание.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Короткий заголовок' },
        description: { type: 'string', description: 'Описание в Markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Метки' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Приоритет' },
        type: { type: 'string', description: 'Тип: feature, bug, task, docs, chore…' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Проверяемые критерии приёмки' },
        parentTaskId: { type: 'string', description: 'id родительской задачи — тогда создаётся подзадача TASK-N.M' },
        milestone: { type: 'string', description: 'Milestone' }
      },
      required: ['title']
    }
  },
  {
    name: 'task_update',
    description:
      'Изменить задачу: статус (To Do → In Progress → Review → Done; законченную работу — в Review), заголовок, описание, '
      + 'метки, критерии (добавить, отметить), заметку хода работы, итог.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id задачи' },
        status: { type: 'string', description: 'Новый статус из config.yml проекта' },
        title: { type: 'string', description: 'Новый заголовок' },
        description: { type: 'string', description: 'Новое описание целиком' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Метки целиком' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        addCriteria: { type: 'array', items: { type: 'string' }, description: 'Добавить критерии приёмки' },
        checkCriteria: { type: 'array', items: { type: 'number' }, description: 'Отметить выполненными критерии с этими номерами (с 1)' },
        uncheckCriteria: { type: 'array', items: { type: 'number' }, description: 'Снять отметку с критериев с этими номерами' },
        appendNotes: { type: 'string', description: 'Дописать заметку в Implementation Notes' },
        finalSummary: { type: 'string', description: 'Итог работы (Final Summary) целиком' }
      },
      required: ['id']
    }
  },
  {
    name: 'doc_list',
    description: 'Документы (backlog/docs) и решения (backlog/decisions) проекта: id, заголовок, раздел, статус.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['doc', 'decision', 'all'], description: 'Что перечислить (по умолчанию all)' },
        section: { type: 'string', description: 'Только раздел (и подразделы), например "Архитектура"' }
      }
    }
  },
  {
    name: 'doc_view',
    description: 'Документ или решение целиком по id (doc-N, decision-N).',
    input_schema: { type: 'object', properties: { id: { type: 'string', description: 'doc-N или decision-N' } }, required: ['id'] }
  },
  {
    name: 'doc_create',
    description:
      'Создать документ (kind: doc) или архитектурное решение ADR (kind: decision) в формате Backlog.md. '
      + 'Раздел обязателен: посмотри существующие через doc_list и выбери подходящий. '
      + 'Решение: разделы ## Context, ## Decision, ## Consequences. Ссылки — [[decision-N]], [[doc-N]], [[TASK-N]].',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['doc', 'decision'] },
        title: { type: 'string', description: 'Заголовок' },
        section: { type: 'string', description: 'Раздел дерева документации через /, например "Архитектура/Агенты"' },
        content: { type: 'string', description: 'Текст в Markdown (без frontmatter)' },
        docType: { type: 'string', enum: ['guide', 'readme', 'specification', 'other'], description: 'Тип документа (для kind: doc)' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'deprecated'], description: 'Статус решения (для kind: decision)' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['kind', 'title', 'section']
    }
  },
  {
    name: 'doc_update',
    description: 'Изменить документ или решение по id. Раздел, id и прочие поля frontmatter сохраняются, если их не менять явно.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'doc-N или decision-N' },
        content: { type: 'string', description: 'Новый текст целиком (без frontmatter)' },
        title: { type: 'string' },
        section: { type: 'string' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'deprecated'] },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['id']
    }
  },
  {
    name: 'docs_search',
    description: 'Поиск по документации, решениям, задачам и памяти проекта. Вызывай перед ответом про устройство проекта.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Запрос на естественном языке' },
        limit: { type: 'number', description: 'Сколько результатов (1–20, по умолчанию 8)' }
      },
      required: ['query']
    }
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
}

export interface ProjectToolDeps {
  listProjectRoots(): Promise<string[]>;
  recordAutoDecision(info: Omit<HitlRequest, 'id' | 'createdAt'>, decision: 'allow' | 'deny', rule: string, detail?: string): string;
  searchDocs(projectRoot: string, query: string, limit: number): Promise<RagSearchResult[]>;
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
        description: parseTaskBody(content).description
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

/** Корень зарегистрированного проекта, внутри которого лежит путь сессии; иначе null. */
export async function resolveProjectToolRoot(sessionPath: string, deps: Pick<ProjectToolDeps, 'listProjectRoots'>): Promise<string | null> {
  if (typeof sessionPath !== 'string' || !sessionPath.trim()) return null;
  return findOwningProject(await deps.listProjectRoots(), sessionPath);
}

const WRITE_TOOLS = new Set<ProjectToolName>(['task_create', 'task_update', 'doc_create', 'doc_update']);

/** Выполняет инструмент. Ошибки не бросает — возвращает текст для модели с `isError`. */
export async function callProjectTool(name: string, args: Record<string, unknown>, ctx: ProjectToolContext, deps: ProjectToolDeps): Promise<ProjectToolResult> {
  if (!isProjectToolName(name)) return { text: `Неизвестный инструмент: ${name}`, isError: true };
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
        ...(ctx.role ? { role: ctx.role } : {}),
        tool: name,
        ...(filePath ? { filePath } : {})
      },
      decision,
      PROJECT_TOOLS_AUDIT_RULE,
      detail
    );

  if (!root) {
    if (WRITE_TOOLS.has(name)) audit('deny', `${name}: invalid_project`, undefined, 'invalid_project');
    return { text: 'Проект недоступен: путь сессии не принадлежит зарегистрированному проекту ProjectHub.', isError: true };
  }

  try {
    switch (name) {
      case 'task_list': {
        const status = str(args.status).trim().toLowerCase();
        const query = str(args.query).trim().toLowerCase();
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 50;
        const rows = (await readTasks(root))
          .filter((t) => !status || t.status.toLowerCase() === status)
          .filter((t) => !query || `${t.title}\n${t.description}\n${t.labels.join(' ')}`.toLowerCase().includes(query));
        if (rows.length === 0) return { text: 'Задач не найдено.', isError: false };
        const lines = rows.slice(0, limit).map((t) => `${t.id} [${t.status}] ${t.title}${t.labels.length ? ` (${t.labels.join(', ')})` : ''}`);
        if (rows.length > limit) lines.push(`… и ещё ${rows.length - limit}`);
        return { text: lines.join('\n'), isError: false };
      }

      case 'task_view': {
        const match = await findTaskFile(root, str(args.id));
        if (!match) return { text: `Задача ${str(args.id)} не найдена.`, isError: true };
        return { text: await fs.readFile(match.filePath, 'utf-8'), isError: false };
      }

      case 'task_create': {
        const title = str(args.title).trim();
        if (!title) return { text: 'Не указан заголовок (title).', isError: true };
        const created = await createBacklogTaskFile(root, {
          title,
          description: str(args.description),
          labels: strList(args.labels),
          ...(str(args.priority) ? { priority: str(args.priority) } : {}),
          ...(str(args.type) ? { type: str(args.type) } : {}),
          ...(str(args.milestone) ? { milestone: str(args.milestone) } : {}),
          ...(str(args.parentTaskId) ? { parentTaskId: str(args.parentTaskId) } : {}),
          acceptanceCriteria: strList(args.acceptanceCriteria)
        });
        if (!created) return { text: 'Задачу создать не удалось (подробности в логе ProjectHub).', isError: true };
        const rel = path.relative(root, created.filePath).split(path.sep).join('/');
        audit('allow', `task_create: ${created.id}`, rel);
        return { text: `Создано: ${created.id} «${created.title}» (${rel}).`, isError: false };
      }

      case 'task_update': {
        const match = await findTaskFile(root, str(args.id));
        if (!match) return { text: `Задача ${str(args.id)} не найдена.`, isError: true };
        const filePath = assertInsideProject(path.join(root, 'backlog'), match.filePath);
        const { eol, data, content } = parseFile(await fs.readFile(filePath, 'utf-8'));
        const changes: string[] = [];

        if (str(args.status).trim()) {
          const statuses = await projectStatuses(root);
          const status = matchStatus(statuses, str(args.status).trim());
          if (!status) return { text: `Статуса «${str(args.status)}» нет в config.yml проекта. Допустимые: ${statuses.join(', ')}.`, isError: true };
          data.status = status;
          changes.push(`статус → ${status}`);
        }
        if (str(args.title).trim()) {
          data.title = str(args.title).trim();
          changes.push('заголовок');
        }
        if (args.labels !== undefined) {
          data.labels = strList(args.labels);
          changes.push('метки');
        }
        if (str(args.priority).trim()) {
          data.priority = str(args.priority).trim().toLowerCase();
          changes.push('приоритет');
        }

        let body = content;
        if (args.description !== undefined) {
          body = applyDescription(body, str(args.description));
          changes.push('описание');
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
          changes.push('критерии');
        }
        if (str(args.appendNotes).trim()) {
          body = applyImplementationNote(body, str(args.appendNotes).trim());
          changes.push('заметка');
        }
        if (str(args.finalSummary).trim()) {
          body = applyFinalSummary(body, str(args.finalSummary).trim());
          changes.push('итог');
        }
        if (changes.length === 0) return { text: 'Нечего менять: не передано ни одного поля.', isError: true };

        await fs.writeFile(filePath, serializeFile(body, withUpdatedDate(data), eol), 'utf-8');
        const id = taskIdOf(data, filePath);
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        audit('allow', `task_update: ${id}`, rel, changes.join(', '));
        return { text: `Обновлено: ${id} (${changes.join(', ')}).`, isError: false };
      }

      case 'doc_list': {
        const kind = str(args.kind) || 'all';
        const section = str(args.section).trim().toLowerCase();
        const docs = (await listProjectDocs(root))
          .filter((d) => kind === 'all' || d.category === kind)
          .filter((d) => !section || (d.section ?? '').toLowerCase().startsWith(section));
        if (docs.length === 0) return { text: 'Документов не найдено.', isError: false };
        return {
          text: docs.map((d) => `${d.id} — ${d.title}${d.section ? ` [${d.section}]` : ''}${d.status ? ` (${d.status})` : ''}`).join('\n'),
          isError: false
        };
      }

      case 'doc_view': {
        const doc = await findDoc(root, str(args.id));
        if (!doc) return { text: `Документ ${str(args.id)} не найден.`, isError: true };
        return { text: await fs.readFile(doc.filePath, 'utf-8'), isError: false };
      }

      case 'doc_create': {
        const kind = str(args.kind) === 'decision' ? 'decision' : 'doc';
        const title = str(args.title).trim();
        const section = str(args.section).trim();
        if (!title) return { text: 'Не указан заголовок (title).', isError: true };
        if (!section) return { text: 'Не указан раздел (section): посмотри существующие через doc_list.', isError: true };
        const docType = str(args.docType);
        const created = await createProjectDoc(root, {
          type: kind,
          title,
          section,
          content: str(args.content) || undefined,
          tags: strList(args.tags),
          ...(kind === 'decision' && str(args.status) ? { status: str(args.status) as 'proposed' } : {}),
          ...(kind === 'doc' && docType ? { docType: docType as 'guide' } : {})
        });
        audit('allow', `doc_create: ${created.id}`, created.fileRelative);
        return { text: `Создано: ${created.id} «${created.title}» (${created.fileRelative}).`, isError: false };
      }

      case 'doc_update': {
        const doc = await findDoc(root, str(args.id));
        if (!doc) return { text: `Документ ${str(args.id)} не найден.`, isError: true };
        const filePath = assertInsideProject(path.join(root, 'backlog'), doc.filePath);
        const { eol, data, content } = parseFile(await fs.readFile(filePath, 'utf-8'));
        const changes: string[] = [];
        if (str(args.title).trim()) {
          data.title = str(args.title).trim();
          changes.push('заголовок');
        }
        if (str(args.section).trim()) {
          data.section = str(args.section).trim();
          changes.push('раздел');
        }
        if (str(args.status).trim() && doc.category === 'decision') {
          data.status = str(args.status).trim();
          changes.push('статус');
        }
        if (args.tags !== undefined) {
          data.tags = strList(args.tags);
          changes.push('метки');
        }
        let body = content;
        if (args.content !== undefined) {
          body = `\n${str(args.content).replace(/^\s*---[\s\S]*?---\s*/, '').trim()}\n`;
          changes.push('текст');
        }
        if (changes.length === 0) return { text: 'Нечего менять: не передано ни одного поля.', isError: true };
        // Даты и прочие значения frontmatter — строками (правило 16), раздел и id — как были.
        for (const key of Object.keys(data)) if (data[key] instanceof Date) data[key] = fmString(data[key]);
        await fs.writeFile(filePath, serializeFile(body, data, eol), 'utf-8');
        audit('allow', `doc_update: ${doc.id}`, doc.fileRelative, changes.join(', '));
        return { text: `Обновлено: ${doc.id} (${changes.join(', ')}).`, isError: false };
      }

      case 'docs_search': {
        const query = str(args.query).trim();
        if (!query) return { text: 'Не указан запрос (query).', isError: true };
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.floor(limitRaw)) : 8;
        const results = await deps.searchDocs(root, query, limit);
        if (results.length === 0) return { text: 'Ничего не найдено.', isError: false };
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
    return { text: `Ошибка: ${message}`, isError: true };
  }
  return { text: `Неизвестный инструмент: ${name}`, isError: true };
}
