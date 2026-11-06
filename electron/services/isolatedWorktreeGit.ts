/**
 * Git хоста в worktree изолированного участника (TASK-265, [[decision-225]]). Агент в контейнере может создать в
 * worktree вложенный git-репозиторий со своим `.git/config` (`core.fsmonitor`, `filter.*.clean` с `.gitattributes`).
 * Пока вложенный репозиторий не отслеживается, git хоста в него не заходит. Стоит ему попасть в индекс как gitlink
 * (mode 160000), и `status`, `diff`, `add` хоста запускают git внутри него — по его конфигу, от пользователя хоста.
 *
 * Поэтому в изолированном worktree:
 * - `add` хоста не принимает новых gitlink: уже отслеживаемые исключаются из pathspec (их `add` не проверяет), новые
 *   снимаются из индекса сразу после `add`;
 * - каждый вызов git хоста получает `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`: git передаёт их и
 *   дочерним процессам во вложенных репозиториях, поэтому `core.fsmonitor`, хуки и обход подмодулей отключены и там.
 *
 * Изолированный worktree узнаётся по маркеру в его `config.worktree` (лежит в общем `.git` хоста, в контейнер не
 * монтируется — агент его не снимет), маркер ставит `hardenMemberWorktreeGit`. Модуль без Electron: git — через
 * `GitRunner`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitRunner } from './checkpointGit.js';
import { isWorktreeGitDirOf, parseGitDirPointer } from './pathGuard.js';
import { AppError } from '../../src/lib/appError.js';

/** Маркер изолированного worktree в `config.worktree`; git хранит имя ключа в нижнем регистре. */
export const ISOLATED_WORKTREE_KEY = 'projecthub.isolatedworktree';

/** Режим gitlink в индексе и дереве git. */
const GITLINK_MODE = '160000';

/**
 * Настройки, которые git хоста получает через окружение в изолированном worktree. Окружение, в отличие от файла
 * конфига, наследуют и процессы git, которые git запускает во вложенных репозиториях.
 */
export function isolatedGitConfig(emptyHooksDir: string): Array<[string, string]> {
  return [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', emptyHooksDir],
    ['diff.ignoreSubmodules', 'all'],
    ['status.submoduleSummary', 'false'],
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false']
  ];
}

/**
 * Переменные, которые simple-git не принимает в явно переданном окружении (редакторы, пейджеры, ssh, пути конфигов):
 * git хоста в worktree работает без них — команды локальные и не интерактивные.
 */
const SIMPLE_GIT_BLOCKED_ENV = new Set([
  'editor',
  'git_askpass',
  'git_config',
  'git_config_global',
  'git_config_system',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_ssh',
  'git_ssh_command',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass'
]);

/** Окружение процесса без переменных, опасных для git хоста, и без чужих `GIT_CONFIG_*`, плюс `extra`. */
export function hostGitEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    const k = key.toLowerCase();
    if (value === undefined || SIMPLE_GIT_BLOCKED_ENV.has(k) || /^git_config_(count|key_\d+|value_\d+|parameters)$/.test(k)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

/**
 * simple-git для изолированного worktree: окружение `hostGitEnv(env)`. simple-git по умолчанию запрещает
 * `GIT_CONFIG_COUNT` и запись `core.fsmonitor`/`core.hooksPath`; здесь они разрешены — значения задаёт хост
 * (`isolatedGitConfig`), и они только выключают выполнение кода.
 */
export function isolatedSimpleGit(baseDir: string, env: Record<string, string>): SimpleGit {
  return simpleGit({ baseDir, unsafe: { allowUnsafeConfigEnvCount: true, allowUnsafeFsMonitor: true, allowUnsafeHooksPath: true } }).env(hostGitEnv(env));
}

/** Те же настройки переменными `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. */
export function isolatedGitEnv(emptyHooksDir: string): Record<string, string> {
  const pairs = isolatedGitConfig(emptyHooksDir);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Пути gitlink из `git ls-files -s -z` (`<mode> <sha> <stage>\t<path>`) или `git ls-tree -r -z`
 * (`<mode> <type> <sha>\t<path>`). Остальные записи пропускаются.
 */
export function gitlinkPaths(output: string): string[] {
  const out = new Set<string>();
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab <= 0) continue;
    if (record.slice(0, tab).split(' ')[0] === GITLINK_MODE) out.add(record.slice(tab + 1));
  }
  return [...out];
}

/** Pathspec «всё дерево, кроме этих путей»: `add` не заходит в исключённые gitlink. */
export function pathspecWithout(paths: readonly string[]): string[] {
  return ['.', ...paths.map((p) => `:(exclude,literal)${p}`)];
}

/**
 * Окружение git хоста для `cwd`: изолированный worktree (маркер в конфиге) — `GIT_CONFIG_*` с его пустым каталогом
 * хуков, иначе `null`. Конфиг читается одним вызовом `git config --get-regexp`; ошибка (не репозиторий) — `null`.
 */
export async function isolatedEnvOf(git: GitRunner, cwd: string): Promise<Record<string, string> | null> {
  const out = await git(['config', '-z', '--get-regexp', '^(projecthub\\.isolatedworktree|core\\.hookspath)$'], { cwd }).catch(() => '');
  let marked = false;
  let hooksDir = '';
  for (const entry of out.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl < 0 ? '' : entry.slice(nl + 1);
    if (key === ISOLATED_WORKTREE_KEY) marked = value.trim().toLowerCase() === 'true';
    else if (key === 'core.hookspath') hooksDir = value;
  }
  if (!marked) return null;
  // Без каталога хуков из конфига worktree хуки отключает несуществующий путь — git тогда не находит ни одного.
  return isolatedGitEnv(hooksDir || path.join(cwd, '.git', 'projecthub-no-hooks'));
}

/**
 * `git add` всего дерева без новых gitlink (TASK-265): отслеживаемые gitlink исключены из pathspec, новые (вложенный
 * репозиторий агента) после `add` снимаются из индекса. `intentToAdd` — `add -N` вместо `add -A` (дифф с новыми
 * файлами). Возвращает снятые пути. `env` — окружение git (`GIT_CONFIG_*`, `GIT_INDEX_FILE`).
 */
export async function addAllWithoutGitlinks(
  git: GitRunner,
  cwd: string,
  env: Record<string, string> = {},
  options: { intentToAdd?: boolean } = {}
): Promise<string[]> {
  const run = (args: string[]) => git(args, { cwd, env });
  const tracked = gitlinkPaths(await run(['ls-files', '-s', '-z']));
  await run(['add', options.intentToAdd ? '-N' : '-A', '--', ...pathspecWithout(tracked)]);
  const candidates = gitlinkPaths(await run(['ls-files', '-s', '-z'])).filter((p) => !tracked.includes(p));
  if (candidates.length === 0) return [];
  // gitlink из HEAD (подмодуль проекта) — не новый: его `add` вернул после снятия из индекса.
  // `ls-tree` сравнивает пути буквально (без glob и без магии pathspec).
  const inHead = new Set(gitlinkPaths(await run(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...candidates]).catch(() => '')));
  const added = candidates.filter((p) => !inHead.has(p));
  if (added.length > 0) await run(['rm', '--cached', '-r', '-q', '-f', '--', ...added.map((p) => `:(literal)${p}`)]);
  return added;
}

/**
 * Файл `.git` worktree — обычный файл с указателем на `<проект>/.git/worktrees/<имя>`. Иначе git хоста работал бы с
 * чужим каталогом git (и его конфигом). Отказ — `AppError` `swarm.sandboxGitPointer`.
 */
export async function assertWorktreeGitPointer(projectRoot: string, worktree: string): Promise<void> {
  const file = path.join(worktree, '.git');
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) throw new AppError('swarm.sandboxGitPointer', { path: worktree });
  const gitdir = parseGitDirPointer(await fs.readFile(file, 'utf8').catch(() => ''));
  if (!gitdir) throw new AppError('swarm.sandboxGitPointer', { path: worktree });
  if (isWorktreeGitDirOf(projectRoot, worktree, gitdir)) return;
  // Пути после `realpath` (macOS: /var → /private/var; корень проекта через ссылку).
  const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktree, gitdir);
  const [realRoot, realGitdir] = await Promise.all([fs.realpath(projectRoot).catch(() => projectRoot), fs.realpath(resolved).catch(() => resolved)]);
  if (!isWorktreeGitDirOf(realRoot, worktree, realGitdir)) throw new AppError('swarm.sandboxGitPointer', { path: worktree });
}
