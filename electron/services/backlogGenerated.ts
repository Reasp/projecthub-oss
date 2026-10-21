import fs from 'node:fs';
import path from 'node:path';
import { buildMemoryIndex, compareMemoryFacts, MEMORY_DIR, MEMORY_INDEX_FILE, parseMemoryFile, type MemoryIndexEntry } from './memoryFormat.js';

/**
 * Сгенерированные файлы backlog при слиянии двух копий репозитория (TASK-139, decision-149): индекс документации
 * `.rag-index/` и индекс памяти `backlog/memory/MEMORY.md` не сливаются, а пересобираются по слитым документам. Их
 * конфликт — не разногласие людей, а два результата одного генератора по разным входам.
 *
 * Модуль без Electron и без синтаксиса, который не снимает `--experimental-strip-types`: его грузит
 * `scripts/backlog-merge.mjs`.
 */

export const RAG_INDEX_DIR = '.rag-index/';
export const MEMORY_INDEX_PATH = `${MEMORY_DIR}/${MEMORY_INDEX_FILE}`;

export type GeneratedKind = 'rag-index' | 'memory-index';

/** Какой генератор отвечает за путь репозитория; `null` — обычный файл. `prefix` — каталог проекта в репозитории. */
export function generatedKind(file: string, prefix = ''): GeneratedKind | null {
  const p = file.replace(/\\/g, '/');
  if (!p.startsWith(prefix)) return null;
  const rel = p.slice(prefix.length);
  if (rel.startsWith(RAG_INDEX_DIR)) return 'rag-index';
  if (rel === MEMORY_INDEX_PATH) return 'memory-index';
  return null;
}

/** Конфликтующие пути: сгенерированные (по генератору) и остальные — их разрешает человек. */
export function splitConflicts(paths: readonly string[], prefix = ''): { generated: Set<GeneratedKind>; other: string[] } {
  const generated = new Set<GeneratedKind>();
  const other: string[] = [];
  for (const p of paths) {
    const kind = generatedKind(p, prefix);
    if (kind) generated.add(kind);
    else other.push(p);
  }
  return { generated, other };
}

/**
 * `MEMORY.md` по файлам фактов каталога памяти — тем же `buildMemoryIndex`, что и ProjectHub. `null` — каталога
 * памяти нет. Файлы с ошибками формата в индекс не попадают: их покажет `lint:docs`.
 */
export function memoryIndexFor(projectRoot: string): string | null {
  const dir = path.join(projectRoot, ...MEMORY_DIR.split('/'));
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return null;
  }
  const facts: MemoryIndexEntry[] = [];
  for (const fileName of names.sort()) {
    if (fileName === MEMORY_INDEX_FILE || !fileName.toLowerCase().endsWith('.md')) continue;
    const parsed = parseMemoryFile(fileName, fs.readFileSync(path.join(dir, fileName), 'utf-8'));
    if (parsed.ok) facts.push({ ...parsed.fact, fileName });
  }
  return buildMemoryIndex(facts.sort(compareMemoryFacts));
}

/** Пересобирает `MEMORY.md`, если каталог памяти есть; `true` — файл изменился. */
export function writeMemoryIndex(projectRoot: string): boolean {
  const next = memoryIndexFor(projectRoot);
  if (next === null) return false;
  const file = path.join(projectRoot, ...MEMORY_INDEX_PATH.split('/'));
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n') : null;
  if (current === next) return false;
  fs.writeFileSync(file, next);
  return true;
}
