/**
 * Тексты CLI ph-agent (TASK-212, [[decision-159]], [[decision-161]] п. 8): справка, вывод команд и ошибки — английский
 * базовый текст и русский перевод. Язык — `--lang`, затем `PH_AGENT_LANG`, затем переменные локали POSIX
 * (`LC_ALL` → `LC_MESSAGES` → `LANG`, первая заданная решает), без них — язык системы; иначе английский.
 * Свой словарь, а не `appErrorText`: строки нужны только терминалу ph-agent.
 *
 * Чистый модуль без Electron и файловой системы — покрыт unit-тестами.
 */
import { appErrorKeyOf, fillAppErrorTemplate, formatAppError, type AppErrorParams } from '../../src/lib/appError';
import { appErrorTextEn, appErrorTextRu } from '../../src/i18n/appErrorText';
import { resolveInitialLanguage } from '../../src/i18n/initialLanguage';
import type { Language } from '../../src/i18n/types';

const EN = {
  help: `ph-agent — windowless ProjectHub federation host (decision-119)

Commands:
  start [--name N] [--port P] [--relay wss://…] [--auto-assigned]   start the host (default)
  pair-info                    address, PIN and pairing link for "Remote hosts" of the controlling ProjectHub
  status                       data directory, secret key, projects, devices
  add-project <path>           add a project to the host registry
  remove-project <path>        remove a project from the registry
  projects                     list projects
  devices                      paired devices and their rights
  device-projects <deviceId>   device rights per host project (decision-144)
      [--default none|readOnly|hitl|full|inherit]     rights for other and new projects
      [--project <path>=none|readOnly|hitl|full|inherit]   project override (the flag repeats)
      [--reset]                remove all settings: device rights apply to all projects again
      With flags it changes the rights (ph-agent must be stopped), without flags it shows them.
  revoke <deviceId>            revoke a device (ph-agent must be stopped)
  claude-login                 sign in to Claude Code for this host's agents
  service install|uninstall|status [--dry-run]   service: systemd (Linux), LaunchAgent (macOS), Task Scheduler (Windows)

Common flags:
  --data <dir>                 data directory (instead of PH_AGENT_DATA)
  --lang en|ru                 output language (instead of PH_AGENT_LANG and the system locale)
  --debug                      print the stack trace of an error

Environment: PH_AGENT_DATA — data directory (~/.projecthub-agent), PH_AGENT_HOME — home directory of the project registry,
PH_AGENT_KEY_FILE — secret key, PH_AGENT_FEDERATION_SECRET — shared federation secret for the catalog and LAN,
PH_AGENT_LANG — output language (en, ru), PH_AGENT_DEBUG=1 — print stack traces.`,

  alreadyRunning: 'already running (pid {pid}) with data directory {dir}',
  mcpNotStarted: 'The MCP server did not start: HITL for Claude CLI agents is unavailable',
  pairingName: 'Name: {name}',
  pairingLink: 'Link ({kind}): {link}',
  hostListening: 'Host {name} ({hostId}) is listening on port {port}; key fingerprint {fingerprint}',
  pairingSaved: 'Pairing data: {file} (or ph-agent pair-info)',
  stopping: 'Stopping ({signal})',

  notStartedYet: 'ph-agent has not run with this data directory yet: run ph-agent start',
  pairHint: 'Controlling ProjectHub: "Remote hosts" → "Add" → paste the link and, if asked, the PIN.',
  notRunning: 'ph-agent is not running now.',

  pathRequired: 'specify a path: ph-agent {command} <path>',
  noDirectory: 'no directory {path}',
  projectAdded: 'Added: {path}',
  projectRemoved: 'Removed: {path}',
  runningSeesChange: 'The running ph-agent will see the change on the next project list request.',
  noProjects: 'No projects: ph-agent add-project <path>',

  stopBeforeRevoke: 'stop ph-agent (pid {pid}) before revoking: the running process would overwrite the device list',
  revokeIdRequired: 'specify deviceId: ph-agent revoke <deviceId>',
  revoked: 'Revoked: {ids}',
  noSuchDevice: 'No device {id}',
  noDevices: 'No paired devices',
  deviceProjectsHint: 'per-project rights: ph-agent device-projects {id}',

  deviceProjectsIdRequired: 'specify deviceId: ph-agent device-projects <deviceId> [--default …] [--project <path>=…] [--reset]',
  stopBeforeRights: 'stop ph-agent (pid {pid}) before changing rights: the running process would overwrite the device list',
  deviceNotFound: 'no device {id}: see ph-agent devices',
  rightsSaved: 'Per-project rights saved.',
  rightsCleared: 'Per-project settings removed: device rights apply to all projects again.',
  deviceHeader: '{name} ({id}), device rights: {rights}',
  memberCeiling: 'Member {member}: the ceiling of their team role also applies.',
  rightsOverride: 'override',
  rightsForOthers: 'for other projects',
  rightsOfDevice: 'device rights',
  rightsOverrideMissing: 'override, project not in the registry',
  rightsOthers: 'Other and new projects: {access}',
  rightsOthersDevice: 'device rights ({rights})',

  statusDataDir: 'Data directory: {dir}',
  statusRegistry: 'Project registry: {file}',
  statusKey: 'Secret key: {key}',
  statusRunning: 'Running: {value}',
  statusRunningPid: 'yes, pid {pid}',
  none: 'none',
  no: 'no',
  statusCounts: 'Projects: {projects}, devices: {devices}',

  claudeLogin: 'Sign-in to Claude Code for ph-agent agents (CLAUDE_CONFIG_DIR={dir}). In the claude that opens, run /login.',

  commandFailed: '{command} exited with code {code}',
  serviceUsage: 'usage: ph-agent service install|uninstall|status',
  unitWritten: 'Unit: {file}',
  lingerHint: 'To keep the service running without a login: sudo loginctl enable-linger {user}',
  serviceUnsupported: 'a service for {platform} is not supported: run ph-agent start under your own supervisor',

  argValueRequired: 'A value is required for {flag}',
  argPort: '--port: a number 1–65535',
  argRelay: '--relay: an address like wss://relay.example.com',
  argAccess: '{flag}: none | readOnly | hitl | full | inherit',
  argProject: '--project: <path>=<none|readOnly|hitl|full|inherit>',
  argLang: '--lang: en | ru',
  argUnknownFlag: 'Unknown flag {flag}',

  keyWrongSize: 'Key {file} must be 32 bytes (raw, hex or base64)',
  keyDpapiFailed: 'DPAPI {op} failed: {detail}',

  debugHint: '(details: --debug)'
};

export type PhAgentTextKey = keyof typeof EN;
type PhAgentLabels = Record<PhAgentTextKey, string>;

const RU: PhAgentLabels = {
  help: `ph-agent — хост федерации ProjectHub без окна (decision-119)

Команды:
  start [--name N] [--port P] [--relay wss://…] [--auto-assigned]   запустить хост (по умолчанию)
  pair-info                    адрес, PIN и ссылка сопряжения для «Удалённых хостов» управляющего ProjectHub
  status                       каталог данных, ключ секретов, проекты, устройства
  add-project <путь>           добавить проект в реестр хоста
  remove-project <путь>        убрать проект из реестра
  projects                     список проектов
  devices                      сопряжённые устройства и их права
  device-projects <deviceId>   права устройства по проектам хоста (decision-144)
      [--default none|readOnly|hitl|full|inherit]     право для остальных и новых проектов
      [--project <путь>=none|readOnly|hitl|full|inherit]   переопределение проекта (флаг повторяется)
      [--reset]                снять все настройки — снова права устройства на все проекты
      С флагами меняет права (ph-agent должен быть остановлен), без флагов — показывает их.
  revoke <deviceId>            отозвать устройство (ph-agent должен быть остановлен)
  claude-login                 войти в Claude Code для агентов этого хоста
  service install|uninstall|status [--dry-run]   служба: systemd (Linux), LaunchAgent (macOS), планировщик (Windows)

Общие флаги:
  --data <каталог>             каталог данных (вместо PH_AGENT_DATA)
  --lang en|ru                 язык вывода (вместо PH_AGENT_LANG и языка системы)
  --debug                      печатать стек ошибки

Окружение: PH_AGENT_DATA — каталог данных (~/.projecthub-agent), PH_AGENT_HOME — домашний каталог реестра проектов,
PH_AGENT_KEY_FILE — ключ секретов, PH_AGENT_FEDERATION_SECRET — общий секрет федерации для каталога и LAN,
PH_AGENT_LANG — язык вывода (en, ru), PH_AGENT_DEBUG=1 — печатать стек ошибок.`,

  alreadyRunning: 'уже запущен (pid {pid}) с каталогом данных {dir}',
  mcpNotStarted: 'MCP-сервер не запустился: HITL агентов Claude CLI недоступен',
  pairingName: 'Имя: {name}',
  pairingLink: 'Ссылка ({kind}): {link}',
  hostListening: 'Хост {name} ({hostId}) слушает порт {port}; отпечаток ключа {fingerprint}',
  pairingSaved: 'Данные для сопряжения: {file} (или ph-agent pair-info)',
  stopping: 'Остановка ({signal})',

  notStartedYet: 'ph-agent ещё не запускался с этим каталогом данных: выполните ph-agent start',
  pairHint: 'Управляющий ProjectHub: «Удалённые хосты» → «Добавить» → вставьте ссылку и при необходимости PIN.',
  notRunning: 'ph-agent сейчас не запущен.',

  pathRequired: 'укажите путь: ph-agent {command} <путь>',
  noDirectory: 'нет каталога {path}',
  projectAdded: 'Добавлен: {path}',
  projectRemoved: 'Убран: {path}',
  runningSeesChange: 'Работающий ph-agent увидит изменение при следующем запросе списка проектов.',
  noProjects: 'Проектов нет: ph-agent add-project <путь>',

  stopBeforeRevoke: 'остановите ph-agent (pid {pid}) перед отзывом: работающий процесс перезапишет список устройств',
  revokeIdRequired: 'укажите deviceId: ph-agent revoke <deviceId>',
  revoked: 'Отозвано: {ids}',
  noSuchDevice: 'Устройства {id} нет',
  noDevices: 'Сопряжённых устройств нет',
  deviceProjectsHint: 'права по проектам: ph-agent device-projects {id}',

  deviceProjectsIdRequired: 'укажите deviceId: ph-agent device-projects <deviceId> [--default …] [--project <путь>=…] [--reset]',
  stopBeforeRights: 'остановите ph-agent (pid {pid}) перед сменой прав: работающий процесс перезапишет список устройств',
  deviceNotFound: 'устройства {id} нет: список — ph-agent devices',
  rightsSaved: 'Права по проектам сохранены.',
  rightsCleared: 'Настройки по проектам сняты: снова права устройства на все проекты.',
  deviceHeader: '{name} ({id}), права устройства: {rights}',
  memberCeiling: 'Участник {member}: действует ещё потолок его роли в команде.',
  rightsOverride: 'переопределение',
  rightsForOthers: 'для остальных проектов',
  rightsOfDevice: 'права устройства',
  rightsOverrideMissing: 'переопределение, проекта нет в реестре',
  rightsOthers: 'Остальные и новые проекты: {access}',
  rightsOthersDevice: 'права устройства ({rights})',

  statusDataDir: 'Каталог данных: {dir}',
  statusRegistry: 'Реестр проектов: {file}',
  statusKey: 'Ключ секретов: {key}',
  statusRunning: 'Запущен: {value}',
  statusRunningPid: 'да, pid {pid}',
  none: 'нет',
  no: 'нет',
  statusCounts: 'Проектов: {projects}, устройств: {devices}',

  claudeLogin: 'Вход в Claude Code для агентов ph-agent (CLAUDE_CONFIG_DIR={dir}). В открывшемся claude выполните /login.',

  commandFailed: '{command} завершился с кодом {code}',
  serviceUsage: 'использование: ph-agent service install|uninstall|status',
  unitWritten: 'Unit: {file}',
  lingerHint: 'Чтобы служба работала без входа в систему: sudo loginctl enable-linger {user}',
  serviceUnsupported: 'служба для {platform} не поддерживается: запускайте ph-agent start своим супервизором',

  argValueRequired: 'Для {flag} нужно значение',
  argPort: '--port: число 1–65535',
  argRelay: '--relay: адрес вида wss://relay.example.com',
  argAccess: '{flag}: none | readOnly | hitl | full | inherit',
  argProject: '--project: <путь>=<none|readOnly|hitl|full|inherit>',
  argLang: '--lang: en | ru',
  argUnknownFlag: 'Неизвестный флаг {flag}',

  keyWrongSize: 'Ключ {file} должен быть 32 байта (сырые, hex или base64)',
  keyDpapiFailed: 'DPAPI {op} не выполнился: {detail}',

  debugHint: '(подробности: --debug)'
};

const LABELS: Record<Language, PhAgentLabels> = { en: EN, ru: RU };

export function phAgentText(lang: Language, key: PhAgentTextKey, params?: AppErrorParams): string {
  return fillAppErrorTemplate(LABELS[lang][key], params);
}

/** Ошибка ph-agent кодом словаря CLI: `message` — английский текст для журнала, терминал печатает на языке вывода. */
export class PhAgentError extends Error {
  readonly phAgentKey: PhAgentTextKey;
  readonly phAgentParams?: AppErrorParams;

  constructor(key: PhAgentTextKey, params?: AppErrorParams) {
    super(phAgentText('en', key, params));
    this.name = 'PhAgentError';
    this.phAgentKey = key;
    this.phAgentParams = params;
  }
}

/** Значение флага до разбора командной строки: язык и отладка нужны и для ошибки самого разбора. */
export function rawFlagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function phAgentLanguage(explicit: string | undefined, env: NodeJS.ProcessEnv, systemLocale?: string): Language {
  for (const chosen of [explicit, env.PH_AGENT_LANG]) {
    if (chosen && /^(en|ru)([-_.].*)?$/i.test(chosen.trim())) return resolveInitialLanguage(null, [chosen]);
  }
  // POSIX: первая заданная переменная решает, `C`/`POSIX` — английский.
  const posix = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (posix) return resolveInitialLanguage(null, [posix]);
  const system = systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return resolveInitialLanguage(null, system ? [system] : []);
}

export function phAgentDebug(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const flag = env.PH_AGENT_DEBUG?.trim().toLowerCase();
  return argv.includes('--debug') || (Boolean(flag) && flag !== '0' && flag !== 'false');
}

/**
 * Текст ошибки для терминала: ошибка CLI и `AppError` сервисов — на языке вывода, прочие — своим текстом с подсказкой
 * про `--debug`. Стек — только в режиме отладки.
 */
export function phAgentErrorText(err: unknown, lang: Language, debug: boolean): string {
  let text: string;
  let known = true;
  const key = appErrorKeyOf(err);
  if (err instanceof PhAgentError) text = phAgentText(lang, err.phAgentKey, err.phAgentParams);
  else if (key) text = formatAppError(key, lang === 'ru' ? appErrorTextRu : appErrorTextEn) ?? (err as Error).message;
  else {
    text = err instanceof Error ? err.message : String(err);
    known = false;
  }
  if (debug) return err instanceof Error && err.stack ? `${text}\n${err.stack}` : text;
  return known ? text : `${text} ${phAgentText(lang, 'debugHint')}`;
}
