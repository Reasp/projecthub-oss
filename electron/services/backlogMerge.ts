import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../src/lib/appError';
import { execGit, sanitizeRefSegment, type GitRunner } from './checkpointGit';
import { backlogPathsAtCommit } from './backlogIdAllocator';
import type { HitlTextLine } from './hitlTypes';
import {
  entityFromBacklogPath,
  findBacklogIdMentions,
  formatRenumberTable,
  markRenumberedFrom,
  planBacklogRenumber,
  renameBacklogPath,
  replaceBacklogIds,
  type BacklogRenumbering
} from './backlogIds';

/**
 * Слияние ветки с перенумерацией входящей стороны (decision-76 п. 4–6, TASK-135).
 *
 * 1. Предпросмотр: коллизии номеров относительно merge-base и все упоминания старых номеров.
 * 2. Перенумерация во временном worktree на коммите входящей ветки: frontmatter, имена файлов, ссылки, упоминания
 *    в коде — только в файлах, которые входящая ветка изменила относительно merge-base. Бинарный индекс RAG
 *    возвращается к версии merge-base и пересобирается после слияния.
 * 3. Коммит перенумерации ложится на временную ветку `backlog-renumber/…` поверх входящей: её история не
 *    переписывается. Сливается временная ветка, сообщение слияния несёт таблицу замен.
 *
 * Модуль без Electron: им пользуются точки слияния ProjectHub и команда `npm run backlog:merge`.
 */

export const RENUMBER_BRANCH_PREFIX = 'backlog-renumber/';
const RAG_INDEX_DIR = '.rag-index/';

export interface BacklogMention {
  /** Путь от корня репозитория. */
  file: string;
  line: number;
  text: string;
}

export interface BacklogMergePreview {
  repoDir: string;
  target: string;
  incoming: string;
  targetSha: string;
  incomingSha: string;
  /** null — у веток нет общей истории: всё входящее считается добавленным. */
  mergeBase: string | null;
  /** Путь каталога `backlog/` от корня репозитория (`backlog/` или `sub/backlog/`). */
  backlogPrefix: string;
  /** Путь корня проекта от корня репозитория (`` или `sub/`). */
  projectPrefix: string;
  renumber: BacklogRenumbering[];
  mentions: BacklogMention[];
}

export interface BacklogMergeOptions {
  /** Целевая ветка или коммит; по умолчанию HEAD. */
  target?: string;
  git?: GitRunner;
}

async function revParse(git: GitRunner, cwd: string, ref: string): Promise<string> {
  return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).trim();
}

async function mergeBaseOf(git: GitRunner, cwd: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(['merge-base', a, b], { cwd })).trim() || null;
  } catch {
    return null;
  }
}

/** Файлы, добавленные или изменённые входящей стороной (пути от корня репозитория). */
async function changedByIncoming(git: GitRunner, cwd: string, base: string | null, incoming: string): Promise<string[]> {
  const out = base
    ? await git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRT', base, incoming], { cwd })
    : await git(['ls-tree', '-r', '-z', '--name-only', '--full-name', incoming], { cwd });
  return out.split('\0').filter(Boolean);
}

const isTextBuffer = (buf: Buffer) => !buf.includes(0);

/** План перенумерации и упоминания старых номеров — без изменений в репозитории (`--dry-run`). */
export async function previewBacklogMerge(repoDir: string, incoming: string, options: BacklogMergeOptions = {}): Promise<BacklogMergePreview> {
  const git = options.git ?? execGit;
  const target = options.target ?? 'HEAD';
  const targetSha = await revParse(git, repoDir, target);
  const incomingSha = await revParse(git, repoDir, incoming);
  if (!targetSha) throw new AppError('git.targetRefNotFound', { ref: target });
  if (!incomingSha) throw new AppError('git.incomingRefNotFound', { ref: incoming });
  const mergeBase = await mergeBaseOf(git, repoDir, targetSha, incomingSha);
  const projectPrefix = (await git(['rev-parse', '--show-prefix'], { cwd: repoDir })).trim().replace(/\\/g, '/');
  const backlogPrefix = `${projectPrefix}backlog/`;

  const [base, ours, theirs] = await Promise.all([
    mergeBase ? backlogPathsAtCommit(git, repoDir, mergeBase, backlogPrefix) : Promise.resolve([]),
    backlogPathsAtCommit(git, repoDir, targetSha, backlogPrefix),
    backlogPathsAtCommit(git, repoDir, incomingSha, backlogPrefix)
  ]);
  const renumber = planBacklogRenumber({ base, ours, theirs });
  // В сообщениях — имя ветки, а не «HEAD» (на отделённом HEAD git сам вернёт HEAD).
  const targetName = target === 'HEAD' ? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).trim() || target : target;
  const preview: BacklogMergePreview = {
    repoDir,
    target: targetName,
    incoming,
    targetSha,
    incomingSha,
    mergeBase,
    backlogPrefix,
    projectPrefix,
    renumber,
    mentions: []
  };
  if (renumber.length === 0) return preview;

  for (const file of await changedByIncoming(git, repoDir, mergeBase, incomingSha)) {
    if (file.startsWith(`${projectPrefix}${RAG_INDEX_DIR}`)) continue;
    let text: string;
    try {
      text = await git(['show', `${incomingSha}:${file}`], { cwd: repoDir });
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    for (const m of findBacklogIdMentions(text, renumber)) preview.mentions.push({ file, ...m });
  }
  return preview;
}

/** Сообщение коммита слияния с таблицей замен (decision-76 п. 5). */
export function mergeMessageWithRenumber(message: string, renumber: readonly BacklogRenumbering[]): string {
  if (renumber.length === 0) return message;
  return `${message}\n\nПеренумерация backlog входящей ветки (decision-76):\n\n${formatRenumberTable(renumber)}\n`;
}

/** Текст плана для человека: таблица замен и число упоминаний по файлам. */
export function describeBacklogRenumber(preview: Pick<BacklogMergePreview, 'renumber' | 'mentions' | 'incoming' | 'target'>): string {
  const files = new Map<string, number>();
  for (const m of preview.mentions) files.set(m.file, (files.get(m.file) ?? 0) + 1);
  const lines = [
    `Numbers from branch ${preview.incoming} collide with numbers already added in ${preview.target}.`,
    `Entries of the target branch stay unchanged; incoming entries get new numbers:`,
    '',
    ...preview.renumber.map((r) => `${r.from} → ${r.to}`),
    '',
    `Mentions of old numbers: ${preview.mentions.length} in ${files.size} files.`,
    ...[...files.entries()].slice(0, 20).map(([file, n]) => `  ${file}: ${n}`)
  ];
  if (files.size > 20) lines.push(`  …and ${files.size - 20} more`);
  return lines.join('\n');
}

/** Тот же план строками словаря карточки HITL (TASK-202.8): окно и телефон показывают его на своём языке. */
export function renumberHitlLines(preview: Pick<BacklogMergePreview, 'renumber' | 'mentions' | 'incoming' | 'target'>): HitlTextLine[] {
  const files = new Map<string, number>();
  for (const m of preview.mentions) files.set(m.file, (files.get(m.file) ?? 0) + 1);
  const text = (value: string): HitlTextLine => ({ code: 'text', params: { text: value } });
  const lines: HitlTextLine[] = [
    { code: 'renumberIntro', params: { incoming: preview.incoming, target: preview.target } },
    { code: 'renumberRule' },
    text(''),
    ...preview.renumber.map((r) => text(`${r.from} → ${r.to}`)),
    text(''),
    { code: 'renumberMentions', params: { count: String(preview.mentions.length), files: String(files.size) } },
    ...[...files.entries()].slice(0, 20).map(([file, n]) => text(`  ${file}: ${n}`))
  ];
  if (files.size > 20) lines.push({ code: 'renumberMore', params: { count: String(files.size - 20) } });
  return lines;
}

export interface RenumberedBranch {
  branch: string;
  commit: string;
}

/**
 * Временная ветка с перенумерованной входящей стороной. Репозиторий и рабочее дерево вызывающего не трогаются:
 * всё делается в отдельном worktree во временном каталоге. Коммит требует настроенных `user.name`/`user.email`.
 */
export async function createRenumberedBranch(
  preview: BacklogMergePreview,
  options: { git?: GitRunner; tmpRoot?: string } = {}
): Promise<RenumberedBranch> {
  if (preview.renumber.length === 0) throw new Error('Nothing to renumber');
  const git = options.git ?? execGit;
  const repo = preview.repoDir;
  const wt = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), 'ph-renumber-'));
  await git(['worktree', 'add', '--detach', wt, preview.incomingSha], { cwd: repo });
  try {
    const ragPrefix = `${preview.projectPrefix}${RAG_INDEX_DIR}`;
    const renamed = new Set(preview.renumber.map((r) => r.from));
    for (const file of await changedByIncoming(git, wt, preview.mergeBase, preview.incomingSha)) {
      const abs = path.join(wt, file);
      if (file.startsWith(ragPrefix)) {
        // Бинарный индекс не переносится: версия merge-base, пересборка — после слияния.
        const atBase = preview.mergeBase
          ? await git(['cat-file', '-e', `${preview.mergeBase}:${file}`], { cwd: wt }).then(() => true, () => false)
          : false;
        if (atBase) await git(['checkout', preview.mergeBase!, '--', file], { cwd: wt });
        else fs.rmSync(abs, { force: true });
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (!isTextBuffer(buf)) continue;
      const original = buf.toString('utf8');
      let text = replaceBacklogIds(original, preview.renumber);

      let target = file;
      if (file.startsWith(preview.backlogPrefix)) {
        const rel = file.slice(preview.backlogPrefix.length);
        const ref = entityFromBacklogPath(rel);
        if (ref && renamed.has(ref.id)) {
          text = markRenumberedFrom(text, ref.id);
          target = preview.backlogPrefix + renameBacklogPath(rel, preview.renumber);
        }
      }
      if (target !== file) {
        fs.mkdirSync(path.dirname(path.join(wt, target)), { recursive: true });
        fs.writeFileSync(path.join(wt, target), text);
        fs.rmSync(abs, { force: true });
      } else if (text !== original) {
        fs.writeFileSync(abs, text);
      }
    }
    await git(['add', '-A'], { cwd: wt });
    const message = `chore(backlog): перенумерация ${preview.incoming} перед слиянием в ${preview.target}\n\n${formatRenumberTable(preview.renumber)}\n`;
    // Хуки проекта (pre-commit шаблона запускает validate-docs через gray-matter) во временном worktree без
    // node_modules падают по причине окружения. Коммит меняет только номера в содержимом, которое уже прошло хуки
    // в своей ветке; коммит слияния в настоящей ветке хуки проходит как обычно.
    await git(['commit', '-q', '--no-verify', '-m', message], { cwd: wt });
    const commit = (await git(['rev-parse', 'HEAD'], { cwd: wt })).trim();
    const branch = `${RENUMBER_BRANCH_PREFIX}${sanitizeRefSegment(preview.incoming)}-${commit.slice(0, 8)}`;
    await git(['branch', '-f', branch, commit], { cwd: repo });
    return { branch, commit };
  } finally {
    await git(['worktree', 'remove', '--force', wt], { cwd: repo }).catch(() => undefined);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

export type PreparedIncoming =
  | { status: 'clean'; mergeRef: string; preview: BacklogMergePreview }
  | { status: 'needs-approval'; preview: BacklogMergePreview }
  | { status: 'renumbered'; mergeRef: string; preview: BacklogMergePreview; branch: RenumberedBranch };

/**
 * Общий шаг всех точек слияния (decision-76 п. 6): без коллизий — сливать как есть; с коллизиями — только с
 * согласия человека (`approved`), иначе вернуть план, чтобы человек его увидел до слияния.
 */
export async function prepareIncomingForMerge(
  repoDir: string,
  incoming: string,
  options: BacklogMergeOptions & { approved?: boolean; tmpRoot?: string } = {}
): Promise<PreparedIncoming> {
  const preview = await previewBacklogMerge(repoDir, incoming, options);
  if (preview.renumber.length === 0) return { status: 'clean', mergeRef: incoming, preview };
  if (!options.approved) return { status: 'needs-approval', preview };
  const branch = await createRenumberedBranch(preview, options);
  return { status: 'renumbered', mergeRef: branch.branch, preview, branch };
}

/** Удалить временную ветку перенумерации после слияния (или отказа от него). */
export async function dropRenumberedBranch(repoDir: string, branch: string, git: GitRunner = execGit): Promise<void> {
  if (!branch.startsWith(RENUMBER_BRANCH_PREFIX)) return;
  await git(['branch', '-D', branch], { cwd: repoDir }).catch(() => undefined);
}

/** Сжатый план для IPC и UI: замены и число упоминаний. */
export interface BacklogRenumberSummary {
  renumber: BacklogRenumbering[];
  mentionCount: number;
  fileCount: number;
  text: string;
  /** План строками карточки HITL (`renumberHitlLines`). */
  lines: HitlTextLine[];
}

export function summarizeRenumber(preview: BacklogMergePreview): BacklogRenumberSummary {
  return {
    renumber: preview.renumber,
    mentionCount: preview.mentions.length,
    fileCount: new Set(preview.mentions.map((m) => m.file)).size,
    text: describeBacklogRenumber(preview),
    lines: renumberHitlLines(preview)
  };
}
