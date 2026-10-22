import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitRunner } from './checkpointGit';
import { conflictFileKind, hasConflictMarkers, parseConflictSegments, type ConflictFileKind, type ConflictSegment } from './conflictMarkers';
import { MEMORY_INDEX_PATH, RAG_INDEX_DIR, splitConflicts, writeMemoryIndex, type GeneratedKind } from './backlogGenerated';
import { findIndexDocsDir } from './docsReindex';

/**
 * Окно конфликтов слияния в ProjectHub (TASK-139.3, decision-157): незавершённое слияние в рабочем дереве проекта —
 * после «Слить ветку», `git pull` или `backlog:merge`, вставших на конфликте. Человек выбирает по блокам «моё / их /
 * оба», правит итог, а завершение делает то же, что `npm run backlog:merge -- --regenerate` и `git commit`:
 * сгенерированные файлы берутся из текущей ветки и пересобираются по слитым документам (decision-149).
 *
 * Модуль без Electron: git и запуск npm внедряются. Пути файлов — от корня репозитория, как их печатает git.
 */

export * from './conflictMarkers';

// ── Состояние слияния ───────────────────────────────────────────────────────────────────────────────────────

/** `content` — обе стороны есть; `ours-deleted`/`theirs-deleted` — одна сторона файл удалила (или не создавала). */
export type ConflictFileState = 'content' | 'ours-deleted' | 'theirs-deleted';

export interface MergeConflictFile {
  path: string;
  kind: ConflictFileKind;
  state: ConflictFileState;
}

export interface MergeState {
  inMerge: boolean;
  /** Ветка рабочего дерева (куда сливаем). */
  branch: string;
  /** Первая строка сообщения слияния: что сливаем. */
  title: string;
  /** Неразрешённые файлы, которые решает человек. */
  files: MergeConflictFile[];
  /** Сгенерированные файлы в конфликте — снимаются при завершении сами. */
  generated: GeneratedKind[];
}

interface RepoPaths {
  top: string;
  /** Каталог проекта в репозитории, `''` или `sub/dir/`. */
  prefix: string;
}

async function repoPaths(git: GitRunner, projectRoot: string): Promise<RepoPaths> {
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd: projectRoot })).trim();
  const prefix = (await git(['rev-parse', '--show-prefix'], { cwd: projectRoot })).trim().replace(/\\/g, '/');
  return { top, prefix };
}

async function inMergeAt(git: GitRunner, top: string): Promise<boolean> {
  try {
    await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: top });
    return true;
  } catch {
    return false;
  }
}

/** Стадии индекса неразрешённых файлов: 1 — предок, 2 — наша сторона, 3 — их. */
async function unmergedStages(git: GitRunner, top: string): Promise<Map<string, Set<number>>> {
  const out = await git(['-c', 'core.quotePath=false', 'ls-files', '-u', '-z'], { cwd: top }).catch(() => '');
  const stages = new Map<string, Set<number>>();
  for (const entry of out.split('\0')) {
    const m = /^\d+ [0-9a-f]+ ([123])\t(.+)$/.exec(entry);
    if (!m) continue;
    const set = stages.get(m[2]) ?? new Set<number>();
    set.add(Number(m[1]));
    stages.set(m[2], set);
  }
  return stages;
}

function stateOf(stages: Set<number>): ConflictFileState {
  if (!stages.has(2)) return 'ours-deleted';
  if (!stages.has(3)) return 'theirs-deleted';
  return 'content';
}

export async function readMergeState(git: GitRunner, projectRoot: string): Promise<MergeState> {
  const { top, prefix } = await repoPaths(git, projectRoot);
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top }).catch(() => 'HEAD')).trim();
  const inMerge = await inMergeAt(git, top);
  const stages = await unmergedStages(git, top);
  const { generated, other } = splitConflicts([...stages.keys()], prefix);
  let title = '';
  if (inMerge) {
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'], { cwd: top })).trim();
    title = (await fs.readFile(path.join(gitDir, 'MERGE_MSG'), 'utf8').catch(() => '')).split(/\r?\n/)[0]?.trim() ?? '';
  }
  return {
    inMerge,
    branch,
    title,
    files: other.sort().map((p) => ({ path: p, kind: conflictFileKind(p, prefix), state: stateOf(stages.get(p)!) })),
    generated: [...generated].sort()
  };
}

export interface ConflictFileContent extends MergeConflictFile {
  /** Файл в рабочем дереве (с маркерами); `null` — его нет. */
  working: string | null;
  segments: ConflictSegment[];
  /** Версии сторон целиком — для файла без маркеров (удалён одной стороной, бинарный). */
  ours: string | null;
  theirs: string | null;
}

/** Путь из окна должен быть среди неразрешённых: окно не читает и не пишет произвольные файлы репозитория. */
async function assertUnmerged(git: GitRunner, top: string, file: string): Promise<Set<number>> {
  const stages = (await unmergedStages(git, top)).get(file);
  if (!stages) throw new Error(`Файл не в конфликте слияния: ${file}`);
  return stages;
}

const showStage = (git: GitRunner, top: string, stage: number, file: string) =>
  git(['show', `:${stage}:${file}`], { cwd: top }).catch(() => null);

export async function readConflictFile(git: GitRunner, projectRoot: string, file: string): Promise<ConflictFileContent> {
  const { top, prefix } = await repoPaths(git, projectRoot);
  const stages = await assertUnmerged(git, top, file);
  const working = await fs.readFile(path.join(top, file), 'utf8').catch(() => null);
  return {
    path: file,
    kind: conflictFileKind(file, prefix),
    state: stateOf(stages),
    working,
    segments: working === null ? [] : parseConflictSegments(working),
    ours: stages.has(2) ? await showStage(git, top, 2, file) : null,
    theirs: stages.has(3) ? await showStage(git, top, 3, file) : null
  };
}

/** `content` — итог из окна; `ours`/`theirs` — версия стороны целиком (нет её — файл удаляется). */
export type ConflictResolution = { kind: 'content'; content: string } | { kind: 'ours' } | { kind: 'theirs' };

export async function resolveConflictFile(git: GitRunner, projectRoot: string, file: string, resolution: ConflictResolution): Promise<void> {
  const { top } = await repoPaths(git, projectRoot);
  const stages = await assertUnmerged(git, top, file);
  if (resolution.kind === 'content') {
    if (hasConflictMarkers(resolution.content)) throw new Error('В итоге остались маркеры конфликта <<<<<<< ======= >>>>>>>');
    await fs.writeFile(path.join(top, file), resolution.content, 'utf8');
    await git(['add', '--', file], { cwd: top });
    return;
  }
  const stage = resolution.kind === 'ours' ? 2 : 3;
  if (!stages.has(stage)) {
    await git(['rm', '-q', '--', file], { cwd: top });
    return;
  }
  await git(['checkout', `--${resolution.kind}`, '--', file], { cwd: top });
  await git(['add', '--', file], { cwd: top });
}

// ── Завершение ──────────────────────────────────────────────────────────────────────────────────────────────

export interface NpmRunner {
  /** `npm run <script>` в каталоге; `true` — код 0. */
  (script: string, cwd: string): Promise<boolean>;
}

export interface FinishMergeResult {
  ok: boolean;
  /** Текст отказа или ошибки. */
  error?: string;
  /** Файлы, которые ещё в конфликте. */
  remaining?: string[];
  sha?: string;
  memoryRebuilt?: boolean;
  /** `fresh` — индекс актуален, `rebuilt` — пересобран, `failed` — `index-docs` упал, `none` — скрипта нет. */
  index?: 'fresh' | 'rebuilt' | 'failed' | 'none';
}

/** Конфликт сгенерированного файла — версия текущей ветки, как `takeOursGenerated` в `backlog-merge.mjs`. */
async function takeOursGenerated(git: GitRunner, top: string, prefix: string, kinds: ReadonlySet<GeneratedKind>): Promise<void> {
  const quiet = (args: string[]) => git(args, { cwd: top }).catch(() => '');
  if (kinds.has('rag-index')) {
    const dir = `${prefix}${RAG_INDEX_DIR.replace(/\/$/, '')}`;
    await quiet(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', dir]);
    await quiet(['checkout', 'HEAD', '--', dir]);
    await quiet(['clean', '-fdq', '--', dir]);
  }
  if (kinds.has('memory-index')) {
    const file = `${prefix}${MEMORY_INDEX_PATH}`;
    const tracked = await git(['cat-file', '-e', `HEAD:${file}`], { cwd: top }).then(() => true, () => false);
    await quiet(tracked ? ['checkout', 'HEAD', '--', file] : ['rm', '-q', '--cached', '--ignore-unmatch', '--', file]);
  }
}

/**
 * Довести слияние: остальных конфликтов нет → сгенерированные файлы из текущей ветки, `MEMORY.md` и индекс
 * документации пересобраны по слитым документам и добавлены, коммит слияния с его сообщением. Хуки репозитория
 * (`pre-commit` поднимает версию, decision-148) работают как при `git commit`.
 */
export async function finishMergeResolution(git: GitRunner, projectRoot: string, npm: NpmRunner): Promise<FinishMergeResult> {
  const { top, prefix } = await repoPaths(git, projectRoot);
  if (!(await inMergeAt(git, top))) return { ok: false, error: 'Слияние не идёт: завершать нечего' };
  const { generated, other } = splitConflicts([...(await unmergedStages(git, top)).keys()], prefix);
  if (other.length > 0) return { ok: false, error: `Остались неразрешённые конфликты: ${other.join(', ')}`, remaining: other };
  if (generated.size > 0) await takeOursGenerated(git, top, prefix, generated);

  const memoryRebuilt = writeMemoryIndex(projectRoot);
  const memoryFile = path.join(projectRoot, ...MEMORY_INDEX_PATH.split('/'));
  if (await fs.stat(memoryFile).then(() => true, () => false)) await git(['add', '--', `${prefix}${MEMORY_INDEX_PATH}`], { cwd: top });

  let index: FinishMergeResult['index'] = 'none';
  const indexDir = findIndexDocsDir(projectRoot);
  if (indexDir) {
    if (await npm('check-index', indexDir)) index = 'fresh';
    else if (await npm('index-docs', indexDir)) {
      index = 'rebuilt';
      const ragDir = path.relative(top, path.join(indexDir, RAG_INDEX_DIR)).replace(/\\/g, '/');
      await git(['add', '-A', '--', ragDir], { cwd: top });
    } else index = 'failed';
  }

  try {
    await git(['commit', '--no-edit'], { cwd: top });
  } catch (err) {
    return { ok: false, error: `Коммит слияния не удался: ${err instanceof Error ? err.message : String(err)}`, memoryRebuilt, index };
  }
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: top })).trim();
  return { ok: true, sha, memoryRebuilt, index };
}

export async function abortMerge(git: GitRunner, projectRoot: string): Promise<void> {
  const { top } = await repoPaths(git, projectRoot);
  if (!(await inMergeAt(git, top))) throw new Error('Слияние не идёт: отменять нечего');
  await git(['merge', '--abort'], { cwd: top });
}
