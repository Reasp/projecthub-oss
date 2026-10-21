import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserDataDir } from './appPaths.js';

/**
 * Журнал записывающих действий с удалённых устройств (decision-126 п. 6): кто — устройство и участник общего хоста, что —
 * метод RPC и его цель, чем закончилось. HITL пишет свой журнал решений (`hitlAudit.ts`); здесь — всё остальное:
 * статусы задач, захват задачи, коммиты, запуск агентов, процессы.
 *
 * Файлы — `<userData>/audit/remote-<yyyy-mm>.jsonl`, рядом с журналом HITL. Содержимое промптов, сообщений и файлов в
 * журнал не попадает — только идентификаторы.
 */
export const REMOTE_AUDIT_VERSION = 1;

export interface RemoteAuditEntry {
  v: number;
  ts: number;
  method: string;
  ok: boolean;
  error?: string;
  deviceId: string;
  deviceName?: string;
  /** Пусто — владелец хоста. */
  memberId?: string;
  projectPath?: string;
  /** Цель действия: задача, файл задачи, процесс, сессия роя, роль. */
  target?: Record<string, string>;
  /** Отказ по праву устройства на проект (TASK-180) — пишется и для методов чтения. */
  denied?: 'project';
  /**
   * Действие сделал владелец, а не устройство (`deviceId` — чьи права меняли): в окне ПК или командой ph-agent
   * на самом хосте (decision-147).
   */
  actor?: 'window' | 'cli';
}

const TARGET_FIELDS = ['taskId', 'filePath', 'processId', 'name', 'processName', 'swarmId', 'roleSlug', 'requestId', 'ruleId', 'actionId', 'newStatus'] as const;

/** Только идентификаторы из параметров: пути файлов — без каталогов, значения обрезаны. */
export function auditTarget(params: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!params) return undefined;
  const out: Record<string, string> = {};
  for (const key of TARGET_FIELDS) {
    const v = params[key];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v);
    out[key] = (key === 'filePath' ? path.basename(s) : s).slice(0, 160);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function remoteAuditFile(dir: string, ts: number): string {
  const d = new Date(ts);
  return path.join(dir, `remote-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
}

let writes: Promise<unknown> = Promise.resolve();

/** Запись в журнал; сбой записи не ломает само действие — только предупреждение в лог. */
export function appendRemoteAudit(entry: Omit<RemoteAuditEntry, 'v'>, dir = path.join(getUserDataDir(), 'audit')): Promise<void> {
  const line = `${JSON.stringify({ v: REMOTE_AUDIT_VERSION, ...entry })}\n`;
  const op = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(remoteAuditFile(dir, entry.ts), line, 'utf8');
  };
  const next = writes.then(op, op);
  writes = next.catch((err) => console.warn('[RemoteAudit] Не удалось записать журнал:', err));
  return next.catch(() => undefined);
}
