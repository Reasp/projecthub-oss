import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocEntry, crossCheckDocs, extractDocRefs, headingAnchorKey, isInSubfolder, sectionFieldError } from './doc-rules.mjs';

// Сквозные проверки документации в lint:docs: раздел дерева, ссылки [[id]] и якоря (правило 14).

const decision = (n, body, data = {}) => buildDocEntry(`backlog/decisions/decision-${n} - X.md`, { id: `decision-${n}`, ...data }, body);

test('ключ заголовка не зависит от регистра и знаков препинания', () => {
  assert.equal(headingAnchorKey('Принятое решение:'), 'принятое-решение');
  assert.equal(headingAnchorKey('принятое-решение'), 'принятое-решение');
  assert.equal(headingAnchorKey('Decision'), headingAnchorKey('decision'));
});

test('поле section — непустая строка, отсутствие поля не ошибка', () => {
  assert.equal(sectionFieldError(undefined), null);
  assert.equal(sectionFieldError('Архитектура/RAG'), null);
  assert.match(sectionFieldError('  '), /section/);
  assert.match(sectionFieldError(['a']), /section/);
});

test('вложенная папка документа считается разделом', () => {
  assert.equal(isInSubfolder('backlog/docs/guides/doc-2 - X.md'), true);
  assert.equal(isInSubfolder('backlog/docs/doc-2 - X.md'), false);
  assert.equal(isInSubfolder('backlog/tasks/sub/task-1 - X.md'), false);
});

test('ссылки в коде не считаются, подпись и якорь разбираются', () => {
  const body = [
    '## Context',
    'См. [[decision-2]], [[DOC-5|гайд]] и [[decision-2#Decision|как выбирали]].',
    'Пример: `[[decision-99]]`.',
    '```',
    '[[doc-77]]',
    '## Не заголовок',
    '```',
  ].join('\n');
  const { refs, anchors, headings } = extractDocRefs(body);
  assert.deepEqual(refs.sort(), ['decision-2', 'doc-5']);
  assert.deepEqual(anchors, [{ id: 'decision-2', anchor: 'Decision' }]);
  assert.deepEqual([...headings], ['context']);
});

test('ссылки в форме Obsidian: имя файла, путь, встраивание, вложенный заголовок, ссылка на блок', () => {
  const body = '[[decision-3 - Заголовок|x]] ![[decisions/decision-4.md#Context#Варианты]] [[doc-6#^abc]] [[Идеи]]';
  const { refs, anchors } = extractDocRefs(body);
  assert.deepEqual(refs, ['decision-3', 'decision-4', 'doc-6']);
  assert.deepEqual(anchors, [{ id: 'decision-4', anchor: 'Варианты' }]);
});

test('проект без разделов проверку раздела не включает', () => {
  const entries = [decision(1, 'текст'), decision(2, 'см. [[decision-1]]')];
  assert.equal(crossCheckDocs(entries).size, 0);
});

test('раздел обязателен у всех, если он есть хотя бы у одного', () => {
  const entries = [
    decision(1, 'текст', { section: 'Агенты' }),
    decision(2, 'текст'),
    buildDocEntry('backlog/docs/guides/doc-1 - X.md', { id: 'doc-1' }, 'текст'),
  ];
  const errors = crossCheckDocs(entries);
  assert.deepEqual([...errors.keys()], ['backlog/decisions/decision-2 - X.md']);
  assert.match(errors.get('backlog/decisions/decision-2 - X.md')[0], /без раздела/);
});

test('битая ссылка и несуществующий заголовок — ошибки', () => {
  const entries = [
    decision(1, '## Decision\nтекст'),
    decision(2, 'см. [[decision-7]], [[decision-1#decision]] и [[decision-1#Consequences]]'),
  ];
  const errors = crossCheckDocs(entries).get('backlog/decisions/decision-2 - X.md');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /\[\[decision-7\]\]/);
  assert.match(errors[1], /Consequences/);
});
