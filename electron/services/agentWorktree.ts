import path from 'node:path';
import type { GitWorktreeInfo } from '../../src/types/electron';

/**
 * Рабочее дерево агента задачи (TASK-270, decision-224). Чистый модуль без Electron и git: правила, по которым
 * сессия Swarm или цикла «до готовности» выбирает дерево задачи вместо временного `swarm/…`, и какие деревья
 * сессия не удаляет при очистке.
 */

/**
 * Задача, которой принадлежит ветка: `task/<id>` ([[decision-6]]) или ветка участника `u/<участник>/<id>`
 * ([[decision-84]] п. 4). Ветки сессий (`swarm/…/done-task-1`, `plan/task-2`, `handoff/…`) задаче не принадлежат —
 * `undefined`: их дерево не записывается в `branch`/`worktree` задачи и не перезатирает её собственное.
 */
export function ownTaskIdOfBranch(branch: string): string | undefined {
  const match = /^(?:task|u\/[^/]+)\/(task-\d+(?:\.\d+)*)$/i.exec(branch.trim());
  return match ? match[1].toLowerCase() : undefined;
}

/** Ветка задачи по decision-6: `task/<id>` строчными. */
export function taskBranchOf(taskId: string): string {
  return `task/${taskId.trim().toLowerCase()}`;
}

/** Дерево задачи — только точным совпадением ветки `task/<id>`, не основное дерево. */
export function findOwnTaskWorktree(worktrees: readonly GitWorktreeInfo[], taskId: string | undefined): GitWorktreeInfo | undefined {
  if (!taskId?.trim()) return undefined;
  const branch = taskBranchOf(taskId);
  return worktrees.find((w) => !w.isMain && !!w.branch && w.branch.toLowerCase() === branch);
}

export interface TaskWorktreeReuseInput {
  taskId?: string;
  /** Сколько агентов в запуске: арене нужны отдельные деревья для сравнения. */
  slots: number;
  useWorktrees: boolean;
  /** База задана вызывающим явно — узел плана работает от интеграционной ветки ([[decision-49]]). */
  explicitBaseBranch?: string;
  /** Ревью PR работает в своём дереве на чтение ([[decision-53]]). */
  review?: boolean;
  /** Агент участника идёт в его личное дерево ([[decision-135]] п. 3). */
  memberWorktree?: boolean;
}

/**
 * Идёт ли сессия в дерево задачи, если оно есть: одиночный агент по задаче, без своей базы, не ревью и не участник.
 * Так работают назначенный агент, цикл «до готовности», `runAgent` Automations и одиночный Swarm по задаче.
 */
export function wantsTaskWorktree(input: TaskWorktreeReuseInput): boolean {
  if (!input.useWorktrees || !input.taskId?.trim()) return false;
  if (input.slots !== 1) return false;
  if (input.explicitBaseBranch?.trim()) return false;
  return !input.review && !input.memberWorktree;
}

/** Сравнимый путь: абсолютный, на Windows без учёта регистра. */
export function comparableWorktreePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface WorktreeHolder {
  id: string;
  status: string;
  agents: ReadonlyArray<{ worktreePath?: string }>;
  taskWorktree?: { path: string };
}

/** Сессия ещё держит дерево: идёт, готовится или прервана и может быть возобновлена. */
function holdsWorktree(status: string): boolean {
  return status === 'preparing' || status === 'running' || status === 'interrupted';
}

/** Другая живая сессия, которая работает в этом дереве: двум агентам в одном каталоге не место. */
export function sessionHoldingWorktree<T extends WorktreeHolder>(
  sessions: Iterable<T>,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform
): T | undefined {
  const key = comparableWorktreePath(worktreePath, platform);
  for (const session of sessions) {
    if (!holdsWorktree(session.status)) continue;
    const paths = [session.taskWorktree?.path, ...session.agents.map((a) => a.worktreePath)];
    if (paths.some((p) => !!p && comparableWorktreePath(p, platform) === key)) return session;
  }
  return undefined;
}

/**
 * Дерево живёт дольше сессии: личное дерево участника или дерево задачи. Сессия фиксирует в нём работу коммитом,
 * но не удаляет ни каталог, ни ветку.
 */
export function isLongLivedWorktree(
  session: { memberWorktree?: { path: string }; taskWorktree?: { path: string } },
  worktreePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const key = comparableWorktreePath(worktreePath, platform);
  return [session.memberWorktree?.path, session.taskWorktree?.path].some((p) => !!p && comparableWorktreePath(p, platform) === key);
}
