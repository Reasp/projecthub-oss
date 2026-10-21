/**
 * Предпросмотр области индексации GitNexus (decision-131, TASK-176): сколько файлов попадёт в индекс и какие
 * каталоги самые крупные — до того, как запускать `gitnexus analyze`, который на большом проекте идёт десятки
 * минут. Обход повторяет `walkRepositoryPaths` GitNexus: все файлы без каталогов и файлов с точкой (`dot: false`),
 * фильтр из `gitnexusIgnoreRules.ts`, файлы больше 512 КБ пропускаются.
 *
 * Сравниваются два набора правил за один обход: «до» (без блока ProjectHub) и «после» (с новым блоком). Так
 * видно, что именно исключает выбранный профиль. Без Electron (правило 17): только `node:fs`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGitNexusFilter, GITNEXUS_DEFAULT_MAX_FILE_BYTES, type GitNexusFilter } from './gitnexusIgnoreRules.js';
import { isMarketplacePlugin } from './codeIndexProfiles.js';

async function readDirents(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Плагины маркетплейса UE в `Plugins/`: каталоги, где лежит `.uplugin` с MarketplaceURL/FabURL. UE разрешает
 * группировать плагины в подкаталоги, поэтому смотрим два уровня. Пути — относительно корня, через `/`.
 */
export async function findMarketplacePlugins(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (rel: string, depth: number) => {
    const entries = await readDirents(path.join(root, rel));
    const descriptor = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.uplugin'));
    if (descriptor) {
      try {
        if (isMarketplacePlugin(JSON.parse(await fs.readFile(path.join(root, rel, descriptor.name), 'utf-8')))) result.push(rel);
      } catch {
        // .uplugin не читается или не JSON — не плагин маркетплейса
      }
      return;
    }
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(`${rel}/${entry.name}`, depth - 1);
    }
  };
  for (const entry of await readDirents(path.join(root, 'Plugins'))) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(`Plugins/${entry.name}`, 1);
  }
  return result.sort();
}

export interface IndexScanInput {
  root: string;
  /** Корневой `.gitignore`; `null` — нет или GitNexus его не читает (`GITNEXUS_NO_GITIGNORE`). */
  gitignore: string | null;
  /** `.gitnexusignore` без блока ProjectHub. */
  before: string | null;
  /** `.gitnexusignore` с новым блоком. */
  after: string | null;
}

export interface IndexScanOptions {
  /** Предел записей каталогов, после которого обход останавливается. */
  maxEntries?: number;
  /** Предел времени обхода, мс. */
  timeBudgetMs?: number;
  maxFileBytes?: number;
}

export interface IndexDirCount {
  dir: string;
  files: number;
}

export interface IndexScanResult {
  /** Попадут в индекс с новыми правилами. */
  included: number;
  /** Попали бы без блока ProjectHub, но блок их исключает. */
  excluded: number;
  /** Пропущены по размеру (больше `--max-file-size`). */
  skippedLarge: number;
  topIncluded: IndexDirCount[];
  topExcluded: IndexDirCount[];
  /** Обход остановлен по пределу записей или времени: числа — нижняя граница. */
  truncated: boolean;
  elapsedMs: number;
}

const DEFAULT_MAX_ENTRIES = 400_000;
const DEFAULT_TIME_BUDGET_MS = 25_000;
const TOP = 10;

/** Каталог для сводки: первые два уровня пути файла, файлы корня — `.`. */
export function summaryDir(rel: string): string {
  const parts = rel.split('/');
  if (parts.length <= 1) return '.';
  return parts.length === 2 ? parts[0] : `${parts[0]}/${parts[1]}`;
}

export function topDirs(counts: Map<string, number>, limit = TOP): IndexDirCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir, files]) => ({ dir, files }));
}

interface Frame {
  rel: string;
  /** Правила «до» ещё пускают в этот каталог. */
  before: boolean;
  after: boolean;
}

export async function scanIndexScope(input: IndexScanInput, options: IndexScanOptions = {}): Promise<IndexScanResult> {
  const started = Date.now();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxBytes = options.maxFileBytes ?? GITNEXUS_DEFAULT_MAX_FILE_BYTES;
  const filters: { before: GitNexusFilter; after: GitNexusFilter } = {
    before: createGitNexusFilter(input.gitignore, input.before),
    after: createGitNexusFilter(input.gitignore, input.after)
  };

  const included = new Map<string, number>();
  const excluded = new Map<string, number>();
  const bump = (map: Map<string, number>, rel: string) => {
    const dir = summaryDir(rel);
    map.set(dir, (map.get(dir) ?? 0) + 1);
  };
  let includedCount = 0;
  let excludedCount = 0;
  let skippedLarge = 0;
  let entries = 0;
  let truncated = false;

  const stack: Frame[] = [{ rel: '', before: true, after: true }];
  while (stack.length > 0) {
    if (entries >= maxEntries || Date.now() - started > budget) {
      truncated = true;
      break;
    }
    const frame = stack.pop() as Frame;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(path.join(input.root, frame.rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      entries++;
      // dot: false — glob не заходит в каталоги с точкой и не отдаёт такие файлы.
      if (dirent.name.startsWith('.')) continue;
      const rel = frame.rel ? `${frame.rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        const before = frame.before && !filters.before.prunesDir(rel, dirent.name);
        const after = frame.after && !filters.after.prunesDir(rel, dirent.name);
        if (before || after) stack.push({ rel, before, after });
        continue;
      }
      // Ссылки glob по `**` не раскрывает; на ссылку на файл индекс тоже не опирается — пропускаем.
      if (!dirent.isFile()) continue;
      const inBefore = frame.before && !filters.before.ignoresFile(rel);
      const inAfter = frame.after && !filters.after.ignoresFile(rel);
      if (!inAfter) {
        if (inBefore) {
          excludedCount++;
          bump(excluded, rel);
        }
        continue;
      }
      try {
        if ((await fs.stat(path.join(input.root, rel))).size > maxBytes) {
          skippedLarge++;
          continue;
        }
      } catch {
        continue;
      }
      includedCount++;
      bump(included, rel);
    }
  }

  return {
    included: includedCount,
    excluded: excludedCount,
    skippedLarge,
    topIncluded: topDirs(included),
    topExcluded: topDirs(excluded),
    truncated,
    elapsedMs: Date.now() - started
  };
}
