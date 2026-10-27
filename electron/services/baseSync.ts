import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitRunner } from './checkpointGit';
import { hasConflictMarkers } from './conflictMarkers';

/**
 * «Подтянуть основную ветку в свой worktree» (TASK-142.6, decision-141): агент, чья ветка разошлась с основной
 * (очередь слияния вернула задачу с конфликтом, основная ушла вперёд), сливает основную ветку в свою ветку прямо в
 * своём worktree, разрешает конфликты и фиксирует слияние. Основное дерево хоста и чужие ветки не меняются.
 *
 * Слияние, а не rebase: история ветки автора не переписывается, очередь потом сливает её как обычно. Git-автор —
 * участник, коммиттер — ProjectHub Agent (окружение из `launcherGitEnv`). Модуль без Electron: git внедряется.
 */

export const BASE_SYNC_TOOL_NAME = 'sync_base_branch';

export type BaseSyncAction = 'start' | 'continue' | 'abort';

/** Описание инструмента — одно для API-движка и встроенного MCP сессии Claude CLI. */
export const BASE_SYNC_TOOL_DEFINITION = {
  name: BASE_SYNC_TOOL_NAME,
  description:
    'Merge the project base branch (the one checked out in the host main tree) into the branch of your worktree: git merge with conflict resolution. '
    + 'action "start" — begin the merge; on conflict it returns the file list: remove the <<<<<<< ======= >>>>>>> markers (write_file), then call with action "continue" — '
    + 'the merge is committed. action "abort" — cancel an unfinished merge. Use it when the merge queue returned the task with a conflict '
    + 'or the base branch moved ahead. Works only in the agent worktree, not in the main tree.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'continue', 'abort'], description: 'start (default), continue after resolving conflicts, abort' },
      explanation: { type: 'string', description: 'Why merge the base branch (shown to the human in the approval request)' }
    }
  }
} as const;

export function baseSyncAction(raw: unknown): BaseSyncAction {
  return raw === 'continue' || raw === 'abort' ? raw : 'start';
}

export interface BaseSyncTarget {
  /** Основное дерево проекта (первый worktree репозитория). */
  mainPath: string;
  /** Ветка основного дерева — её и подтягиваем. */
  base: string;
  /** Ветка worktree агента. */
  branch: string;
}

export type BaseSyncStatus = 'up-to-date' | 'merged' | 'conflict' | 'resolved' | 'aborted' | 'refused';

/** Почему отказано: по коду интерфейс берёт текст из словарей i18n (TASK-201, правило 25). */
export type BaseSyncRefusalCode =
  | 'no-main-tree'
  | 'not-a-repo'
  | 'in-main-tree'
  | 'detached'
  | 'no-branch'
  | 'same-branch'
  | 'main-detached'
  | 'on-main-branch'
  | 'nothing-to-abort'
  | 'nothing-to-continue'
  | 'dirty'
  | 'merge-failed'
  | 'git-error';

export interface BaseSyncRefusal {
  code: BaseSyncRefusalCode;
  /** Ветка из текста отказа: несуществующая, текущая или основная. */
  branch?: string;
  /** Число незакоммиченных файлов (`dirty`). */
  count?: number;
  /** Сообщение git как есть — не переводится. */
  detail?: string;
}

export interface BaseSyncResult {
  ok: boolean;
  status: BaseSyncStatus;
  /** Текст для модели и для чата — русский, человеку не показывается. */
  text: string;
  /** Код отказа при `status: 'refused'`. */
  reason?: BaseSyncRefusal;
  target?: BaseSyncTarget;
  conflicts?: string[];
  sha?: string;
}

const lines = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const samePath = (a: string, b: string) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
const refused = (text: string, reason: BaseSyncRefusal, target?: BaseSyncTarget): BaseSyncResult =>
  ({ ok: false, status: 'refused', text, reason, ...(target ? { target } : {}) });
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

interface TargetRefusal { text: string; reason: BaseSyncRefusal }
const no = (text: string, reason: BaseSyncRefusal): TargetRefusal => ({ text, reason });

export { hasConflictMarkers };

/**
 * Куда сливать и что: `workDir` должен быть отдельным worktree на своей ветке, основное дерево — на ветке.
 * `base` — подтянуть другую локальную ветку вместо ветки основного дерева: окно завершения worktree сливает в
 * выбранную человеком ветку (TASK-139.6). Ошибка — текст для агента, без исключения.
 */
export async function resolveBaseSyncTarget(git: GitRunner, workDir: string, base?: string): Promise<BaseSyncTarget | string> {
  const resolved = await resolveTarget(git, workDir, base);
  return 'text' in resolved ? resolved.text : resolved;
}

async function resolveTarget(git: GitRunner, workDir: string, base?: string): Promise<BaseSyncTarget | TargetRefusal> {
  let top: string;
  let mainPath: string;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], { cwd: workDir })).trim();
    const first = lines(await git(['worktree', 'list', '--porcelain'], { cwd: workDir })).find((l) => l.startsWith('worktree '));
    if (!first) return no('Could not determine the main tree of the repository', { code: 'no-main-tree' });
    mainPath = first.slice('worktree '.length).trim();
  } catch (err) {
    return no(`The agent working directory is not in a git repository: ${errorText(err)}`, { code: 'not-a-repo', detail: errorText(err) });
  }
  if (samePath(top, mainPath)) {
    return no('The agent works in the project main tree, not in its own worktree: there is nowhere to merge the base branch into', { code: 'in-main-tree' });
  }
  const branchOf = async (cwd: string) => (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => '')).trim();
  const branch = await branchOf(top);
  if (!branch || branch === 'HEAD') return no('The agent worktree is not on a branch (detached HEAD): there is nowhere to commit the merge', { code: 'detached' });
  if (base !== undefined) {
    // Имя ветки приходит из рендерера: только существующая локальная ветка, не опция git.
    const exists = !base.startsWith('-') && await git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`], { cwd: workDir }).then(() => true, () => false);
    if (!exists) return no(`Branch ${base} does not exist in the repository`, { code: 'no-branch', branch: base });
    if (base === branch) return no(`The worktree is already on branch ${base}`, { code: 'same-branch', branch: base });
    return { mainPath, base, branch };
  }
  const mainBranch = await branchOf(mainPath);
  if (!mainBranch || mainBranch === 'HEAD') return no('The project main tree is not on a branch: nothing to merge', { code: 'main-detached' });
  if (branch === mainBranch) return no(`The agent worktree is on the base branch ${mainBranch}`, { code: 'on-main-branch', branch: mainBranch });
  return { mainPath, base: mainBranch, branch };
}

async function mergeInProgress(git: GitRunner, cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function unmergedFiles(git: GitRunner, cwd: string): Promise<string[]> {
  // Имена как есть, без кавычек и восьмеричных кодов кириллицы: по ним читаются файлы.
  return lines(await git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'], { cwd }).catch(() => ''));
}

function conflictText(target: BaseSyncTarget, conflicts: string[]): string {
  return [
    `Conflict merging ${target.base} into ${target.branch}: ${conflicts.join(', ')}.`,
    'Open these files (read_file), put together the final content without the <<<<<<< ======= >>>>>>> markers and write it (write_file),',
    `then call ${BASE_SYNC_TOOL_NAME} with action "continue". To cancel the merge — action "abort".`
  ].join(' ');
}

/**
 * Выполнить действие в worktree агента. `env` — git-окружение участника (автор), пустое — gitconfig хоста.
 * Никогда не бросает: отказ и ошибка git — результат с текстом для модели.
 */
export async function runBaseSync(git: GitRunner, input: { workDir: string; action: BaseSyncAction; env?: Record<string, string>; base?: string }): Promise<BaseSyncResult> {
  const resolved = await resolveTarget(git, input.workDir, input.base);
  if ('text' in resolved) return refused(resolved.text, resolved.reason);
  const target = resolved;
  const cwd = (await git(['rev-parse', '--show-toplevel'], { cwd: input.workDir })).trim();
  const env = input.env ?? {};
  const inMerge = await mergeInProgress(git, cwd);

  try {
    if (input.action === 'abort') {
      if (!inMerge) return refused('There is no unfinished merge — nothing to cancel', { code: 'nothing-to-abort' }, target);
      await git(['merge', '--abort'], { cwd });
      return { ok: true, status: 'aborted', text: `The merge of ${target.base} into ${target.branch} was cancelled, the worktree is back to its previous state.`, target };
    }

    if (input.action === 'continue') {
      if (!inMerge) return refused(`There is no unfinished merge: begin with action "start"`, { code: 'nothing-to-continue' }, target);
      const pending = await unmergedFiles(git, cwd);
      const withMarkers: string[] = [];
      for (const file of pending) {
        const content = await fs.readFile(path.join(cwd, file), 'utf8').catch(() => '');
        if (hasConflictMarkers(content)) withMarkers.push(file);
      }
      if (withMarkers.length > 0) {
        return { ok: false, status: 'conflict', text: `Conflict markers remain in files: ${withMarkers.join(', ')}. Resolve them and repeat "continue".`, target, conflicts: withMarkers };
      }
      await git(['add', '-A'], { cwd });
      await git(['commit', '--no-edit', '--no-verify'], { cwd, env });
      const sha = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
      return { ok: true, status: 'resolved', text: `Conflict resolved: ${target.base} merged into ${target.branch} (${sha.slice(0, 7)}). The task can go to the merge queue again.`, target, sha };
    }

    if (inMerge) {
      const conflicts = await unmergedFiles(git, cwd);
      return { ok: false, status: 'conflict', text: `A merge is already in progress. ${conflictText(target, conflicts.length > 0 ? conflicts : ['(files are already marked as resolved)'])}`, target, conflicts };
    }
    const dirty = lines(await git(['status', '--porcelain', '--untracked-files=no'], { cwd }));
    if (dirty.length > 0) {
      return refused(
        `The worktree has uncommitted changes (${dirty.length}): commit them first (git add -A and git commit), then merge ${target.base}`,
        { code: 'dirty', count: dirty.length },
        target
      );
    }
    const baseSha = (await git(['rev-parse', '--verify', `${target.base}^{commit}`], { cwd })).trim();
    try {
      await git(['merge-base', '--is-ancestor', baseSha, 'HEAD'], { cwd });
      return { ok: true, status: 'up-to-date', text: `Branch ${target.branch} already contains ${target.base} (${baseSha.slice(0, 7)}): nothing to merge.`, target };
    } catch {
      // основная ушла вперёд — сливаем
    }
    try {
      await git(['merge', '--no-ff', '--no-edit', '-m', `merge(${target.base}): merge the base branch into ${target.branch}`, baseSha], { cwd, env });
    } catch (err) {
      const conflicts = await unmergedFiles(git, cwd);
      if (conflicts.length === 0) {
        await git(['merge', '--abort'], { cwd }).catch(() => '');
        return refused(`The merge failed: ${errorText(err)}`, { code: 'merge-failed', detail: errorText(err) }, target);
      }
      return { ok: false, status: 'conflict', text: conflictText(target, conflicts), target, conflicts };
    }
    const sha = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
    return { ok: true, status: 'merged', text: `${target.base} merged into ${target.branch} without conflicts (${sha.slice(0, 7)}).`, target, sha };
  } catch (err) {
    return refused(`git error: ${errorText(err)}`, { code: 'git-error', detail: errorText(err) }, target);
  }
}

/** Команда для карточки HITL и политики: что именно сделает инструмент. */
export function baseSyncCommand(action: BaseSyncAction, target?: Pick<BaseSyncTarget, 'base' | 'branch'>): string {
  const base = target?.base ?? '<base branch>';
  if (action === 'abort') return 'git merge --abort';
  if (action === 'continue') return `git add -A && git commit --no-edit  # finish merging ${base}`;
  return `git merge --no-ff ${base}${target ? `  # into ${target.branch}` : ''}`;
}
