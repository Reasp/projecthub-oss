/**
 * Выполнение одной проверки проекта в рабочем каталоге (decision-20, TASK-61, TASK-75).
 *
 * Общий путь для автосудьи арены и цикла «до готовности»: разовый запуск через
 * `processManager.runOnce`, разбор счётчиков и хвоста вывода — чтобы оба режима видели
 * одинаковые статусы и одинаково обрезанный вывод. Проверка `ui-smoke` получает каталог
 * артефактов в `<userData>/visual` и сдаёт скриншоты/trace (TASK-78, decision-55).
 */
import { processManager, type RunOnceResult } from './processManager.js';
import { CHECK_OUTPUT_TAIL_CHARS, checkStatusFromExit, parseCheckOutput, tailOutput } from './arenaChecks.js';
import { ARTIFACTS_DIR_ENV, isUiSmokeCheck, substituteArtifactsDir } from './visualArtifacts.js';
import { visualArtifactService, type PreparedArtifactsDir } from './visualArtifactService.js';
import type { CheckDefinition, CheckRunResult } from './arenaTypes.js';
import { AppError } from '../../src/lib/appError.js';

/** Пустой результат проверки до запуска. */
/** Причина пропуска или ошибки проверки: английский текст и код (decision-165). */
export function checkDetailOf(err: AppError): Pick<CheckRunResult, 'detail' | 'detailKey'> {
  return { detail: err.message, detailKey: err.appErrorKey };
}

export function setCheckDetail(result: CheckRunResult, err: AppError): void {
  Object.assign(result, checkDetailOf(err));
}

export function pendingCheckResult(def: CheckDefinition): CheckRunResult {
  return {
    id: def.id,
    kind: def.kind,
    name: def.name,
    command: def.command,
    status: 'pending',
    blocking: def.blocking !== false
  };
}

/** Где хранить артефакты `ui-smoke`: сессия, агент и прогон (`judge-…`, `iter-N`). Без него — `adhoc`. */
export interface CheckArtifactsTarget {
  scope: string;
  agentId?: string;
  run: string;
}

/**
 * Запуск проверки в контейнере изолированного участника (TASK-246, [[decision-191]]): скрипты проверок пишет его
 * агент, хост их не выполняет. Сети у контейнера нет, порт не подбирается.
 */
export type CheckSandboxRunner = (command: string, options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<RunOnceResult>;

export interface ExecuteCheckOptions {
  artifacts?: CheckArtifactsTarget;
  sandbox?: CheckSandboxRunner;
}

/**
 * Запускает команду проверки и заполняет `result` (мутирует — UI видит промежуточные состояния
 * через ссылку на объект в сессии). Не бросает: ошибка запуска оседает в статусе `error`.
 */
export async function executeCheck(
  result: CheckRunResult,
  def: Pick<CheckDefinition, 'command' | 'timeoutMs' | 'portStrategy' | 'port'> & Partial<Pick<CheckDefinition, 'artifacts'>>,
  workdir: string,
  signal?: AbortSignal,
  options: ExecuteCheckOptions = {}
): Promise<CheckRunResult> {
  result.status = 'running';
  result.startedAt = Date.now();

  let prepared: PreparedArtifactsDir | null = null;
  let command = def.command;
  const env: Record<string, string> = {};
  if (options.sandbox && isUiSmokeCheck(result)) {
    // Браузера в образе участника нет, а каталог артефактов хоста в контейнер не монтируется: его файлы хост собирал бы
    // по путям, которые пишет агент. Блокирующая проверка не выполнена — это ошибка, а не пропуск: очередь и цикл не
    // пропустят результат без неё (ревью TASK-246).
    result.status = result.blocking ? 'error' : 'skipped';
    setCheckDetail(result, new AppError('checks.sandboxUiSmoke'));
    return result;
  }
  if (isUiSmokeCheck(result)) {
    const target = options.artifacts ?? { scope: 'adhoc', run: `run-${result.startedAt}` };
    try {
      prepared = await visualArtifactService.prepare({ ...target, checkId: result.id });
      env[ARTIFACTS_DIR_ENV] = prepared.absDir;
      command = substituteArtifactsDir(command, prepared.absDir);
    } catch (err) {
      console.warn('[CheckRunner] Не удалось подготовить каталог артефактов:', err);
    }
  }

  let run: RunOnceResult;
  try {
    run = options.sandbox
      ? await options.sandbox(command, { ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}), ...(signal ? { signal } : {}) })
      : await processManager.runOnce(command, {
          cwd: workdir,
          timeoutMs: def.timeoutMs,
          signal,
          env,
          portStrategy: def.portStrategy,
          port: def.port
        });
  } catch (err) {
    // Контейнер не собрался (план отклонён): проверка не выполнена, причина — кодом.
    result.status = 'error';
    result.durationMs = Date.now() - (result.startedAt ?? Date.now());
    if (err instanceof AppError) setCheckDetail(result, err);
    else result.detail = err instanceof Error ? err.message : String(err);
    return result;
  }

  const counters = parseCheckOutput(result.kind, run.output);
  const { text, truncated } = tailOutput(run.output, CHECK_OUTPUT_TAIL_CHARS);
  result.exitCode = run.exitCode ?? undefined;
  result.durationMs = run.durationMs;
  result.outputTail = text;
  result.outputTruncated = truncated || run.truncated;
  Object.assign(result, counters);
  if (run.error && run.exitCode === null) {
    result.status = signal?.aborted ? 'skipped' : 'error';
    result.detail = run.error;
    if (run.errorKey) result.detailKey = run.errorKey;
  } else {
    result.status = checkStatusFromExit(run.exitCode, run.timedOut);
  }

  if (prepared) {
    // Скриншоты собираем и у упавшей проверки: по ним видно, что сломалось.
    await visualArtifactService.collect(result, prepared, workdir, def.artifacts);
    void visualArtifactService.prune(options.artifacts?.scope).catch(() => {});
  }
  return result;
}
