import fs from 'node:fs';
import path from 'node:path';

const REINDEX_TIMEOUT_MS = 15 * 60_000;

/** Каталог с `package.json`, где есть скрипт `index-docs`: корень проекта или инфраструктура в `.projecthub/infra`. */
export function findIndexDocsDir(projectPath: string): string | null {
  for (const dir of [projectPath, path.join(projectPath, '.projecthub', 'infra')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['index-docs']) return dir;
    } catch {
      // нет package.json или он не читается — следующий кандидат
    }
  }
  return null;
}

/**
 * Пересборка индекса RAG в фоне после слияния с перенумерацией (decision-76 п. 4): бинарный индекс входящей ветки
 * не переносится, а собирается заново. Без скрипта `index-docs` — `false`; ошибка сборки только пишется в лог,
 * её поймает `lint:docs` (проверка актуальности индекса).
 */
export function reindexDocsInBackground(projectPath: string): boolean {
  const cwd = findIndexDocsDir(projectPath);
  if (!cwd) return false;
  // processManager тянет Electron — грузится только здесь, чтобы модули слияния оставались без него.
  void import('./processManager.js')
    .then(({ processManager }) => processManager.runOnce('npm run index-docs', { cwd, timeoutMs: REINDEX_TIMEOUT_MS }))
    .then((run) => {
      if (run.exitCode === 0 && !run.timedOut) console.log(`[docsReindex] Индекс документации пересобран: ${cwd}`);
      else console.warn(`[docsReindex] index-docs не прошёл (${run.timedOut ? 'тайм-аут' : `код ${run.exitCode}`}): ${run.error ?? ''}`);
    })
    .catch((err) => console.warn('[docsReindex] index-docs не запустился:', err instanceof Error ? err.message : String(err)));
  return true;
}
