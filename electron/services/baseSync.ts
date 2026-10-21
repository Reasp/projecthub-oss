import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitRunner } from './checkpointGit';

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
    'Подтянуть основную ветку проекта (ту, что стоит в основном дереве хоста) в ветку своего worktree: git merge с разрешением конфликтов. '
    + 'action "start" — начать слияние; при конфликте вернёт список файлов: убери маркеры <<<<<<< ======= >>>>>>> (write_file), затем вызови с action "continue" — '
    + 'слияние зафиксируется коммитом. action "abort" — отменить незаконченное слияние. Нужен, когда очередь слияния вернула задачу с конфликтом '
    + 'или основная ветка ушла вперёд. Работает только в worktree агента, не в основном дереве.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'continue', 'abort'], description: 'start (по умолчанию), continue после разрешения конфликтов, abort' },
      explanation: { type: 'string', description: 'Зачем подтягивать основную ветку (показывается человеку при запросе одобрения)' }
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

export interface BaseSyncResult {
  ok: boolean;
  status: BaseSyncStatus;
  /** Текст для модели и для чата. */
  text: string;
  target?: BaseSyncTarget;
  conflicts?: string[];
  sha?: string;
}

const lines = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const samePath = (a: string, b: string) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
const refused = (text: string, target?: BaseSyncTarget): BaseSyncResult => ({ ok: false, status: 'refused', text, ...(target ? { target } : {}) });

/** Маркеры конфликта git в начале строки. */
export function hasConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7})(\s|$)/m.test(content) || /^={7}\r?$/m.test(content);
}

/**
 * Куда сливать и что: `workDir` должен быть отдельным worktree на своей ветке, основное дерево — на ветке.
 * Ошибка — текст для агента, без исключения.
 */
export async function resolveBaseSyncTarget(git: GitRunner, workDir: string): Promise<BaseSyncTarget | string> {
  let top: string;
  let mainPath: string;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], { cwd: workDir })).trim();
    const first = lines(await git(['worktree', 'list', '--porcelain'], { cwd: workDir })).find((l) => l.startsWith('worktree '));
    if (!first) return 'Не удалось определить основное дерево репозитория';
    mainPath = first.slice('worktree '.length).trim();
  } catch (err) {
    return `Рабочий каталог агента не в git-репозитории: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (samePath(top, mainPath)) {
    return 'Агент работает в основном дереве проекта, а не в своём worktree: подтягивать основную ветку некуда';
  }
  const branchOf = async (cwd: string) => (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => '')).trim();
  const base = await branchOf(mainPath);
  const branch = await branchOf(top);
  if (!base || base === 'HEAD') return 'Основное дерево проекта не на ветке: подтягивать нечего';
  if (!branch || branch === 'HEAD') return 'Worktree агента не на ветке (detached HEAD): слияние некуда фиксировать';
  if (branch === base) return `Worktree агента стоит на основной ветке ${base}`;
  return { mainPath, base, branch };
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
    `Конфликт при слиянии ${target.base} в ${target.branch}: ${conflicts.join(', ')}.`,
    'Открой эти файлы (read_file), собери итоговое содержимое без маркеров <<<<<<< ======= >>>>>>> и запиши его (write_file),',
    `затем вызови ${BASE_SYNC_TOOL_NAME} с action "continue". Отменить слияние — action "abort".`
  ].join(' ');
}

/**
 * Выполнить действие в worktree агента. `env` — git-окружение участника (автор), пустое — gitconfig хоста.
 * Никогда не бросает: отказ и ошибка git — результат с текстом для модели.
 */
export async function runBaseSync(git: GitRunner, input: { workDir: string; action: BaseSyncAction; env?: Record<string, string> }): Promise<BaseSyncResult> {
  const resolved = await resolveBaseSyncTarget(git, input.workDir);
  if (typeof resolved === 'string') return refused(resolved);
  const target = resolved;
  const cwd = (await git(['rev-parse', '--show-toplevel'], { cwd: input.workDir })).trim();
  const env = input.env ?? {};
  const inMerge = await mergeInProgress(git, cwd);

  try {
    if (input.action === 'abort') {
      if (!inMerge) return refused('Незаконченного слияния нет — отменять нечего', target);
      await git(['merge', '--abort'], { cwd });
      return { ok: true, status: 'aborted', text: `Слияние ${target.base} в ${target.branch} отменено, worktree вернулся к прежнему состоянию.`, target };
    }

    if (input.action === 'continue') {
      if (!inMerge) return refused(`Незаконченного слияния нет: начни с action "start"`, target);
      const pending = await unmergedFiles(git, cwd);
      const withMarkers: string[] = [];
      for (const file of pending) {
        const content = await fs.readFile(path.join(cwd, file), 'utf8').catch(() => '');
        if (hasConflictMarkers(content)) withMarkers.push(file);
      }
      if (withMarkers.length > 0) {
        return { ok: false, status: 'conflict', text: `В файлах остались маркеры конфликта: ${withMarkers.join(', ')}. Разреши их и повтори "continue".`, target, conflicts: withMarkers };
      }
      await git(['add', '-A'], { cwd });
      await git(['commit', '--no-edit', '--no-verify'], { cwd, env });
      const sha = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
      return { ok: true, status: 'resolved', text: `Конфликт разрешён: ${target.base} слита в ${target.branch} (${sha.slice(0, 7)}). Задачу можно снова ставить в очередь слияния.`, target, sha };
    }

    if (inMerge) {
      const conflicts = await unmergedFiles(git, cwd);
      return { ok: false, status: 'conflict', text: `Слияние уже начато. ${conflictText(target, conflicts.length > 0 ? conflicts : ['(файлы уже отмечены как разрешённые)'])}`, target, conflicts };
    }
    const dirty = lines(await git(['status', '--porcelain', '--untracked-files=no'], { cwd }));
    if (dirty.length > 0) {
      return refused(
        `В worktree есть незакоммиченные изменения (${dirty.length}): сначала зафиксируй их (git add -A и git commit), затем подтягивай ${target.base}`,
        target
      );
    }
    const baseSha = (await git(['rev-parse', '--verify', `${target.base}^{commit}`], { cwd })).trim();
    try {
      await git(['merge-base', '--is-ancestor', baseSha, 'HEAD'], { cwd });
      return { ok: true, status: 'up-to-date', text: `Ветка ${target.branch} уже содержит ${target.base} (${baseSha.slice(0, 7)}): подтягивать нечего.`, target };
    } catch {
      // основная ушла вперёд — сливаем
    }
    try {
      await git(['merge', '--no-ff', '--no-edit', '-m', `merge(${target.base}): подтянуть основную ветку в ${target.branch}`, baseSha], { cwd, env });
    } catch (err) {
      const conflicts = await unmergedFiles(git, cwd);
      if (conflicts.length === 0) {
        await git(['merge', '--abort'], { cwd }).catch(() => '');
        return refused(`Слияние не удалось: ${err instanceof Error ? err.message : String(err)}`, target);
      }
      return { ok: false, status: 'conflict', text: conflictText(target, conflicts), target, conflicts };
    }
    const sha = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
    return { ok: true, status: 'merged', text: `${target.base} слита в ${target.branch} без конфликтов (${sha.slice(0, 7)}).`, target, sha };
  } catch (err) {
    return refused(`Ошибка git: ${err instanceof Error ? err.message : String(err)}`, target);
  }
}

/** Команда для карточки HITL и политики: что именно сделает инструмент. */
export function baseSyncCommand(action: BaseSyncAction, target?: Pick<BaseSyncTarget, 'base' | 'branch'>): string {
  const base = target?.base ?? '<основная ветка>';
  if (action === 'abort') return 'git merge --abort';
  if (action === 'continue') return `git add -A && git commit --no-edit  # завершить слияние ${base}`;
  return `git merge --no-ff ${base}${target ? `  # в ${target.branch}` : ''}`;
}
