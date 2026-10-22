import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { INFRA_ROOT, PROJECT_ROOT } from './config.mjs';
import { buildMemoryIndexText, MEMORY_INDEX_FILE, MEMORY_ROOT } from './memory-rules.mjs';

// Сгенерированные файлы после слияния (TASK-139.4, decision-156): индекс документации .rag-index/ и
// backlog/memory/MEMORY.md не сливаются — драйвер projecthub-generated (scripts/task-merge-driver.mjs) оставляет их
// своей стороне, — а пересобираются по слитым документам. Копия в template/scripts/.
//
//   node scripts/generated-merge.mjs post-merge [1]       # git-хук post-merge; 1 — squash
//   node scripts/generated-merge.mjs post-rewrite rebase  # git-хук post-rewrite: после rebase (git pull --rebase)
//   node scripts/generated-merge.mjs resolve              # слияние встало на конфликте: сгенерированные — своя
//                                                         # сторона, пересборка, в индекс git; остальное — человеку
//
// Коммит слияния, который git только что создал, дополняется пересобранным (commit-tree с теми же родителями,
// автором и сообщением: `--amend` во время post-merge запрещён). Чужие коммиты — fast-forward, rebase — не
// переписываются: пересборка остаётся в рабочем дереве, и хук напоминает её закоммитить.

const RAG_DIR = path.join(PROJECT_ROOT, '.rag-index');
const MEMORY_INDEX = path.join(PROJECT_ROOT, ...MEMORY_ROOT.split('/'), MEMORY_INDEX_FILE);
const RAG_SCRIPTS = path.join(INFRA_ROOT, 'scripts', 'rag');

function git(args, opts = {}) {
  const res = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8', ...opts });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

const toPosix = (p) => p.split(path.sep).join('/');
const repoRoot = path.resolve(git(['rev-parse', '--show-toplevel']).out || PROJECT_ROOT);
/** Путь от корня репозитория (`:/`): инфраструктура и проект могут быть подкаталогом. */
const top = (abs) => `:/${toPosix(path.relative(repoRoot, abs))}`;

/** MEMORY.md по файлам фактов; `true` — файл изменился. */
function rebuildMemoryIndex() {
  const next = buildMemoryIndexText(PROJECT_ROOT);
  if (next === null) return false;
  const current = fs.existsSync(MEMORY_INDEX) ? fs.readFileSync(MEMORY_INDEX, 'utf-8').replace(/\r\n/g, '\n') : null;
  if (current === next) return false;
  fs.writeFileSync(MEMORY_INDEX, next);
  console.log(`🧠 ${MEMORY_ROOT}/${MEMORY_INDEX_FILE} пересобран по файлам фактов.`);
  return true;
}

/** Индекс документации, если check-index говорит, что он устарел: `fresh` | `rebuilt` | `failed` | `none`. */
function rebuildDocsIndex() {
  const check = path.join(RAG_SCRIPTS, 'check-index.mjs');
  if (!fs.existsSync(check)) return 'none';
  // check-index сам пропускает проект без docsRag и без документов.
  if (spawnSync(process.execPath, [check], { cwd: INFRA_ROOT, stdio: 'ignore' }).status === 0) return 'fresh';
  console.log('📚 Индекс документации устарел после слияния — пересборка (index-docs)...');
  const run = spawnSync(process.execPath, [path.join(RAG_SCRIPTS, 'index-docs.mjs')], { cwd: INFRA_ROOT, stdio: 'inherit' });
  if (run.status === 0) return 'rebuilt';
  console.warn('⚠️  index-docs не прошёл — пересоберите индекс вручную (npm run index-docs), lint:docs напомнит.');
  return 'failed';
}

/** Пересобрать оба файла; возвращает пути `:/…` того, что изменилось. */
function regenerate() {
  const changed = [];
  if (rebuildMemoryIndex()) changed.push(top(MEMORY_INDEX));
  if (rebuildDocsIndex() === 'rebuilt') changed.push(top(RAG_DIR));
  return changed;
}

const stage = (paths) => paths.length > 0 && git(['add', '-A', '--', ...paths]);

function remindCommit(paths) {
  console.log(`\n⚠️  Сгенерированные файлы пересобраны в рабочем дереве, коммит не изменён. Закоммитьте их:`);
  console.log(`   git add -A -- ${paths.join(' ')} && git commit -m "chore: пересборка индексов после слияния"`);
}

/** Коммит слияния HEAD пересобирается из индекса git с теми же родителями, автором и сообщением. */
function amendMergeCommit(parents) {
  const head = git(['rev-parse', 'HEAD']).out;
  const tree = git(['write-tree']).out;
  if (!tree || tree === git(['rev-parse', 'HEAD^{tree}']).out) return;
  const [name, email, date] = git(['log', '-1', '--format=%an%x00%ae%x00%aD', head]).out.split('\0');
  const message = execFileSync('git', ['log', '-1', '--format=%B', head], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])];
  const amended = execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8', input: message, env }).trim();
  git(['update-ref', '-m', 'post-merge: пересборка индексов (TASK-139.4)', 'HEAD', amended, head]);
  console.log('✅ Коммит слияния дополнен пересобранными индексами.');
}

function postMerge(squash) {
  const changed = regenerate();
  if (changed.length === 0) return;
  // squash коммитит сам человек обычным git commit — пересобранное просто входит в индекс.
  if (squash) return void stage(changed);
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).out.split(/\s+/).slice(1);
  const origHead = git(['rev-parse', '-q', '--verify', 'ORIG_HEAD']).out;
  // Свой коммит слияния — только что созданный поверх прежнего HEAD. Fast-forward на чужой коммит слияния даёт те же
  // два родителя, но первый из них — не ORIG_HEAD.
  if (parents.length >= 2 && parents[0] === origHead) {
    stage(changed);
    amendMergeCommit(parents);
  } else {
    remindCommit(changed);
  }
}

function resolve() {
  if (!git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
    console.error('Слияние не идёт (нет MERGE_HEAD) — пересборка после завершённого слияния делает хук post-merge.');
    return 1;
  }
  const unmerged = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  const ragRel = `${toPosix(path.relative(repoRoot, RAG_DIR))}/`;
  const memoryRel = toPosix(path.relative(repoRoot, MEMORY_INDEX));
  const generated = unmerged.filter((p) => p.startsWith(ragRel) || p === memoryRel);
  const other = unmerged.filter((p) => !generated.includes(p));
  if (generated.some((p) => p.startsWith(ragRel))) {
    const dir = top(RAG_DIR);
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', dir]);
    git(['checkout', 'HEAD', '--', dir]);
    git(['clean', '-fdq', '--', dir]);
  }
  if (generated.includes(memoryRel)) {
    if (git(['cat-file', '-e', `HEAD:${memoryRel}`]).ok) git(['checkout', 'HEAD', '--', top(MEMORY_INDEX)]);
    else git(['rm', '-q', '--cached', '--ignore-unmatch', '--', top(MEMORY_INDEX)]);
  }
  if (generated.length > 0) console.log(`♻️  Конфликт сгенерированных файлов снят (${generated.length}): своя сторона.`);
  if (other.length > 0) {
    console.error(`⚠️  Остались конфликты в ${other.length} файлах:\n${other.map((f) => `   ${f}`).join('\n')}`);
    console.error('   Разрешите их и запустите команду снова.');
    return 1;
  }
  stage(regenerate());
  console.log('✅ Сгенерированные файлы пересобраны и добавлены. Завершите слияние: git commit.');
  return 0;
}

const [command, arg] = process.argv.slice(2);
let code = 0;
try {
  if (command === 'post-merge') postMerge(arg === '1');
  else if (command === 'post-rewrite') {
    if (arg === 'rebase') {
      const changed = regenerate();
      if (changed.length > 0) remindCommit(changed);
    }
  } else if (command === 'resolve') code = resolve();
  else {
    console.error('Использование: node scripts/generated-merge.mjs post-merge [1] | post-rewrite rebase | resolve');
    code = 2;
  }
} catch (err) {
  // Из хука: слияние уже состоялось, его не ломаем — только сообщаем.
  console.error(`⚠️  generated-merge: ${err instanceof Error ? err.message : String(err)}`);
  code = command === 'resolve' ? 1 : 0;
}
process.exit(code);
