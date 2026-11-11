import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFrontmatterField, withSection } from './doc-rules.mjs';

const DOC = ['---', 'id: doc-5', 'title: "Пример"', 'created_date: "2026-11-11 10:00"', '---', '', '# Пример', ''].join('\n');

test('withSection дописывает поле перед закрывающим --- и не трогает остальное', () => {
  const next = withSection(DOC, 'Инфраструктура/RAG');
  assert.equal(next, DOC.replace('created_date: "2026-11-11 10:00"\n---', 'created_date: "2026-11-11 10:00"\nsection: "Инфраструктура/RAG"\n---'));
});

test('withSection заменяет существующую строку и возвращает null, если поле уже такое', () => {
  const withOld = DOC.replace('---\n\n# Пример', 'section: "Старый"\n---\n\n# Пример');
  const next = withSection(withOld, 'Новый');
  assert.match(next, /section: "Новый"/);
  assert.doesNotMatch(next, /Старый/);
  assert.equal(withSection(next, 'Новый'), null);
});

test('withFrontmatterField сохраняет CRLF и экранирует кавычки в значении', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const next = withFrontmatterField(crlf, 'description', 'Описание с "кавычками"');
  assert.ok(next.includes('description: "Описание с \\"кавычками\\""\r\n---'));
  assert.ok(!next.includes('\n\n#') || next.includes('\r\n\r\n#'));
});

test('withFrontmatterField падает на файле без закрытого frontmatter', () => {
  assert.throws(() => withFrontmatterField('# без шапки\n', 'section', 'X'), /frontmatter/);
});
