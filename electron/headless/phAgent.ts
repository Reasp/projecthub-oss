import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentDataDir, agentHomeDir, secretKeySource } from './electronShim.js';
import {
  HELP,
  WINDOWS_TASK_NAME,
  launchdPlist,
  pairingLink,
  parseArgs,
  serviceStartArgs,
  systemdUnit,
  windowsTaskXml,
  type PhAgentArgs,
  type ServiceSpec
} from './phAgentCli.js';

/**
 * ph-agent — хост федерации ProjectHub без окна (TASK-130, [[decision-119]]). Те же сервисы main-процесса, что у
 * десктопа, собранные с shim модуля `electron`: Remote Control (hub-режим другого ProjectHub и телефон), назначенный
 * агент Claude CLI в worktree, HITL через встроенный MCP. Сервисы грузятся динамически — после того как каталог
 * данных задан: конфиг Remote Control читается ещё в конструкторе модуля.
 */

const PID_FILE = 'ph-agent.pid';
const PAIRING_FILE = 'pairing.txt';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`ph-agent: ${message}\n`);
  process.exit(1);
}

function pidFile(): string {
  return path.join(agentDataDir(), PID_FILE);
}

/** Работает ли ph-agent с этим каталогом данных: pid из файла жив. */
function runningPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function loadServices() {
  const [{ logger, parseLogLevel }, { remoteControlService }, { projectRegistry }] = await Promise.all([
    import('../services/logger.js'),
    import('../services/remoteControlService.js'),
    import('../services/projectRegistry.js')
  ]);
  logger.init({ dir: path.join(agentDataDir(), 'logs'), minLevel: parseLogLevel(process.env.PROJECTHUB_LOG_LEVEL, 'info') });
  return { logger, remoteControlService, projectRegistry };
}

function writePairing(text: string): string {
  const file = path.join(agentDataDir(), PAIRING_FILE);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

async function start(args: PhAgentArgs): Promise<void> {
  const other = runningPid();
  if (other) fail(`уже запущен (pid ${other}) с каталогом данных ${agentDataDir()}`);
  fs.mkdirSync(agentDataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile(), String(process.pid));

  const { logger, remoteControlService, projectRegistry } = await loadServices();
  logger.captureConsole();
  const [{ hitlService }, { agentFleetService }, { claudeBridgeService }, { mcpServerService }] = await Promise.all([
    import('../services/hitlService.js'),
    import('../services/agentFleetService.js'),
    import('../services/claudeBridgeService.js'),
    import('../services/mcpServerService.js')
  ]);

  // Порядок — как в main.ts (decision-119 п. 4): HITL, флот, брокер разрешений CLI, MCP, Remote Control.
  hitlService.configure({ hostId: remoteControlService.getHostId() });
  await hitlService.init({ dir: path.join(agentDataDir(), 'hitl'), auditDir: path.join(agentDataDir(), 'audit') });
  await agentFleetService.init();
  claudeBridgeService.setCliPermissionBroker({ ensureEndpoint: () => mcpServerService.ensurePermissionEndpoint() });
  await mcpServerService.init();
  if (!(await mcpServerService.start())) logger.warn('[ph-agent] MCP-сервер не запустился: HITL агентов Claude CLI недоступен');

  await remoteControlService.initOnStartup();
  await remoteControlService.updateConfig({
    machineName: args.name || os.hostname(),
    ...(args.port ? { port: args.port } : {}),
    // Релей — только явно: адрес по умолчанию (127.0.0.1:42055) на сервере никуда не ведёт.
    ...(args.relay ? { relayServerUrl: args.relay, mode: 'relay' as const } : { relayServerUrl: '', mode: 'lan' as const }),
    // Подтвердить устройство на хосте нечем: доказательство — PIN или ключ из ссылки (decision-119 п. 5).
    requireApproval: false,
    sessionV2Only: true,
    autoStartAssignedTasks: args.autoAssigned,
    ...(process.env.PH_AGENT_FEDERATION_SECRET ? { federationSecret: process.env.PH_AGENT_FEDERATION_SECRET } : {})
  });
  await remoteControlService.start();
  // Активный проект хоста выбирает окно; у ph-agent окна нет — первый проект реестра. «Удалённые хосты» по нему
  // показывают задачи и кнопку запуска назначенного агента, другой проект выбирает `select_project`.
  const first = (await projectRegistry.getProjects())[0];
  if (first) remoteControlService.setActiveProject(first.path);
  const status = remoteControlService.getStatus();
  const addresses = remoteControlService.getPhoneEndpoints().filter((e) => e.kind === 'lan' || e.kind === 'vpn');
  const lines = [
    `hostId: ${status.hostId}`,
    `Имя: ${status.machineName}`,
    `PIN: ${status.pairingPin}`,
    ...addresses.map((e) => `Ссылка (${e.kind}): ${pairingLink({ address: new URL(e.url).host, hostId: status.hostId, secretKey: status.secretKey, hostKey: status.hostKey ?? '' })}`)
  ];
  const pairing = writePairing(`${lines.join('\n')}\n`);
  logger.info(`[ph-agent] Хост ${status.machineName} (${status.hostId}) слушает порт ${status.port}; отпечаток ключа ${status.hostKeyFingerprint}`);
  logger.info(`[ph-agent] Данные для сопряжения: ${pairing} (или ph-agent pair-info)`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`[ph-agent] Остановка (${signal})`);
    try {
      await hitlService.shutdown('ph-agent остановлен');
      claudeBridgeService.killAll();
      await agentFleetService.shutdown();
      await mcpServerService.stop();
      await remoteControlService.stop();
    } finally {
      fs.rmSync(pidFile(), { force: true });
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => {
    try {
      if (fs.readFileSync(pidFile(), 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile(), { force: true });
    } catch {
      // файла уже нет
    }
  });
}

async function pairInfo(): Promise<void> {
  const file = path.join(agentDataDir(), PAIRING_FILE);
  if (!fs.existsSync(file)) fail('ph-agent ещё не запускался с этим каталогом данных: выполните ph-agent start');
  out(fs.readFileSync(file, 'utf8').trim());
  out();
  out('Управляющий ProjectHub: «Удалённые хосты» → «Добавить» → вставьте ссылку и при необходимости PIN.');
  if (!runningPid()) out('ph-agent сейчас не запущен.');
}

async function projects(args: PhAgentArgs): Promise<void> {
  const { projectRegistry } = await loadServices();
  if (args.command === 'add-project' || args.command === 'remove-project') {
    const target = args.rest[0] ? path.resolve(args.rest[0]) : '';
    if (!target) fail(`укажите путь: ph-agent ${args.command} <путь>`);
    if (args.command === 'add-project') {
      if (!fs.existsSync(target)) fail(`нет каталога ${target}`);
      await projectRegistry.addProject(target);
      out(`Добавлен: ${target}`);
    } else {
      await projectRegistry.removeProject(target);
      out(`Убран: ${target}`);
    }
    if (runningPid()) out('Работающий ph-agent увидит изменение при следующем запросе списка проектов.');
    return;
  }
  const list = await projectRegistry.getProjects();
  if (list.length === 0) out('Проектов нет: ph-agent add-project <путь>');
  for (const p of list) out(p.path);
}

async function devices(args: PhAgentArgs): Promise<void> {
  if (args.command === 'revoke') {
    const pid = runningPid();
    if (pid) fail(`остановите ph-agent (pid ${pid}) перед отзывом: работающий процесс перезапишет список устройств`);
  }
  const { remoteControlService } = await loadServices();
  await remoteControlService.initOnStartup();
  if (args.command === 'revoke') {
    const id = args.rest[0];
    if (!id) fail('укажите deviceId: ph-agent revoke <deviceId>');
    const removed = remoteControlService.revokeDeviceToken(id);
    // Запись токенов асинхронная — даём ей завершиться до выхода.
    await new Promise((r) => setTimeout(r, 300));
    out(removed.length > 0 ? `Отозвано: ${removed.join(', ')}` : `Устройства ${id} нет`);
    return;
  }
  const list = remoteControlService.getPairedDevices();
  if (list.length === 0) out('Сопряжённых устройств нет');
  for (const d of list) out(`${d.deviceId}  ${d.rights}  ${d.name}  ${new Date(d.createdAt).toISOString().slice(0, 16)}`);
}

async function status(): Promise<void> {
  const { projectRegistry, remoteControlService } = await loadServices();
  await remoteControlService.initOnStartup();
  const key = secretKeySource();
  const pid = runningPid();
  out(`Каталог данных: ${agentDataDir()}`);
  out(`Реестр проектов: ${path.join(agentHomeDir(), '.projecthub', 'projects.json')}`);
  out(`Ключ секретов: ${key ? `${key.kind} (${key.path})` : 'нет'}`);
  out(`hostId: ${remoteControlService.getHostId()}`);
  out(`Запущен: ${pid ? `да, pid ${pid}` : 'нет'}`);
  out(`Проектов: ${(await projectRegistry.getProjects()).length}, устройств: ${remoteControlService.getPairedDevices().length}`);
}

async function claudeLogin(): Promise<void> {
  const { defaultClaudeAccountDir } = await import('../services/claudeAccountService.js');
  const dir = defaultClaudeAccountDir();
  fs.mkdirSync(dir, { recursive: true });
  out(`Вход в Claude Code для агентов ph-agent (CLAUDE_CONFIG_DIR=${dir}). В открывшемся claude выполните /login.`);
  const child = spawn('claude', [], { stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, shell: process.platform === 'win32' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
}

function serviceSpec(args: PhAgentArgs): ServiceSpec {
  // PATH установившего: у службы свой короткий PATH, без него не найдутся `claude` и `git` из каталогов пользователя.
  const env: Record<string, string> = process.env.PATH ? { PATH: process.env.PATH } : {};
  if (process.env.PH_AGENT_HOME) env.PH_AGENT_HOME = process.env.PH_AGENT_HOME;
  if (process.env.PH_AGENT_KEY_FILE) env.PH_AGENT_KEY_FILE = process.env.PH_AGENT_KEY_FILE;
  return { nodePath: process.execPath, scriptPath: fileURLToPath(import.meta.url), dataDir: agentDataDir(), startArgs: serviceStartArgs(args), env };
}

function run(cmd: string, argv: string[], dryRun: boolean): void {
  out(`$ ${cmd} ${argv.join(' ')}`);
  if (dryRun) return;
  const res = spawnSync(cmd, argv, { stdio: 'inherit', windowsHide: true });
  if (res.status !== 0) fail(`${cmd} завершился с кодом ${res.status ?? res.error?.message}`);
}

async function service(args: PhAgentArgs): Promise<void> {
  const action = args.rest[0];
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') fail('ph-agent service install|uninstall|status');
  const spec = serviceSpec(args);
  const dry = args.dryRun;

  if (process.platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const unit = path.join(unitDir, 'ph-agent.service');
    if (action === 'install') {
      const text = systemdUnit(spec);
      if (dry) out(text);
      else {
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(unit, text);
        out(`Unit: ${unit}`);
      }
      run('systemctl', ['--user', 'daemon-reload'], dry);
      run('systemctl', ['--user', 'enable', '--now', 'ph-agent.service'], dry);
      out(`Чтобы служба работала без входа в систему: sudo loginctl enable-linger ${os.userInfo().username}`);
    } else if (action === 'uninstall') {
      run('systemctl', ['--user', 'disable', '--now', 'ph-agent.service'], dry);
      if (!dry) fs.rmSync(unit, { force: true });
      run('systemctl', ['--user', 'daemon-reload'], dry);
    } else run('systemctl', ['--user', 'status', '--no-pager', 'ph-agent.service'], dry);
    return;
  }

  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.projecthub.ph-agent.plist');
    if (action === 'install') {
      const text = launchdPlist(spec);
      if (dry) out(text);
      else {
        fs.mkdirSync(path.dirname(plist), { recursive: true });
        fs.mkdirSync(path.join(spec.dataDir, 'logs'), { recursive: true });
        fs.writeFileSync(plist, text);
      }
      run('launchctl', ['load', '-w', plist], dry);
    } else if (action === 'uninstall') {
      run('launchctl', ['unload', '-w', plist], dry);
      if (!dry) fs.rmSync(plist, { force: true });
    } else run('launchctl', ['list', 'com.projecthub.ph-agent'], dry);
    return;
  }

  if (process.platform === 'win32') {
    if (action === 'install') {
      const user = `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
      const text = windowsTaskXml(spec, user);
      const file = path.join(agentDataDir(), 'ph-agent-task.xml');
      if (dry) out(text);
      else {
        fs.mkdirSync(agentDataDir(), { recursive: true });
        // Планировщик ждёт XML в UTF-16 с BOM.
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
      }
      run('schtasks', ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', file, '/F'], dry);
      run('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], dry);
    } else if (action === 'uninstall') {
      run('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME], dry);
      run('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], dry);
    } else run('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/V', '/FO', 'LIST'], dry);
    return;
  }
  fail(`служба для ${process.platform} не поддерживается — запускайте ph-agent start своим супервизором`);
}

async function main(): Promise<void> {
  let args: PhAgentArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (args.data) process.env.PH_AGENT_DATA = path.resolve(args.data);
  switch (args.command) {
    case 'help':
      out(HELP);
      return;
    case 'start':
      return start(args);
    case 'pair-info':
      return pairInfo();
    case 'status':
      return status();
    case 'add-project':
    case 'remove-project':
    case 'projects':
      return projects(args);
    case 'devices':
    case 'revoke':
      return devices(args);
    case 'claude-login':
      return claudeLogin();
    case 'service':
      return service(args);
  }
}

let keepAlive = false;
try {
  keepAlive = parseArgs(process.argv.slice(2)).command === 'start';
} catch {
  // ошибку аргументов покажет main
}
main().then(
  () => {
    // Команды, кроме start, не держат процесс: сервисы оставляют таймеры, поэтому выходим явно.
    if (!keepAlive) setTimeout(() => process.exit(0), 200);
  },
  (err) => fail(err instanceof Error ? err.stack || err.message : String(err))
);
