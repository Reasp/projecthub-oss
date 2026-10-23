import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import { applyDescription, normalizeFrontmatter, parseTaskBody, taskNumberFromName, withUpdatedDate } from './backlogTaskFormat.js';
import { createBacklogTaskFile } from './backlogTaskCreate.js';
import { parseBacklogConfig } from './backlogConfigService.js';
import type { LocalTaskInfo } from './trackerSyncPlan.js';
import type { FieldValues } from './trackerTypes.js';
import { AppError } from '../../src/lib/appError.js';

/**
 * Задачи проекта для синка с трекером (TASK-128, decision-103): чтение `backlog/tasks` и `backlog/completed`,
 * ссылки на внешние задачи из нативного поля `references`, запись полей и ссылки в файл задачи.
 */

export interface LocalTaskFile extends LocalTaskInfo {
  filePath: string;
  references: string[];
}

const TASK_DIRS = ['tasks', 'completed'];

const fmString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return String(value);
};

const fmList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => fmString(v) ?? '').filter(Boolean) : typeof value === 'string' && value ? [value] : [];

function parseFile(raw: string) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const parsed = matter(raw.replace(/\r\n/g, '\n'));
  return { eol, data: { ...parsed.data } as Record<string, unknown>, content: parsed.content };
}

/** Маркеры секций Backlog.md во внешнем описании сломали бы разбор файла задачи — такие строки убираются. */
const BACKLOG_MARKER = /^\s*<!--\s*(?:SECTION:[A-Z_]+:(?:BEGIN|END)|AC:(?:BEGIN|END)|DOD:(?:BEGIN|END))\s*-->\s*$/;

export function sanitizeRemoteDescription(description: string): string {
  return description
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !BACKLOG_MARKER.test(line))
    .join('\n')
    .trim();
}

export function sanitizeRemoteTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim() || 'Untitled';
}

export async function projectStatuses(root: string): Promise<string[]> {
  try {
    return parseBacklogConfig(await fs.readFile(path.join(root, 'backlog', 'config.yml'), 'utf-8')).statuses;
  } catch {
    return parseBacklogConfig(null).statuses;
  }
}

/** Задачи проекта; `parseLink` выбирает из `references` ссылки своего адаптера. */
export async function readLocalTasks(root: string, parseLink: (ref: string) => string | null): Promise<LocalTaskFile[]> {
  const out: LocalTaskFile[] = [];
  for (const sub of TASK_DIRS) {
    const dir = path.join(root, 'backlog', sub);
    if (!existsSync(dir)) continue;
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.md')) continue;
      const filePath = path.join(dir, name);
      try {
        const { data, content } = parseFile(await fs.readFile(filePath, 'utf-8'));
        const n = taskNumberFromName(path.basename(name, '.md'));
        const references = fmList(data.references);
        out.push({
          id: (fmString(data.id) ?? (n !== null ? `TASK-${n}` : name)).replace(/^task-/i, 'TASK-'),
          title: fmString(data.title) ?? name,
          description: parseTaskBody(content).description,
          status: fmString(data.status) ?? 'To Do',
          labels: fmList(data.labels),
          links: references.map((r) => parseLink(r)).filter((id): id is string => Boolean(id)),
          references,
          parentTaskId: fmString(data.parent_task_id),
          filePath
        });
      } catch {
        // битый файл задачи не прячет остальные
      }
    }
  }
  return out;
}

/** Запись через временный файл: оборванная запись не оставляет полупустую задачу. */
async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, 'utf-8');
  try {
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    await fs.writeFile(file, body, 'utf-8');
  }
}

/** Изменить поля задачи и добавить ссылку на внешнюю задачу. Остальные поля и разделы файла не трогаются. */
export async function updateLocalTaskFile(
  filePath: string,
  change: { fields?: Partial<FieldValues>; addReference?: string }
): Promise<void> {
  const { eol, data, content } = parseFile(await fs.readFile(filePath, 'utf-8'));
  let body = content;
  if (change.fields?.title !== undefined) data.title = sanitizeRemoteTitle(change.fields.title);
  if (change.fields?.status !== undefined) data.status = change.fields.status;
  if (change.fields?.description !== undefined) body = applyDescription(body, sanitizeRemoteDescription(change.fields.description));
  if (change.addReference) {
    const refs = fmList(data.references);
    if (!refs.includes(change.addReference)) data.references = [...refs, change.addReference];
  }
  const text = matter.stringify(body, normalizeFrontmatter(withUpdatedDate(data)));
  await writeAtomic(filePath, eol === '\n' ? text : text.replace(/\n/g, eol));
}

/** Новая задача из внешней: файл Backlog.md, статус по таблице, ссылка в `references`. */
export async function createLocalTaskFromRemote(
  root: string,
  input: { title: string; description: string; status: string; reference: string; parentTaskId?: string; labels?: string[] }
): Promise<{ id: string; filePath: string }> {
  const created = await createBacklogTaskFile(root, {
    title: sanitizeRemoteTitle(input.title),
    description: sanitizeRemoteDescription(input.description),
    labels: input.labels ?? [],
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {})
  });
  if (!created) throw new AppError('tracker.taskCreateFailed');
  await updateLocalTaskFile(created.filePath, { fields: { status: input.status }, addReference: input.reference });
  return { id: created.id, filePath: created.filePath };
}
