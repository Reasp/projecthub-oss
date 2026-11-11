#!/usr/bin/env node
// `npm run rag-check` — живой прогон контрольных запросов по индексу .rag-index тем же поиском, что у MCP
// docs-rag (правило 1 infra-dev.md). Гонять после `npm run index-docs`, при смене модели эмбеддингов или
// чанкера и когда поиск «вдруг» перестал находить документ. Выход: 0 — все запросы в топ-K; 1 — есть
// промахи (поиск деградировал) или файл запросов неверен; 2 — проверить нечем (нет индекса).
// Нет файла `rag-control-queries.json` в корне проекта — подсказка и выход 0: проект его ещё не завёл.
import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { embedQuery, readIndexModel } from './embed.mjs';
import { CONTROL_QUERIES_FILE, evaluateRagQuality, formatRagQualityReport, parseControlQueries } from './quality.mjs';
import { PROJECT_ROOT, requireFeature } from '../config.mjs';

requireFeature('docsRag');

const INDEX_DIR = path.join(PROJECT_ROOT, '.rag-index');
const TABLE_NAME = 'docs';
const QUERIES_PATH = path.join(PROJECT_ROOT, CONTROL_QUERIES_FILE);

async function main() {
  if (!fs.existsSync(QUERIES_PATH)) {
    console.log(`Контрольных запросов нет (${CONTROL_QUERIES_FILE} в корне проекта) — проверять нечего. Образец формата: scripts/rag/quality.mjs.`);
    return;
  }
  const { topK, queries } = parseControlQueries(fs.readFileSync(QUERIES_PATH, 'utf-8'));
  const model = readIndexModel(INDEX_DIR);
  if (!model) {
    console.error('Индекс не найден или без meta.json. Сначала выполните: npm run index-docs');
    process.exit(2);
  }
  const db = await connect(INDEX_DIR);
  const table = await db.openTable(TABLE_NAME);
  const search = async (query, limit) => {
    const vector = await embedQuery(query, model);
    const rows = await table.search(vector).limit(limit).toArray();
    return rows.map((r) => ({ source: r.file }));
  };
  console.log(`Контроль качества поиска по документации, модель индекса: ${model.id}\n`);
  const report = await evaluateRagQuality(search, queries, topK);
  console.log(formatRagQualityReport(report));
  table.close?.();
  db.close?.();
  if (report.passed < report.total) {
    console.error('\n❌ Не все контрольные запросы находят ожидаемый документ — поиск деградировал (или появился законный конкурент: проверь и обнови expect).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Проверка не выполнена:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
