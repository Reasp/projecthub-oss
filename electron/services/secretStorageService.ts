import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getLegacyStateDir, getUserDataDir } from './appPaths.js';
import type {
  SecretBackupPreview,
  SecretIssue,
  SecretIssueReason,
  SecretIssueSource,
  SecretIssuesState,
  SecretRestoreResult,
  SecretBackupDeleteResult
} from './secretStorageTypes.js';
import { backupEntryId, buildBackupPreview, planBackupRemoval, planSecretRestore, type SecretBackupEntry, type SecretEntryProbe } from './secretRestore.js';

/**
 * Хранилище секретов main-процесса (TASK-18, TASK-65; расположение и сбои — TASK-141, decision-88).
 *
 * Ключ `safeStorage` у Electron свой для каждого `userData`, поэтому файл секретов лежит там же —
 * `<userData>/secrets.enc.json`. Копия ProjectHub с другим `--user-data-dir` пишет в свой файл и не
 * портит секреты основного профиля. Старый общий `~/.projecthub/secrets.enc.json` при первом запуске
 * переносится: берутся только записи, которые расшифровываются ключом этого профиля, сам файл не меняется.
 *
 * Значение, которое не удалось расшифровать, не теряется: оно откладывается в
 * `<userData>/secrets.undecryptable.json` и попадает в список проблем, который показывает UI.
 */

const ENCRYPTION_PREFIX = 'enc_v1:';
export const SECRETS_FILE_NAME = 'secrets.enc.json';
export const SECRETS_BACKUP_FILE_NAME = 'secrets.undecryptable.json';

/** Шифр, которым закрываются значения. В приложении — `safeStorage`, в тестах — подмена. */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SecretStorageOptions {
  /** Каталог файла секретов — `userData`, где лежит и ключ шифрования. */
  dir: () => string;
  /** Старый общий файл секретов (до TASK-141), из которого переносятся записи этого профиля. */
  legacyFile?: () => string | null;
  cipher?: SecretCipher;
}

export type DecryptResult = { ok: true; value: string } | { ok: false; reason: Exclude<SecretIssueReason, 'corruptFile'> };

/** Значение хранится как лежало на диске (зашифрованное) — для восстановления, если ключ вернётся. */
type BackupEntry = SecretBackupEntry;

interface BackupFile {
  version: 1;
  entries: BackupEntry[];
}

const safeStorageCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (data) => safeStorage.decryptString(data)
};

function defaultOptions(): SecretStorageOptions {
  return {
    dir: () => getUserDataDir(),
    // Источник разового переноса (decision-88 п. 2), а не путь хранения: прежний общий каталог.
    legacyFile: () => path.join(getLegacyStateDir(), SECRETS_FILE_NAME),
    cipher: safeStorageCipher
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Запись через временный файл: оборванная запись не оставляет полупустой JSON. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
    // Windows: файл держит антивирус или индексатор — пишем напрямую, чтобы не потерять изменение.
    await fs.writeFile(file, body, { encoding: 'utf-8', mode: 0o600 });
  }
}

export class SecretStorageService {
  private readonly options: SecretStorageOptions;
  private readonly cipher: SecretCipher;
  private readonly cache = new Map<string, string>();
  /** Все операции с файлами идут по очереди: параллельные setSecret не теряют друг друга. */
  private queue: Promise<unknown> = Promise.resolve();
  private migration: Promise<void> | null = null;
  private readonly listeners = new Set<(state: SecretIssuesState) => void>();

  constructor(options: SecretStorageOptions = defaultOptions()) {
    this.options = options;
    this.cipher = options.cipher ?? safeStorageCipher;
  }

  private get filePath(): string {
    return path.join(this.options.dir(), SECRETS_FILE_NAME);
  }

  private get backupPath(): string {
    return path.join(this.options.dir(), SECRETS_BACKUP_FILE_NAME);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureMigrated();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Check if OS-level encryption (Windows DPAPI / macOS Keychain / Linux Libsecret) is available.
   */
  public isEncryptionAvailable(): boolean {
    try {
      return this.cipher.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Encrypt a plain text string using safeStorage.
   * Returns a prefixed base64 string, or original text if safeStorage is unavailable.
   */
  public encrypt(plainText: string): string {
    if (!plainText || plainText.startsWith(ENCRYPTION_PREFIX)) {
      return plainText;
    }

    if (this.isEncryptionAvailable()) {
      try {
        const buffer = this.cipher.encrypt(plainText);
        return `${ENCRYPTION_PREFIX}${buffer.toString('base64')}`;
      } catch (err) {
        console.warn('[SecretStorage] safeStorage.encryptString failed, using plain fallback:', err);
        return plainText;
      }
    }

    return plainText;
  }

  /** Расшифровка с причиной отказа. Значение без префикса `enc_v1:` возвращается как есть. */
  public tryDecrypt(cipherText: string): DecryptResult {
    if (!cipherText.startsWith(ENCRYPTION_PREFIX)) return { ok: true, value: cipherText };
    if (!this.isEncryptionAvailable()) return { ok: false, reason: 'encryptionUnavailable' };
    try {
      const buffer = Buffer.from(cipherText.slice(ENCRYPTION_PREFIX.length), 'base64');
      return { ok: true, value: this.cipher.decrypt(buffer) };
    } catch {
      return { ok: false, reason: 'undecryptable' };
    }
  }

  /**
   * Decrypt an encrypted string.
   * If string is not encrypted (does not start with enc_v1:), returns as-is (auto-migration).
   */
  public decrypt(cipherText: string): string {
    if (!cipherText) return '';
    const result = this.tryDecrypt(cipherText);
    if (result.ok) return result.value;
    console.error(`[SecretStorage] Decryption failed: ${result.reason}`);
    return '';
  }

  /**
   * Masks a secret string for safe logging and UI display.
   * e.g. "sk-ant-api03-abcdef123456" -> "sk-ant-***...***3456"
   */
  public mask(secret: string): string {
    if (!secret) return '';
    const clean = secret.startsWith(ENCRYPTION_PREFIX) ? this.decrypt(secret) : secret;
    if (clean.length <= 8) return '********';
    return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
  }

  /**
   * Перенос старого общего файла (decision-88 п. 2): только записи, которые расшифровываются ключом
   * этого профиля. Чужие записи пропускаются молча — это секреты другого профиля, не сбой этого.
   */
  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = (async () => {
        const target = this.filePath;
        if (existsSync(target)) return;
        const legacy = this.options.legacyFile?.() ?? null;
        if (!legacy || samePath(legacy, target) || !existsSync(legacy)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fs.readFile(legacy, 'utf-8'));
        } catch (err) {
          console.warn('[SecretStorage] Legacy secrets file is unreadable, migration skipped:', err instanceof Error ? err.message : err);
          return;
        }
        const moved: Record<string, string> = {};
        let skipped = 0;
        for (const [key, value] of Object.entries(isStringRecord(parsed) ? parsed : {})) {
          if (typeof value !== 'string' || !value) continue;
          const result = this.tryDecrypt(value);
          if (result.ok) moved[key] = this.encrypt(result.value);
          else skipped += 1;
        }
        await writeJsonAtomic(target, moved);
        console.log(
          `[SecretStorage] Migrated ${Object.keys(moved).length} secret(s) from the shared legacy file; ${skipped} belong to another profile and were left there`
        );
      })().catch((err) => {
        console.error('[SecretStorage] Legacy migration failed:', err);
      });
    }
    return this.migration;
  }

  private async readStore(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(isStringRecord(parsed) ? parsed : {})) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      // Испорченный файл не затираем пустым: откладываем копию и сообщаем пользователю.
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, aside).catch(() => fs.copyFile(this.filePath, aside));
      await this.addBackupEntries([{ key: SECRETS_FILE_NAME, value: '', reason: 'corruptFile', source: 'secrets', at: Date.now() }]);
      console.error('[SecretStorage] Secrets file is not valid JSON; moved aside, starting a new store');
      return {};
    }
  }

  private async writeStore(data: Record<string, string>): Promise<void> {
    await writeJsonAtomic(this.filePath, data);
  }

  private async readBackup(): Promise<BackupFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.backupPath, 'utf-8')) as Partial<BackupFile>;
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  /** Резервная копия нерасшифрованных значений. Одно и то же значение ключа второй раз не пишется. */
  private async addBackupEntries(entries: BackupEntry[]): Promise<void> {
    const backup = await this.readBackup();
    const fresh = entries.filter(
      (e) => !backup.entries.some((b) => b.key === e.key && b.value === e.value && b.reason === e.reason && e.value !== '')
    );
    if (fresh.length === 0) return;
    backup.entries.push(...fresh);
    await writeJsonAtomic(this.backupPath, backup);
    console.error(
      `[SecretStorage] ${fresh.length} stored secret(s) could not be read (${[...new Set(fresh.map((e) => e.reason))].join(', ')}); old values kept in ${SECRETS_BACKUP_FILE_NAME}`
    );
    this.emitIssues(backup);
  }

  /** Перед перезаписью или удалением нерасшифрованное значение откладывается в резервную копию. */
  private async backupIfUnreadable(key: string, stored: string | undefined, source: SecretIssueSource): Promise<boolean> {
    if (!stored) return false;
    const result = this.tryDecrypt(stored);
    if (result.ok) return false;
    await this.addBackupEntries([{ key, value: stored, reason: result.reason, source, at: Date.now() }]);
    return true;
  }

  /**
   * Сообщить о нерасшифрованном значении, которое лежит вне файла секретов (поле `apiKey` в
   * `ai-config.json`, `llm-profiles.json`). Значение сохраняется в резервной копии.
   */
  public reportUndecryptable(key: string, stored: string, source: SecretIssueSource): Promise<void> {
    return this.serialize(async () => {
      await this.backupIfUnreadable(key, stored, source);
    });
  }

  /**
   * Store a secret key-value pair encrypted on disk.
   */
  public setSecret(key: string, value: string): Promise<void> {
    return this.serialize(async () => {
      const all = await this.readStore();
      await this.backupIfUnreadable(key, all[key], 'secrets');
      all[key] = this.encrypt(value);
      await this.writeStore(all);
      this.cache.set(key, value);
    });
  }

  /**
   * Retrieve and decrypt a secret. `null` — значения нет или его не удалось расшифровать
   * (тогда оно отложено в резервную копию и показано пользователю).
   */
  public getSecret(key: string): Promise<string | null> {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key)!);
    return this.serialize(async () => {
      if (this.cache.has(key)) return this.cache.get(key)!;
      const all = await this.readStore();
      const stored = all[key];
      if (!stored) return null;
      const result = this.tryDecrypt(stored);
      if (!result.ok) {
        await this.backupIfUnreadable(key, stored, 'secrets');
        return null;
      }
      this.cache.set(key, result.value);
      return result.value;
    });
  }

  /**
   * Delete a stored secret.
   */
  public deleteSecret(key: string): Promise<boolean> {
    this.cache.delete(key);
    return this.serialize(async () => {
      this.cache.delete(key);
      const all = await this.readStore();
      if (!(key in all)) return false;
      await this.backupIfUnreadable(key, all[key], 'secrets');
      delete all[key];
      await this.writeStore(all);
      return true;
    });
  }

  private toState(backup: BackupFile): SecretIssuesState {
    return {
      issues: backup.entries
        .filter((e): e is BackupEntry & { reason: SecretIssue['reason'] } => !e.acknowledged && e.reason !== 'replaced')
        .map(({ key, reason, source, at }) => ({ key, reason, source, at })),
      backupFile: this.backupPath
    };
  }

  /** Расшифровка записи копии текущим ключом — только для сравнения внутри сервиса. */
  private probeEntry(entry: BackupEntry, store: Record<string, string>): SecretEntryProbe {
    const restored = this.tryDecrypt(entry.value);
    if (!restored.ok) return { readable: false, equalsCurrent: false };
    const current = store[entry.key] ? this.tryDecrypt(store[entry.key]) : null;
    return { readable: true, equalsCurrent: Boolean(current?.ok && current.value === restored.value) };
  }

  private buildPreview(backup: BackupFile, store: Record<string, string>): SecretBackupPreview {
    return {
      items: buildBackupPreview(
        backup.entries,
        (entry) => this.probeEntry(entry, store),
        (key) => Boolean(store[key] && this.tryDecrypt(store[key]).ok)
      ),
      backupFile: this.backupPath,
      encryptionAvailable: this.isEncryptionAvailable()
    };
  }

  /** Предпросмотр резервной копии для окна восстановления (TASK-154): без значений. */
  public getBackupPreview(): Promise<SecretBackupPreview> {
    return this.serialize(async () => this.buildPreview(await this.readBackup(), await this.readStore()));
  }

  /**
   * Вернуть выбранные записи копии в хранилище (TASK-154). Текущее читаемое значение ключа перед заменой
   * откладывается в ту же копию с причиной `replaced` — восстановление можно откатить. Запись копии остаётся
   * (копия хранится до ручного удаления, decision-88 п. 5) и получает `restoredAt`.
   */
  public restoreFromBackup(ids: readonly string[]): Promise<SecretRestoreResult> {
    return this.serialize(async () => {
      const backup = await this.readBackup();
      const store = await this.readStore();
      const plan = planSecretRestore(this.buildPreview(backup, store).items, ids);
      const now = Date.now();
      const restored: string[] = [];
      for (const item of plan.restore) {
        const entry = backup.entries.find((e) => backupEntryId(e) === item.id);
        const value = entry ? this.tryDecrypt(entry.value) : null;
        if (!entry || !value?.ok) continue;
        const current = store[entry.key];
        if (current) {
          // Текущее значение не затирается: читаемое — `replaced`, нечитаемое (записано другим ключом) — со своей
          // причиной. Человек сам запустил замену, поэтому баннер о нём не нужен.
          const readable = this.tryDecrypt(current);
          const replaced: BackupEntry = {
            key: entry.key,
            value: current,
            reason: readable.ok ? 'replaced' : readable.reason,
            source: 'secrets',
            at: now,
            acknowledged: true
          };
          if (!backup.entries.some((e) => e.key === replaced.key && e.value === replaced.value)) backup.entries.push(replaced);
        }
        store[entry.key] = this.encrypt(value.value);
        this.cache.set(entry.key, value.value);
        entry.restoredAt = now;
        entry.acknowledged = true;
        restored.push(entry.key);
      }
      if (restored.length > 0) {
        await this.writeStore(store);
        await writeJsonAtomic(this.backupPath, backup);
        // Имена секретов в лог не пишутся (decision-88 п. 5): только число.
        console.log(`[SecretStorage] Restored ${restored.length} secret(s) from ${SECRETS_BACKUP_FILE_NAME}`);
        this.emitIssues(backup);
      }
      return { restored, skipped: plan.skipped, preview: this.buildPreview(backup, store) };
    });
  }

  /**
   * Удалить выбранные записи копии (TASK-157, decision-90 п. 7). Рендерер передаёт только id; main сам
   * находит записи по свежей копии. Окно заранее предупреждает о записях — единственных копиях значения.
   */
  public deleteFromBackup(ids: readonly string[]): Promise<SecretBackupDeleteResult> {
    return this.serialize(async () => {
      const backup = await this.readBackup();
      const store = await this.readStore();
      const plan = planBackupRemoval(this.buildPreview(backup, store).items, ids);
      const drop = new Set(plan.remove.map((item) => item.id));
      if (drop.size > 0) {
        backup.entries = backup.entries.filter((entry) => !drop.has(backupEntryId(entry)));
        await writeJsonAtomic(this.backupPath, backup);
        // Имена секретов в лог не пишутся (decision-88 п. 5): только число.
        console.log(`[SecretStorage] Removed ${drop.size} entr${drop.size === 1 ? 'y' : 'ies'} from ${SECRETS_BACKUP_FILE_NAME}`);
        this.emitIssues(backup);
      }
      return { removed: plan.remove.map((item) => item.key), skipped: plan.skipped, preview: this.buildPreview(backup, store) };
    });
  }

  /** Непросмотренные проблемы с секретами — для баннера в UI. */
  public getIssues(): Promise<SecretIssuesState> {
    return this.serialize(async () => this.toState(await this.readBackup()));
  }

  /** Пользователь прочитал сообщение: проблемы скрываются, резервные копии остаются. */
  public acknowledgeIssues(): Promise<SecretIssuesState> {
    return this.serialize(async () => {
      const backup = await this.readBackup();
      if (backup.entries.some((e) => !e.acknowledged)) {
        for (const e of backup.entries) e.acknowledged = true;
        await writeJsonAtomic(this.backupPath, backup);
      }
      const state = this.toState(backup);
      this.emitIssues(backup);
      return state;
    });
  }

  public onIssuesChanged(listener: (state: SecretIssuesState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitIssues(backup: BackupFile): void {
    const state = this.toState(backup);
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.warn('[SecretStorage] Issues listener failed:', err);
      }
    }
  }
}

export const secretStorageService = new SecretStorageService();
