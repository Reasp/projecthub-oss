/**
 * Инструменты API-агента изолированного участника (TASK-246, [[decision-191]]). Цикл модели идёт в процессе хоста — ключ
 * провайдера в контейнер не попадает, — а всё, что делает агент, остаётся в границах его worktree и контейнера:
 *
 * - чтение, запись и список файлов — под worktree без следования симлинкам (`worktreeFs.ts`);
 * - команды — разовым контейнером участника без сети (`memberSandboxService.runShell`);
 * - фоновые процессы, управление компьютером, память проекта, «Входящие» телефона и слияние основной ветки закрыты:
 *   они выполняются хостом вне контейнера или пишут в основное дерево — как и у Claude CLI в контейнере, где из MCP
 *   доступен только запрос разрешения человека.
 *
 * HITL, аудит, поиск по документации и вопросы человеку — общие с обычным исполнителем.
 */
import path from 'node:path';
import type { ApiToolExecutorDeps } from './apiToolExecutor.js';
import type { RunOnceResult } from './processManager.js';
import { listWorktreeDir, readWorktreeFile, worktreePathExistsSync, worktreeRelative, writeWorktreeFile } from './worktreeFs.js';
import { AppError } from '../../src/lib/appError.js';

/**
 * Путь задевает метаданные git: компонент `.git` (без учёта регистра, хвостовых точек и пробелов, потока `::$DATA`) или
 * короткое имя 8.3 `GIT~N`. Хост пишет файлы API-агента сам — указатель `gitdir:` или вложенный репозиторий со своим
 * конфигом выполнили бы код агента в git хоста (ревью TASK-246).
 */
export function touchesGitMeta(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .map((seg) => seg.replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase())
    .some((seg) => seg === '.git' || /^git~\d+$/.test(seg));
}

export type SandboxShell = (command: string, options: { timeoutMs?: number; onOutput?: (text: string) => void; env?: Record<string, string> }) => Promise<RunOnceResult>;

export function sandboxedApiToolDeps(base: ApiToolExecutorDeps, worktree: string, shell: SandboxShell): ApiToolExecutorDeps {
  return {
    newRequestId: base.newRequestId,
    requestApproval: base.requestApproval,
    recordAutoDecision: base.recordAutoDecision,
    recordOutcome: base.recordOutcome,
    generateDiff: base.generateDiff,
    searchDocs: base.searchDocs,
    parseQuestion: base.parseQuestion,
    readFile: (absPath) => readWorktreeFile(worktree, absPath),
    fileExists: (absPath) => worktreePathExistsSync(worktree, absPath),
    listDir: (absPath) => listWorktreeDir(worktree, absPath),
    writeFile: async (workDir, filePath, content) => {
      const abs = path.resolve(workDir, filePath);
      if (touchesGitMeta(worktreeRelative(worktree, abs) ?? filePath)) throw new AppError('worktree.gitMeta', { path: filePath });
      await writeWorktreeFile(worktree, abs, content);
    },
    runCommand: async (command, _cwd, { timeoutMs, onOutput, env }) => {
      let soFar = '';
      const res = await shell(command, {
        ...(timeoutMs ? { timeoutMs } : {}),
        // Git-автор участника (decision-135) — переменными окружения команды в контейнере.
        ...(env ? { env } : {}),
        ...(onOutput
          ? {
              onOutput: (text: string) => {
                soFar += text;
                onOutput(soFar);
              }
            }
          : {})
      });
      return {
        output: res.error ? `${res.output}${res.output ? '\n' : ''}${res.error}` : res.output,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        truncated: res.truncated
      };
    }
  };
}
