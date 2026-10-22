import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './config.mjs';
import { mergeTaskText } from './task-merge-rules.mjs';

// git merge driver `projecthub-task`: задачи Backlog.md сливаются по полям frontmatter, тело — `git merge-file`
// (TASK-139.2, decision-154). Копия в template/scripts/.
//
//   node scripts/task-merge-driver.mjs install [--quiet]  # npm install → prepare: драйвер и пути задач в этой копии
//   node scripts/task-merge-driver.mjs uninstall
//   node scripts/task-merge-driver.mjs merge %O %A %B %L %P  # вызывает git
//
// Драйвер и пути задач ставятся вместе и только в эту копию репозитория: `merge.projecthub-task` в .git/config и
// блок в info/attributes общего каталога git (его видят и worktree). Пути — от корня репозитория, поэтому работает и
// инфраструктура в подпапке (projectRoot в infra.config.json), а закоммиченные файлы проекта не меняются.

const DRIVER = 'projecthub-task';
const TASK_DIRS = ['tasks', 'completed', 'drafts', 'archive/tasks', 'archive/drafts'];
const BLOCK_START = `# >>> ${DRIVER} (ProjectHub, TASK-139.2)`;
const BLOCK_END = `# <<< ${DRIVER}`;

const SCRIPT = fileURLToPath(import.meta.url);

function git(args, opts = {}) {
  const res = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8', ...opts });
  return { ok: res.status === 0, status: res.status, out: res.stdout ?? '', err: (res.stderr ?? '').trim() };
}

const toPosix = (p) => p.split(path.sep).join('/');

function repoPaths() {
  const top = git(['rev-parse', '--show-toplevel']);
  const common = git(['rev-parse', '--git-common-dir']);
  if (!top.ok || !common.ok) return null;
  const repoRoot = path.resolve(top.out.trim());
  return { repoRoot, commonDir: path.resolve(PROJECT_ROOT, common.out.trim()) };
}

function attributesBlock(repoRoot) {
  const rel = toPosix(path.relative(repoRoot, PROJECT_ROOT));
  const prefix = rel && !rel.startsWith('..') ? `${rel}/` : '';
  return [BLOCK_START, ...TASK_DIRS.map((d) => `${prefix}backlog/${d}/**/*.md merge=${DRIVER}`), BLOCK_END].join('\n');
}

function withoutBlock(text) {
  const re = new RegExp(`\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END}\\n?`, 'g');
  return text.replace(re, '\n').replace(/^\n+/, '');
}

function install(quiet) {
  const log = (msg) => !quiet && console.log(msg);
  const repo = repoPaths();
  if (!repo) {
    log(`${DRIVER}: ${PROJECT_ROOT} не является git-репозиторием — драйвер слияния задач не подключён.`);
    return 0;
  }
  // Путь от корня рабочего дерева: git запускает драйвер оттуда, а у каждого worktree своя копия скрипта.
  let script = toPosix(path.relative(repo.repoRoot, SCRIPT));
  if (!script || script.startsWith('..')) script = toPosix(SCRIPT);
  git(['config', `merge.${DRIVER}.name`, 'ProjectHub: задачи Backlog.md по полям frontmatter']);
  const set = git(['config', `merge.${DRIVER}.driver`, `node "${script}" merge %O %A %B %L %P`]);
  if (!set.ok) {
    console.error(`${DRIVER}: не удалось записать merge.${DRIVER}.driver: ${set.err}`);
    return 1;
  }
  const file = path.join(repo.commonDir, 'info', 'attributes');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const rest = withoutBlock(current);
  const next = `${rest}${rest && !rest.endsWith('\n') ? '\n' : ''}${attributesBlock(repo.repoRoot)}\n`;
  if (next !== current) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
  }
  log(`${DRIVER}: задачи Backlog.md сливаются по полям frontmatter (merge.${DRIVER}, ${toPosix(path.relative(repo.repoRoot, file))}).`);
  return 0;
}

function uninstall() {
  const repo = repoPaths();
  if (!repo) return 0;
  git(['config', '--remove-section', `merge.${DRIVER}`]);
  const file = path.join(repo.commonDir, 'info', 'attributes');
  if (fs.existsSync(file)) fs.writeFileSync(file, withoutBlock(fs.readFileSync(file, 'utf-8')));
  console.log(`${DRIVER}: драйвер слияния задач снят.`);
  return 0;
}

/** Тело (или весь файл) через `git merge-file`. */
function mergeFileText(markerSize) {
  return (base, ours, theirs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-task-merge-'));
    try {
      const files = { base, ours, theirs };
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      const res = spawnSync(
        'git',
        ['merge-file', '-p', `--marker-size=${markerSize}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'],
        { cwd: dir, encoding: 'utf-8' }
      );
      if (res.status === null || res.status < 0 || res.status > 127) {
        throw new Error(`git merge-file: ${(res.stderr ?? '').trim() || res.error?.message || `код ${res.status}`}`);
      }
      return { text: res.stdout, conflicted: res.status > 0 };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function merge([basePath, oursPath, theirsPath, markerArg, filePath]) {
  const markerSize = Number.parseInt(markerArg, 10) || 7;
  const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
  const mergeBody = mergeFileText(markerSize);
  let result;
  try {
    result = mergeTaskText(read(basePath), read(oursPath), read(theirsPath), mergeBody, { markerSize });
  } catch (err) {
    // Сбой разбора не должен оставить слияние без результата: весь файл — обычным merge-file.
    console.error(`${DRIVER}: ${filePath ?? oursPath}: ${err.message} — слияние целиком`);
    const whole = mergeBody(read(basePath), read(oursPath), read(theirsPath));
    result = { text: whole.text, conflicts: whole.conflicted ? ['(файл)'] : [] };
  }
  fs.writeFileSync(oursPath, result.text);
  if (result.conflicts.length) {
    console.error(`${DRIVER}: ${filePath ?? oursPath}: конфликт — ${result.conflicts.join(', ')}`);
    return 1;
  }
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
let code;
if (command === 'install') code = install(rest.includes('--quiet'));
else if (command === 'uninstall') code = uninstall();
else if (command === 'merge') code = merge(rest);
else {
  console.error(`Использование: node ${toPosix(path.relative(process.cwd(), SCRIPT))} install|uninstall|merge %O %A %B %L %P`);
  code = 2;
}
process.exit(code);
