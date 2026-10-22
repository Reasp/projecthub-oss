/**
 * Общее для скриптов сборки мобильного приложения: Android (`android.mjs`, TASK-140.8) и iOS (`ios.mjs`, TASK-140.18).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..');
export const mobileDir = path.join(root, 'mobile');
const isWin = process.platform === 'win32';

export function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

export function run(cmd, args, cwd, env = process.env) {
  console.log(`▶ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} завершилась с кодом ${res.status}`);
}

/** Capacitor ищет плагины в mobile/package.json, а ставятся они в корне — версии должны совпадать. */
export function checkVersions() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const mobilePkg = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const mismatched = Object.entries(mobilePkg.dependencies || {}).filter(([name, v]) => rootDeps[name] !== v);
  if (mismatched.length) {
    fail(`версии в mobile/package.json не совпадают с корневыми: ${mismatched.map(([n, v]) => `${n} ${v} ≠ ${rootDeps[n] ?? 'нет'}`).join(', ')}`);
  }
}

/** Единая версия приложений (decision-148) и номер сборки: та же формула, что у versionCode в build.gradle. */
export function appVersion() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const [major, minor, patch] = version.split('.').map(Number);
  return { version, build: String(major * 1000000 + minor * 1000 + patch) };
}
