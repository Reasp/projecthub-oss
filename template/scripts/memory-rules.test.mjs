import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMemoryFile, indexLinks, validateMemoryDir } from './memory-rules.mjs';

// Проверка памяти проекта backlog/memory в lint:docs (копия правил ProjectHub, decision-51 там).

const fact = (id, title) =>
  `---\nid: "${id}"\ntitle: "${title}"\ndescription: "описание"\ntype: "project"\ncreated: "2026-09-28 08:00"\n---\n\nТело: ${title}\n`;

function withMemory(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'infra-mem-'));
  try {
    const dir = join(root, 'backlog', 'memory');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('корректные факты и индекс проходят проверку', () => {
  withMemory(
    {
      'mem-1 - Первый-факт.md': fact('mem-1', 'Первый факт'),
      'mem-2 - Второй-факт.md': fact('mem-2', 'Второй факт'),
      'MEMORY.md': '# Память\n\n- [Первый факт](mem-1%20-%20Первый-факт.md) — описание\n- [Второй факт](mem-2%20-%20Второй-факт.md) — описание\n',
    },
    (root) => {
      const result = validateMemoryDir(root);
      assert.equal(result.size, 3);
      for (const errors of result.values()) assert.deepEqual(errors, []);
    },
  );
});

test('без каталога памяти — пусто', () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-mem-'));
  try {
    assert.equal(validateMemoryDir(root).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ловит расхождение индекса с файлами и отсутствие индекса', () => {
  withMemory(
    {
      'mem-1 - A.md': fact('mem-1', 'A'),
      'MEMORY.md': '# Память\n\n- [Пропавший](mem-9%20-%20X.md) — нет файла\n',
    },
    (root) => {
      const errors = validateMemoryDir(root).get('backlog/memory/MEMORY.md').join('\n');
      assert.match(errors, /не упомянут в индексе/);
      assert.match(errors, /отсутствующий файл "mem-9 - X.md"/);
    },
  );
  withMemory({ 'mem-1 - A.md': fact('mem-1', 'A') }, (root) => {
    assert.match(validateMemoryDir(root).get('backlog/memory/MEMORY.md').join('\n'), /Нет индекса MEMORY.md/);
  });
});

test('ловит незакавыченную дату, чужой тип, неверный id, секрет и имя файла', () => {
  const bad = '---\nid: "mem-3"\ntitle: "t"\ndescription: "d"\ntype: "decision"\ncreated: 2026-09-26\n---\n\nключ sk-ant-api03-AbCdEf0123456789xyzXYZ\n'; // projecthub:allow-secret — фиктивный ключ теста
  const errors = checkMemoryFile('mem-4 - t.md', bad).join('\n');
  assert.match(errors, /"created" должно быть строкой/);
  assert.match(errors, /type "decision"/);
  assert.match(errors, /не совпадает с именем файла/);
  assert.match(errors, /provider_key/);
  assert.equal(checkMemoryFile('notes.md', '').length, 1);
});

test('indexLinks раскодирует пробелы', () => {
  assert.deepEqual(indexLinks('- [a](mem-1%20-%20A.md) — d\n- [b](mem-2.md) — e\n'), ['mem-1 - A.md', 'mem-2.md']);
});
