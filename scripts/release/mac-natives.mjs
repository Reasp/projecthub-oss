#!/usr/bin/env node
// Нативные пакеты macOS обеих архитектур в одной сборке (TASK-222, decision-178).
//
// `npm ci` на раннере arm64 ставит необязательные платформенные пакеты только своей архитектуры, а electron-builder
// собирает arm64 и x64 одним вызовом (иначе два `latest-mac.yml` перезапишут друг друга). Поэтому:
//
//   node scripts/release/mac-natives.mjs install   — до упаковки: доставить darwin-пакеты обеих архитектур тех версий,
//                                                    что записаны в package-lock.json (`npm pack` + распаковка);
//   afterPack (scripts/mac/after-pack.mjs)          — удалить из сборки нативные файлы чужой архитектуры.
//
// `@lancedb/lancedb-darwin-x64` не публикуется с 0.23: его нет в lock-файле, и x64-сборка остаётся без LanceDB
// (поиск по документации на Intel Mac недоступен, остальное работает).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Семейства платформенных пакетов, которые грузятся по `darwin-${arch}` в рантайме. */
export const MAC_NATIVE_FAMILIES = ['sherpa-onnx-darwin-', '@img/sharp-darwin-', '@img/sharp-libvips-darwin-', '@lancedb/lancedb-darwin-'];

export const MAC_ARCHS = ['arm64', 'x64'];

/**
 * Пакеты верхнего уровня `node_modules` из lock-файла, которые нужны сборке macOS: имя и версия.
 * Вложенные копии (`node_modules/x/node_modules/...`) не берутся — их грузит только свой родитель.
 */
export function macNativePackages(lockPackages) {
  const out = [];
  for (const [key, meta] of Object.entries(lockPackages ?? {})) {
    const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (!m || !meta?.version) continue;
    const name = m[1];
    const family = MAC_NATIVE_FAMILIES.find((f) => name.startsWith(f));
    if (!family || !MAC_ARCHS.includes(name.slice(family.length))) continue;
    out.push({ name, version: meta.version });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Пути внутри `node_modules` сборки, которые нужны только другой архитектуре. */
export function foreignArchPaths(arch) {
  const other = arch === 'arm64' ? 'x64' : 'arm64';
  return [
    ...MAC_NATIVE_FAMILIES.map((f) => `${f}${other}`),
    `node-pty/prebuilds/darwin-${other}`,
    `uiohook-napi/prebuilds/darwin-${other}`,
    `onnxruntime-node/bin/napi-v3/darwin/${other}`
  ];
}

/** Архитектура из контекста afterPack electron-builder: `Arch` — число (x64 = 1, arm64 = 3). */
export function archName(arch) {
  if (arch === 3 || arch === 'arm64') return 'arm64';
  if (arch === 1 || arch === 'x64') return 'x64';
  return null;
}

/**
 * Архитектура, под которую обрезать нативы в этом afterPack, или `null` — не обрезать (TASK-231.2). Универсальная
 * сборка сначала пакует оба приложения во временные каталоги `mac-universal-x64-temp` и `mac-universal-arm64-temp`,
 * а `@electron/universal` склеивает их, требуя одинаковый набор файлов: обрезка там дала бы разное число mach-o.
 * Итоговое универсальное приложение (`Arch.universal`) несёт обе архитектуры и тоже не обрезается.
 */
export function pruneArchFor(appOutDir, arch) {
  if (/-(x64|arm64)-temp$/i.test(path.basename(String(appOutDir || '')))) return null;
  return archName(arch);
}

/** Удаляет из собранного .app нативные файлы чужой архитектуры; возвращает удалённые относительные пути. */
export function pruneForeignArch(resourcesDir, arch) {
  const removed = [];
  for (const base of ['app.asar.unpacked/node_modules', 'app/node_modules']) {
    for (const rel of foreignArchPaths(arch)) {
      const target = path.join(resourcesDir, base, rel);
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(`${base}/${rel}`);
    }
  }
  return removed;
}

function npmPack(spec, dest) {
  const opts = { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' };
  const out = execFileSync('npm', ['pack', spec, '--silent'], opts).trim().split(/\r?\n/).pop();
  return path.join(dest, out);
}

function install(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-mac-natives-'));
  try {
    for (const { name, version } of macNativePackages(lock.packages)) {
      const dir = path.join(root, 'node_modules', name);
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        console.log(`  = ${name}@${version} уже стоит`);
        continue;
      }
      const tgz = npmPack(`${name}@${version}`, tmp);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
      console.log(`  + ${name}@${version}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'install') {
    console.error('Usage: node scripts/release/mac-natives.mjs install [--root <dir>]');
    process.exit(2);
  }
  const rootAt = rest.indexOf('--root');
  install(rootAt >= 0 ? path.resolve(rest[rootAt + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}
