import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import treeKill from 'tree-kill';
import { humanText, isCliSessionId } from './claudeCliSessions.js';

/**
 * `/rewind` во вкладке Agents Studio (TASK-284, decision-205). Формат Claude Code 2.1.314:
 *
 * - Файл сессии — цепочка записей с `uuid` и `parentUuid`; текущий разговор — цепочка от последней записи к корню.
 * - Перед каждой репликой человека CLI пишет `file-history-snapshot` с `messageId` реплики: `trackedFileBackups` —
 *   путь (относительно каталога сессии) → `{ backupFileName: "<хэш>@v<N>" | null, version, realParentDir }`.
 *   `null` — файла в тот момент не было. Первая правка файла в ходе пишет `file-history-delta` с `trackingPath`,
 *   `snapshotMessageId` (реплика хода) и `backup` — состоянием до правки.
 * - Копии лежат в `<CLAUDE_CONFIG_DIR>/file-history/<сессия>/<backupFileName>`. В `-p` CLI ведёт их только с
 *   `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` — Studio задаёт её на каждом ходе.
 * - Без терминала откатывают скрытые флаги: `--resume <id> --rewind-files <uuid реплики>` возвращает файлы к состоянию
 *   перед репликой и выходит; `--resume <id> --resume-session-at <uuid> --fork-session` продолжает разговор в новой
 *   сессии только до записи `<uuid>` включительно.
 */

/** Переменная, без которой `claude -p` не снимает копии файлов перед правками. */
export const CLI_FILE_CHECKPOINTING_ENV = 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING';

export interface CliRewindPoint {
  /** uuid реплики человека — к состоянию перед ней откатываются файлы. */
  uuid: string;
  /** Запись перед репликой: разговор продолжается с неё (`--resume-session-at`); `null` — реплика первая. */
  keepUuid: string | null;
  text: string;
  timestamp: string;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
  messageId?: unknown;
  snapshotMessageId?: unknown;
  trackingPath?: unknown;
  backup?: unknown;
  snapshot?: { trackedFileBackups?: unknown };
}

function parseEntries(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (entry && typeof entry === 'object') out.push(entry as Entry);
    } catch {
      // Неполная первая строка хвоста или битая строка — пропускаем.
    }
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Реплики человека текущего разговора по порядку: цепочка `parentUuid` от последней записи, побочные ветки не входят. */
export function cliRewindPoints(text: string): CliRewindPoint[] {
  const entries = parseEntries(text);
  const byUuid = new Map<string, Entry>();
  let leaf: string | null = null;
  for (const e of entries) {
    const uuid = str(e.uuid);
    if (!uuid) continue;
    byUuid.set(uuid, e);
    if ((e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true) leaf = uuid;
  }
  const points: CliRewindPoint[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id && !seen.has(id); ) {
    seen.add(id);
    const e = byUuid.get(id);
    if (!e) break;
    if (e.type === 'user' && e.isMeta !== true && e.isCompactSummary !== true) {
      const content = humanText(e.message?.content).replace(/^\uFEFF/, '').trim();
      if (content) points.push({ uuid: id, keepUuid: str(e.parentUuid), text: content, timestamp: str(e.timestamp) ?? '' });
    }
    id = str(e.parentUuid);
  }
  return points.reverse();
}

export interface CliFileTarget {
  /** Путь относительно каталога сессии, как его пишет CLI. */
  trackingPath: string;
  /** Абсолютный путь файла. */
  absPath: string;
  /** Имя копии в `file-history/<сессия>/`; `null` — после отката файла не будет. */
  backupFileName: string | null;
}

interface BackupRef {
  backupFileName?: unknown;
  realParentDir?: unknown;
}

function target(trackingPath: string, backup: BackupRef, cwd: string): CliFileTarget {
  const realParentDir = str(backup.realParentDir);
  return {
    trackingPath,
    absPath: realParentDir ? path.join(realParentDir, path.basename(trackingPath.replace(/\\/g, '/'))) : path.resolve(cwd, trackingPath),
    backupFileName: str(backup.backupFileName)
  };
}

/**
 * Каким станет каждый файл после отката к реплике `promptUuid`: копия из снимка этой реплики, а для файлов, которые
 * агент тронул позже впервые, — самая ранняя копия после неё (состояние до первой правки). Учитываются только
 * реплики текущего разговора.
 */
export function cliRewindTargets(text: string, promptUuid: string, cwd: string): CliFileTarget[] {
  const order = new Map(cliRewindPoints(text).map((p, i) => [p.uuid, i]));
  const at = order.get(promptUuid);
  if (at === undefined) return [];
  const entries = parseEntries(text);
  const targets = new Map<string, CliFileTarget>();
  // Снимок самой реплики (последний, если CLI его обновлял).
  for (const e of entries) {
    if (e.type !== 'file-history-snapshot' || e.messageId !== promptUuid) continue;
    targets.clear();
    const tracked = e.snapshot?.trackedFileBackups;
    if (tracked && typeof tracked === 'object') {
      for (const [p, b] of Object.entries(tracked as Record<string, BackupRef>)) targets.set(p, target(p, b ?? {}, cwd));
    }
  }
  const later = new Map<string, CliFileTarget>();
  for (const e of entries) {
    if (e.type === 'file-history-delta') {
      const turn = order.get(str(e.snapshotMessageId) ?? '');
      const p = str(e.trackingPath);
      if (turn === undefined || turn < at || !p || targets.has(p) || later.has(p)) continue;
      later.set(p, target(p, (e.backup as BackupRef) ?? {}, cwd));
    } else if (e.type === 'file-history-snapshot') {
      const turn = order.get(str(e.messageId) ?? '');
      const tracked = e.snapshot?.trackedFileBackups;
      if (turn === undefined || turn <= at || !tracked || typeof tracked !== 'object') continue;
      for (const [p, b] of Object.entries(tracked as Record<string, BackupRef>)) {
        if (!targets.has(p) && !later.has(p)) later.set(p, target(p, b ?? {}, cwd));
      }
    }
  }
  return [...targets.values(), ...later.values()];
}

export type CliFileChange = 'modify' | 'delete' | 'restore';

export interface CliRewindFile {
  path: string;
  /** `modify` — содержимое вернётся к прежнему, `delete` — файл удалится, `restore` — удалённый файл вернётся. */
  change: CliFileChange;
}

/** Сравнение текущего файла с копией: что сделает откат. `null` — файл уже в нужном состоянии. */
export function fileChange(current: Buffer | null, backup: Buffer | null, backupExpected: boolean): CliFileChange | null {
  if (!backupExpected) return current ? 'delete' : null;
  if (!current) return 'restore';
  // Копии нет на диске — откат файл всё равно перепишет, не утверждаем, что он совпадает.
  if (!backup) return 'modify';
  return current.equals(backup) ? null : 'modify';
}

const readOrNull = (file: string) => fs.readFile(file).catch(() => null);

/** Файлы, которые изменит откат к реплике: сравнение текущих файлов с копиями CLI (аналог `dryRun` SDK). */
export async function cliRewindPreview(configDir: string, cwd: string, sessionId: string, transcript: string, promptUuid: string): Promise<CliRewindFile[]> {
  const out: CliRewindFile[] = [];
  for (const t of cliRewindTargets(transcript, promptUuid, cwd)) {
    const backup = t.backupFileName ? await readOrNull(path.join(configDir, 'file-history', sessionId, t.backupFileName)) : null;
    const change = fileChange(await readOrNull(t.absPath), backup, t.backupFileName !== null);
    if (change) out.push({ path: t.trackingPath.replace(/\\/g, '/'), change });
  }
  return out;
}

export interface CliRewindFilesResult {
  ok: boolean;
  /** Вывод CLI — его собственный текст. */
  output: string;
}

const REWIND_TIMEOUT_MS = 120_000;

/** Аргументы отката файлов; uuid проверены — в командную строку оболочки не попадает ничего другого. */
export function cliRewindFilesArgs(sessionId: string, promptUuid: string): string[] {
  if (!isCliSessionId(sessionId) || !isCliSessionId(promptUuid)) throw new Error('invalid session or message id');
  return ['-p', '--resume', sessionId, '--rewind-files', promptUuid];
}

/** `claude -p --resume <id> --rewind-files <uuid>` в каталоге вкладки под её аккаунтом. */
export function runCliRewindFiles(configDir: string, cwd: string, sessionId: string, promptUuid: string): Promise<CliRewindFilesResult> {
  const args = cliRewindFilesArgs(sessionId, promptUuid);
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result: CliRewindFilesResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn('claude', args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CLAUDE_CONFIG_DIR: configDir, [CLI_FILE_CHECKPOINTING_ENV]: 'true' }
    });
    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid);
      finish({ ok: false, output: `${output}\ntimeout`.trim() });
    }, REWIND_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.on('error', (err) => finish({ ok: false, output: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, output: output.trim() }));
  });
}
