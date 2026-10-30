import { ptyService } from './ptyService';
import { processManager } from './processManager';
import { isInsideProject } from './pathGuard';
import { logger } from './logger';

/**
 * Закрывает терминалы и процессы ProjectHub, работающие в каталоге worktree, перед его удалением (TASK-269):
 * Windows не удаляет каталог, который занят текущим каталогом процесса или открытыми файлами.
 * Чужие программы (редактор, внешний терминал) не трогаются — их занятость покажет ошибка с повтором.
 */
export async function releaseWorktreeHandles(worktreePath: string): Promise<void> {
  let terminals = 0;
  for (const session of ptyService.listSessions()) {
    if (session.status !== 'running' || !session.cwd || !isInsideProject(worktreePath, session.cwd)) continue;
    if (ptyService.kill(session.id)) terminals += 1;
  }

  let processes = 0;
  for (const proc of processManager.getAllRunningProcesses()) {
    const dirs = [proc.workspaceRoot, proc.workingDir].filter((d): d is string => Boolean(d));
    if (!dirs.some((d) => isInsideProject(worktreePath, d))) continue;
    if (await processManager.stopProcess(proc.id)) processes += 1;
  }

  if (terminals > 0 || processes > 0) {
    logger.info(`[WorktreeHandles] ${worktreePath}: closed ${terminals} terminal(s), stopped ${processes} process(es) before removal`);
  }
}
