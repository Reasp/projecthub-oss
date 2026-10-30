import type { GitWorktreeInfo } from '../types/electron';
import { useProjectStore } from './useProjectStore';
import { useAIStudioStore } from './useAIStudioStore';
import { useSwarmStore } from './useSwarmStore';
import { findTaskWorktree, sameWorkPath, taskWorktreeBranch } from '../lib/studioWorktree';

export interface StartTaskInWorktreeResult {
  worktree: GitWorktreeInfo | null;
  /** Дерево создано сейчас (ветка новая или уже была без дерева), а не переиспользовано. */
  created: boolean;
  sessionId?: string;
}

/**
 * «Начать в worktree» из карточки задачи (TASK-268, decision-195): дерево `task/<id>` создаётся или
 * переиспользуется, при создании main выполняет `worktreeInit`; дерево становится активным, и открывается вкладка
 * Agents Studio, закреплённая за ним, с задачей в контексте. Вкладка этой задачи в этом дереве уже открыта — она и
 * выбирается, вторая не создаётся.
 */
export async function startTaskInWorktree(task: { id: string; title: string }): Promise<StartTaskInWorktreeResult> {
  const projectStore = useProjectStore.getState();
  const project = projectStore.selectedProject;
  if (!project) return { worktree: null, created: false };

  // Список деревьев мог устареть (дерево создали из терминала или CLI) — перечитываем перед созданием.
  let worktree = findTaskWorktree(projectStore.worktrees, task.id);
  if (!worktree) worktree = findTaskWorktree(await projectStore.loadWorktreesAction(project.path), task.id);

  let created = false;
  if (!worktree) {
    const branch = taskWorktreeBranch(task.id);
    // Ветка задачи осталась после удаления дерева (TASK-267 сохраняет работу в ней) — выписываем её, а не создаём.
    const branchExists = (useProjectStore.getState().gitRepoDetails?.branches || []).some((b) => b.toLowerCase() === branch);
    worktree = (await projectStore.createWorktreeAction(branch, !branchExists, branchExists ? undefined : 'HEAD')) ?? undefined;
    created = !!worktree;
  }
  if (!worktree) return { worktree: null, created: false };

  await useProjectStore.getState().setActiveWorktree(worktree.path);

  const studio = useAIStudioStore.getState();
  await studio.loadSessions(project.path);
  const taskId = task.id;
  const existing = (useAIStudioStore.getState().sessions[project.path] || []).find(
    (s) => s.activeTaskId?.toLowerCase() === taskId.toLowerCase() && sameWorkPath(s.worktree?.path, worktree!.path)
  );
  let sessionId: string;
  if (existing) {
    sessionId = existing.id;
    studio.switchSession(project.path, sessionId);
  } else {
    sessionId = studio.createSession(project.path, `${task.id}: ${task.title}`.slice(0, 120), {
      worktree: { path: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}) },
      taskId
    });
  }

  useSwarmStore.getState().requestAiView('studio');
  useProjectStore.getState().setActiveTab('ai');
  return { worktree, created, sessionId };
}
