import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conditionResolver,
  mergeSection,
  normalizeForCompare,
  renderRules,
  rulesSourceFile,
  skillsDrift,
  START,
  END,
} from './sync-agent-rules.mjs';

const resolver = (enabled) => (name) => enabled.includes(name);

test('условная разметка: строка с хвостом <!-- if:X --> остаётся без маркера только при включённом X', () => {
  const src = ['| a | b | <!-- if:lightrag -->', '| c | d |'].join('\n');
  assert.equal(renderRules(src, { isEnabled: resolver(['lightrag']) }), '| a | b |\n| c | d |');
  assert.equal(renderRules(src, { isEnabled: resolver([]) }), '| c | d |');
});

test('условная разметка: блок if/endif вырезается целиком, двойные пустые строки схлопываются', () => {
  const src = ['11. правило', '', '<!-- if:windows -->', '21. Windows', '    детали', '<!-- endif -->', '', '22. секреты'].join('\n');
  assert.equal(renderRules(src, { isEnabled: resolver(['windows']) }), '11. правило\n\n21. Windows\n    детали\n\n22. секреты');
  assert.equal(renderRules(src, { isEnabled: resolver([]) }), '11. правило\n\n22. секреты');
});

test('условная разметка: {{infraDir}} подставляется, вложенность и незакрытый блок — ошибка', () => {
  assert.equal(renderRules('cd {{infraDir}} && npm test', { isEnabled: () => true, infraDir: '.projecthub/infra' }), 'cd .projecthub/infra && npm test');
  assert.throws(() => renderRules('<!-- if:a -->\n<!-- if:b -->\nx\n<!-- endif -->\n<!-- endif -->', { isEnabled: () => true }), /вложенный/);
  assert.throws(() => renderRules('<!-- if:a -->\nx', { isEnabled: () => true }), /не закрыт/);
  assert.throws(() => renderRules('x\n<!-- endif -->', { isEnabled: () => true }), /без открывающего/);
});

test('conditionResolver: фичи из конфига, subfolder, наборы правил включены все без ruleSets', () => {
  const all = conditionResolver({ features: { lightrag: false, playwright: true }, subfolder: false });
  assert.equal(all('lightrag'), false);
  assert.equal(all('playwright'), true);
  assert.equal(all('subfolder'), false);
  assert.equal(all('lang-ru'), true);
  const limited = conditionResolver({ features: {}, ruleSets: ['lang-ru'], subfolder: true });
  assert.equal(limited('windows'), false);
  assert.equal(limited('lang-ru'), true);
  assert.equal(limited('subfolder'), true);
});

test('mergeSection заменяет секцию между маркерами и дописывает её в файл без маркеров', () => {
  const block = `${START}\n\nновое\n\n${END}`;
  assert.equal(mergeSection(`# CLAUDE.md\n\nсвоё\n\n${START}\n\nстарое\n\n${END}\nхвост\n`, block), `# CLAUDE.md\n\nсвоё\n\n${block}\nхвост\n`);
  assert.equal(mergeSection('# CLAUDE.md\n', block), `# CLAUDE.md\n\n${block}\n`);
});

test('normalizeForCompare не различает CRLF, BOM и счётчики GitNexus', () => {
  const a = '﻿x (12 symbols, 3 relationships, 1 execution flows)\r\n';
  const b = 'x (99 symbols, 0 relationships, 7 execution flows)\n';
  assert.equal(normalizeForCompare(a), normalizeForCompare(b));
});

test('skillsDrift находит скилл на одной стороне и расхождение SKILL.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-drift-'));
  try {
    for (const [side, name, text] of [
      ['.claude', 'same', 'one\r\n'],
      ['.agents', 'same', 'one\n'],
      ['.claude', 'diff', 'a'],
      ['.agents', 'diff', 'b'],
      ['.claude', 'only-claude', 'x'],
      ['.agents', 'only-agents', 'y'],
    ]) {
      mkdirSync(join(root, side, 'skills', name), { recursive: true });
      writeFileSync(join(root, side, 'skills', name, 'SKILL.md'), text);
    }
    const messages = skillsDrift(root);
    assert.equal(messages.length, 3);
    assert.ok(messages.some((m) => m.startsWith('скилл diff:')));
    assert.ok(messages.some((m) => m.includes('only-claude') && m.includes('только в .claude/skills')));
    assert.ok(messages.some((m) => m.includes('only-agents') && m.includes('только в .agents/skills')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('источник правил: английская база, перевод по locale из infra.config.json', () => {
  assert.equal(rulesSourceFile(undefined), 'infra-dev.md');
  assert.equal(rulesSourceFile('en'), 'infra-dev.md');
  assert.equal(rulesSourceFile('ru'), 'locales/ru/infra-dev.md');
});
