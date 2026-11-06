import crypto from 'node:crypto';

// Инкрементальная сборка индекса документации (TASK-302, decision-221): вектор чанка зависит только от модели,
// её префикса для фрагментов и текста, который кодируется (`embedText`: заголовок документа, путь заголовков
// и сам фрагмент). Ключ — хэш этих трёх значений; он хранится в строке таблицы, и следующая сборка берёт вектор
// из прежнего индекса, а эмбеддинги считает только для чанков с новым ключом. Чистый модуль без LanceDB.

/** Ключ вектора чанка: тот же ключ — тот же вектор. */
export function chunkKey(model, embedText) {
  return crypto
    .createHash('sha256')
    .update(model.id)
    .update('\0')
    .update(model.passagePrefix ?? '')
    .update('\0')
    .update(embedText)
    .digest('hex');
}

/**
 * Векторы прежнего индекса по ключу. Строки без ключа (индекс до TASK-302) и с пустым вектором не берутся.
 * `rows` — строки таблицы с полями `key` и `vector` (массив чисел или типизированный массив).
 */
export function vectorCache(rows) {
  const cache = new Map();
  for (const row of rows) {
    if (typeof row?.key !== 'string' || !row.key || !row.vector || row.vector.length === 0) continue;
    if (!cache.has(row.key)) cache.set(row.key, Array.from(row.vector));
  }
  return cache;
}

/**
 * Раскладывает векторы из кэша по строкам нового индекса. Возвращает номера строк, для которых эмбеддинги
 * нужно посчитать, и сколько векторов взято из кэша. Строки получают `vector`, если ключ найден.
 */
export function applyCachedVectors(rows, cache) {
  const missing = [];
  let reused = 0;
  rows.forEach((row, i) => {
    const vector = cache.get(row.key);
    if (vector) {
      row.vector = vector;
      reused += 1;
    } else {
      missing.push(i);
    }
  });
  return { missing, reused };
}

/**
 * Можно ли не пересобирать индекс: та же модель, тот же чанкер и тот же хэш документации (в него входят и пути
 * файлов). `meta` — прежний meta.json или `null`.
 */
export function isIndexFresh(meta, { model, chunkerVersion, docsHash }) {
  if (!meta || typeof meta !== 'object') return false;
  return meta.model === model.id && (meta.chunkerVersion ?? 1) === chunkerVersion && meta.docsHash === docsHash;
}
