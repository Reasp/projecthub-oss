/**
 * Разделы профиля ProjectHub (TASK-224, [[decision-175]] п. 3): общий список для main и окна. Чистый модуль без
 * Node и React — формат, шифрование и слияние в `electron/services/profileFormat.ts`.
 */

export const PROFILE_SECTIONS = [
  'aiConfig',
  'modelTiers',
  'llmProfiles',
  'modelAssignments',
  'agentPricing',
  'llmModelCatalog',
  'connections',
  'uiLanguage',
  'voiceHotkey',
  'notifications',
  'roles',
  'automations',
  'projects'
] as const;

export type ProfileSectionId = (typeof PROFILE_SECTIONS)[number];

/** Что даст импорт раздела. */
export type SectionChange = 'new' | 'changed' | 'same';

/** Минимальная длина пароля профиля: короткий пароль перебирается по файлу без ограничения попыток. */
export const PROFILE_PASSWORD_MIN = 8;

export function isProfileSectionId(value: unknown): value is ProfileSectionId {
  return typeof value === 'string' && (PROFILE_SECTIONS as readonly string[]).includes(value);
}
