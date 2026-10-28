/**
 * Тексты окна переноса профиля (TASK-224, decision-175), en и ru. Отдельный словарь окна: им пользуется только
 * `ProfileTransferModal` и кнопка в Activity Bar. Чистый модуль без React.
 */
import type { Language } from './types';
import type { ProfileSectionId, SectionChange } from '../lib/profileSections';

export interface ProfileTransferLabels {
  open: string;
  title: string;
  subtitle: string;
  never: string;
  exportTitle: string;
  exportHint: string;
  password: string;
  passwordRepeat: string;
  passwordShort: (min: number) => string;
  passwordMismatch: string;
  exportButton: string;
  exported: (file: string, count: number) => string;
  importTitle: string;
  importHint: string;
  chooseFile: string;
  preview: string;
  fileChosen: (file: string) => string;
  madeAt: (date: string, version?: string) => string;
  apply: string;
  applied: (count: number) => string;
  restartHint: string;
  restart: string;
  nothingSelected: string;
  sections: Record<ProfileSectionId, string>;
  change: Record<SectionChange, string>;
  newer: string;
  older: string;
  projectsTitle: string;
  projectsHint: string;
  clone: string;
  cloned: (path: string) => string;
  close: string;
  working: string;
  homeTitle: string;
  homeHint: string;
  homeHost: string;
  noPeers: string;
  peerOffline: string;
  pull: string;
  push: string;
  fromHost: (name: string) => string;
  toHost: (name: string) => string;
  hostNewer: string;
  localNewer: string;
  applyOnHost: string;
  appliedOnHost: (count: number) => string;
  hostRestartHint: string;
}

const en: ProfileTransferLabels = {
  open: 'Transfer profile',
  title: 'Transfer ProjectHub profile',
  subtitle: 'Move your settings to another computer with a password-protected file',
  never: 'Never included: secrets and API keys, CLI sign-ins, audit and HITL history, paired devices, computer control permissions, sessions.',
  exportTitle: 'Export',
  exportHint: 'AI settings without keys, roles, Automations rules, notifications and the list of projects with their git remotes.',
  password: 'Password',
  passwordRepeat: 'Repeat password',
  passwordShort: (min) => `At least ${min} characters.`,
  passwordMismatch: 'The passwords do not match.',
  exportButton: 'Export to file…',
  exported: (file, count) => `Saved ${count} sections to ${file}`,
  importTitle: 'Import',
  importHint: 'Settings are merged by key: what exists only here stays, disputed values come from the newer side.',
  chooseFile: 'Choose file…',
  preview: 'Show changes',
  fileChosen: (file) => `File: ${file}`,
  madeAt: (date, version) => `Profile from ${date}${version ? `, ProjectHub ${version}` : ''}`,
  apply: 'Import selected',
  applied: (count) => `Imported sections: ${count}.`,
  restartHint: 'Restart ProjectHub so that every window picks up the imported settings.',
  restart: 'Restart now',
  nothingSelected: 'Select at least one section.',
  sections: {
    aiConfig: 'AI settings',
    modelTiers: 'Model tiers',
    llmProfiles: 'Model servers and profiles',
    modelAssignments: 'Model assignments',
    agentPricing: 'Agent pricing',
    llmModelCatalog: 'Model catalog',
    connections: 'Connections (without tokens)',
    uiLanguage: 'Interface language',
    voiceHotkey: 'Voice hotkey',
    notifications: 'Notifications',
    roles: 'Roles',
    automations: 'Automations rules',
    projects: 'Projects'
  },
  change: { new: 'new', changed: 'will change', same: 'no changes' },
  newer: 'profile is newer',
  older: 'this computer is newer',
  projectsTitle: 'Projects that are not on this computer',
  projectsHint: 'ProjectHub does not create local paths: clone a project to work with it here.',
  clone: 'Clone…',
  cloned: (path) => `Cloned to ${path}`,
  close: 'Close',
  working: 'Working…',
  homeTitle: 'Home host',
  homeHint: 'A computer paired over federation: your main PC or ph-agent on a server. The same merge as with a file, no password; the host lets only your device with full rights read or change its profile.',
  homeHost: 'Host',
  noPeers: 'No paired computers. Add one in Remote hosts.',
  peerOffline: 'not connected',
  pull: 'Take profile from host',
  push: 'Send profile to host',
  fromHost: (name) => `Profile of ${name}: changes on this computer`,
  toHost: (name) => `Profile of this computer: changes on ${name}`,
  hostNewer: 'host is newer',
  localNewer: 'this computer is newer',
  applyOnHost: 'Apply selected on host',
  appliedOnHost: (count) => `Applied on host: ${count} sections.`,
  hostRestartHint: 'Restart ProjectHub on the host so that it picks up the settings.'
};

const ru: ProfileTransferLabels = {
  open: 'Перенос профиля',
  title: 'Перенос профиля ProjectHub',
  subtitle: 'Перенесите настройки на другой компьютер файлом, защищённым паролем',
  never: 'Никогда не переносятся: секреты и ключи API, вход в CLI, аудит и история HITL, сопряжённые устройства, разрешения управления компьютером, сессии.',
  exportTitle: 'Экспорт',
  exportHint: 'Настройки AI без ключей, роли, правила Automations, уведомления и список проектов с адресами git remote.',
  password: 'Пароль',
  passwordRepeat: 'Повторите пароль',
  passwordShort: (min) => `Не короче ${min} символов.`,
  passwordMismatch: 'Пароли не совпадают.',
  exportButton: 'Экспорт в файл…',
  exported: (file, count) => `Сохранено разделов: ${count}, файл ${file}`,
  importTitle: 'Импорт',
  importHint: 'Настройки сливаются по ключам: то, что есть только здесь, остаётся, спорные значения берутся с более новой стороны.',
  chooseFile: 'Выбрать файл…',
  preview: 'Показать изменения',
  fileChosen: (file) => `Файл: ${file}`,
  madeAt: (date, version) => `Профиль от ${date}${version ? `, ProjectHub ${version}` : ''}`,
  apply: 'Импортировать выбранное',
  applied: (count) => `Импортировано разделов: ${count}.`,
  restartHint: 'Перезапустите ProjectHub, чтобы все окна подхватили импортированные настройки.',
  restart: 'Перезапустить',
  nothingSelected: 'Выберите хотя бы один раздел.',
  sections: {
    aiConfig: 'Настройки AI',
    modelTiers: 'Тиры моделей',
    llmProfiles: 'Серверы и профили моделей',
    modelAssignments: 'Назначения моделей',
    agentPricing: 'Цены агентов',
    llmModelCatalog: 'Каталог моделей',
    connections: 'Подключения (без токенов)',
    uiLanguage: 'Язык интерфейса',
    voiceHotkey: 'Горячая клавиша голоса',
    notifications: 'Уведомления',
    roles: 'Роли',
    automations: 'Правила Automations',
    projects: 'Проекты'
  },
  change: { new: 'новое', changed: 'изменится', same: 'без изменений' },
  newer: 'профиль новее',
  older: 'здесь новее',
  projectsTitle: 'Проекты, которых нет на этом компьютере',
  projectsHint: 'ProjectHub не создаёт локальные пути: клонируйте проект, чтобы работать с ним здесь.',
  clone: 'Клонировать…',
  cloned: (path) => `Склонировано в ${path}`,
  close: 'Закрыть',
  working: 'Выполняется…',
  homeTitle: 'Домашний хост',
  homeHint: 'Компьютер, сопряжённый по федерации: основной ПК или ph-agent на сервере. Слияние то же, что с файлом, без пароля; читать и менять свой профиль хост разрешает только вашему устройству с полными правами.',
  homeHost: 'Хост',
  noPeers: 'Нет сопряжённых компьютеров. Добавьте компьютер в «Удалённых хостах».',
  peerOffline: 'не подключён',
  pull: 'Взять профиль с хоста',
  push: 'Отправить профиль на хост',
  fromHost: (name) => `Профиль ${name}: изменения на этом компьютере`,
  toHost: (name) => `Профиль этого компьютера: изменения на ${name}`,
  hostNewer: 'на хосте новее',
  localNewer: 'здесь новее',
  applyOnHost: 'Применить выбранное на хосте',
  appliedOnHost: (count) => `Применено на хосте разделов: ${count}.`,
  hostRestartHint: 'Перезапустите ProjectHub на хосте, чтобы он подхватил настройки.'
};

export const PROFILE_TRANSFER_TEXT: Record<Language, ProfileTransferLabels> = { en, ru };

export function profileTransferText(language: Language): ProfileTransferLabels {
  return PROFILE_TRANSFER_TEXT[language] ?? en;
}
