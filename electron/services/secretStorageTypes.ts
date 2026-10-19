/**
 * Типы хранилища секретов (TASK-141, decision-88). Без зависимостей от Electron: модуль
 * импортируют `secretStorageService` (main) и рендерер через `src/types/electron.d.ts`.
 */

/** Почему сохранённое значение не удалось прочитать. */
export type SecretIssueReason =
  /** Расшифровка не удалась: значение записано другим ключом (другой `userData`, сменился ключ ОС). */
  | 'undecryptable'
  /** Шифрование ОС сейчас недоступно (Linux без keyring), а значение зашифровано. */
  | 'encryptionUnavailable'
  /** Файл секретов не разбирается как JSON: он отложен в копию, хранилище начато заново. */
  | 'corruptFile';

/** Откуда значение: файл секретов или поле ключа в общих конфигурационных файлах. */
export type SecretIssueSource = 'secrets' | 'ai-config' | 'llm-profiles';

/** Проблема с секретом, которую видит пользователь. Само значение наружу не отдаётся. */
export interface SecretIssue {
  key: string;
  reason: SecretIssueReason;
  source: SecretIssueSource;
  /** Время обнаружения, мс. */
  at: number;
}

export interface SecretIssuesState {
  issues: SecretIssue[];
  /** Файл с резервными копиями нерасшифрованных значений. */
  backupFile: string;
}

/**
 * Причина записи в резервной копии. Кроме сбоев чтения — `replaced`: значение, которое заменило
 * восстановление из копии (TASK-154). По нему восстановление можно откатить.
 */
export type SecretBackupReason = SecretIssueReason | 'replaced';

/**
 * Можно ли вернуть запись копии сейчас:
 * - `restorable` — расшифровывается ключом этого профиля и отличается от текущего значения;
 * - `current` — расшифровывается и уже совпадает с текущим значением (восстановлена раньше);
 * - `unreadable` — ключ всё ещё другой или шифрование ОС недоступно;
 * - `noValue` — значения нет: запись об испорченном файле.
 */
export type SecretRestoreStatus = 'restorable' | 'current' | 'unreadable' | 'noValue';

/** Запись резервной копии для предпросмотра. Значение наружу не отдаётся — ни открытое, ни зашифрованное. */
export interface SecretBackupItem {
  /** Устойчивый id записи (хэш), по нему рендерер выбирает, что восстановить. */
  id: string;
  key: string;
  reason: SecretBackupReason;
  source: SecretIssueSource;
  at: number;
  status: SecretRestoreStatus;
  /** У ключа сейчас есть читаемое значение: восстановление заменит его, а старое уйдёт в копию. */
  replacesCurrent: boolean;
  /** Самая свежая восстанавливаемая запись своего ключа — её предлагают выбрать по умолчанию. */
  suggested: boolean;
  /** Когда запись уже восстанавливали. */
  restoredAt?: number;
}

export interface SecretBackupPreview {
  items: SecretBackupItem[];
  backupFile: string;
  encryptionAvailable: boolean;
}

export type SecretRestoreSkipReason = 'unknown' | 'notRestorable' | 'duplicateKey';

export interface SecretRestoreResult {
  /** Ключи, значения которых восстановлены. */
  restored: string[];
  skipped: Array<{ id: string; reason: SecretRestoreSkipReason }>;
  preview: SecretBackupPreview;
}
