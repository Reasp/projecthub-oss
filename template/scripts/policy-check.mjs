#!/usr/bin/env node
// `npm run policy:check` — проверка политики проекта `.projecthub/policy.json` для CI (TASK-148.1).
// Нет файла — нечего проверять, код 0. Неверная политика — список ошибок и код 1: на хосте ProjectHub такая
// политика переводит все действия агентов проекта на подтверждение человеком.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config.mjs';
import { PROJECT_POLICY_FILE, parseProjectPolicy } from './policy-rules.mjs';

const file = join(PROJECT_ROOT, PROJECT_POLICY_FILE);
if (!existsSync(file)) {
  console.log(`policy:check — ${PROJECT_POLICY_FILE} not found, nothing to check`);
  process.exit(0);
}
const result = parseProjectPolicy(readFileSync(file, 'utf8'));
if (!result.ok) {
  console.error(`✖ ${PROJECT_POLICY_FILE}:`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
const keys = Object.keys(result.policy.permissions);
console.log(`✓ ${PROJECT_POLICY_FILE}: valid (${keys.length ? keys.join(', ') : 'no restrictions'})`);
