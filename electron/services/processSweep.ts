import { execFile, type ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import {
  createSnapshotCache,
  DISPLAY_SNAPSHOT_MAX_AGE_MS,
  resolveEntryStatuses,
  type EnvEntryStatus,
  type EnvIdentityEntry
} from './envRegistryIdentity';
import { windowsSnapshotSource } from './windowsProcessSnapshot';

/**
 * Добивание потомков оболочки, переживших tree-kill (TASK-97, decision-37).
 *
 * На Windows tree-kill — это `taskkill /T /F` по снимку дерева. Если оболочка порождает
 * процесс уже после снимка, он остаётся жить с ParentProcessId мёртвой оболочки и держит
 * унаследованные stdio. Такие процессы находятся по цепочке ParentProcessId от PID оболочки;
 * время создания отсекает чужие процессы при повторном использовании PID.
 */

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Время создания, мс Unix; 0 — неизвестно (системные процессы). */
  createdAt: number;
}

/** Допуск на расхождение времени создания процесса и отметки `Date.now()` перед spawn. */
export const SWEEP_CREATION_SLACK_MS = 2000;

/** Разница эпох FILETIME (1601-01-01) и Unix, мс. */
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;

/**
 * FILETIME (сотни наносекунд с 1601 года, десятичной строкой) в мс Unix с отбрасыванием долей — как
 * `DateTimeOffset.ToUnixTimeMilliseconds()` и `Process.StartTime`. Число FILETIME больше 2^53, поэтому делим строкой.
 * `0` и время до 1970 года — 0 («неизвестно»).
 */
export function fileTimeToUnixMs(fileTime: string): number {
  if (fileTime.length <= 4) return 0;
  const ms = Number(fileTime.slice(0, -4)) - FILETIME_UNIX_EPOCH_MS;
  return ms > 0 ? ms : 0;
}

/** Разбирает строки `pid,ppid,FILETIME` из снимка процессов (decision-97); мусорные строки пропускаются. */
export function parseProcessList(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+),(\d+),(\d+)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: fileTimeToUnixMs(m[3]) });
  }
  return out;
}

/**
 * Все потомки `rootPid` (сам корень может быть уже мёртв и отсутствовать в снимке).
 * Потомок должен быть создан не раньше родителя (с допуском `slackMs`): иначе его
 * ParentProcessId указывает на прежнего владельца переиспользованного PID.
 */
export function collectDescendantPids(
  entries: ProcessEntry[],
  rootPid: number,
  rootStartedAt: number,
  slackMs = SWEEP_CREATION_SLACK_MS
): number[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const e of entries) {
    if (e.pid === e.ppid) continue;
    const list = byParent.get(e.ppid) ?? [];
    list.push(e);
    byParent.set(e.ppid, list);
  }
  const result: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; createdAt: number }> = [{ pid: rootPid, createdAt: rootStartedAt }];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const e of byParent.get(parent.pid) ?? []) {
      if (seen.has(e.pid)) continue;
      if (e.createdAt === 0 || e.createdAt < parent.createdAt - slackMs) continue;
      seen.add(e.pid);
      result.push(e.pid);
      queue.push({ pid: e.pid, createdAt: e.createdAt });
    }
  }
  return result;
}

/** Предельное время снимка процессов для статусов и остановки записей env-tools (показ не должен висеть). */
export const LIST_PROCESSES_TIMEOUT_MS = 15_000;

/**
 * Предельное время снимка при добивании потомков после остановки (decision-93 п. 9). Снимок идёт уже после выхода
 * оболочки и никого не блокирует, а сдавшийся обход оставляет сирот. Первый снимок включает запуск помощника
 * PowerShell (decision-97): при 24 busy-процессах на 16 ядрах это ~3 с, разовый CIM запасного пути — до 21 с.
 */
export const SWEEP_SNAPSHOT_TIMEOUT_MS = 30_000;

/** Снимок процессов Windows (pid, ppid, время создания) через общий помощник (decision-97). */
export async function listWindowsProcesses(timeoutMs = LIST_PROCESSES_TIMEOUT_MS): Promise<ProcessEntry[]> {
  return parseProcessList(await windowsSnapshotSource.snapshot(timeoutMs));
}

/**
 * Разбирает вывод `ps -A -o pid=,ppid=,lstart=` (LC_ALL=C): `pid ppid Mon Sep 28 01:05:00 2026`.
 * Время — локальное, секундная точность; нечитаемое время даёт createdAt 0.
 */
export function parsePsProcessList(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[3]);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: Number.isFinite(ms) ? ms : 0 });
  }
  return out;
}

/** Снимок процессов POSIX (pid, ppid, время создания) — источник тот же, что у env-tools (`ps lstart`). */
export function listPosixProcesses(timeoutMs = LIST_PROCESSES_TIMEOUT_MS): Promise<ProcessEntry[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,lstart='],
      { timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(parsePsProcessList(String(stdout))))
    );
  });
}

/** Снимок процессов текущей ОС. */
export function listProcesses(): Promise<ProcessEntry[]> {
  return process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
}

/**
 * Общий кэш снимка для сверки записей реестра env-tools (TASK-111, decision-60): вкладка процессов
 * и сканер проектов берут снимок не старше `DISPLAY_SNAPSHOT_MAX_AGE_MS`, остановка — всегда свежий.
 */
export const processSnapshotCache = createSnapshotCache(listProcesses);

/**
 * Статусы записей реестра env-tools одним снимком процессов (TASK-111, decision-60).
 * `fresh` — для остановки: снимок не из кэша, при ошибке снимка — исключение.
 */
export function envToolsEntryStatuses(
  entries: EnvIdentityEntry[],
  { fresh = false }: { fresh?: boolean } = {}
): Promise<EnvEntryStatus[]> {
  return resolveEntryStatuses(entries, {
    fresh,
    strict: fresh,
    snapshot: ({ fresh: f }) => processSnapshotCache.get(f ? 0 : DISPLAY_SNAPSHOT_MAX_AGE_MS)
  });
}

/**
 * Убивает оставшихся потомков завершившейся оболочки. Возвращает PID, которым отправлен kill.
 * Только Windows: на POSIX осиротевший процесс переподчиняется init и по ppid не находится.
 */
export async function sweepOrphanedDescendants(rootPid: number, rootStartedAt: number): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const pids = collectDescendantPids(await listWindowsProcesses(SWEEP_SNAPSHOT_TIMEOUT_MS), rootPid, rootStartedAt);
  await Promise.all(
    pids.map((pid) => new Promise<void>((resolve) => treeKill(pid, 'SIGKILL', () => resolve())))
  );
  return pids;
}

/** Сколько ждать 'close' после 'exit' (после остановки — после добивания потомков). */
export const CHILD_CLOSE_GRACE_MS = 1500;

export interface ChildExitSupervisor {
  /** Остановка: tree-kill живого процесса; уже вышедшего — добивание переживших его потомков. */
  kill(): void;
  /** Снять таймер ожидания: результат уже выдан по другому пути (например, 'error'). */
  dispose(): void;
}

export interface SuperviseChildExitOptions {
  /** Отметка `Date.now()` перед spawn — защита обхода потомков от переиспользования PID. */
  startedAt: number;
  /** Остановка живого процесса (tree-kill). */
  killTree: (child: ChildProcess) => void;
  /** Вызывается один раз: по 'close' или по истечении ожидания после 'exit'. */
  onDone: (code: number | null) => void;
  graceMs?: number;
}

/**
 * Ограниченное ожидание завершения дочернего процесса (decision-37, TASK-97, TASK-99).
 *
 * 'close' приходит, только когда закрыты все копии stdio, включая унаследованные потомками;
 * потомок, переживший tree-kill или намеренно оставленный в фоне, держал бы его бесконечно.
 * Поэтому результат выдаётся не позже `graceMs` после 'exit', затем потоки уничтожаются.
 * После `kill()` пережившие tree-kill потомки добиваются, и ожидание начинается после этого.
 * Без `kill()` потомков не трогаем: фоновый процесс мог быть намеренным.
 */
export function superviseChildExit(child: ChildProcess, options: SuperviseChildExitOptions): ChildExitSupervisor {
  const graceMs = options.graceMs ?? CHILD_CLOSE_GRACE_MS;
  let done = false;
  let killRequested = false;
  let swept = false;
  let exitCode: number | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const sweep = (): Promise<unknown> => {
    if (swept || !child.pid) return Promise.resolve();
    swept = true;
    return sweepOrphanedDescendants(child.pid, options.startedAt).catch(() => []);
  };
  const dispose = () => {
    done = true;
    if (closeTimer) clearTimeout(closeTimer);
  };
  const finish = (code: number | null) => {
    if (done) return;
    dispose();
    options.onDone(code);
  };

  child.on('exit', (code) => {
    exitCode = code;
    const afterSweep = killRequested ? sweep() : Promise.resolve();
    void afterSweep.then(() => {
      if (done) return;
      closeTimer = setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, graceMs);
    });
  });
  child.on('close', (code) => finish(code ?? exitCode));

  return {
    kill: () => {
      killRequested = true;
      if (child.exitCode !== null || child.signalCode !== null) void sweep();
      else options.killTree(child);
    },
    dispose
  };
}
