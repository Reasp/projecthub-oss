// Контроль качества смыслового поиска по документации (правило 1 infra-dev.md; паттерн из WorldSim,
// TASK-401 там): контрольные запросы на языке документации и документ, который обязан оказаться в
// топе выдачи. Запросы формулируются «своими словами», а не копией заголовка — иначе проверка мерила
// бы совпадение слов, а не смысла. Модуль чистый (поиск передаётся функцией) и покрыт node --test без
// индекса и модели; живой прогон — scripts/rag/check-quality.mjs (`npm run rag-check`).
//
// Файл контрольных запросов — `rag-control-queries.json` в корне проекта:
//   { "topK": 3, "queries": [ { "query": "…", "expect": ["doc-1"] }, … ] }
// expect — id документов (doc-N/decision-N/mem-N), любой из которых засчитывает попадание; второй id —
// только если тема честно разделена между двумя документами. При промахе сначала смотри, не появился ли
// законный конкурент; подгонять запрос под выдачу нельзя.

export const RAG_QUALITY_TOP_K = 3;
// Сколько результатов запрашивать: больше топа, чтобы при промахе показать, на каком месте документ всё же нашёлся.
export const RAG_QUALITY_SCAN = 10;
export const CONTROL_QUERIES_FILE = 'rag-control-queries.json';

/** id документа по пути источника: `backlog/docs/guides/doc-13 - RAG.md` → `doc-13`. */
export function sourceDocId(source) {
  const base = String(source).replace(/\\/g, '/').split('/').pop() ?? '';
  const m = base.match(/^((?:doc|decision|task|mem)-\d+)(?:\s|\.)/i);
  return m ? m[1].toLowerCase() : base;
}

/** Разбор и проверка файла контрольных запросов; ошибки формата — исключение с понятным текстом. */
export function parseControlQueries(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !Array.isArray(data.queries) || data.queries.length === 0) {
    throw new Error(`${CONTROL_QUERIES_FILE}: ожидается объект с непустым массивом "queries"`);
  }
  const topK = data.topK === undefined ? RAG_QUALITY_TOP_K : Number(data.topK);
  if (!Number.isInteger(topK) || topK < 1) throw new Error(`${CONTROL_QUERIES_FILE}: "topK" должен быть целым числом ≥ 1`);
  const queries = data.queries.map((q, i) => {
    if (!q || typeof q.query !== 'string' || !q.query.trim()) throw new Error(`${CONTROL_QUERIES_FILE}: queries[${i}].query — непустая строка`);
    if (!Array.isArray(q.expect) || q.expect.length === 0 || !q.expect.every((e) => /^(doc|decision|task|mem)-\d+$/i.test(e))) {
      throw new Error(`${CONTROL_QUERIES_FILE}: queries[${i}].expect — непустой массив id вида doc-N/decision-N/mem-N`);
    }
    return { query: q.query.trim(), expect: q.expect.map((e) => e.toLowerCase()) };
  });
  return { topK, queries };
}

/**
 * Прогоняет контрольные запросы через search(query, limit) → [{ source }] (порядок = ранг).
 * rank — место первого чанка ожидаемого документа (1-based) или null, если его нет в выдаче.
 */
export async function evaluateRagQuality(search, queries, topK = RAG_QUALITY_TOP_K) {
  const results = [];
  for (const { query, expect } of queries) {
    const hits = await search(query, Math.max(RAG_QUALITY_SCAN, topK));
    const ids = hits.map((h) => sourceDocId(h.source));
    const index = ids.findIndex((id) => expect.includes(id));
    const rank = index === -1 ? null : index + 1;
    results.push({ query, expect, rank, passed: rank !== null && rank <= topK, top: [...new Set(ids)].slice(0, topK) });
  }
  const passed = results.filter((r) => r.passed).length;
  return { results, passed, total: results.length, topK };
}

/** Человекочитаемый отчёт для консоли. */
export function formatRagQualityReport({ results, passed, total, topK }) {
  const lines = results.map((r) => {
    const mark = r.passed ? 'OK  ' : 'МИМО';
    const where = r.rank === null ? `нет в первой ${RAG_QUALITY_SCAN}` : `место ${r.rank}`;
    return `${mark} [${where}] «${r.query}» → ждём ${r.expect.join('/')}; топ-${topK}: ${r.top.join(', ')}`;
  });
  lines.push('', `Итог: ${passed}/${total} запросов с ожидаемым документом в топ-${topK}.`);
  return lines.join('\n');
}
