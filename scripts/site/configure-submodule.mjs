// Настройка git для сабмодуля сайта `site/` (decision-158 п. 8, TASK-144.1): `npm install` → prepare включает
// `submodule.recurse=true`, чтобы `git pull` и `git checkout` подтягивали сайт. Явно выставленное значение
// (в том числе false) не перезаписывается; вне git-репозитория и без .gitmodules ничего не делает.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../config.mjs';

const quiet = process.argv.includes('--quiet');
const git = (args) => {
  const res = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  return res.status === 0 ? (res.stdout ?? '').trim() : null;
};

if (!fs.existsSync(path.join(PROJECT_ROOT, '.gitmodules'))) process.exit(0);
if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);
if (git(['config', '--get', 'submodule.recurse']) !== null) process.exit(0);

git(['config', 'submodule.recurse', 'true']);
if (!quiet) console.log('🔗 git: submodule.recurse = true — pull и checkout подтягивают сайт site/ (decision-158)');
