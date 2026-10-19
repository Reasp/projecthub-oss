import type { SecretBackupReason, SecretIssueSource } from '../../types/electron';
import type { TranslationDictionary } from '../../i18n/types';

type SecretTexts = TranslationDictionary['secretIssues'];

/** Понятное имя секрета по ключу хранилища; ключи профилей LLM — с id профиля. */
export function secretKeyLabel(texts: SecretTexts, key: string): string {
  const known = texts.keys[key];
  if (known) return known;
  const profile = /^llmProfile\.(.+)\.apiKey$/.exec(key);
  return profile ? `${texts.keys['ai.apiKey']} (${profile[1]})` : key;
}

export function secretReasonLabel(texts: SecretTexts, reason: SecretBackupReason): string {
  switch (reason) {
    case 'corruptFile':
      return texts.reasonCorrupt;
    case 'encryptionUnavailable':
      return texts.reasonUnavailable;
    case 'replaced':
      return texts.reasonReplaced;
    default:
      return texts.reasonUndecryptable;
  }
}

export function secretSourceLabel(texts: SecretTexts, source: SecretIssueSource): string {
  return source === 'ai-config' ? texts.sourceAiConfig : source === 'llm-profiles' ? texts.sourceLlmProfiles : texts.sourceSecrets;
}
