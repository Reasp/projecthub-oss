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
