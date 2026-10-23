/**
 * Чистые функции ph-agent (TASK-130, [[decision-119]]): разбор командной строки, ссылка сопряжения для hub-режима
 * и файлы службы для systemd, launchd и планировщика Windows. Без файловой системы и процессов — тестируются unit.
 */
import type { DeviceRights } from '../../src/types/remote';
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
  throw new Error(`${flag}: none | readOnly | hitl | full | inherit`);
}

export function parseArgs(argv: readonly string[]): PhAgentArgs {
  const out: PhAgentArgs = { command: 'start', rest: [], dryRun: false, autoAssigned: false, projectRights: { reset: false, projects: [] } };
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`A value is required for ${a}`);
      return v;
    };
    if (a === '--help' || a === '-h') out.command = 'help';
    else if (a === '--name') out.name = value();
    else if (a === '--port') {
      const p = Number(value());
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('--port: a number 1–65535');
      out.port = p;
    } else if (a === '--relay') {
      const r = value();
      if (!/^wss?:\/\/\S+$/i.test(r)) throw new Error('--relay: an address like wss://relay.example.com');
      out.relay = r;
    } else if (a === '--data') out.data = value();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--auto-assigned') out.autoAssigned = true;
    else if (a === '--reset') out.projectRights.reset = true;
    else if (a === '--default') out.projectRights.defaultAccess = parseAccessEdit(value(), a);
    else if (a === '--project') {
      // <путь>=<право>: путь может содержать «=», право — нет, поэтому делим по последнему.
      const v = value();
      const at = v.lastIndexOf('=');
      if (at <= 0) throw new Error('--project: <path>=<none|readOnly|hitl|full|inherit>');
      out.projectRights.projects.push({ path: v.slice(0, at), access: parseAccessEdit(v.slice(at + 1), a) });
    } else if (a.startsWith('--')) throw new Error(`Unknown flag ${a}`);
    else if (!commandSet && COMMANDS.has(a as PhAgentCommand)) {
      if (out.command !== 'help') out.command = a as PhAgentCommand;
      commandSet = true;
    } else out.rest.push(a);
  }
  return out;
}

export const HELP = `ph-agent — хост федерации ProjectHub без окна (decision-119)

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

Окружение: PH_AGENT_DATA — каталог данных (~/.projecthub-agent), PH_AGENT_HOME — домашний каталог реестра проектов,
PH_AGENT_KEY_FILE — ключ секретов, PH_AGENT_FEDERATION_SECRET — общий секрет федерации для каталога и LAN.`;

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
Description=ProjectHub ph-agent — хост федерации без окна
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${env}
Restart=always
RestartSec=5
# Ключ секретов можно передать как зашифрованный credential (systemd-creds encrypt):
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
    <Description>ProjectHub ph-agent — хост федерации без окна</Description>
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
export function describeProjectRights(deviceRights: DeviceRights, rights: DeviceProjectRights | undefined, registry: readonly string[]): string[] {
  const lines: string[] = [];
  const known = new Set(registry.map(projectAccessKey));
  for (const p of registry) {
    const own = rights?.projects?.[projectAccessKey(p)];
    const source = own ? 'переопределение' : rights?.defaultAccess ? 'для остальных проектов' : 'права устройства';
    lines.push(`${projectAccessFor(deviceRights, rights, p).padEnd(8)}  ${p}  (${source})`);
  }
  for (const [key, access] of Object.entries(rights?.projects ?? {})) {
    if (!known.has(key)) lines.push(`${access.padEnd(8)}  ${key}  (переопределение, проекта нет в реестре)`);
  }
  lines.push(`Остальные и новые проекты: ${rights?.defaultAccess ?? `права устройства (${deviceRights})`}`);
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
