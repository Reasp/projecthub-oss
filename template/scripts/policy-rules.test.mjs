import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectPolicy } from './policy-rules.mjs';

// Проверка политики проекта для CI (копия правил ProjectHub, TASK-148.1).

test('верная политика разбирается, списки без повторов', () => {
  const r = parseProjectPolicy(JSON.stringify({ version: 1, permissions: { allowCommands: false, commandDenyList: ['git push', 'git push'], approvalTimeoutMin: 30 } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.policy.permissions, { allowCommands: false, commandDenyList: ['git push'], approvalTimeoutMin: 30 });
});

test('неверная политика — ошибки по каждому полю', () => {
  const r = parseProjectPolicy(JSON.stringify({ version: 2, extra: 1, permissions: { allowCommands: 'no', taskCreate: 'propose', commandTimeoutSec: 0 } }));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5);
  assert.equal(parseProjectPolicy('{').ok, false);
});
