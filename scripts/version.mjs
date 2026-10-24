// Единая версия приложений ProjectHub (TASK-193, decision-148).
//
//   node scripts/version.mjs check            — версии во всех файлах совпадают с package.json (входит в npm run build)
//   node scripts/version.mjs bump [--stage]   — третье число + 1 от версии HEAD во всех файлах рабочего дерева;
//                                              --stage пишет ту же правку и в текущий индекс git (учитывает GIT_INDEX_FILE),
//                                              поверх содержимого индекса, а не рабочего дерева
//   node scripts/version.mjs ensure-staged    — для git-хуков .githooks: коммит с кодом в master без повышения версии
//                                              получает следующую (в индекс, который собирается в коммит)
//   node scripts/version.mjs ensure-merge [1] — для post-merge: коммит слияния с кодом в master без повышения версии
//                                              дополняется ею (--amend); аргумент 1 — squash, пропускается
//   node scripts/version.mjs install-hooks   — core.hooksPath = .githooks (npm install → prepare)
//   node scripts/version.mjs verify --range A..B — аудит: каждый коммит первой линии A..B, меняющий код, поднял версию
//   node scripts/version.mjs latest-tag <tag>  — печатает true, если <tag> самый новый из локальных тегов v*, иначе false
//                                              (workflow зеркала собирает релиз только последнего тега, TASK-220)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  GRADLE_FILE,
  VERSION_FILES,
  bumpPatch,
  checkVersionTexts,
  compareVersions,
  isCodePath,
  isLatestReleaseTag,
  readVersions,
  setVersion
} from './version-rules.mjs';

const rootDir = process.cwd();

function git(args, input) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// Пути изменённых файлов. `-z` — без экранирования: иначе git отдаёт путь с кириллицей как `"backlog/\320….md"`,
// и isCodePath принимает задачу или документ за код.
function changedPaths(args) {
  return git(['diff', '-z', '--name-only', ...args]).split('\0').filter(Boolean);
}

function readWorking(file) {
  const full = path.join(rootDir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : undefined;
}

function versionAt(rev) {
  const text = gitOrNull(['show', `${rev}:package.json`]);
  return text === null ? null : readVersions(text, 1)[0] ?? null;
}

function check() {
  const texts = {};
  for (const file of [...VERSION_FILES.map((f) => f.path), GRADLE_FILE]) texts[file] = readWorking(file);
  const errors = checkVersionTexts(texts);
  if (errors.length) {
    console.error('❌ Версии приложений расходятся (TASK-193):');
    for (const e of errors) console.error(`   ${e}`);
    console.error('   Исправить: npm run version:bump (или выровнять файлы по package.json).');
    process.exit(1);
  }
  console.log(`✓ Версия приложений: ${readVersions(texts['package.json'], 1)[0]}`);
}

function stageFile(file, version, count) {
  const entry = gitOrNull(['ls-files', '-s', '--', file])?.trim();
  if (!entry) return false;
  const mode = entry.split(/\s+/)[0];
  const text = git(['show', `:${file}`]);
  const next = setVersion(text, version, count);
  if (next === text) return false;
  const sha = git(['hash-object', '-w', '--stdin', `--path=${file}`], next).trim();
  git(['update-index', '--cacheinfo', `${mode},${sha},${file}`]);
  return true;
}

function bump(stage) {
  const base = versionAt('HEAD') ?? readVersions(readWorking('package.json') ?? '', 1)[0];
  const next = bumpPatch(base);
  for (const file of VERSION_FILES) {
    const text = readWorking(file.path);
    if (text === undefined) throw new Error(`${file.path}: файла нет`);
    const updated = setVersion(text, next, file.count);
    if (updated !== text) fs.writeFileSync(path.join(rootDir, file.path), updated, 'utf-8');
    if (stage) stageFile(file.path, next, file.count);
  }
  console.log(`🏷️  Версия ${base} → ${next}${stage ? ' (в рабочем дереве и в индексе)' : ''}`);
}

/** Ветки, в которых коммит с кодом поднимает версию. В остальных ветках и worktree её поднимает слияние в master. */
const MAIN_BRANCHES = new Set(['master', 'main']);

/**
 * Для git-хуков pre-commit и pre-merge-commit: коммит в master, меняющий код, получает следующую версию, если её в нём
 * ещё не подняли. Ручное повышение (например, второго числа) не трогается.
 */
function ensureStaged() {
  const branch = gitOrNull(['symbolic-ref', '--short', '-q', 'HEAD'])?.trim();
  if (!branch || !MAIN_BRANCHES.has(branch)) return;
  const head = versionAt('HEAD');
  if (!head) return;
  const changed = changedPaths(['--cached', 'HEAD']);
  if (!changed.some(isCodePath)) return;
  const staged = readVersions(gitOrNull(['show', ':package.json']) ?? '', 1)[0];
  if (compareVersions(staged, head) > 0) return;
  bump(true);
}

/**
 * Для git-хука post-merge: после pre-merge-commit git индекс не перечитывает, поэтому коммит слияния, принёсший код в
 * master без повышения версии, дополняется ею сразу после создания (`--amend`). Fast-forward и squash не трогаются:
 * у fast-forward нет своего коммита, squash коммитится обычным `git commit` через pre-commit.
 */
function ensureMerge(squash) {
  if (squash) return;
  const branch = gitOrNull(['symbolic-ref', '--short', '-q', 'HEAD'])?.trim();
  if (!branch || !MAIN_BRANCHES.has(branch)) return;
  const parents = (gitOrNull(['rev-list', '--parents', '-n', '1', 'HEAD']) ?? '').trim().split(/\s+/).slice(1);
  if (parents.length < 2) return;
  // Только свой, только что созданный коммит слияния: fast-forward на чужой коммит слияния тоже даёт два родителя, но
  // первый из них — не прежний HEAD (TASK-139.4).
  if (parents[0] !== gitOrNull(['rev-parse', '-q', '--verify', 'ORIG_HEAD'])?.trim()) return;
  const changed = changedPaths([parents[0], 'HEAD']);
  if (!changed.some(isCodePath)) return;
  if (compareVersions(versionAt('HEAD'), versionAt(parents[0])) > 0) return;
  bump(true);
  // `commit --amend` во время post-merge запрещён (MERGE_HEAD ещё на месте): коммит слияния пересобирается из индекса с
  // теми же родителями, автором и сообщением.
  const head = git(['rev-parse', 'HEAD']).trim();
  const [name, email, date] = git(['log', '-1', '--format=%an%x00%ae%x00%aD', head]).trim().split('\0');
  const tree = git(['write-tree']).trim();
  const message = git(['log', '-1', '--format=%B', head]);
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])];
  const amended = execFileSync('git', args, { cwd: rootDir, encoding: 'utf-8', input: message, env }).trim();
  git(['update-ref', '-m', 'post-merge: версия приложений (TASK-193)', 'HEAD', amended, head]);
}

/** Подключает .githooks (npm install → prepare). Чужой core.hooksPath не перезаписывает. */
function installHooks() {
  if (gitOrNull(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return;
  if (!fs.existsSync(path.join(rootDir, '.githooks', 'pre-commit'))) return;
  const current = gitOrNull(['config', '--get', 'core.hooksPath'])?.trim();
  if (current === '.githooks') return;
  if (current) {
    console.warn(`⚠️  core.hooksPath = ${current}: хуки версии (.githooks) не подключены, поднимайте версию npm run version:bump`);
    return;
  }
  git(['config', 'core.hooksPath', '.githooks']);
  console.log('🪝 git-хуки подключены: core.hooksPath = .githooks (версия приложений, TASK-193)');
}

function verify(range) {
  if (!range) throw new Error('verify: нужен --range A..B');
  const [from, toRaw] = range.split('..');
  const to = toRaw || 'HEAD';
  // Новая ветка или первый push: «до» нет, проверяется только последний коммит.
  const hasFrom = Boolean(from) && !/^0+$/.test(from) && gitOrNull(['cat-file', '-e', `${from}^{commit}`]) !== null;
  const effective = hasFrom ? `${from}..${to}` : `${to}~1..${to}`;
  const commits = (gitOrNull(['rev-list', '--first-parent', '--reverse', effective]) ?? '').split('\n').filter(Boolean);
  const failed = [];
  for (const sha of commits) {
    const parent = gitOrNull(['rev-parse', `${sha}^1`])?.trim();
    if (!parent) continue;
    // Правило действует с коммита, который его ввёл: у более ранних родителей этого файла нет.
    if (gitOrNull(['cat-file', '-e', `${parent}:scripts/version-rules.mjs`]) === null) continue;
    const changed = changedPaths([parent, sha]);
    if (!changed.some(isCodePath)) continue;
    const before = versionAt(parent);
    const after = versionAt(sha);
    if (compareVersions(after, before) <= 0) {
      failed.push(`${sha.slice(0, 7)} ${git(['log', '-1', '--format=%s', sha]).trim()} — версия ${after}, у родителя ${before}`);
    }
  }
  if (failed.length) {
    console.error('❌ Коммиты с кодом без повышения версии (TASK-193, правило 24):');
    for (const f of failed) console.error(`   ${f}`);
    process.exit(1);
  }
  console.log(`✓ Версия поднята во всех коммитах с кодом (${commits.length} проверено)`);
}

function latestTag(tag) {
  if (!tag) throw new Error('latest-tag: нужен тег, например v0.1.50');
  const tags = git(['tag', '--list', 'v*']).split(/\r?\n/).filter(Boolean);
  console.log(isLatestReleaseTag(tag, tags) ? 'true' : 'false');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'check') check();
  else if (cmd === 'bump') bump(rest.includes('--stage'));
  else if (cmd === 'ensure-staged') ensureStaged();
  else if (cmd === 'ensure-merge') ensureMerge(rest[0] === '1');
  else if (cmd === 'install-hooks') installHooks();
  else if (cmd === 'verify') verify(rest[rest.indexOf('--range') + 1]);
  else if (cmd === 'latest-tag') latestTag(rest[0]);
  else {
    console.error('Использование: node scripts/version.mjs check | bump [--stage] | ensure-staged | ensure-merge [1] | install-hooks | verify --range A..B | latest-tag <tag>');
    process.exit(2);
  }
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
