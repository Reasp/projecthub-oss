import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * Источник снимка процессов Windows (TASK-163, decision-97).
 *
 * Основной путь — долгоживущий `powershell.exe`, который на каждую строку stdin делает один системный вызов
 * `NtQuerySystemInformation(SystemProcessInformation)` и печатает `pid,ppid,FILETIME` по процессу. Под полной
 * нагрузкой CPU прежний разовый скрипт `Get-CimInstance Win32_Process | ForEach-Object` шёл десятки секунд: время
 * съедали запуск PowerShell, провайдер WMI и конвейер по объектам. Запасной путь — разовый запрос CIM только нужных
 * свойств, если помощник не запустился (политика, AMSI, 32-битная PowerShell). Формат вывода у обоих путей один.
 */

/** P/Invoke через Reflection.Emit, без `Add-Type` (тот запускает csc.exe). `PreserveSig` — код NTSTATUS числом. */
const NT_SETUP =
  "$ErrorActionPreference = 'Stop'; " +
  "if ([IntPtr]::Size -ne 8) { throw 'нужна 64-битная PowerShell' }; " +
  "$a = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'PhSnap'), 'Run'); " +
  "$t = $a.DefineDynamicModule('PhSnap').DefineType('PhNt', 'Public,Class'); " +
  "$t.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', 'Public,Static,PinvokeImpl', 'Standard', [int], " +
  "[Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig'); " +
  '$nt = $t.CreateType(); $M = [Runtime.InteropServices.Marshal]; $size = 1MB; ';

/**
 * Один снимок: буфер растёт, пока ядро отвечает STATUS_INFO_LENGTH_MISMATCH (0xC0000004). Поля x64
 * SYSTEM_PROCESS_INFORMATION: NextEntryOffset +0x00, CreateTime +0x20, UniqueProcessId +0x50,
 * InheritedFromUniqueProcessId +0x58.
 */
const NT_SNAPSHOT =
  '$len = 0; while ($true) { $buf = $M::AllocHGlobal($size); $st = $nt::NtQuerySystemInformation(5, $buf, $size, [ref]$len); ' +
  "if ($st -eq 0) { break }; $M::FreeHGlobal($buf); if ($st -ne -1073741820) { throw ('NTSTATUS 0x{0:X8}' -f $st) }; $size = $len + 256KB }; " +
  '$b = [Text.StringBuilder]::new(65536); $off = 0; ' +
  'try { while ($true) { $p = [IntPtr]::Add($buf, $off); ' +
  "[void]$b.Append($M::ReadInt64($p, 0x50)).Append(',').Append($M::ReadInt64($p, 0x58)).Append(',').Append($M::ReadInt64($p, 0x20)).Append(\"`n\"); " +
  '$next = $M::ReadInt32($p, 0); if ($next -eq 0) { break }; $off += $next } } finally { $M::FreeHGlobal($buf) }; ' +
  '[Console]::Out.Write($b.ToString())';

/** Маркеры протокола помощника: конец ответа и ошибка снимка (строки данных — только цифры и запятые). */
export const HELPER_END = '#end';
export const HELPER_ERROR = '#error';

/** Скрипт помощника: снимок на каждую строку stdin; конец stdin (выход ProjectHub) — выход PowerShell. */
export const HELPER_SCRIPT =
  NT_SETUP +
  'while ($null -ne [Console]::In.ReadLine()) { ' +
  `try { ${NT_SNAPSHOT} } catch { [Console]::Out.Write("${HELPER_ERROR} " + ($_.Exception.Message -replace '\\s+', ' ') + "\`n") }; ` +
  `[Console]::Out.Write("${HELPER_END}\`n"); [Console]::Out.Flush() }`;

/** Запасной разовый снимок: CIM только трёх свойств, без конвейера; дата — FILETIME, как у помощника. */
export const CIM_SNAPSHOT_SCRIPT =
  '$b = [Text.StringBuilder]::new(65536); ' +
  'foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) { ' +
  "$c = $p.CreationDate; [void]$b.Append($p.ProcessId).Append(',').Append($p.ParentProcessId).Append(',')" +
  '.Append($(if ($c) { $c.ToFileTimeUtc() } else { 0 })).Append("`n") }; ' +
  '[Console]::Out.Write($b.ToString())';

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

/** Сколько помощник живёт без запросов: вкладка процессов опрашивает каждые 5 с, после неё процесс не нужен. */
export const HELPER_IDLE_MS = 30_000;

export interface WindowsSnapshotSourceDeps {
  spawnHelper: () => ChildProcess;
  /** Разовый снимок запасным путём; текст в формате помощника. */
  runFallback: (timeoutMs: number) => Promise<string>;
  idleMs?: number;
  log?: (message: string) => void;
}

export interface WindowsSnapshotSource {
  /** Текст снимка `pid,ppid,FILETIME` по строкам; каждый вызов — новый снимок, сделанный после вызова. */
  snapshot(timeoutMs: number): Promise<string>;
  /** Остановить помощника (тесты; при выходе ProjectHub он завершается сам по закрытию stdin). */
  dispose(): void;
}

interface Pending {
  timeoutMs: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

interface Helper {
  proc: ChildProcess;
  /** Помощник уже отдал хотя бы один снимок: его падение — сбой, а не «помощник недоступен». */
  served: boolean;
  tail: string;
  lines: string[];
  error?: string;
}

/**
 * Очередь снимков через одного помощника. Запросы не объединяются: снимок для добивания потомков должен быть сделан
 * после выхода оболочки, поэтому каждый запрос получает свой вызов. Тайм-аут убивает помощника, следующий запрос
 * запускает нового. Если помощник не отдал ни одного снимка (не запустился), источник до конца сессии переходит на
 * запасной путь.
 */
export function createWindowsSnapshotSource(deps: WindowsSnapshotSourceDeps): WindowsSnapshotSource {
  const idleMs = deps.idleMs ?? HELPER_IDLE_MS;
  const queue: Pending[] = [];
  let helper: Helper | null = null;
  let current: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let unavailable = false;

  const viaFallback = (req: Pending) => {
    deps.runFallback(req.timeoutMs).then(req.resolve, req.reject);
  };

  const stopHelper = () => {
    const h = helper;
    helper = null;
    if (!h) return;
    h.proc.removeAllListeners();
    h.proc.stdout?.removeAllListeners();
    h.proc.on('error', () => undefined);
    h.proc.kill();
  };

  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    current = null;
  };

  const goUnavailable = (reason: string) => {
    unavailable = true;
    deps.log?.(`снимок процессов: помощник недоступен (${reason}), дальше — разовый запрос CIM`);
    stopHelper();
    const waiting = [current, ...queue.splice(0)].filter((r): r is Pending => r !== null);
    finish();
    for (const req of waiting) viaFallback(req);
  };

  const onHelperGone = (h: Helper, reason: string) => {
    if (helper !== h) return;
    if (!h.served) {
      goUnavailable(reason);
      return;
    }
    // Помощник работал и упал: текущий запрос — запасным путём, следующий запустит нового помощника.
    deps.log?.(`снимок процессов: помощник завершился (${reason})`);
    helper = null;
    const req = current;
    finish();
    if (req) viaFallback(req);
    pump();
  };

  const onLine = (h: Helper, line: string) => {
    if (line === HELPER_END) {
      const req = current;
      const error = h.error;
      const text = h.lines.join('\n');
      h.lines = [];
      h.error = undefined;
      finish();
      if (error !== undefined) {
        // Ошибка самого снимка (не тайм-аут): помощник жив, но этот источник не годится.
        if (req) queue.unshift(req);
        goUnavailable(error);
        return;
      }
      h.served = true;
      req?.resolve(text);
      pump();
      return;
    }
    if (line.startsWith(HELPER_ERROR)) h.error = line.slice(HELPER_ERROR.length).trim() || 'ошибка снимка';
    else if (line) h.lines.push(line);
  };

  const startHelper = (): Helper => {
    const proc = deps.spawnHelper();
    const h: Helper = { proc, served: false, tail: '', lines: [] };
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      const parts = (h.tail + chunk).split(/\r?\n/);
      h.tail = parts.pop() ?? '';
      for (const line of parts) {
        if (helper !== h) return;
        onLine(h, line.trim());
      }
    });
    proc.on('error', (err) => onHelperGone(h, err.message));
    proc.on('exit', (code) => onHelperGone(h, `код ${code}`));
    // Запись в stdin умершего помощника — EPIPE; о смерти сообщит 'exit'.
    proc.stdin?.on('error', () => undefined);
    // Помощник не держит ProjectHub и тесты живыми: пока ждём ответ, цикл событий держит таймер тайм-аута.
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) (s as { unref?: () => void } | null)?.unref?.();
    return h;
  };

  const pump = () => {
    if (current || queue.length === 0) {
      if (!current && helper && !idleTimer) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          if (!current && queue.length === 0) stopHelper();
        }, idleMs);
        idleTimer.unref?.();
      }
      return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const req = queue.shift()!;
    if (unavailable) {
      viaFallback(req);
      pump();
      return;
    }
    current = req;
    if (!helper) {
      try {
        helper = startHelper();
      } catch (err) {
        goUnavailable(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const h = helper;
    timer = setTimeout(() => {
      if (current !== req) return;
      finish();
      stopHelper();
      req.reject(new Error(`the process snapshot did not finish within ${req.timeoutMs} ms`));
      pump();
    }, req.timeoutMs);
    h.proc.stdin?.write('\n');
  };

  return {
    snapshot(timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        queue.push({ timeoutMs, resolve, reject });
        pump();
      });
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      stopHelper();
    }
  };
}

function spawnPowerShellHelper(): ChildProcess {
  return spawn('powershell.exe', [...POWERSHELL_ARGS, HELPER_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

function runCimSnapshot(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...POWERSHELL_ARGS, CIM_SNAPSHOT_SCRIPT],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    );
  });
}

/** Общий источник main-процесса: один помощник на всё приложение. */
export const windowsSnapshotSource = createWindowsSnapshotSource({
  spawnHelper: spawnPowerShellHelper,
  runFallback: runCimSnapshot,
  log: (message) => console.warn(`[processSweep] ${message}`)
});
