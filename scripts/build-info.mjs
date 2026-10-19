// Отметка сборки (decision-92, TASK-158): коммит, его время, число незакоммиченных файлов и время сборки
// в build/build-info.json. electron-builder кладёт файл в ресурсы приложения (extraResources), ProjectHub
// показывает его в «Диагностике» и по нему замечает, что сборку на диске заменили.
// Без git (архив исходников) пишется commit: "unknown" — сборка не падает.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const status = git(['status', '--porcelain']);
const info = {
  commit: git(['rev-parse', 'HEAD']) || 'unknown',
  commitDate: git(['log', '-1', '--format=%cI']) || null,
  dirtyFiles: status ? status.split('\n').filter(Boolean).length : 0,
  builtAt: new Date().toISOString()
};

const out = path.join(rootDir, 'build', 'build-info.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
console.log(`🏷️  build-info: ${info.commit.slice(0, 7)}${info.dirtyFiles ? ` (+${info.dirtyFiles} не в коммите)` : ''}, ${info.builtAt}`);
