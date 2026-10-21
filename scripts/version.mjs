// Единая версия приложений ProjectHub (TASK-193, decision-148).
//
//   node scripts/version.mjs check            — версии во всех файлах совпадают с package.json (входит в npm run build)
//   node scripts/version.mjs bump [--stage]   — третье число + 1 от версии HEAD во всех файлах рабочего дерева;
//                                              --stage пишет ту же правку и в текущий индекс git (учитывает GIT_INDEX_FILE),
//                                              поверх содержимого индекса, а не рабочего дерева
//   node scripts/version.mjs verify --range A..B — каждый коммит первой линии A..B, меняющий код, поднял версию (CI)
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
    const changed = git(['diff', '--name-only', parent, sha]).split('\n').filter(Boolean);
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

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'check') check();
  else if (cmd === 'bump') bump(rest.includes('--stage'));
  else if (cmd === 'verify') verify(rest[rest.indexOf('--range') + 1]);
  else {
    console.error('Использование: node scripts/version.mjs check | bump [--stage] | verify --range A..B');
    process.exit(2);
  }
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
