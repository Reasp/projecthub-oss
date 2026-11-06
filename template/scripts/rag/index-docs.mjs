import fs from 'node:fs';
import path from 'node:path';
import { connect } from '@lancedb/lancedb';
import { embedPassages, resolveModel } from './embed.mjs';
import { chunkMarkdown, CHUNKER_VERSION } from './chunk.mjs';
import { collectMarkdownFiles, computeDocsHash, DOC_ROOTS } from './docs-hash.mjs';
import { applyCachedVectors, chunkKey, isIndexFresh, vectorCache } from './reuse.mjs';
import { PROJECT_ROOT, requireFeature } from '../config.mjs';

// Сборка векторного индекса документации. Инкрементальная (TASK-302, decision-221): актуальный индекс не трогается, а при
// пересборке эмбеддинги считаются только для новых и изменённых чанков — векторы остальных берутся из прежнего
// индекса по ключу чанка (reuse.mjs).
//
//   node scripts/rag/index-docs.mjs           # пересобрать, если документация изменилась
//   node scripts/rag/index-docs.mjs --force   # пересобрать и пересчитать все эмбеддинги

requireFeature('docsRag');

const ROOT = PROJECT_ROOT;
const INDEX_DIR = path.join(ROOT, '.rag-index');
const META_PATH = path.join(INDEX_DIR, 'meta.json');
const TABLE_NAME = 'docs';
const force = process.argv.includes('--force');

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** Векторы прежнего индекса той же модели. Нет индекса, другой формат или таблица не читается — пустой кэш. */
async function readPreviousVectors(meta, model) {
  if (!meta || meta.model !== model.id) return new Map();
  let db = null;
  let table = null;
  try {
    db = await connect(INDEX_DIR);
    table = await db.openTable(TABLE_NAME);
    const schema = await table.schema();
    if (!schema.fields.some((field) => field.name === 'key')) return new Map();
    return vectorCache(await table.query().select(['key', 'vector']).toArray());
  } catch (err) {
    // После слияния драйвер projecthub-generated оставляет в каталоге файлы обеих сторон (decision-156) — такой
    // индекс читать нельзя, собираем с нуля.
    console.warn(`Прежний индекс не прочитан (${err instanceof Error ? err.message : String(err)}) — эмбеддинги считаются заново.`);
    return new Map();
  } finally {
    // Каталог индекса дальше удаляется: на Windows открытые файлы таблицы не дали бы его стереть.
    table?.close();
    db?.close();
  }
}

async function main() {
  const files = collectMarkdownFiles(ROOT);
  if (files.length === 0) {
    console.log(`Нет .md файлов в: ${DOC_ROOTS.join(', ')}. Индекс не создан.`);
    return;
  }

  const model = resolveModel();
  const docsHash = computeDocsHash(ROOT, files);
  const meta = readMeta();
  if (!force && isIndexFresh(meta, { model, chunkerVersion: CHUNKER_VERSION, docsHash })) {
    console.log(`✓ Индекс актуален: ${files.length} файлов, ${meta.chunks} чанков — пересборка не нужна (--force — пересобрать всё).`);
    return;
  }

  const rows = [];
  const embedTexts = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const chunks = chunkMarkdown(text, { title: path.basename(file, '.md') });
    chunks.forEach((chunk, i) => {
      rows.push({ file, chunk_index: i, heading: chunk.heading, text: chunk.text, key: chunkKey(model, chunk.embedText) });
      embedTexts.push(chunk.embedText);
    });
  }

  const cache = force ? new Map() : await readPreviousVectors(meta, model);
  const { missing, reused } = applyCachedVectors(rows, cache);
  console.log(
    `Найдено файлов: ${files.length}, чанков: ${rows.length}. Из прежнего индекса: ${reused}, ` +
      `считать эмбеддинги: ${missing.length}${missing.length ? ` (модель ${model.id})` : ''}.`,
  );

  // По одному чанку: у квантованной модели (q8) вектор зависит от соседей по пакету — масштаб активаций считается
  // по всему пакету, расхождение до 0.4% по косинусу. Без пакетов вектор зависит только от текста, и сборка из
  // прежних векторов совпадает с полной. Пакет из 16 на CPU быстрее не был: короткие чанки добиваются до длинного.
  const PROGRESS_EVERY = 50;
  for (let i = 0; i < missing.length; i++) {
    const [vector] = await embedPassages([embedTexts[missing[i]]], model);
    rows[missing[i]].vector = vector;
    if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === missing.length) console.log(`  ${i + 1}/${missing.length}`);
  }

  // Индекс собирается с нуля: после слияния драйвер projecthub-generated оставляет в каталоге файлы обеих сторон
  // (decision-156), а dropTable убирает только таблицу. Векторы прежнего индекса к этому моменту уже в памяти.
  fs.rmSync(INDEX_DIR, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const db = await connect(INDEX_DIR);
  await db.createTable(TABLE_NAME, rows);

  // meta.json читают: rag-server/search-cli (модель и префиксы запроса), check-index и сам index-docs
  // (docsHash, chunkerVersion), ProjectHub (projectScanner — статус RAG в карточке проекта,
  // ragSearch — модель для кодирования запроса).
  fs.writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        model: model.id,
        queryPrefix: model.queryPrefix,
        passagePrefix: model.passagePrefix,
        chunkerVersion: CHUNKER_VERSION,
        docsHash,
        files,
        chunks: rows.length,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(
    `Готово. Индекс: ${path.relative(ROOT, INDEX_DIR)} (${rows.length} чанков из ${files.length} файлов, ` +
      `новых эмбеддингов: ${missing.length}).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
