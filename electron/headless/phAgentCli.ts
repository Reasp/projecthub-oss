/**
 * Чистые функции ph-agent (TASK-130, [[decision-119]]): разбор командной строки, ссылка сопряжения для hub-режима
 * и файлы службы для systemd, launchd и планировщика Windows. Без файловой системы и процессов — тестируются unit.
 */
import type { DeviceRights } from '../../src/types/remote';
import type { Language } from '../../src/i18n/types';
import { PhAgentError, phAgentText, type PhAgentTextKey } from './phAgentText';
import {
  isProjectAccess,
  projectAccessFor,
  projectAccessKey,
  sanitizeProjectRights,
  type DeviceProjectRights,
  type ProjectAccess
} from '../../src/utils/projectAccess';

export type PhAgentCommand =
  | 'start'
  | 'pair-info'
  | 'status'
  | 'add-project'
  | 'remove-project'
  | 'projects'
  | 'devices'
  | 'device-projects'
  | 'revoke'
  | 'claude-login'
  | 'service'
  | 'help';

export interface PhAgentArgs {
  command: PhAgentCommand;
  /** Позиционные аргументы после команды: путь проекта, id устройства, `install|uninstall|status`. */
  rest: string[];
  name?: string;
  port?: number;
  relay?: string;
  data?: string;
  dryRun: boolean;
  /** Язык вывода (`--lang`); без флага — `PH_AGENT_LANG` и язык системы (`phAgentLanguage`). */
  lang?: Language;
  /** Печатать стек ошибки (`--debug`). */
  debug: boolean;
  /** Автозапуск назначенных этому хосту задач по `git pull` (decision-19 п. 5). */
  autoAssigned: boolean;
  /** Правка прав устройства по проектам (`device-projects`, decision-147). */
  projectRights: ProjectRightsEdit;
}

/** Право в правке: уровень доступа или `inherit` — снять настройку. */
export type ProjectAccessEdit = ProjectAccess | 'inherit';

export interface ProjectRightsEdit {
  /** Сначала снять все настройки по проектам — снова права устройства на все проекты. */
  reset: boolean;
  /** Право для остальных и новых проектов. */
  defaultAccess?: ProjectAccessEdit;
  /** Переопределения по проектам, по порядку флагов. */
  projects: Array<{ path: string; access: ProjectAccessEdit }>;
}

const COMMANDS = new Set<PhAgentCommand>(['start', 'pair-info', 'status', 'add-project', 'remove-project', 'projects', 'devices', 'device-projects', 'revoke', 'claude-login', 'service', 'help']);

function parseAccessEdit(raw: string, flag: string): ProjectAccessEdit {
  if (raw === 'inherit' || isProjectAccess(raw)) return raw;
  throw new PhAgentError('argAccess', { flag });
}

export function parseArgs(argv: readonly string[]): PhAgentArgs {
  const out: PhAgentArgs = { command: 'start', rest: [], dryRun: false, debug: false, autoAssigned: false, projectRights: { reset: false, projects: [] } };
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new PhAgentError('argValueRequired', { flag: a });
      return v;
    };
    if (a === '--help' || a === '-h') out.command = 'help';
    else if (a === '--name') out.name = value();
    else if (a === '--port') {
      const p = Number(value());
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new PhAgentError('argPort');
      out.port = p;
    } else if (a === '--relay') {
      const r = value();
      if (!/^wss?:\/\/\S+$/i.test(r)) throw new PhAgentError('argRelay');
      out.relay = r;
    } else if (a === '--data') out.data = value();
    else if (a === '--lang') {
      const l = value();
      if (l !== 'en' && l !== 'ru') throw new PhAgentError('argLang');
      out.lang = l;
    } else if (a === '--debug') out.debug = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--auto-assigned') out.autoAssigned = true;
    else if (a === '--reset') out.projectRights.reset = true;
    else if (a === '--default') out.projectRights.defaultAccess = parseAccessEdit(value(), a);
    else if (a === '--project') {
      // <путь>=<право>: путь может содержать «=», право — нет, поэтому делим по последнему.
      const v = value();
      const at = v.lastIndexOf('=');
      if (at <= 0) throw new PhAgentError('argProject');
      out.projectRights.projects.push({ path: v.slice(0, at), access: parseAccessEdit(v.slice(at + 1), a) });
    } else if (a.startsWith('--')) throw new PhAgentError('argUnknownFlag', { flag: a });
    else if (!commandSet && COMMANDS.has(a as PhAgentCommand)) {
      if (out.command !== 'help') out.command = a as PhAgentCommand;
      commandSet = true;
    } else out.rest.push(a);
  }
  return out;
}

/** Ссылка сопряжения в формате окна Remote Control: её понимает поле «Ссылка сопряжения» в «Удалённых хостах». */
export function pairingLink(o: { address: string; hostId: string; secretKey: string; hostKey: string }): string {
  const hash = new URLSearchParams({ hostId: o.hostId, key: o.secretKey, ...(o.hostKey ? { hk: o.hostKey } : {}), mode: 'lan' });
  return `http://${o.address}/remote#${hash.toString()}`;
}

export interface ServiceSpec {
  nodePath: string;
  scriptPath: string;
  dataDir: string;
  /** Аргументы `start` (имя, порт, релей) — сохраняются в службе. */
  startArgs: string[];
  /** Переменные, которые нужны службе (секрет федерации не пишется в файл службы — только путь к ключу и каталоги). */
  env: Record<string, string>;
}

/** Описание службы в файлах ОС — английское: файлы службы не зависят от языка установившего. */
const SERVICE_DESCRIPTION = 'ProjectHub ph-agent — windowless federation host';

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Пользовательский unit systemd: работает от владельца входа в Claude Code, перезапускается при падении. */
export function systemdUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.scriptPath, 'start', ...spec.startArgs].map(shellQuote).join(' ');
  const env = Object.entries({ PH_AGENT_DATA: spec.dataDir, ...spec.env })
    .map(([k, v]) => `Environment=${shellQuote(`${k}=${v}`)}`)
    .join('\n');
  return `[Unit]
Description=${SERVICE_DESCRIPTION}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${env}
Restart=always
RestartSec=5
# The secret key can be passed as an encrypted credential (systemd-creds encrypt):
# LoadCredentialEncrypted=ph-agent.key:%h/.config/ph-agent/ph-agent.key.cred
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.nodePath, spec.scriptPath, 'start', ...spec.startArgs].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries({ PH_AGENT_DATA: spec.dataDir, ...spec.env })
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.projecthub.ph-agent</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(`${spec.dataDir}/logs/launchd.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${spec.dataDir}/logs/launchd.log`)}</string>
</dict>
</plist>
`;
}

export const WINDOWS_TASK_NAME = 'ProjectHub ph-agent';

/**
 * Задача планировщика Windows при входе пользователя с перезапуском при сбое (decision-119 п. 8). Запуск — через
 * `cmd /c` с переменными окружения: у задачи планировщика своих переменных нет.
 */
export function windowsTaskXml(spec: ServiceSpec, userId: string): string {
  const sets = Object.entries({ PH_AGENT_DATA: spec.dataDir, ...spec.env })
    .map(([k, v]) => `set "${k}=${v}"`)
    .join(' && ');
  const run = [spec.nodePath, spec.scriptPath, 'start', ...spec.startArgs].map((a) => `"${a}"`).join(' ');
  const command = `/d /s /c "${sets} && ${run}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(SERVICE_DESCRIPTION)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xml(command)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function hasProjectRightsEdit(edit: ProjectRightsEdit): boolean {
  return edit.reset || edit.defaultAccess !== undefined || edit.projects.length > 0;
}

/**
 * Новые права устройства по проектам после правки из командной строки. Пути — как их понимает хост
 * (`projectAccessKey`); `resolvePath` делает относительный путь абсолютным. `undefined` — настроек не осталось.
 */
export function applyProjectRightsEdit(
  current: DeviceProjectRights | undefined,
  edit: ProjectRightsEdit,
  resolvePath: (p: string) => string = (p) => p
): DeviceProjectRights | undefined {
  const projects: Record<string, ProjectAccess> = edit.reset ? {} : { ...(current?.projects ?? {}) };
  let defaultAccess = edit.reset ? undefined : current?.defaultAccess;
  if (edit.defaultAccess !== undefined) defaultAccess = edit.defaultAccess === 'inherit' ? undefined : edit.defaultAccess;
  for (const { path, access } of edit.projects) {
    const key = projectAccessKey(resolvePath(path));
    if (access === 'inherit') delete projects[key];
    else projects[key] = access;
  }
  return sanitizeProjectRights({ projects, ...(defaultAccess ? { defaultAccess } : {}) });
}

/** Строки «право  путь  (откуда)» по проектам реестра и по переопределениям проектов, которых в реестре нет. */
export function describeProjectRights(
  deviceRights: DeviceRights,
  rights: DeviceProjectRights | undefined,
  registry: readonly string[],
  lang: Language = 'en'
): string[] {
  const t = (key: PhAgentTextKey, params?: Record<string, string>) => phAgentText(lang, key, params);
  const lines: string[] = [];
  const known = new Set(registry.map(projectAccessKey));
  for (const p of registry) {
    const own = rights?.projects?.[projectAccessKey(p)];
    const source = own ? t('rightsOverride') : rights?.defaultAccess ? t('rightsForOthers') : t('rightsOfDevice');
    lines.push(`${projectAccessFor(deviceRights, rights, p).padEnd(8)}  ${p}  (${source})`);
  }
  for (const [key, access] of Object.entries(rights?.projects ?? {})) {
    if (!known.has(key)) lines.push(`${access.padEnd(8)}  ${key}  (${t('rightsOverrideMissing')})`);
  }
  lines.push(t('rightsOthers', { access: rights?.defaultAccess ?? t('rightsOthersDevice', { rights: deviceRights }) }));
  return lines;
}

/** Аргументы `start`, которые служба должна повторять при каждом запуске. */
export function serviceStartArgs(args: PhAgentArgs): string[] {
  return [
    ...(args.name ? ['--name', args.name] : []),
    ...(args.port ? ['--port', String(args.port)] : []),
    ...(args.relay ? ['--relay', args.relay] : []),
    ...(args.autoAssigned ? ['--auto-assigned'] : [])
  ];
}
