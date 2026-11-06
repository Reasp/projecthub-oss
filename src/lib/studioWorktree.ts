import type { AISession, GitWorktreeInfo, StudioSessionWorktree } from '../types/electron';

/**
 * Рабочее дерево задачи и вкладки Agents Studio (TASK-268, decision-195). Чистый модуль без React и Electron: его
 * используют карточка задачи, доска, стор Studio и тесты.
 */

/** Сравнение путей как в `samePath` стора: регистр и вид разделителя не важны (Windows), хвостовой слэш тоже. */
export function sameWorkPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Ветка задачи по decision-6: `task/<id>` строчными. */
export function taskWorktreeBranch(taskId: string): string {
  return `task/${taskId.trim().toLowerCase()}`;
}

/**
 * Worktree задачи — только точным совпадением ветки `task/<id>`. Подстрока не годится: `task-1` нашла бы дерево
 * `task-12`, а `taskId` из имени есть и у деревьев роя (`swarm/…/done-task-1-3`), которые задаче не принадлежат.
 */
export function findTaskWorktree(worktrees: readonly GitWorktreeInfo[], taskId: string | undefined): GitWorktreeInfo | undefined {
  if (!taskId) return undefined;
  const branch = taskWorktreeBranch(taskId);
  return worktrees.find((w) => !w.isMain && !!w.branch && w.branch.toLowerCase() === branch);
}

/** Есть ли у ветки `task/<id>` выписанное дерево, по всем деревьям проекта: id задачи → дерево. */
export function taskWorktreesById(worktrees: readonly GitWorktreeInfo[]): Map<string, GitWorktreeInfo> {
  const byId = new Map<string, GitWorktreeInfo>();
  for (const w of worktrees) {
    const match = !w.isMain && w.branch ? /^task\/(task-\d+(?:\.\d+)*)$/i.exec(w.branch) : null;
    if (match) byId.set(match[1].toLowerCase(), w);
  }
  return byId;
}

/** Запись дерева для вкладки: путь, ветка и признак основного дерева. */
export function sessionWorktreeOf(path: string, worktrees: readonly GitWorktreeInfo[], projectPath: string): StudioSessionWorktree {
  if (sameWorkPath(path, projectPath)) return { path: projectPath, isMain: true };
  const known = worktrees.find((w) => sameWorkPath(w.path, path));
  return known?.branch ? { path, branch: known.branch } : { path };
}

/**
 * Каталог агента вкладки. Порядок:
 * 1. дерево, закреплённое за вкладкой;
 * 2. старая вкладка без поля, где разговор Claude CLI уже идёт, — его каталог (там его найдёт `--resume`);
 * 3. иначе — активное дерево проекта на момент отправки.
 */
export function sessionWorkDir(
  session: Pick<AISession, 'worktree' | 'engineSessionId' | 'engineSessionCwd'> | undefined,
  activeRoot: string | null | undefined,
  projectPath: string
): string {
  if (session?.worktree?.path) return session.worktree.path;
  if (session?.engineSessionId && session.engineSessionCwd) return session.engineSessionCwd;
  return activeRoot || projectPath;
}

export type SessionWorktreeState = 'main' | 'ok' | 'missing' | 'unknown';

/**
 * Состояние дерева вкладки по списку деревьев проекта: `main` — основное дерево или вкладка не закреплена;
 * `missing` — дерева нет в `git worktree list`; `unknown` — список ещё не загружен (пустой), судить нельзя.
 */
export function sessionWorktreeState(
  session: Pick<AISession, 'worktree'> | undefined,
  worktrees: readonly GitWorktreeInfo[],
  projectPath: string
): SessionWorktreeState {
  const wt = session?.worktree;
  if (!wt || wt.isMain || sameWorkPath(wt.path, projectPath)) return 'main';
  if (worktrees.length === 0) return 'unknown';
  return worktrees.some((w) => sameWorkPath(w.path, wt.path)) ? 'ok' : 'missing';
}

/** Короткая подпись дерева: ветка, иначе имя каталога. */
export function worktreeLabel(wt: Pick<StudioSessionWorktree, 'path' | 'branch'>): string {
  return wt.branch || wt.path.split(/[\\/]/).filter(Boolean).pop() || wt.path;
}

/** Санитайзер поля с диска: строки ограниченной длины, иначе поле отбрасывается (старые сессии — без него). */
export function sanitizeSessionWorktree(value: unknown): StudioSessionWorktree | undefined {
  const v = value as Partial<StudioSessionWorktree> | null | undefined;
  if (!v || typeof v !== 'object' || typeof v.path !== 'string' || !v.path.trim()) return undefined;
  return {
    path: v.path.slice(0, 1000),
    ...(typeof v.branch === 'string' && v.branch ? { branch: v.branch.slice(0, 250) } : {}),
    ...(v.isMain === true ? { isMain: true } : {})
  };
}
