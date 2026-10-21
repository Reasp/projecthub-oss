import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Тесты git-хуков инфраструктуры (правило 19 infra-dev.md: правило, которое можно проверить
// машиной, получает скрипт). Хуки — sh-скрипты, поэтому тесты пропускаются там, где нет sh
// (на Windows sh даёт Git for Windows — тот же, которым git запускает хуки).
//
// post-commit проверяется на заглушке вместо настоящего gitnexus (через GITNEXUS_HOOK_CMD):
// полный analyze занимает полминуты, а нам нужна не скорость индексатора, а порядок вызовов
// при отказе (analyze → clean --force → analyze).

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = __dirname;

const SH = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf-8' });
const NO_SH = SH.error || SH.status !== 0;
const skip = NO_SH && 'нет sh (Git Bash)';

function sandboxDir() {
  return mkdtempSync(join(tmpdir(), 'infra-hooks-'));
}

/**
 * post-commit: песочница с заглушкой gitnexus. failFirstAnalyze повторяет боевой отказ.
 * commitFiles — песочница становится репозиторием, и последний коммит содержит эти файлы.
 */
function runPostCommit({ failFirstAnalyze, indexed = true, commitFiles = null }) {
  const dir = sandboxDir();
  if (commitFiles) {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    for (const file of commitFiles) writeFileSync(join(dir, file), 'x\n');
    git('add', ...commitFiles);
    git('-c', 'user.email=hook@test', '-c', 'user.name=hook', 'commit', '-qm', 'test');
  }
  copyFileSync(join(HOOKS, 'post-commit'), join(dir, 'hook.sh'));
  if (indexed) mkdirSync(join(dir, '.gitnexus'));
  writeFileSync(
    join(dir, 'stub.cjs'),
    `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.log', args.join(' ') + '\\n');
if (args[0] === 'clean') { fs.writeFileSync('cleaned', ''); process.exit(0); }
if (args[0] === 'analyze') {
  const broken = ${failFirstAnalyze} && !fs.existsSync('cleaned');
  process.exit(broken ? 1 : 0);
}
process.exit(0);
`,
  );
  const run = spawnSync('sh', ['hook.sh'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, GITNEXUS_HOOK_CMD: 'node stub.cjs', INFRA_HOOKS_SKIP: '' },
  });
  const log = existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf-8').trim().split('\n')
    : [];
  return { run, log };
}

test('post-commit: после падения переиндексации добивает полной пересборкой', { skip }, () => {
  const { run, log } = runPostCommit({ failFirstAnalyze: true });
  const ANALYZE = 'analyze --skip-agents-md --skip-skills';
  assert.deepEqual(log, [ANALYZE, 'clean --force', ANALYZE], `ожидался analyze → clean → analyze, вышло: ${log.join(' | ')}`);
  assert.equal(run.status, 0, 'хук не должен падать сам: post-commit уже ничего не отменит');
  assert.match(run.stdout, /пересобран начисто/, `нет сообщения об успешной пересборке:\n${run.stdout}`);
});

test('post-commit: при успешной переиндексации ничего не пересобирает', { skip }, () => {
  const { run, log } = runPostCommit({ failFirstAnalyze: false });
  assert.deepEqual(log, ['analyze --skip-agents-md --skip-skills'], `лишние вызовы после успешного analyze: ${log.join(' | ')}`);
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stdout, /clean/, 'хук предлагает очистку там, где всё прошло успешно');
});

test('post-commit: коммит с .gitnexusignore или .gitignore — полный проход (--force)', { skip }, () => {
  for (const file of ['.gitnexusignore', '.gitignore']) {
    const { run, log } = runPostCommit({ failFirstAnalyze: false, commitFiles: [file, 'a.txt'] });
    assert.deepEqual(log, ['analyze --force --skip-agents-md --skip-skills'], `${file}: ${log.join(' | ')}`);
    assert.equal(run.status, 0);
  }
});

test('post-commit: коммит без правил индексации — обычный инкрементальный проход', { skip }, () => {
  const { log } = runPostCommit({ failFirstAnalyze: false, commitFiles: ['src.ts'] });
  assert.deepEqual(log, ['analyze --skip-agents-md --skip-skills']);
});

test('post-commit: в проекте без .gitnexus/ молча ничего не делает', { skip }, () => {
  const { run, log } = runPostCommit({ failFirstAnalyze: false, indexed: false });
  assert.deepEqual(log, [], 'без индекса gitnexus вызываться не должен');
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), '');
});

/** commit-msg: прогоняет хук на тексте сообщения, возвращает {status, stdout}. */
function runCommitMsg(message) {
  const dir = sandboxDir();
  const msgFile = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(msgFile, message);
  return spawnSync('sh', [join(HOOKS, 'commit-msg'), msgFile], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, INFRA_HOOKS_SKIP: '' },
  });
}

const REJECTED = [
  ['трейлер Co-Authored-By Claude', 'feat(task-3): доска задач\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n'],
  ['трейлер Co-authored-by Copilot', 'fix: null check\n\nCo-authored-by: GitHub Copilot <copilot@github.com>\n'],
  ['подпись Generated with Claude Code', 'docs: README\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'],
  ['фраза Generated by AI', 'chore: bump\n\nGenerated by AI\n'],
  ['фраза Assisted by Gemini', 'refactor: вынос парсера\n\nAssisted by Gemini CLI\n'],
  ['русская фраза', 'feat: экспорт\n\nсгенерировано Claude\n'],
  ['трейлер Assisted-by', 'feat: x\n\nAssisted-by: Codex\n'],
];

for (const [label, message] of REJECTED) {
  test(`commit-msg: отклоняет — ${label}`, { skip }, () => {
    const res = runCommitMsg(message);
    assert.equal(res.status, 1, `ожидался отказ, вышло status=${res.status}\nstdout: ${res.stdout}`);
    assert.match(res.stdout, /атрибуция AI/);
  });
}

const ACCEPTED = [
  ['обычное сообщение', 'feat(task-3): реализация доски задач\n\nДобавлен drag-and-drop колонок.\n'],
  ['соавтор-человек', 'fix: гонка в планировщике\n\nCo-Authored-By: Ivan Petrov <ivan@example.com>\n'],
  ['упоминание AI как темы правки', 'feat(llm): переключение провайдера через env\n\nМок-провайдер по умолчанию, DeepSeek/OpenRouter по ключу.\n'],
  ['комментарии git игнорируются', 'chore: bump\n\n# Co-Authored-By: Claude <noreply@anthropic.com>\n'],
];

for (const [label, message] of ACCEPTED) {
  test(`commit-msg: пропускает — ${label}`, { skip }, () => {
    const res = runCommitMsg(message);
    assert.equal(res.status, 0, `ожидался пропуск, вышло status=${res.status}\nstdout: ${res.stdout}`);
  });
}

test('commit-msg: INFRA_HOOKS_SKIP=1 отключает проверку', { skip }, () => {
  const dir = sandboxDir();
  const msgFile = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(msgFile, 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  const res = spawnSync('sh', [join(HOOKS, 'commit-msg'), msgFile], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, INFRA_HOOKS_SKIP: '1' },
  });
  assert.equal(res.status, 0);
});

test('pre-commit: на документации шаблона проходит (lint:docs + check-index)', { skip }, () => {
  // Интеграционный прогон на реальном PROJECT_ROOT: хук вычисляет путь к инфраструктуре от
  // самого себя, cwd — корень репозитория, как у git.
  const projectRoot = join(HOOKS, '..', '..');
  const res = spawnSync('sh', [join(HOOKS, 'pre-commit')], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: { ...process.env, INFRA_HOOKS_SKIP: '' },
  });
  assert.equal(res.status, 0, `pre-commit упал:\n${res.stdout}\n${res.stderr}`);
});
