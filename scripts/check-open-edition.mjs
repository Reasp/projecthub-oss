#!/usr/bin/env node
/**
 * Проверка открытой сборки (TASK-151, decision-123 п. 5): после `PROJECTHUB_EDITION=open` в бандлах main,
 * ph-agent и рендерера нет кода модулей `ee/`. Признак — каналы IPC платных модулей (`'ee:<модуль>:…'`) и
 * пути `ee/` в импортах. Запускается в CI после открытой сборки; на сборке Team упадёт — так и задумано.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const targets = [
  path.join(root, 'dist-electron', 'main.js'),
  path.join(root, 'dist-ph-agent', 'ph-agent.mjs'),
  ...listJs(path.join(root, 'dist', 'assets'))
];
const MARKERS = [/["'`]ee:[a-z][\w-]*:/, /[\\/]ee[\\/](electron|src)[\\/]/];

function listJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
}

let failed = false;
for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.error(`[check-open-edition] Нет файла сборки: ${path.relative(root, file)}`);
    failed = true;
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of MARKERS) {
    const m = text.match(marker);
    if (m) {
      console.error(`[check-open-edition] ${path.relative(root, file)}: найден код ee/ («${m[0]}»)`);
      failed = true;
    }
  }
}
if (failed) {
  console.error('[check-open-edition] Открытая сборка содержит платные модули или не собрана.');
  process.exit(1);
}
console.log(`[check-open-edition] OK: ${targets.length} файлов без кода ee/`);
