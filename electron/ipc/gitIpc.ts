import { ipcMain } from 'electron';
import { AppError } from '../../src/lib/appError.js';
import { gitService } from '../services/gitService';
import { worktreeService } from '../services/worktreeService';
import { prService } from '../services/prServiceInstance';
import path from 'node:path';
import { assertRegisteredProject, assertWorkspaceRoot, isProjectWorktreeRoot } from '../services/projectPathGuard';
import { runBaseSync, type BaseSyncResult } from '../services/baseSync';
import { execGit } from '../services/checkpointGit';
import { assertInsideProject } from '../services/pathGuard';
import { runWorktreeInit } from '../services/worktreeInitService';
import { guardedCommit } from '../services/commitSecretGuard';
import { readBacklogConfig } from '../services/backlogConfigService';
import type { AddWorktreeOptions, PRCreateOptions } from '../../src/types/electron';
import type { ConflictResolution } from '../services/mergeConflicts';

export function registerGitIpc() {
  // Git Core & Status
  ipcMain.handle('git:getLog', async (_event, projectPath: string, maxCount = 30) => {
    return await gitService.getLog(await assertWorkspaceRoot(projectPath), maxCount);
  });

  ipcMain.handle('git:getStatus', async (_event, projectPath: string) => {
    return await gitService.getStatus(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:getRepoDetails', async (_event, projectPath: string) => {
    return await gitService.getRepoDetails(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:unwatch', async (_event, projectPath: string) => {
    gitService.unwatchProjectGit(await assertWorkspaceRoot(projectPath));
    return true;
  });

  ipcMain.handle('git:checkout', async (_event, projectPath: string, branchName: string, createNew = false) => {
    return await gitService.checkoutBranch(await assertWorkspaceRoot(projectPath), branchName, createNew);
  });

  ipcMain.handle('git:createBranch', async (_event, projectPath: string, branchName: string) => {
    return await gitService.createBranch(await assertWorkspaceRoot(projectPath), branchName);
  });

  ipcMain.handle('git:stageFile', async (_event, projectPath: string, filePath: string) => {
    return await gitService.stageFile(await assertWorkspaceRoot(projectPath), filePath);
  });

  ipcMain.handle('git:unstageFile', async (_event, projectPath: string, filePath: string) => {
    return await gitService.unstageFile(await assertWorkspaceRoot(projectPath), filePath);
  });

  ipcMain.handle('git:stageAll', async (_event, projectPath: string) => {
    return await gitService.stageAll(await assertWorkspaceRoot(projectPath));
  });

  // Коммит из окна проверяется сканером секретов в main (decision-56 п. 4): находки — отказ с видами и файлами,
  // «закоммитить всё равно» — повтор с хэшем дерева индекса, который видел человек, и запись в аудит.
  ipcMain.handle('git:commit', async (_event, projectPath: string, message: string, stageAll = false, acknowledgeSecrets?: unknown) => {
    return await guardedCommit(await assertWorkspaceRoot(projectPath), message, {
      stageAll: Boolean(stageAll),
      ...(typeof acknowledgeSecrets === 'string' && /^[0-9a-f]{40,64}$/.test(acknowledgeSecrets) ? { acknowledgeSecrets } : {}),
      allowOverride: true,
      source: { kind: 'local' }
    });
  });

  ipcMain.handle('git:getFileDiff', async (_event, projectPath: string, filePath: string, staged = false) => {
    return await gitService.getFileDiff(await assertWorkspaceRoot(projectPath), filePath, staged);
  });

  ipcMain.handle('git:deleteBranch', async (_event, projectPath: string, branchName: string, force = false) => {
    return await gitService.deleteBranch(await assertWorkspaceRoot(projectPath), branchName, force);
  });

  ipcMain.handle('git:mergeBranch', async (_event, projectPath: string, branchName: string, options?: { renumber?: unknown }) => {
    // Из рендерера берётся только флаг согласия на перенумерацию (decision-76 п. 6).
    return await gitService.mergeBranch(await assertWorkspaceRoot(projectPath), branchName, { renumber: options?.renumber === true });
  });

  // Окно конфликтов слияния (TASK-139.3): путь файла проверяется в main — только файлы в конфликте.
  ipcMain.handle('git:mergeState', async (_event, projectPath: string) => {
    return await gitService.getMergeState(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:conflictFile', async (_event, projectPath: string, filePath: string) => {
    return await gitService.getConflictFile(await assertWorkspaceRoot(projectPath), String(filePath));
  });

  ipcMain.handle('git:resolveConflict', async (_event, projectPath: string, filePath: string, resolution: unknown) => {
    const r = resolution as { kind?: unknown; content?: unknown } | null;
    const parsed: ConflictResolution | null =
      r?.kind === 'content' && typeof r.content === 'string'
        ? { kind: 'content', content: r.content }
        : r?.kind === 'ours' || r?.kind === 'theirs'
          ? { kind: r.kind }
          : null;
    if (!parsed) return { success: false, error: 'Unknown resolution method', failure: { code: 'bad-resolution' } };
    return await gitService.resolveConflict(await assertWorkspaceRoot(projectPath), String(filePath), parsed);
  });

  ipcMain.handle('git:finishMerge', async (_event, projectPath: string) => {
    return await gitService.finishMerge(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:abortMerge', async (_event, projectPath: string) => {
    return await gitService.abortMerge(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:fetchRemote', async (_event, projectPath: string) => {
    return await gitService.fetchRemote(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:pullRemote', async (_event, projectPath: string) => {
    return await gitService.pullRemote(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:pushRemote', async (_event, projectPath: string) => {
    return await gitService.pushRemote(await assertWorkspaceRoot(projectPath));
  });

  ipcMain.handle('git:discardFileChanges', async (_event, projectPath: string, filePath: string) => {
    return await gitService.discardFileChanges(await assertWorkspaceRoot(projectPath), filePath);
  });

  ipcMain.handle('git:getDiffBetween', async (_event, projectPath: string, targetA: string, targetB?: string, filePath?: string) => {
    return await gitService.getDiffBetween(await assertWorkspaceRoot(projectPath), targetA, targetB, filePath);
  });

  // Git Worktrees (TASK-53)
  ipcMain.handle('git:worktree:list', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.listWorktrees(safeProject);
  });

  ipcMain.handle('git:worktree:add', async (_event, projectPath: string, options: AddWorktreeOptions) => {
    const safeProject = await assertRegisteredProject(projectPath);
    if (options.customPath) {
      assertInsideProject(safeProject, options.customPath);
    }
    const created = await worktreeService.addWorktree(safeProject, options);
    // Политика worktreeInit: node_modules и команды инициализации нового дерева (TASK-62).
    const init = await runWorktreeInit(safeProject, created.path);
    return init.ran ? { ...created, init } : created;
  });

  ipcMain.handle('git:worktree:remove', async (_event, projectPath: string, worktreePath: string, force = false) => {
    const safeProject = await assertRegisteredProject(projectPath);
    assertInsideProject(safeProject, worktreePath);
    return await worktreeService.removeWorktree(safeProject, worktreePath, force);
  });

  ipcMain.handle('git:worktree:prune', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.pruneWorktrees(safeProject);
  });

  ipcMain.handle('git:worktree:getDiff', async (_event, projectPath: string, worktreeBranch: string, baseBranch: string, worktreePath?: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.getWorktreeDiff(safeProject, worktreeBranch, baseBranch, worktreePath);
  });

  ipcMain.handle('git:worktree:merge', async (_event, projectPath: string, worktreeBranch: string, targetBranch: string, options?: { renumber?: unknown }) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.mergeWorktree(safeProject, worktreeBranch, targetBranch, { renumber: options?.renumber === true });
  });

  // Слияние worktree встало на конфликте — подтянуть целевую ветку в ветку worktree и разрешить там (TASK-139.6).
  ipcMain.handle('git:worktree:pullBase', async (_event, projectPath: string, worktreePath: string, targetBranch: string): Promise<BaseSyncResult> => {
    const safeProject = await assertRegisteredProject(projectPath);
    if (typeof worktreePath !== 'string' || !isProjectWorktreeRoot(safeProject, worktreePath)) {
      throw new AppError('access.notProjectWorktree', { path: String(worktreePath) });
    }
    return await runBaseSync(execGit, { workDir: path.resolve(worktreePath), action: 'start', base: String(targetBranch) });
  });

  ipcMain.handle('git:worktree:checkoutFiles', async (_event, projectPath: string, branch: string, filePaths: string[]) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.checkoutFilesFromBranch(safeProject, branch, filePaths);
  });

  ipcMain.handle('git:worktree:findOrphaned', async (_event, projectPath: string, activeTaskIds: string[] = [], activeSwarmIds: string[] = []) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.findOrphanedWorktreesAndBranches(safeProject, activeTaskIds, activeSwarmIds);
  });

  ipcMain.handle('git:worktree:cleanOrphaned', async (_event, projectPath: string, worktreePaths: string[], branches: string[]) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await worktreeService.cleanOrphanedWorktreesAndBranches(safeProject, worktreePaths, branches);
  });

  // Pull & Merge Requests
  ipcMain.handle('pr:getProviderInfo', async (_event, projectPath: string) => {
    return await prService.getProviderInfo(projectPath);
  });

  ipcMain.handle('pr:list', async (_event, projectPath: string, state?: 'all' | 'open' | 'closed' | 'merged') => {
    return await prService.listPullRequests(projectPath, state);
  });

  ipcMain.handle('pr:create', async (_event, projectPath: string, options: PRCreateOptions) => {
    return await prService.createPullRequest(projectPath, options);
  });

  ipcMain.handle('pr:getDiff', async (_event, projectPath: string, prNumber: number) => {
    return await prService.getPRDiff(projectPath, prNumber);
  });

  // PR на слое подключений (TASK-138.2, decision-105)
  ipcMain.handle('pr:setConnection', async (_event, projectPath: string, connectionId: string | null) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await prService.setProjectConnection(safeProject, connectionId ? String(connectionId) : null);
  });

  ipcMain.handle('pr:setMergeStatus', async (_event, projectPath: string, status: string | null) => {
    const safeProject = await assertRegisteredProject(projectPath);
    const wanted = typeof status === 'string' ? status.trim() : '';
    if (!wanted) return await prService.setMergeStatus(safeProject, null);
    // Только статус из конфига проекта, в его написании: иначе задача ушла бы в колонку, которой нет.
    const known = (await readBacklogConfig(safeProject)).statuses.find((s) => s.toLowerCase() === wanted.toLowerCase());
    if (!known) throw new AppError('pr.statusNotInConfig', { status: wanted });
    return await prService.setMergeStatus(safeProject, known);
  });

  ipcMain.handle('pr:importCliLogin', async (_event, projectPath: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await prService.importCliLogin(safeProject);
  });

  ipcMain.handle('pr:forTask', async (_event, projectPath: string, taskId: string) => {
    const safeProject = await assertRegisteredProject(projectPath);
    return await prService.getTaskPullRequests(safeProject, String(taskId ?? ''));
  });
}
