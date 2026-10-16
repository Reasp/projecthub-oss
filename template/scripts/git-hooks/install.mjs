import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, INFRA_ROOT, PROJECT_ROOT } from '../config.mjs';

// Подключает git-хуки инфраструктуры (scripts/git-hooks/) через core.hooksPath — без копирования
// в .git/hooks/, чтобы хуки версионировались вместе с проектом и обновлялись через git pull.
//
//   node scripts/git-hooks/install.mjs             # установить (вызывается и из `npm install` → prepare)
//   node scripts/git-hooks/install.mjs --uninstall # снять core.hooksPath, если он указывает на нас
//   --quiet — не шуметь, если это не git-репозиторий (для prepare в CI/чужих окружениях)
//
// Хуки — sh-скрипты, git запускает их через sh и на Windows (Git for Windows), поэтому
// одна реализация работает на всех ОС. На POSIX нужен бит исполнения — выставляем.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = __dirname;
const HOOK_NAMES = ['pre-commit', 'commit-msg', 'post-commit'];

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const uninstall = args.includes('--uninstall');

function git(gitArgs, cwd = PROJECT_ROOT) {
  const res = spawnSync('git', gitArgs, { cwd, encoding: 'utf-8' });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

function log(msg) {
  if (!quiet) console.log(msg);
}

// ProjectHub выключает хуки шаблона, если у проекта свои (husky, lefthook, core.hooksPath):
// `npm install` → prepare не должен молча переопределить их.
if (!uninstall && CONFIG.gitHooks === false) {
  log('git-hooks: выключены в infra.config.json ("gitHooks": false) — core.hooksPath не трогаю.');
  process.exit(0);
}

const top = git(['rev-parse', '--show-toplevel']);
if (!top.ok) {
  log(`git-hooks: ${PROJECT_ROOT} не является git-репозиторием — хуки не установлены (git init, затем npm run install-hooks).`);
  process.exit(0);
}

const repoRoot = path.resolve(top.out);
let hooksPath = path.relative(repoRoot, HOOKS_DIR).split(path.sep).join('/');
if (!hooksPath || hooksPath.startsWith('..')) {
  // Инфраструктура вне репозитория — редкий случай, но core.hooksPath принимает и абсолютный путь.
  hooksPath = HOOKS_DIR.split(path.sep).join('/');
}

const current = git(['config', '--get', 'core.hooksPath']);

if (uninstall) {
  if (current.ok && current.out === hooksPath) {
    git(['config', '--unset', 'core.hooksPath']);
    log(`git-hooks: core.hooksPath снят (${hooksPath}).`);
  } else {
    log(`git-hooks: core.hooksPath не указывает на ${hooksPath} (сейчас: ${current.out || 'не задан'}) — ничего не трогаю.`);
  }
  process.exit(0);
}

if (current.ok && current.out && current.out !== hooksPath) {
  console.warn(`git-hooks: core.hooksPath уже задан (${current.out}) — переопределяю на ${hooksPath}. Если там были другие хуки (husky и т.п.), перенесите их в scripts/git-hooks/.`);
}

const set = git(['config', 'core.hooksPath', hooksPath]);
if (!set.ok) {
  console.error(`git-hooks: не удалось записать core.hooksPath: ${set.err}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  for (const name of HOOK_NAMES) {
    const file = path.join(HOOKS_DIR, name);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }
}

const present = HOOK_NAMES.filter((n) => fs.existsSync(path.join(HOOKS_DIR, n)));
log(`git-hooks: core.hooksPath = ${hooksPath} (${present.join(', ')}). Инфраструктура: ${path.relative(repoRoot, INFRA_ROOT) || '.'}`);
