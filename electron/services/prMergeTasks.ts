import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { findTaskFile } from './taskFileLookup.js';
import { normalizeFrontmatter, withUpdatedDate } from './backlogTaskFormat.js';
import { parsePrUrl, taskIdsInText, type PrUrlRef } from './prHosting.js';
import type { PrStateInfo } from './prSnapshot.js';
import type { PrMergeOutcome } from './prWatcher.js';

/**
 * Слияние PR переводит задачу (TASK-138.5): задачи PR — ссылка на него в `references` (или прежнем поле
 * `pr`) и номер задачи в ветке или заголовке; из `Review` они переходят в статус из настройки проекта.
 * Задача в любом другом статусе, в том числе `Done`, не трогается: перевод в `Done` в обход `Review`
 * запрещён правилами проекта, а вернуть закрытую задачу назад слияние не может.
 */

export const MERGE_SOURCE_STATUS = 'Review';

function sameStatus(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function samePr(a: PrUrlRef, b: PrUrlRef): boolean {
  return a.number === b.number && a.hostname === b.hostname && a.repoPath.toLowerCase() === b.repoPath.toLowerCase();
}

function taskRefs(data: Record<string, unknown>): string[] {
  return [...(Array.isArray(data.references) ? data.references : []), ...(typeof data.pr === 'string' ? [data.pr] : [])].map((r) => String(r).trim());
}

/** Задачи PR: номер в ветке и заголовке (если такая задача есть) и задачи со ссылкой на PR. */
export async function linkedTaskIds(projectPath: string, pr: Pick<PrStateInfo, 'url' | 'headRef' | 'title'>): Promise<string[]> {
  const ids = new Set<string>();
  for (const id of taskIdsInText(`${pr.headRef} ${pr.title}`)) {
    if (await findTaskFile(projectPath, id)) ids.add(id);
  }
  const ref = parsePrUrl(pr.url);
  if (!ref) return [...ids];
  const dir = path.join(projectPath, 'backlog', 'tasks');
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf-8').catch(() => '');
    // Дешёвый отсев до разбора YAML: номер PR должен встречаться в тексте.
    if (!raw.includes(String(ref.number))) continue;
    let data: Record<string, unknown>;
    try {
      data = matter(raw.replace(/\r\n/g, '\n')).data;
    } catch {
      continue;
    }
    if (typeof data.id !== 'string') continue;
    if (taskRefs(data).some((r) => {
      const other = parsePrUrl(r);
      return other !== null && samePr(other, ref);
    })) ids.add(data.id.toUpperCase());
  }
  return [...ids];
}

/** Перевести задачи из `Review` в `targetStatus`; без настройки (`null`) ничего не меняется. */
export async function moveMergedTasks(projectPath: string, taskIds: string[], targetStatus: string | null): Promise<PrMergeOutcome['movedTasks']> {
  const target = targetStatus?.trim();
  if (!target || sameStatus(target, MERGE_SOURCE_STATUS)) return [];
  const moved: PrMergeOutcome['movedTasks'] = [];
  for (const taskId of taskIds) {
    const task = await findTaskFile(projectPath, taskId);
    if (!task || !sameStatus(task.data.status, MERGE_SOURCE_STATUS)) continue;
    const from = String(task.data.status);
    const data = withUpdatedDate({ ...task.data, status: target });
    await fs.writeFile(task.filePath, matter.stringify(task.content, normalizeFrontmatter(data)), 'utf-8');
    moved.push({ taskId, from, to: target });
  }
  return moved;
}

export async function applyPrMerge(projectPath: string, pr: PrStateInfo, targetStatus: string | null): Promise<PrMergeOutcome> {
  const taskIds = await linkedTaskIds(projectPath, pr);
  return { taskIds, movedTasks: await moveMergedTasks(projectPath, taskIds, targetStatus) };
}
