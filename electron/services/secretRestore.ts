/**
 * Восстановление секретов из резервной копии `secrets.undecryptable.json` (TASK-154, долг decision-88).
 *
 * Чистый модуль без Electron: какие записи можно вернуть и какие из выбранных человеком вернуть на самом деле.
 * Расшифровку делает `secretStorageService` и передаёт сюда только признаки (`readable`, `equalsCurrent`),
 * поэтому значения в этот модуль не попадают.
 */
import { createHash } from 'node:crypto';
import type {
  SecretBackupItem,
  SecretBackupReason,
  SecretIssueSource,
  SecretRestoreSkipReason,
  SecretRestoreStatus
} from './secretStorageTypes.js';
import { isSoleCopy } from '../../src/utils/secretBackup.js';

/** Запись копии, как она лежит на диске. */
export interface SecretBackupEntry {
  key: string;
  /** Значение как оно лежало на диске (зашифрованное); пустое — у записи об испорченном файле. */
  value: string;
  reason: SecretBackupReason;
  source: SecretIssueSource;
  at: number;
  acknowledged?: boolean;
  restoredAt?: number;
}

/** Что сервис узнал о записи, расшифровав её текущим ключом. */
export interface SecretEntryProbe {
  /** Значение расшифровывается ключом этого профиля. */
  readable: boolean;
  /** Расшифрованное значение совпадает с текущим значением ключа. */
  equalsCurrent: boolean;
}

/** Устойчивый id записи: одна и та же запись получает один id при каждом чтении копии. */
export function backupEntryId(entry: Pick<SecretBackupEntry, 'key' | 'value' | 'reason' | 'at'>): string {
  return createHash('sha256').update(`${entry.key}\u0000${entry.reason}\u0000${entry.at}\u0000${entry.value}`).digest('hex').slice(0, 16);
}

export function restoreStatus(entry: Pick<SecretBackupEntry, 'value'>, probe: SecretEntryProbe): SecretRestoreStatus {
  if (!entry.value) return 'noValue';
  if (!probe.readable) return 'unreadable';
  return probe.equalsCurrent ? 'current' : 'restorable';
}

/**
 * Предпросмотр копии: новые записи сверху. `hasCurrent(key)` — у ключа сейчас есть читаемое значение.
 * У каждого ключа предлагается одна запись — самая свежая из восстанавливаемых, кроме отката замены.
 */
export function buildBackupPreview(
  entries: readonly SecretBackupEntry[],
  probe: (entry: SecretBackupEntry) => SecretEntryProbe,
  hasCurrent: (key: string) => boolean
): SecretBackupItem[] {
  const items = entries.map((entry): SecretBackupItem => {
    const status = restoreStatus(entry, entry.value ? probe(entry) : { readable: false, equalsCurrent: false });
    return {
      id: backupEntryId(entry),
      key: entry.key,
      reason: entry.reason,
      source: entry.source,
      at: entry.at,
      status,
      replacesCurrent: status === 'restorable' && hasCurrent(entry.key),
      suggested: false,
      ...(typeof entry.restoredAt === 'number' ? { restoredAt: entry.restoredAt } : {})
    };
  });
  const newestByKey = new Map<string, SecretBackupItem>();
  for (const item of items) {
    // Откат замены (`replaced`) не предлагается сам: иначе второе нажатие сразу отменило бы восстановление.
    if (item.status !== 'restorable' || item.reason === 'replaced') continue;
    const best = newestByKey.get(item.key);
    if (!best || item.at > best.at) newestByKey.set(item.key, item);
  }
  for (const item of newestByKey.values()) item.suggested = true;
  return items.sort((a, b) => b.at - a.at);
}

export interface SecretRestorePlan {
  restore: SecretBackupItem[];
  skipped: Array<{ id: string; reason: SecretRestoreSkipReason }>;
}

/**
 * Что вернуть из выбранного человеком. Только `restorable`; на ключ — одна запись, самая свежая из выбранных:
 * два значения одного ключа подряд оставили бы последнее случайным.
 */
export function planSecretRestore(items: readonly SecretBackupItem[], selectedIds: readonly string[]): SecretRestorePlan {
  const byId = new Map(items.map((item) => [item.id, item]));
  const skipped: SecretRestorePlan['skipped'] = [];
  const chosen = new Map<string, SecretBackupItem>();
  for (const id of new Set(selectedIds)) {
    const item = byId.get(id);
    if (!item) {
      skipped.push({ id, reason: 'unknown' });
      continue;
    }
    if (item.status !== 'restorable') {
      skipped.push({ id, reason: 'notRestorable' });
      continue;
    }
    const other = chosen.get(item.key);
    if (!other) {
      chosen.set(item.key, item);
      continue;
    }
    const [keep, drop] = item.at > other.at ? [item, other] : [other, item];
    chosen.set(item.key, keep);
    skipped.push({ id: drop.id, reason: 'duplicateKey' });
  }
  return { restore: [...chosen.values()], skipped };
}

export interface SecretBackupRemovalPlan {
  remove: SecretBackupItem[];
  skipped: Array<{ id: string; reason: 'unknown' }>;
  /** Сколько из удаляемых — единственная копия значения (`isSoleCopy`). */
  soleCopies: number;
}

/**
 * Что удалить из копии по выбору человека (TASK-157). Любые записи, в том числе несколько записей
 * одного ключа; неизвестный id (копия изменилась после предпросмотра) пропускается.
 */
export function planBackupRemoval(items: readonly SecretBackupItem[], selectedIds: readonly string[]): SecretBackupRemovalPlan {
  const byId = new Map(items.map((item) => [item.id, item]));
  const remove: SecretBackupItem[] = [];
  const skipped: SecretBackupRemovalPlan['skipped'] = [];
  for (const id of new Set(selectedIds)) {
    const item = byId.get(id);
    if (item) remove.push(item);
    else skipped.push({ id, reason: 'unknown' });
  }
  return { remove, skipped, soleCopies: remove.filter(isSoleCopy).length };
}
