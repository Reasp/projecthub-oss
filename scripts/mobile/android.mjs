#!/usr/bin/env node
/**
 * Отладочный APK мобильного клиента (TASK-140.8).
 *
 *   npm run mobile:android:apk       — собрать release/mobile/ProjectHub-android-debug.apk
 *   npm run mobile:android:install   — собрать и поставить на телефон по adb (USB-отладка)
 *
 * Нужны JDK 17+ и Android SDK (platform 36, build-tools). Ищутся в JAVA_HOME/ANDROID_HOME, затем
 * в стандартных местах Windows/macOS/Linux. Подпись — отладочный ключ Gradle; релизная подпись и
 * сторы — TASK-140.6, ключи только в секретах CI (decision-79 п. 10).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const mobileDir = path.join(root, 'mobile');
const androidDir = path.join(mobileDir, 'android');
const outDir = path.join(root, 'release', 'mobile');
const isWin = process.platform === 'win32';
const mode = process.argv[2] || 'build';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p));
}

function findJavaHome() {
  const javaBin = (home) => path.join(home, 'bin', isWin ? 'java.exe' : 'java');
  if (process.env.JAVA_HOME && fs.existsSync(javaBin(process.env.JAVA_HOME))) return process.env.JAVA_HOME;
  const dirs = isWin
    ? ['C:\\Program Files\\Android\\openjdk', 'C:\\Program Files\\Android\\Android Studio\\jbr', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    if (fs.existsSync(javaBin(dir))) return dir;
    for (const sub of fs.readdirSync(dir).sort().reverse()) {
      const home = fs.existsSync(path.join(dir, sub, 'Contents', 'Home')) ? path.join(dir, sub, 'Contents', 'Home') : path.join(dir, sub);
      if (fs.existsSync(javaBin(home))) return home;
    }
  }
  return null;
}

function findSdk() {
  return firstExisting([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk')
  ]);
}

/** Capacitor ищет плагины в mobile/package.json, а ставятся они в корне — версии должны совпадать. */
function checkVersions() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const mobilePkg = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const mismatched = Object.entries(mobilePkg.dependencies || {}).filter(([name, v]) => rootDeps[name] !== v);
  if (mismatched.length) {
    fail(`версии в mobile/package.json не совпадают с корневыми: ${mismatched.map(([n, v]) => `${n} ${v} ≠ ${rootDeps[n] ?? 'нет'}`).join(', ')}`);
  }
}

function run(cmd, args, cwd, env = process.env) {
  console.log(`▶ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} завершилась с кодом ${res.status}`);
}

checkVersions();
const javaHome = findJavaHome();
if (!javaHome) fail('не найден JDK 17+ (задайте JAVA_HOME)');
const sdk = findSdk();
if (!sdk || !fs.existsSync(path.join(sdk, 'platforms'))) fail('не найден Android SDK с platforms (задайте ANDROID_HOME или поставьте SDK)');
console.log(`JDK: ${javaHome}\nAndroid SDK: ${sdk}`);

// local.properties в .gitignore проекта Android — путь к SDK этой машины.
fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
delete env.ELECTRON_RUN_AS_NODE;

run('npm', ['run', 'build:mobile:capacitor'], root, env);
run('npx', ['cap', 'sync', 'android'], mobileDir, env);
// Полный путь: cmd с NoDefaultCurrentDirectoryInExePath не ищет gradlew.bat в текущем каталоге.
run(path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew'), ['assembleDebug', '--console=plain'], androidDir, env);

const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(apk)) fail(`APK не найден: ${apk}`);
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, 'ProjectHub-android-debug.apk');
fs.copyFileSync(apk, target);
console.log(`✅ ${path.relative(root, target)} (${Math.round(fs.statSync(target).size / 1024 / 1024)} МБ)`);

if (mode === 'install') {
  const adb = path.join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb');
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => /\tdevice$/.test(l));
  if (devices.length === 0) fail('телефон не найден в adb devices: включите «Отладку по USB» и подтвердите ключ ПК на телефоне');
  run(adb, ['install', '-r', target], root, env);
  console.log('✅ Установлено. Откройте ProjectHub на телефоне.');
}
