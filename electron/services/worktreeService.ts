import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AppError, appErrorFields } from '../../src/lib/appError.js';
import { simpleGit } from 'simple-git';
import { errorMessage } from './errorMessage.js';
import matter from 'gray-matter';
import type {
  GitWorktreeInfo,
  AddWorktreeOptions,
  MergeOptions,
  MergeWorktreeResult,
  OrphanedWorktreeScan,
  CleanOrphanedResult,
  WorktreeDirtyState
} from '../../src/types/electron';
import { AGENT_COMMITTER } from '../extensions/editionRegistry.js';
import { agentResultRef, RESULT_REFLOG_MESSAGE } from './agentResultRefs.js';
import { findTaskFile } from './taskFileLookup.js';
import { normalizeFrontmatter, withUpdatedDate } from './backlogTaskFormat.js';
import { dropRenumberedBranch, mergeMessageWithRenumber, prepareIncomingForMerge, summarizeRenumber, type PreparedIncoming } from './backlogMerge.js';
import { reindexDocsInBackground } from './docsReindex.js';

/**
 * Снять ссылки верхнего уровня worktree (junction `node_modules` из `linkNodeModules`, symlink) до его удаления:
 * `git worktree remove` и рекурсивное удаление идут по junction и стирают каталог, на который он указывает, — то
 * есть `node_modules` основного дерева. Сама ссылка удаляется, цель остаётся. Возвращает снятые имена.
 */
export async function detachLinkedDirs(worktreePath: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(worktreePath);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const full = path.join(worktreePath, name);
    try {
      if (!(await fs.lstat(full)).isSymbolicLink()) continue;
      // На Windows junction каталога снимается как каталог, symlink файла — как файл.
      await fs.rmdir(full).catch(() => fs.unlink(full));
      removed.push(name);
    } catch (err) {
      console.warn(`[WorktreeService] Не удалось снять ссылку ${full}:`, err);
    }
  }
  return removed;
}

/** Ссылки верхнего уровня, которые остались в каталоге: снять их не вышло — удалять дерево нельзя. */
async function remainingLinkedDirs(worktreePath: string): Promise<string[]> {
  const names = await fs.readdir(worktreePath).catch(() => [] as string[]);
  const linked: string[] = [];
  for (const name of names) {
    const stat = await fs.lstat(path.join(worktreePath, name)).catch(() => null);
    if (stat?.isSymbolicLink()) linked.push(name);
  }
  return linked;
}

/** Файлы заняты другим процессом (Windows: открытый файл, текущий каталог процесса). */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Повторы `fs.rm` при EBUSY/EPERM/ENOTEMPTY: линейная пауза 200 мс × попытка, всего около 4 секунд. */
const RM_MAX_RETRIES = 6;
const RM_RETRY_DELAY_MS = 200;

/**
 * Закрыть терминалы и процессы ProjectHub, работающие в каталоге дерева, до его удаления (TASK-269): иначе Windows
 * не отдаёт каталог. Задаёт main ([[decision-6]]); без него удаление идёт как раньше.
 */
export type ReleaseWorktreeHandles = (worktreePath: string) => Promise<void>;

/**
 * Пути из `git status --porcelain -z -uall`: записи `XY путь` через NUL; у переименования и копирования (`R`, `C` в
 * первой колонке) следом идёт исходный путь — он пропускается.
 */
export function parseStatusPorcelainZ(raw: string): string[] {
  return parseStatusEntriesZ(raw).map((e) => e.path);
}

/** Записи того же вывода с признаком правки в индексе: первая колонка — не пробел и не `?`. */
export function parseStatusEntriesZ(raw: string): Array<{ path: string; staged: boolean }> {
  const parts = raw.split('\0');
  const entries: Array<{ path: string; staged: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    entries.push({ path: entry.slice(3), staged: entry[0] !== ' ' && entry[0] !== '?' });
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return entries;
}

/**
 * Незакоммиченные пути основного дерева, которые меняет слияние (TASK-268): их правку слияние перезаписало бы, и git
 * откажет сам. Остальные незакоммиченные правки — статус задачи, который пишет сам ProjectHub, — слиянию не мешают.
 */
export function dirtyPathsTouchedByMerge(dirty: readonly string[], incoming: readonly string[], ignoreCase = process.platform === 'win32'): string[] {
  const norm = (p: string) => (ignoreCase ? p.toLowerCase() : p);
  const touched = new Set(incoming.map(norm));
  return dirty.filter((p) => touched.has(norm(p)));
}

/** Сколько путей грязного дерева отдавать окну: окно показывает список, а не весь репозиторий. */
const DIRTY_FILES_SHOWN = 50;

/**
 * Нормализация пути для сравнения (учитывая особенности Windows).
 */
function normalizePath(p: string): string {
  const norm = path.resolve(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * Извлечение ID задачи (`task-N`, включая подзадачи `task-N.M`) из имени ветки или пути.
 *
 * Точки в именах веток заменяются на дефисы (`sanitizeSlug` в `agentFleetService`), поэтому хвост
 * из цифр после номера читается как номер подзадачи: `swarm/0-abcd/done-task-1-3` → `task-1.3`.
 * Без этого worktree узла плана записывался бы во frontmatter **родительской** задачи `task-1`
 * (найдено живым прогоном планировщика, TASK-80.4).
 */
export function extractTaskId(branchOrPath: string): string | undefined {
  const match = branchOrPath.match(/(?:^|[\\/_-])(task-\d+(?:-\d+)*)(?:[\\/_-]|$)/i);
  if (!match) return undefined;
  const numbers = match[1].toLowerCase().replace(/^task-/, '').split('-');
  return `task-${numbers.join('.')}`;
}

/**
 * Парсинг вывода `git worktree list --porcelain`.
 * Чистая функция для удобного unit-тестирования.
 */
export function parseWorktreeListPorcelain(raw: string, mainProjectPath: string): GitWorktreeInfo[] {
  const entries: GitWorktreeInfo[] = [];
  const blocks = raw.trim().split(/\r?\n\r?\n/);
  const normMain = normalizePath(mainProjectPath);

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);

    let worktreePath = '';
    let head = '';
    let branch: string | null = null;
    let isDetached = false;
    let isLocked = false;
    let lockReason: string | undefined;
    let isPrunable = false;
    let pruneReason: string | undefined;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.substring('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.substring('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const fullRef = line.substring('branch '.length).trim();
        branch = fullRef.replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        isDetached = true;
      } else if (line.startsWith('locked')) {
        isLocked = true;
        const rest = line.substring('locked'.length).trim();
        if (rest) lockReason = rest;
      } else if (line.startsWith('prunable')) {
        isPrunable = true;
        const rest = line.substring('prunable'.length).trim();
        if (rest) pruneReason = rest;
      }
    }

    if (!worktreePath) continue;

    const normPath = normalizePath(worktreePath);
    const isMain = normPath === normMain;
    const taskId = branch ? extractTaskId(branch) || extractTaskId(worktreePath) : extractTaskId(worktreePath);

    entries.push({
      path: path.normalize(worktreePath),
      head,
      branch,
      isDetached,
      isLocked,
      lockReason,
      isPrunable,
      pruneReason,
      isMain,
      taskId
    });
  }

  return entries;
}

export class WorktreeService {
  protected getGit(projectPath: string) {
    return simpleGit(projectPath);
  }

  /**
   * Проверка и гарантированное добавление `.worktrees/` в `.gitignore` проекта (AC #7).
   */
  async ensureWorktreeIgnored(projectPath: string): Promise<boolean> {
    const gitignorePath = path.join(projectPath, '.gitignore');
    try {
      if (existsSync(gitignorePath)) {
        const content = await fs.readFile(gitignorePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const hasWorktrees = lines.some((l) => {
          const t = l.trim();
          return t === '.worktrees' || t === '.worktrees/' || t === '/.worktrees' || t === '/.worktrees/';
        });

        if (!hasWorktrees) {
          const suffix = content.endsWith('\n') ? '' : '\n';
          const addition = `${suffix}# Git Worktrees (isolated task directories)\n.worktrees/\n`;
          await fs.appendFile(gitignorePath, addition, 'utf-8');
          return true;
        }
      } else {
        const initial = `# Git Worktrees (isolated task directories)\n.worktrees/\n`;
        await fs.writeFile(gitignorePath, initial, 'utf-8');
        return true;
      }
    } catch (err) {
      console.warn(`[WorktreeService] Failed to update .gitignore in ${projectPath}:`, err);
    }
    return false;
  }

  /**
   * Список всех активных worktrees проекта.
   */
  async listWorktrees(projectPath: string): Promise<GitWorktreeInfo[]> {
    try {
      const git = simpleGit(projectPath);
      const raw = await git.raw(['worktree', 'list', '--porcelain']);
      return parseWorktreeListPorcelain(raw, projectPath);
    } catch (err) {
      console.error(`[WorktreeService] Failed to list worktrees for ${projectPath}:`, err);
      return [];
    }
  }

  /**
   * Создание нового worktree для задачи или ветки (AC #1, AC #4, AC #7).
   */
  async addWorktree(projectPath: string, options: AddWorktreeOptions): Promise<GitWorktreeInfo> {
    const git = simpleGit(projectPath);

    // Гарантируем добавление в .gitignore
    await this.ensureWorktreeIgnored(projectPath);

    // Определяем имя папки
    const folderSlug = options.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    const targetDir = options.customPath
      ? path.resolve(projectPath, options.customPath)
      : path.join(projectPath, '.worktrees', folderSlug);

    // Создаем родительский каталог .worktrees при необходимости
    const parentDir = path.dirname(targetDir);
    if (!existsSync(parentDir)) {
      await fs.mkdir(parentDir, { recursive: true });
    }

    const args: string[] = ['worktree', 'add'];

    if (options.newBranch) {
      args.push('-b', options.branch, targetDir);
      if (options.baseCommitOrBranch) {
        args.push(options.baseCommitOrBranch);
      }
    } else {
      args.push(targetDir, options.branch);
    }

    await git.raw(args);

    // Получаем обновленный список и возвращаем созданное дерево
    const worktrees = await this.listWorktrees(projectPath);
    const created = worktrees.find((w) => normalizePath(w.path) === normalizePath(targetDir));
    const taskId = extractTaskId(options.branch) || extractTaskId(targetDir);

    if (taskId) {
      await this.recordWorktreeInTask(projectPath, taskId, options.branch, targetDir);
    }

    if (!created) {
      return {
        path: targetDir,
        head: '',
        branch: options.branch,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
        isMain: false,
        taskId
      };
    }

    return created;
  }

  /** Обратная связь задача → worktree/branch во frontmatter (TASK-64) — best-effort, не роняет создание worktree. */
  private async recordWorktreeInTask(projectPath: string, taskId: string, branch: string, worktreePath: string): Promise<void> {
    try {
      const task = await findTaskFile(projectPath, taskId);
      if (!task) return;
      const data = { ...task.data, branch, worktree: path.relative(projectPath, worktreePath) };
      const updated = matter.stringify(task.content, normalizeFrontmatter(withUpdatedDate(data)));
      await fs.writeFile(task.filePath, updated, 'utf-8');
    } catch (err) {
      console.error(`[WorktreeService] Failed to record worktree in task ${taskId}:`, err);
    }
  }

  /** Незакоммиченные файлы дерева, включая untracked (TASK-267). Каталога нет — дерево чистое. */
  async worktreeDirtyState(worktreePath: string): Promise<WorktreeDirtyState> {
    if (!existsSync(worktreePath)) return { path: worktreePath, count: 0, files: [] };
    const files = parseStatusPorcelainZ(await simpleGit(worktreePath).raw(['status', '--porcelain', '-z', '-uall']));
    return { path: worktreePath, count: files.length, files: files.slice(0, DIRTY_FILES_SHOWN) };
  }

  /** Worktree ветки (не основное дерево) и его незакоммиченные файлы; ветка не выписана в worktree — `null`. */
  protected async branchWorktreeDirtyState(projectPath: string, branch: string): Promise<WorktreeDirtyState | null> {
    const wt = (await this.listWorktrees(projectPath)).find((w) => !w.isMain && w.branch === branch);
    return wt ? this.worktreeDirtyState(wt.path) : null;
  }

  /**
   * Коммит всех изменений дерева (`add -A`) от имени пользователя git — это его работа, не агента. Хуки проекта
   * выполняются как при обычном коммите; отказ хука или нет `user.name` — ошибка с причиной.
   */
  protected async commitWorktreeChanges(worktreePath: string, message: string): Promise<void> {
    const git = simpleGit(worktreePath);
    try {
      await git.raw(['add', '-A']);
      await git.raw(['commit', '-m', message]);
    } catch (err) {
      throw new AppError('git.worktreeCommitFailed', { reason: errorMessage(err) });
    }
  }

  /**
   * Снимок незакоммиченных изменений в ref результатов (`refs/projecthub/results/worktree-<каталог>/removed-<время>`,
   * TASK-238): его видно в окне сохранённых результатов, оттуда он восстанавливается в ветку. Автор снимка — технический,
   * как у результата агента: `stash create` без `user.name` падает. `null` — снимок не получился.
   */
  protected async preserveWorktreeSnapshot(worktreePath: string): Promise<string | null> {
    const git = simpleGit(worktreePath);
    const who = ['-c', `user.name=${AGENT_COMMITTER.name}`, '-c', `user.email=${AGENT_COMMITTER.email}`];
    try {
      await git.raw(['add', '-A']);
      const hash = (await git.raw([...who, 'stash', 'create', `ProjectHub: ${path.basename(worktreePath)} before removal`])).trim();
      if (!/^[0-9a-f]{40,64}$/i.test(hash)) return null;
      const ref = agentResultRef(`worktree-${path.basename(worktreePath)}`, `removed-${Date.now()}`);
      await git.raw(['update-ref', '--create-reflog', '-m', RESULT_REFLOG_MESSAGE, ref, hash]);
      return ref;
    } catch (err) {
      console.error(`[WorktreeService] Failed to snapshot ${worktreePath} before removal:`, err);
      return null;
    }
  }

  private releaseHandles: ReleaseWorktreeHandles | null = null;

  /** Main подключает закрытие терминалов и процессов дерева перед удалением (TASK-269). */
  setReleaseHandles(release: ReleaseWorktreeHandles | null): void {
    this.releaseHandles = release;
  }

  /** Удаление worktree для внутренних вызовов: ошибка — в лог, результат `false`. */
  async removeWorktree(projectPath: string, worktreePath: string, force = false): Promise<boolean> {
    try {
      await this.removeWorktreeOrThrow(projectPath, worktreePath, force);
      return true;
    } catch (err) {
      console.error(`[WorktreeService] Failed to remove worktree ${worktreePath}:`, err);
      return false;
    }
  }

  /**
   * Удаление worktree (AC #1). Незакоммиченные изменения сначала уходят в снимок ([[decision-8]] п. 5): не получилось —
   * дерево остаётся. Терминалы и процессы дерева закрываются заранее, занятые файлы удаляются с повтором; неудача —
   * `AppError` с причиной, человек может повторить (TASK-269, [[decision-6]]).
   */
  async removeWorktreeOrThrow(projectPath: string, worktreePath: string, force = false): Promise<void> {
    if (this.releaseHandles) {
      await this.releaseHandles(worktreePath).catch((err) => console.warn(`[WorktreeService] Could not release ${worktreePath}:`, err));
    }
    // Ссылки внутри worktree (junction node_modules) — до удаления, иначе удаление дойдёт до их цели.
    await detachLinkedDirs(worktreePath);
    const stuckLinks = await remainingLinkedDirs(worktreePath);
    if (stuckLinks.length > 0) throw new AppError('git.worktreeLinkStuck', { path: worktreePath, names: stuckLinks.join(', ') });
    // Без `.git` (прошлое удаление прервалось на полпути) git нашёл бы репозиторий основного дерева выше по пути и
    // снимок забрал бы его изменения: такому дереву сохранять нечего.
    const linked = existsSync(path.join(worktreePath, '.git'));
    // Без `force` git сам не удаляет грязное дерево — снимок нужен только при принудительном удалении.
    let dirty: WorktreeDirtyState | null = null;
    if (force && linked) {
      try {
        dirty = await this.worktreeDirtyState(worktreePath);
      } catch (err) {
        // Повреждённое дерево git не читает: сохранять нечего, удаление идёт как раньше.
        console.warn(`[WorktreeService] Could not read status of ${worktreePath}:`, err);
      }
    }
    if (dirty && dirty.count > 0) {
      const ref = await this.preserveWorktreeSnapshot(worktreePath);
      if (!ref) throw new AppError('git.worktreeSnapshotFailed', { path: worktreePath });
      console.info(`[WorktreeService] ${dirty.count} uncommitted file(s) of ${worktreePath} preserved in ${ref}`);
    }
    try {
      const args = ['worktree', 'remove', worktreePath];
      if (force) {
        args.push('--force');
      }
      await simpleGit(projectPath).raw(args);
      return;
    } catch (err) {
      console.warn(`[WorktreeService] git worktree remove failed for ${worktreePath}:`, err);
      // Каталога уже нет — осталась только запись git о дереве.
      if (!existsSync(worktreePath)) {
        await this.pruneWorktrees(projectPath);
        return;
      }
      if (!force) throw new AppError('git.worktreeRemoveFailed', { path: worktreePath, reason: errorMessage(err) });
    }
    // git не удалил занятые или неотслеживаемые файлы: удаляем каталог сами с повтором и убираем запись git.
    try {
      await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
    } catch (rmErr) {
      const code = (rmErr as NodeJS.ErrnoException)?.code;
      if (code && BUSY_CODES.has(code)) throw new AppError('git.worktreeRemoveBusy', { path: worktreePath });
      throw new AppError('git.worktreeRemoveFailed', { path: worktreePath, reason: errorMessage(rmErr) });
    }
    await this.pruneWorktrees(projectPath);
  }

  /**
   * Очистка записей об удаленных/невалидных worktrees (AC #1).
   */
  async pruneWorktrees(projectPath: string): Promise<boolean> {
    try {
      const git = simpleGit(projectPath);
      await git.raw(['worktree', 'prune']);
      return true;
    } catch (err) {
      console.error(`[WorktreeService] Failed to prune worktrees for ${projectPath}:`, err);
      return false;
    }
  }

  /**
   * Получение диффа между веткой worktree и базовой веткой проекта (AC #2, AC #7).
   * Считается внутри рабочей директории worktree с учетом untracked-файлов (git add -N).
   */
  async getWorktreeDiff(
    projectPath: string,
    worktreeBranch: string,
    baseBranch: string,
    worktreePath?: string
  ): Promise<string> {
    try {
      let targetWtPath = worktreePath;
      if (!targetWtPath) {
        const wts = await this.listWorktrees(projectPath);
        const match = wts.find((w) => w.branch === worktreeBranch);
        if (match && !match.isMain) {
          targetWtPath = match.path;
        }
      }

      if (targetWtPath && existsSync(targetWtPath)) {
        try {
          const wtGit = simpleGit(targetWtPath);
          // `add -N` на файле в конфликте заменяет его unmerged-записи пустой intent-to-add и тихо «разрешает»
          // конфликт: пока в worktree идёт слияние (TASK-139.6), индекс не трогаем.
          const unmerged = await wtGit.raw(['ls-files', '-u']).catch(() => '');
          if (!unmerged.trim()) {
            try {
              await wtGit.raw(['add', '-N', '.']);
            } catch {
              // Игнорируем если нечего добавлять или временные коллизии
            }
          }
          const diffOutput = await wtGit.diff([baseBranch]);
          if (diffOutput && diffOutput.trim()) {
            return diffOutput;
          }
        } catch (wtErr) {
          console.warn(`[WorktreeService] Internal worktree diff failed for ${targetWtPath}:`, wtErr);
        }
      }

      // Fallback на расчет через основной репозиторий (для коммитов)
      const git = simpleGit(projectPath);
      return await git.diff([`${baseBranch}...${worktreeBranch}`]);
    } catch (err) {
      console.error(`[WorktreeService] Failed to get diff between ${baseBranch} and ${worktreeBranch}:`, err);
      return '';
    }
  }

  /** Шаг перенумерации backlog перед слиянием (decision-76); отдельным методом — чтобы подменять в тестах. */
  protected prepareIncoming(projectPath: string, branch: string, targetBranch: string, approved: boolean): Promise<PreparedIncoming> {
    return prepareIncomingForMerge(projectPath, branch, { target: targetBranch, approved });
  }

  /** Временная ветка перенумерации больше не нужна; после слияния — пересборка индекса RAG (decision-76 п. 4). */
  protected async finishRenumbered(projectPath: string, renumberBranch: string, merged: boolean): Promise<void> {
    await dropRenumberedBranch(projectPath, renumberBranch);
    if (merged) reindexDocsInBackground(projectPath);
  }

  /**
   * Безопасное слияние ветки worktree в целевую ветку проекта (AC #3, AC #7).
   * Проверяет чистоту дерева, использует merge --no-commit, при конфликте выполняет abort
   * и восстанавливает исходную ветку.
   */
  async mergeWorktree(
    projectPath: string,
    worktreeBranch: string,
    targetBranch: string,
    options: MergeOptions = {}
  ): Promise<MergeWorktreeResult> {
    const git = this.getGit(projectPath);
    let originalBranch: string | null = null;
    let switchedBranch = false;
    let prepared: PreparedIncoming | null = null;

    try {
      const status = await git.status();
      originalBranch = status.current;

      // Незакоммиченное основного дерева (TASK-268): слияние идёт поверх него, если дерево уже на целевой ветке, в индексе
      // пусто и правки не пересекаются со слиянием (проверка ниже, после перенумерации). Так работает и сам git: статус
      // задачи, который ProjectHub пишет в основное дерево при старте работы, не блокирует её завершение.
      let mainDirty: string[] = [];
      if (!status.isClean()) {
        const entries = originalBranch === targetBranch ? parseStatusEntriesZ(await git.raw(['status', '--porcelain', '-z', '-uall'])) : [];
        if (originalBranch !== targetBranch || entries.some((e) => e.staged)) {
          return {
            success: false,
            uncleanWorkingTree: true,
            ...appErrorFields(new AppError('git.workingTreeDirty'))
          };
        }
        mainDirty = entries.map((e) => e.path);
      }

      // Незакоммиченное в worktree ветки сливается только коммитом (TASK-267): иначе дифф в окне показывает правки,
      // а слияние их не несёт и следующее удаление дерева их стирает. До перенумерации — она строится от вершины ветки.
      if (options.pendingChanges) {
        const dirty = await this.branchWorktreeDirtyState(projectPath, worktreeBranch);
        if (dirty && dirty.count > 0) {
          if (options.pendingChanges === 'refuse') {
            return {
              success: false,
              worktreeDirty: dirty,
              ...appErrorFields(new AppError('git.worktreeDirty', { branch: worktreeBranch, count: dirty.count }))
            };
          }
          await this.commitWorktreeChanges(dirty.path, options.commitMessage?.trim() || `wip(${worktreeBranch}): work in worktree`);
        }
      }

      // Номера backlog, добавленные обеими ветками, — до слияния и до checkout (decision-76 п. 6): человек видит
      // план замен и подтверждает его повтором с `renumber: true`.
      prepared = await this.prepareIncoming(projectPath, worktreeBranch, targetBranch, options.renumber === true);
      if (prepared.status === 'needs-approval') {
        return {
          success: false,
          renumberRequired: summarizeRenumber(prepared.preview),
          ...appErrorFields(new AppError('git.renumberRequired', { branch: worktreeBranch, target: targetBranch }))
        };
      }
      const renumbered = prepared.status === 'renumbered' ? prepared.preview.renumber : [];

      if (mainDirty.length > 0) {
        const base = (await git.raw(['merge-base', 'HEAD', prepared.mergeRef])).trim();
        const incoming = (await git.raw(['diff', '--name-only', '--no-renames', '-z', base, prepared.mergeRef])).split('\0').filter(Boolean);
        const overlap = dirtyPathsTouchedByMerge(mainDirty, incoming);
        if (overlap.length > 0) {
          if (prepared.status === 'renumbered') await this.finishRenumbered(projectPath, prepared.mergeRef, false);
          return {
            success: false,
            uncleanWorkingTree: true,
            ...appErrorFields(new AppError('git.workingTreeDirtyOverlap', { files: overlap.slice(0, 10).join(', '), count: overlap.length }))
          };
        }
      }

      if (originalBranch !== targetBranch) {
        await git.checkout(targetBranch);
        switchedBranch = true;
      }

      try {
        await git.raw(['merge', '--no-ff', '--no-commit', prepared.mergeRef]);
        await git.raw(['commit', '-m', mergeMessageWithRenumber(`Merge branch '${worktreeBranch}' into ${targetBranch}`, renumbered)]);
        if (prepared.status === 'renumbered') {
          await this.finishRenumbered(projectPath, prepared.mergeRef, true);
          return { success: true, renumbered };
        }
        return { success: true };
      } catch (mergeErr: unknown) {
        const conflictStatus = await git.status();
        const conflictedFiles = conflictStatus.conflicted || [];

        try {
          await git.raw(['merge', '--abort']);
        } catch (abortErr) {
          console.warn('[WorktreeService] merge --abort failed:', abortErr);
        }

        if (switchedBranch && originalBranch) {
          try {
            await git.checkout(originalBranch);
          } catch (checkoutErr) {
            console.warn(`[WorktreeService] Failed to restore branch ${originalBranch}:`, checkoutErr);
          }
        }
        if (prepared.status === 'renumbered') await this.finishRenumbered(projectPath, prepared.mergeRef, false);

        const failure = conflictedFiles.length > 0
          ? appErrorFields(new AppError('git.mergeConflictIn', { files: conflictedFiles.join(', ') }))
          : appErrorFields(mergeErr);

        return {
          success: false,
          wasAborted: true,
          conflictedFiles,
          ...failure
        };
      }
    } catch (err: unknown) {
      console.error(`[WorktreeService] Failed to merge ${worktreeBranch} into ${targetBranch}:`, err);
      if (switchedBranch && originalBranch) {
        try {
          await git.checkout(originalBranch);
        } catch {}
      }
      if (prepared?.status === 'renumbered') await this.finishRenumbered(projectPath, prepared.mergeRef, false);
      return { success: false, ...appErrorFields(err) };
    }
  }

  /**
   * Частичное принятие файлов из ветки worktree в текущее рабочее дерево (AC #5).
   */
  async checkoutFilesFromBranch(
    projectPath: string,
    branch: string,
    filePaths: string[]
  ): Promise<{ success: boolean; error?: string; files?: string[] }> {
    try {
      if (!filePaths || filePaths.length === 0) {
        return { success: true, files: [] };
      }
      const git = this.getGit(projectPath);
      await git.raw(['checkout', branch, '--', ...filePaths]);
      return { success: true, files: filePaths };
    } catch (err: unknown) {
      console.error(`[WorktreeService] Failed to checkout files from ${branch}:`, err);
      return { success: false, error: errorMessage(err) };
    }
  }

  /**
   * Поиск осиротевших worktrees и веток swarm/handoff/task (AC #6).
   */
  async findOrphanedWorktreesAndBranches(
    projectPath: string,
    activeTaskIds: string[] = [],
    activeSwarmIds: string[] = []
  ): Promise<OrphanedWorktreeScan> {
    const orphanedPaths: string[] = [];
    const orphanedBranches: string[] = [];
    let allWorktrees: GitWorktreeInfo[] = [];

    try {
      const git = this.getGit(projectPath);
      allWorktrees = await this.listWorktrees(projectPath);
      const lowerActiveTasks = new Set(activeTaskIds.map((id) => id.toLowerCase()));
      const activeSwarms = new Set(activeSwarmIds);

      // 1. Проверяем физические каталоги в .worktrees/, которых нет в зарегистрированных worktrees
      const wtDir = path.join(projectPath, '.worktrees');
      if (existsSync(wtDir)) {
        try {
          const diskFolders = await fs.readdir(wtDir);
          const registeredPaths = new Set(allWorktrees.map((w) => normalizePath(w.path)));
          for (const folder of diskFolders) {
            const fullPath = path.join(wtDir, folder);
            if (!registeredPaths.has(normalizePath(fullPath))) {
              orphanedPaths.push(fullPath);
            }
          }
        } catch { /* ignore readdir error */ }
      }

      // 2. Проверяем зарегистрированные worktrees, чьи задачи или рои уже не активны
      for (const wt of allWorktrees) {
        if (wt.isMain) continue;

        const branch = wt.branch || '';
        const folderName = path.basename(wt.path);

        // Swarm worktrees
        if (branch.startsWith('swarm/') || folderName.startsWith('swarm-')) {
          const isAssociatedWithActiveSwarm = Array.from(activeSwarms).some(
            (sId) => branch.includes(sId) || folderName.includes(sId)
          );
          if (!isAssociatedWithActiveSwarm) {
            orphanedPaths.push(wt.path);
            continue;
          }
        }

        // Handoff worktrees
        if (branch.startsWith('handoff/') || folderName.startsWith('handoff-')) {
          const isAssociatedWithActiveSwarm = Array.from(activeSwarms).some(
            (sId) => branch.includes(sId) || folderName.includes(sId)
          );
          if (!isAssociatedWithActiveSwarm) {
            orphanedPaths.push(wt.path);
            continue;
          }
        }

        // Task worktrees
        if (wt.taskId) {
          if (!lowerActiveTasks.has(wt.taskId.toLowerCase())) {
            orphanedPaths.push(wt.path);
          }
        }
      }

      // 3. Сканируем локальные ветки
      const branchSummary = await git.branchLocal();
      const wtBranches = new Set(allWorktrees.map((w) => w.branch).filter(Boolean) as string[]);

      for (const b of branchSummary.all) {
        if (b === 'master' || b === 'main' || b === branchSummary.current) continue;

        if (b.startsWith('swarm/')) {
          const isAssociated = Array.from(activeSwarms).some((sId) => b.includes(sId));
          if (!isAssociated) {
            orphanedBranches.push(b);
            continue;
          }
        }

        if (b.startsWith('handoff/')) {
          const isAssociated = Array.from(activeSwarms).some((sId) => b.includes(sId));
          if (!isAssociated) {
            orphanedBranches.push(b);
            continue;
          }
        }

        if (b.startsWith('task/')) {
          const extractedId = extractTaskId(b);
          if (extractedId && !lowerActiveTasks.has(extractedId.toLowerCase())) {
            orphanedBranches.push(b);
          }
        }

        const taskMatch = extractTaskId(b);
        if (taskMatch) {
          // Если задача не активна и ветка не привязана к живому активному worktree
          if (!lowerActiveTasks.has(taskMatch.toLowerCase()) && !wtBranches.has(b)) {
            orphanedBranches.push(b);
          }
        }
      }
    } catch (err) {
      console.error(`[WorktreeService] Failed to find orphaned worktrees/branches for ${projectPath}:`, err);
    }

    return {
      orphanedWorktrees: allWorktrees.filter((w) => orphanedPaths.includes(w.path)),
      orphanedPaths: Array.from(new Set(orphanedPaths)),
      orphanedBranches: Array.from(new Set(orphanedBranches))
    };
  }

  /**
   * Удаление осиротевших worktrees и веток (AC #6).
   */
  async cleanOrphanedWorktreesAndBranches(
    projectPath: string,
    worktreePaths: string[],
    branches: string[]
  ): Promise<CleanOrphanedResult> {
    const removedWorktrees: string[] = [];
    const removedBranches: string[] = [];
    const errors: string[] = [];
    const git = this.getGit(projectPath);

    for (const wtPath of worktreePaths) {
      try {
        const ok = await this.removeWorktree(projectPath, wtPath, true);
        if (ok) {
          removedWorktrees.push(wtPath);
        } else {
          errors.push(`Failed to remove worktree ${wtPath}`);
        }
      } catch (err: unknown) {
        errors.push(`Error removing worktree ${wtPath}: ${errorMessage(err)}`);
      }
    }

    for (const b of branches) {
      try {
        await git.deleteLocalBranch(b, true);
        removedBranches.push(b);
      } catch (err: unknown) {
        errors.push(`Failed to delete branch ${b}: ${errorMessage(err)}`);
      }
    }

    try {
      await this.pruneWorktrees(projectPath);
    } catch { /* ignore */ }

    return { removedWorktrees, removedBranches, errors };
  }
}

export const worktreeService = new WorktreeService();
