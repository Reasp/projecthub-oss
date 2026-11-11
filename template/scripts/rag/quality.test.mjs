import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRagQuality, formatRagQualityReport, parseControlQueries, sourceDocId } from './quality.mjs';

test('sourceDocId берёт id из имени файла документа, решения и факта памяти', () => {
  assert.equal(sourceDocId('backlog/docs/doc-13 - RAG.md'), 'doc-13');
  assert.equal(sourceDocId('backlog\\decisions\\decision-2 - Выбор.md'), 'decision-2');
  assert.equal(sourceDocId('backlog/memory/mem-7 - Урок.md'), 'mem-7');
  assert.equal(sourceDocId('README.md'), 'README.md');
});

test('parseControlQueries проверяет формат и нормализует id', () => {
  const parsed = parseControlQueries('{"queries":[{"query":" как ","expect":["Doc-1","decision-2"]}]}');
  assert.deepEqual(parsed, { topK: 3, queries: [{ query: 'как', expect: ['doc-1', 'decision-2'] }] });
  assert.throws(() => parseControlQueries('{}'), /queries/);
  assert.throws(() => parseControlQueries('{"queries":[{"query":"x","expect":["задача-1"]}]}'), /expect/);
  assert.throws(() => parseControlQueries('{"topK":0,"queries":[{"query":"x","expect":["doc-1"]}]}'), /topK/);
});

test('evaluateRagQuality считает попадание в топ-K и место при промахе', async () => {
  const index = {
    первый: ['doc-1', 'doc-1', 'doc-2', 'doc-3'],
    второй: ['doc-9', 'doc-8', 'doc-7', 'doc-6', 'doc-2'],
    третий: ['doc-5'],
  };
  const search = async (query) => (index[query] ?? []).map((id) => ({ source: `backlog/docs/${id} - X.md` }));
  const report = await evaluateRagQuality(search, [
    { query: 'первый', expect: ['doc-1'] },
    { query: 'второй', expect: ['doc-2'] },
    { query: 'третий', expect: ['doc-4', 'doc-5'] },
    { query: 'нет', expect: ['doc-1'] },
  ]);
  assert.equal(report.passed, 2);
  assert.equal(report.total, 4);
  assert.deepEqual(report.results.map((r) => r.rank), [1, 5, 1, null]);
  assert.deepEqual(report.results[0].top, ['doc-1', 'doc-2', 'doc-3']);
  const text = formatRagQualityReport(report);
  assert.match(text, /МИМО \[место 5\]/);
  assert.match(text, /нет в первой 10/);
  assert.match(text, /Итог: 2\/4/);
});
