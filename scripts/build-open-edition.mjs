#!/usr/bin/env node
/**
 * Открытая сборка без модулей `ee/` (TASK-151, decision-123 п. 5): main, preload, рендерер и ph-agent с
 * `PROJECTHUB_EDITION=open`, затем проверка бандлов на код `ee/`. Публичный релиз (`open-edition.yml` зеркала, decision-167) собирается так же.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, PROJECTHUB_EDITION: 'open' };
const steps = [
  // Отметка сборки с `edition: "open"`: по ней скрипт публикации отличает открытую сборку от полной (TASK-144.4).
  ['node', ['scripts/build-info.mjs']],
  ['npx', ['vite', 'build']],
  ['npx', ['vite', 'build', '--config', 'vite.ph-agent.config.ts']],
  ['node', ['scripts/check-open-edition.mjs']]
];
for (const [cmd, args] of steps) {
  console.log(`[build-open-edition] ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
