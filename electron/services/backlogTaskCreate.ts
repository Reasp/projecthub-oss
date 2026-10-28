import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import { buildTaskBody, nowBacklogTimestamp, parseTaskBody, sanitizeTaskFileTitle, taskNumberFromName } from './backlogTaskFormat';
import { allocateBacklogId } from './backlogIdAllocator';

export interface CreateBacklogTaskInput {
  title: string;
  description: string;
  labels: string[];
  type?: string;
  priority?: string;
  milestone?: string;
  /**
   * Родительская задача (`TASK-80`): создаётся подзадача `TASK-80.<n>` с `parent_task_id`
   * в frontmatter — нативный формат Backlog.md (TASK-80, decision-49 п. 1).
   */
  parentTaskId?: string;
  /** Идентификаторы задач, от которых зависит эта (`dependencies` в frontmatter). */
  dependencies?: string[];
  /** Критерии приёмки: попадают в секцию `## Acceptance Criteria` неотмеченными. */
  acceptanceCriteria?: string[];
  /** Исполнители (`assignee`): люди или `agent:<role>[@host]`. */
  assignee?: string[];
  /** Автор (`reporter`, нативное поле Backlog.md): у задач агентов — `agent:<роль>` (decision-89). */
  reporter?: string;
  /** Статус новой задачи; по умолчанию `To Do`. */
  status?: string;
  /** Ссылки (`references`, нативное поле Backlog.md) — например, на задачу внешнего трекера. */
  references?: string[];
}

export interface CreatedBacklogTask {
  id: string;
  title: string;
  status: string;
  labels: string[];
  milestone?: string;
  created: string;
  filePath: string;
  description: string;
  acceptanceCriteria: ReturnType<typeof parseTaskBody>['criteria'];
}

/** Предел части имени файла из заголовка: длинный заголовок (из трекера, от агента) давал ENAMETOOLONG на Windows. */
export const TASK_FILE_SLUG_MAX = 80;

/** Часть имени файла задачи из заголовка, не длиннее `TASK_FILE_SLUG_MAX`; полный заголовок остаётся во frontmatter. */
export function taskFileSlug(title: string): string {
  const slug = sanitizeTaskFileTitle(title);
  const cut = slug.length > TASK_FILE_SLUG_MAX ? slug.slice(0, TASK_FILE_SLUG_MAX).replace(/[-_.]+$/, '') : slug;
  return cut || 'task';
}

/**
 * Создаёт файл задачи Backlog.md в проекте. Общая логика для IPC (`backlogIpc.ts`) и Remote
 * Control RPC `create_task` (TASK-65) — во избежание дублирования нумерации/frontmatter.
 */
export async function createBacklogTaskFile(projectPath: string, task: CreateBacklogTaskInput): Promise<CreatedBacklogTask | null> {
  try {
    const backlogDir = path.join(projectPath, 'backlog');
    const tasksDir = path.join(backlogDir, 'tasks');
    if (!existsSync(tasksDir)) {
      await fs.mkdir(tasksDir, { recursive: true });
    }

    // Подзадача нумеруется внутри родителя (`task-80.3`), обычная задача — сквозным номером. Номер учитывает все
    // каталоги задач, ветки репозитория и соседние worktree (decision-76 п. 8).
    const parentNumber = task.parentTaskId ? taskNumberFromName(task.parentTaskId) : null;
    const id = await allocateBacklogId(projectPath, 'task', parentNumber !== null ? { parentTaskId: `TASK-${parentNumber}` } : {});
    const number = id.slice('TASK-'.length);
    const fileName = `task-${number} - ${taskFileSlug(task.title)}.md`;
    const fullPath = path.join(tasksDir, fileName);
    const createdDate = nowBacklogTimestamp();
    const labels = task.labels || [];
    const status = task.status?.trim() || 'To Do';

    const frontmatter: Record<string, unknown> = {
      id,
      title: task.title,
      status,
      assignee: task.assignee ?? [],
      ...(task.reporter ? { reporter: task.reporter } : {}),
      created_date: createdDate,
      labels,
      dependencies: task.dependencies ?? [],
      ...(task.parentTaskId ? { parent_task_id: task.parentTaskId } : {}),
      ...(task.milestone ? { milestone: task.milestone } : {}),
      ...(task.priority ? { priority: task.priority } : {}),
      ...(task.references?.length ? { references: task.references } : {}),
      type: task.type || 'task'
    };

    const body = buildTaskBody(
      task.description || '',
      (task.acceptanceCriteria ?? []).map((text) => ({ text, completed: false }))
    );
    await fs.writeFile(fullPath, matter.stringify(body, frontmatter), { encoding: 'utf-8', flag: 'wx' });
    const { criteria, description } = parseTaskBody(body);

    return {
      id,
      title: task.title,
      status,
      labels,
      milestone: task.milestone,
      created: createdDate,
      filePath: fullPath,
      description,
      acceptanceCriteria: criteria
    };
  } catch (err) {
    console.error('Failed to create task:', err);
    return null;
  }
}
