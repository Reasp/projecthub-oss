/**
 * Открытые ключи издателя для обновления файлом (TASK-147.4, [[decision-189]] п. 3). Ключ создаёт и хранит правообладатель:
 * `node scripts/release/sign-update.mjs keygen --out <файл вне репозитория>` печатает строку для этого списка.
 *
 * Ключ подписи обновлений — отдельный от ключа лицензий. Ротация: новый ключ добавляется сюда раньше, чем им начинают
 * подписывать; старый убирается, когда в контурах не осталось сборок без нового. Пустой список — установка из файла
 * отказывает (`update.noTrustedKeys`).
 */
export interface UpdateTrustedKey {
  /** Первые 16 hex SHA-256 от SPKI DER (`updateKeyId`). */
  id: string;
  /** PEM `-----BEGIN PUBLIC KEY-----`. */
  publicKey: string;
}

export const UPDATE_TRUSTED_KEYS: readonly UpdateTrustedKey[] = [];
