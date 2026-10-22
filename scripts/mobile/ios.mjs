#!/usr/bin/env node
/**
 * Отладочная сборка iOS мобильного клиента (TASK-140.18). Только macOS с Xcode.
 *
 *   npm run mobile:ios:sim        — собрать под симулятор
 *   npm run mobile:ios:selftest   — собрать, запустить в симуляторе и проверить WebCrypto, Keychain и ws:// в LAN
 *   npm run mobile:ios:install    — собрать с подписью бесплатной командой Apple ID и поставить на iPhone по кабелю
 *                                   (iOS 17+ — devicectl, iOS 16 и старше — libimobiledevice: brew install ideviceinstaller)
 *   npm run mobile:ios:open       — записать подпись и версию в local.xcconfig и открыть проект в Xcode
 *
 * Подпись — Personal Team из Xcode → Settings → Accounts (бесплатный Apple ID): приложение работает 7 дней, push и
 * TestFlight недоступны (decision-152). Команду можно задать явно: PH_IOS_TEAM=<Team ID>; bundle id — PH_IOS_BUNDLE_ID,
 * если com.projecthub.mobile уже занят чужой командой. Релизная подпись и сторы — TASK-140.6.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { appVersion, checkVersions, fail, mobileDir, root, run } from './common.mjs';

const iosDir = path.join(mobileDir, 'ios');
const projectDir = path.join(iosDir, 'App');
// App/build — в .gitignore проекта iOS.
const derivedDir = path.join(projectDir, 'build');
const mode = process.argv[2] || 'sim';
const DEFAULT_BUNDLE_ID = 'com.projecthub.mobile';
const REMOTE_PORT = 42050;
const TRUST_HINT = 'Если iPhone не открывает приложение: Настройки → Основные → VPN и управление устройством → ваш Apple ID → «Доверять».';

if (process.platform !== 'darwin') fail('сборка iOS возможна только на macOS с Xcode');
if (!['sim', 'selftest', 'install', 'open'].includes(mode)) fail(`неизвестный режим «${mode}»: sim, selftest, install или open`);

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmpJson(name) {
  return path.join(os.tmpdir(), `ph-ios-${process.pid}-${name}.json`);
}

/**
 * Бинарные xcframework Capacitor кладутся в кэш SwiftPM заранее: xcodebuild на загрузке бинарных пакетов бывает
 * подвисает без вывода, а fetch надёжен. Контрольную сумму из Package.swift SwiftPM проверяет сам.
 */
async function prefetchCapacitorBinaries() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@capacitor', 'ios', 'package.json'), 'utf8')).version;
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'org.swift.swiftpm', 'artifacts');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const name of ['Capacitor', 'Cordova']) {
    const url = `https://github.com/ionic-team/capacitor-swift-pm/releases/download/${version}/${name}.xcframework.zip`;
    const cached = path.join(cacheDir, url.replace(/[^A-Za-z0-9]/g, '_'));
    if (fs.existsSync(cached)) continue;
    console.log(`⬇ ${url}`);
    const res = await fetch(url);
    if (!res.ok) fail(`не удалось скачать ${url}: HTTP ${res.status}`);
    fs.writeFileSync(`${cached}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${cached}.part`, cached);
  }
}

/** Команда подписи: PH_IOS_TEAM или аккаунт, добавленный в Xcode (последняя выбранная, затем бесплатная). */
function findTeam() {
  if (process.env.PH_IOS_TEAM) return { id: process.env.PH_IOS_TEAM, name: 'PH_IOS_TEAM' };
  const plist = path.join(os.homedir(), 'Library', 'Preferences', 'com.apple.dt.Xcode.plist');
  if (!fs.existsSync(plist)) return null;
  const read = (key) => {
    try {
      return JSON.parse(capture('plutil', ['-extract', key, 'json', '-o', '-', plist]));
    } catch {
      return null;
    }
  };
  const byAccount = read('IDEProvisioningTeamByIdentifier') ?? read('IDEProvisioningTeams') ?? {};
  const teams = Object.values(byAccount).flat().filter((t) => t && t.teamID);
  if (teams.length === 0) return null;
  const last = read('IDEProvisioningTeamManagerLastSelectedTeamID');
  const team = teams.find((t) => t.teamID === last) ?? teams.find((t) => t.isFreeProvisioningTeam) ?? teams[0];
  return { id: team.teamID, name: team.teamName ?? team.teamID };
}

/** Подпись и версия этой машины для Debug: их подключает debug.xcconfig, ими же собирает кнопка Run в Xcode. */
function writeLocalXcconfig(team) {
  const { version, build } = appVersion();
  const lines = [
    '// Written by scripts/mobile/ios.mjs (TASK-140.18). Machine-specific, not in git.',
    `MARKETING_VERSION = ${version}`,
    `CURRENT_PROJECT_VERSION = ${build}`
  ];
  if (team) lines.push(`DEVELOPMENT_TEAM = ${team.id}`, 'CODE_SIGN_STYLE = Automatic');
  if (process.env.PH_IOS_BUNDLE_ID) lines.push(`PRODUCT_BUNDLE_IDENTIFIER = ${process.env.PH_IOS_BUNDLE_ID}`);
  fs.writeFileSync(path.join(iosDir, 'local.xcconfig'), `${lines.join('\n')}\n`);
  console.log(`Версия ${version} (${build})${team ? `, команда ${team.name} (${team.id})` : ''}`);
}

function xcodebuild(args) {
  run('xcodebuild', ['-project', 'App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug', '-derivedDataPath', derivedDir, ...args], projectDir, env);
}

/** Подключённый iPhone: CoreDevice (devicectl) видит телефоны с iOS 17+ и сопряжённые с этим Mac. */
function findDevice() {
  const out = tmpJson('devices');
  try {
    capture('xcrun', ['devicectl', 'list', 'devices', '--json-output', out]);
    const devices = JSON.parse(fs.readFileSync(out, 'utf8')).result?.devices ?? [];
    const phones = devices.filter((d) => d.hardwareProperties?.reality !== 'simulated' && d.hardwareProperties?.platform === 'iOS');
    const ready = (d) => d.connectionProperties?.tunnelState === 'connected' || d.connectionProperties?.pairingState === 'paired';
    const phone = phones.find(ready) ?? phones[0];
    if (!phone) return null;
    return {
      id: phone.identifier,
      udid: phone.hardwareProperties?.udid,
      name: phone.deviceProperties?.name ?? phone.hardwareProperties?.marketingName ?? 'iPhone',
      os: phone.deviceProperties?.osVersionNumber,
      ready: ready(phone)
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Сопряжённый iPhone, который видит libimobiledevice (usbmuxd): нужен для iOS 16 и старше. */
function findLegacyDevice() {
  try {
    const udid = capture('idevice_id', ['-l']).split('\n').map((l) => l.trim()).find(Boolean);
    if (!udid) return null;
    const info = (key) => capture('ideviceinfo', ['-u', udid, '-k', key]).trim();
    return { udid, name: info('DeviceName') || 'iPhone', os: info('ProductVersion') };
  } catch {
    return null;
  }
}

/** UDID телефонов из профиля подписи сборки. */
function provisionedDevices(app) {
  try {
    const profile = capture('security', ['cms', '-D', '-i', path.join(app, 'embedded.mobileprovision')]);
    const json = execFileSync('plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', '-'], { input: profile, encoding: 'utf8' });
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/** .ipa из подписанного .app: Payload/App.app в zip. */
function packageIpa(app) {
  const staging = path.join(derivedDir, 'ipa');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'Payload'), { recursive: true });
  run('ditto', [app, path.join(staging, 'Payload', 'App.app')], root, env);
  const ipa = path.join(derivedDir, 'ProjectHub-ios-debug.ipa');
  fs.rmSync(ipa, { force: true });
  run('zip', ['-qry', ipa, 'Payload'], staging, env);
  return ipa;
}

/** Симулятор iPhone: PH_IOS_SIM, уже запущенный или с самой новой iOS. */
function findSimulator() {
  const list = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])).devices;
  const sims = Object.entries(list)
    .filter(([runtime]) => runtime.includes('iOS'))
    .sort(([a], [b]) => b.localeCompare(a, 'en', { numeric: true }))
    .flatMap(([, devices]) => devices)
    .filter((d) => d.name.startsWith('iPhone'));
  const wanted = process.env.PH_IOS_SIM;
  return (wanted && sims.find((d) => d.udid === wanted || d.name === wanted)) || sims.find((d) => d.state === 'Booted') || sims[0] || null;
}

function lanAddress() {
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return candidates[0]?.address ?? null;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Запуск с `-phSelfTest`: страница пишет в консоль строку PH_SELFTEST {json} (App/SelfTest.swift, только Debug). */
function runSelfTest(sim, wsUrl) {
  return new Promise((resolve) => {
    const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', sim.udid, bundleId, '-phSelfTest', wsUrl], { env });
    let buffer = '';
    const done = (result) => {
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 45000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/PH_SELFTEST (\{.*\})/);
      if (match) done(JSON.parse(match[1]));
    });
    child.on('exit', () => done(null));
  });
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const bundleId = process.env.PH_IOS_BUNDLE_ID || DEFAULT_BUNDLE_ID;

checkVersions();
try {
  capture('xcodebuild', ['-version']);
} catch {
  fail('не найден Xcode: поставьте его из App Store и выполните sudo xcode-select -s /Applications/Xcode.app');
}

const team = findTeam();
if ((mode === 'install' || mode === 'open') && !team) {
  fail('в Xcode нет Apple ID: Xcode → Settings → Accounts → «+» → Apple ID, затем запустите команду снова (или задайте PH_IOS_TEAM)');
}
writeLocalXcconfig(mode === 'install' || mode === 'open' ? team : null);

run('npm', ['run', 'build:mobile:capacitor'], root, env);
run('npx', ['cap', 'sync', 'ios'], mobileDir, env);
await prefetchCapacitorBinaries();

if (mode === 'open') {
  run('open', [path.join(projectDir, 'App.xcodeproj')], root, env);
  console.log('✅ Проект открыт: выберите iPhone в списке устройств вверху окна Xcode и нажмите Run (⌘R).');
  process.exit(0);
}

if (mode === 'sim' || mode === 'selftest') {
  xcodebuild(['-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', 'build']);
  const app = path.join(derivedDir, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
  if (!fs.existsSync(app)) fail(`приложение не найдено: ${app}`);
  console.log(`✅ ${path.relative(root, app)}`);
  if (mode === 'sim') process.exit(0);

  const sim = findSimulator();
  if (!sim) fail('нет симулятора iPhone: Xcode → Settings → Components → iOS');
  console.log(`Симулятор: ${sim.name} (${sim.udid})`);
  if (sim.state !== 'Booted') run('xcrun', ['simctl', 'boot', sim.udid], root, env);
  run('xcrun', ['simctl', 'bootstatus', sim.udid, '-b'], root, env);
  run('xcrun', ['simctl', 'install', sim.udid, app], root, env);

  const host = process.env.PH_SELFTEST_HOST || lanAddress() || '127.0.0.1';
  const wsUrl = `ws://${host}:${REMOTE_PORT}/`;
  const hostListening = await portOpen(host, REMOTE_PORT);
  const r = await runSelfTest(sim, wsUrl);
  if (!r) fail('приложение не прислало результат самопроверки за 45 с');
  console.log(JSON.stringify(r, null, 2));
  const checks = [
    ['защищённый контекст', r.secureContext === true],
    ['WebCrypto ECDH P-256', r.ecdhP256 === true],
    ['WebCrypto X25519', r.x25519 === true],
    ['плагин PhSecureStore', r.plugins?.PhSecureStore === true],
    ['плагин PhTts', r.plugins?.PhTts === true],
    ['Keychain: запись и чтение', r.keychainRoundTrip === true && r.keychainRemoved === true],
    ['localStorage пуст', Array.isArray(r.localStorageKeys) && r.localStorageKeys.length === 0]
  ];
  // ws:// проверяется, только если на этом Mac слушает Remote Control ProjectHub.
  if (hostListening) checks.push([`WebSocket ${wsUrl}`, r.ws === 'open']);
  else console.log(`ℹ ${host}:${REMOTE_PORT} не слушает (ProjectHub или Remote Control выключен) — ws:// не проверялся`);
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  const shot = path.join(derivedDir, 'selftest.png');
  run('xcrun', ['simctl', 'io', sim.udid, 'screenshot', shot], root, env);
  console.log(`Снимок экрана: ${path.relative(root, shot)}`);
  if (checks.some(([, ok]) => !ok)) fail('самопроверка не пройдена');
  console.log('✅ Самопроверка пройдена');
  process.exit(0);
}

// install
const app = path.join(derivedDir, 'Build', 'Products', 'Debug-iphoneos', 'App.app');
const device = findDevice();
if (device?.ready && device.udid) {
  console.log(`iPhone: ${device.name}${device.os ? `, iOS ${device.os}` : ''}`);
  xcodebuild(['-destination', `id=${device.udid}`, '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build']);
  if (!fs.existsSync(app)) fail(`приложение не найдено: ${app}`);
  run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.id, app], root, env);
  try {
    capture('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.id, bundleId]);
    console.log('✅ Установлено и запущено на iPhone.');
  } catch {
    console.log(`✅ Установлено. ${TRUST_HINT}`);
  }
} else {
  // iOS 16 и старше: CoreDevice их не поддерживает, а Xcode 27 не видит вовсе. Ставим подписанную сборку через
  // libimobiledevice — он работает с сопряжённым телефоном напрямую по USB.
  const legacy = findLegacyDevice();
  if (!legacy) {
    fail(
      'iPhone не найден: подключите его кабелем, разблокируйте и нажмите «Доверять». Для iOS 17+ включите Настройки → ' +
        'Конфиденциальность и безопасность → Режим разработчика; для iOS 16 и старше нужен libimobiledevice: brew install ideviceinstaller'
    );
  }
  console.log(`iPhone: ${legacy.name}, iOS ${legacy.os} — установка через libimobiledevice`);
  xcodebuild(['-destination', 'generic/platform=iOS', '-allowProvisioningUpdates', 'build']);
  if (!fs.existsSync(app)) fail(`приложение не найдено: ${app}`);
  // Профиль бесплатной команды пускает только зарегистрированные телефоны; зарегистрировать новый может только Xcode.
  if (!provisionedDevices(app).includes(legacy.udid)) {
    fail(`${legacy.name} не зарегистрирован в профиле команды: подключите его один раз к Xcode (Window → Devices and Simulators) или к Xcode 16, затем повторите`);
  }
  const ipa = packageIpa(app);
  run('ideviceinstaller', ['-u', legacy.udid, 'install', ipa], root, env);
  console.log(`✅ Установлено: откройте ProjectHub на iPhone. ${TRUST_HINT}`);
}
console.log('Подпись бесплатного Apple ID действует 7 дней: потом повторите npm run mobile:ios:install.');
