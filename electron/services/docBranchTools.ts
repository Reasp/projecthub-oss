/**
 * Инструменты веток документации для агентов во встроенном MCP ProjectHub (TASK-194, decision-151):
 * `doc_branch_open/list/diff/resolve/propose/merge/close`. Правки в ветке — `doc_create`/`doc_update` с `branch`
 * (`projectAgentTools.ts`). Модуль чистый: git, HITL и аудит внедряются.
 */
import {
  closeDocBranch,
  diffDocBranch,
  listDocBranches,
  mergeDocBranch,
  openDocBranch,
  proposeDocBranch,
  resolveDocBranch,
  type DocBranchConflict,
  type DocBranchDiff,
  type DocBranchEnv,
  type DocBranchMeta,
  type DocBranchResolutions
} from './docBranches.js';
import type { DocResolution } from './docSectionMerge.js';
import type { HitlTextLine } from './hitlTypes.js';
import { keyedHitlText } from './hitlText.js';
import type { ProjectToolContext, ProjectToolDeps, ProjectToolResult } from './projectAgentTools.js';

export const DOC_BRANCH_TOOL_NAMES = [
  'doc_branch_open',
  'doc_branch_list',
  'doc_branch_diff',
  'doc_branch_resolve',
  'doc_branch_propose',
  'doc_branch_merge',
  'doc_branch_close'
] as const;
export type DocBranchToolName = (typeof DOC_BRANCH_TOOL_NAMES)[number];

export function isDocBranchToolName(name: string): name is DocBranchToolName {
  return (DOC_BRANCH_TOOL_NAMES as readonly string[]).includes(name);
}

export type DocBranchEvent = 'opened' | 'updated' | 'synced' | 'proposed' | 'merged' | 'closed';

export interface DocBranchChange {
  projectPath: string;
  branchId: string;
  event: DocBranchEvent;
  title?: string;
  author?: string;
}

type Audit = (decision: 'allow' | 'deny', title: string, filePath?: string, detail?: string) => string;

interface Scope {
  root: string;
  ctx: ProjectToolContext;
  deps: ProjectToolDeps;
  audit: Audit;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const CONFLICT_TEXT_LIMIT = 2500;

const STATUS_LABEL: Record<DocBranchMeta['status'], string> = {
  open: 'open',
  proposed: 'proposed for merge',
  merged: 'merged',
  closed: 'closed'
};

function clip(text: string | null): string {
  if (text === null) return '(none: removed or never existed)';
  const t = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return t.length > CONFLICT_TEXT_LIMIT ? `${t.slice(0, CONFLICT_TEXT_LIMIT)}\n… (truncated)` : t || '(empty)';
}

/** Автор ветки для списка и карточек: имя агента, роль или источник сессии. */
export function branchAuthor(ctx: ProjectToolContext): string {
  return ctx.agentName || ctx.role || (ctx.origin === 'terminal' ? 'terminal agent' : ctx.origin);
}

/** Решения конфликтов из аргумента инструмента: `[{doc, key, take, text}]`. */
export function parseResolutions(raw: unknown): DocBranchResolutions {
  const out: DocBranchResolutions = {};
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const doc = str(r.doc).trim();
    const key = str(r.key).trim();
    const take = str(r.take).trim();
    if (!doc || !key) continue;
    let resolution: DocResolution | null = null;
    if (take === 'ours' || take === 'theirs' || take === 'both') resolution = take;
    else if (take === 'text') resolution = { text: str(r.text) };
    if (!resolution) continue;
    (out[doc] ??= {})[key] = resolution;
  }
  return out;
}

export function formatBranchLine(b: DocBranchMeta): string {
  const extra = [b.author ? `author: ${b.author}` : '', b.task ? b.task : ''].filter(Boolean).join(', ');
  return `${b.id} "${b.title}" — ${STATUS_LABEL[b.status]}${extra ? ` (${extra})` : ''}`;
}

export function formatConflicts(conflicts: DocBranchConflict[]): string {
  return conflicts
    .map((c) =>
      [
        `### ${c.doc} — ${c.label}`,
        `key: ${c.key}`,
        '--- base (before branching) ---',
        clip(c.base),
        '--- main (ours) ---',
        clip(c.ours),
        '--- branch (theirs) ---',
        clip(c.theirs)
      ].join('\n')
    )
    .join('\n\n');
}

export function formatDiff(diff: DocBranchDiff, full = false): string {
  const head = `${formatBranchLine(diff.branch)}${diff.branch.proposal ? `\nProposal: ${diff.branch.proposal}` : ''}`;
  if (diff.files.length === 0) return `${head}\nNo changes relative to main.`;
  const lines = [head, `Documents: ${diff.files.length}`];
  for (const f of diff.files) {
    const what = f.change === 'added' ? 'new' : f.change === 'removed' ? 'removed' : 'modified';
    const parts = f.parts.map((p) => `${p.scope === 'frontmatter' ? 'field ' : ''}${p.label}${p.change === 'added' ? ' (+)' : p.change === 'removed' ? ' (−)' : ''}`);
    const notes = [
      f.renumberedFrom ? `number ${f.renumberedFrom} is taken in main → ${f.docId}` : '',
      f.mainChanged ? 'main changed too' : '',
      f.conflicts.length ? `conflicts: ${f.conflicts.length}` : ''
    ].filter(Boolean);
    lines.push(`- ${f.docId} "${f.title}" — ${what}${parts.length ? `: ${parts.join('; ')}` : ''}${notes.length ? ` [${notes.join('; ')}]` : ''}`);
    if (full && f.branch !== null && f.change !== 'removed') lines.push('', clip(f.branch), '');
  }
  const conflicts = diff.files.flatMap((f) => f.conflicts.map((c) => ({ ...c, doc: f.docId, path: f.path })));
  if (conflicts.length) {
    lines.push('', 'Conflicts: resolve them with doc_branch_resolve and resolutions:', '', formatConflicts(conflicts));
  }
  return lines.join('\n');
}

/** Изменения ветки строками карточки HITL (TASK-202.8): вид изменения и пометки — кодом словаря. */
export function docMergeHitlLines(diff: DocBranchDiff, files: DocBranchDiff['files']): HitlTextLine[] {
  const mark = (change: string) => (change === 'added' ? ' (+)' : change === 'removed' ? ' (−)' : '');
  const lines: HitlTextLine[] = [];
  if (diff.branch.proposal) lines.push({ code: 'docProposal', params: { text: diff.branch.proposal } });
  lines.push({ code: 'docCount', params: { count: String(files.length) } });
  for (const f of files) {
    const change = f.change === 'added' || f.change === 'removed' ? f.change : 'modified';
    lines.push({ code: 'docFile', params: { doc: f.docId, title: f.title, change: { code: `docChange.${change}` } } });
    if (f.parts.length) {
      const parts = f.parts.map((p) => ({ code: p.scope === 'frontmatter' ? 'docField' : 'docPart', params: { label: p.label, mark: mark(p.change) } }));
      lines.push({ code: 'docParts', params: { parts } });
    }
    const notes: HitlTextLine[] = [
      ...(f.renumberedFrom ? [{ code: 'docRenumbered', params: { from: f.renumberedFrom, to: f.docId } }] : []),
      ...(f.mainChanged ? [{ code: 'docMainChanged' }] : []),
      ...(f.conflicts.length ? [{ code: 'docConflicts', params: { count: String(f.conflicts.length) } }] : [])
    ];
    if (notes.length) lines.push({ code: 'docNotes', params: { notes } });
  }
  return lines;
}

/** `doc_list` с `branch`: документы, изменённые в ветке. */
export async function listBranchDocs(root: string, branch: string, env?: DocBranchEnv): Promise<ProjectToolResult> {
  const diff = await diffDocBranch(root, branch, env);
  if (diff.files.length === 0) return { text: `Branch ${diff.branch.id} has no changed documents: all others are as in main.`, isError: false };
  return {
    text: [
      ...diff.files.map((f) => `${f.docId} — ${f.title} (${f.change === 'added' ? 'new' : f.change === 'removed' ? 'removed' : 'modified'})`),
      '',
      'All other documents in the branch are as in main at the time of branching.'
    ].join('\n'),
    isError: false
  };
}

async function approveMerge(scope: Scope, diff: DocBranchDiff, docs: string[]): Promise<{ ok: true } | { ok: false; text: string }> {
  const { ctx, deps, root } = scope;
  const mode = ctx.permissions?.docMerge ?? 'ask';
  if (mode === 'deny') return { ok: false, text: 'The role is not allowed to merge documentation branches (permissions.docMerge: deny). Propose a merge instead: doc_branch_propose.' };
  if (mode === 'allow') return { ok: true };
  if (!deps.requestApproval) {
    return { ok: false, text: 'Only a human can merge the branch: propose a merge (doc_branch_propose), and they will merge it in ProjectHub or on the phone.' };
  }
  const selected = docs.length ? diff.files.filter((f) => docs.some((d) => d.toLowerCase() === f.docId.toLowerCase())) : diff.files;
  const approved = await deps
    .requestApproval({
      sessionId: ctx.sessionId,
      projectPath: root,
      type: 'file_write',
      ...keyedHitlText({ code: 'doc_merge', params: { id: diff.branch.id, title: diff.branch.title }, lines: docMergeHitlLines(diff, selected) }),
      origin: ctx.origin,
      engine: ctx.engine,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
      ...(ctx.role ? { role: ctx.role } : {}),
      tool: 'doc_branch_merge'
    })
    .catch(() => false);
  return approved ? { ok: true } : { ok: false, text: 'The human did not merge the branch; main is unchanged.' };
}

export async function callDocBranchTool(name: DocBranchToolName, args: Record<string, unknown>, scope: Scope): Promise<ProjectToolResult> {
  const { root, ctx, deps, audit } = scope;
  const env = deps.docBranchEnv;
  const branch = str(args.branch).trim();
  const notify = (branchId: string, event: DocBranchEvent, meta?: DocBranchMeta) =>
    deps.onDocBranchChanged?.({ projectPath: root, branchId, event, ...(meta ? { title: meta.title, ...(meta.author ? { author: meta.author } : {}) } : {}) });
  if (name !== 'doc_branch_open' && name !== 'doc_branch_list' && !branch) return { text: 'No branch given (branch): db-N from doc_branch_list.', isError: true };

  switch (name) {
    case 'doc_branch_open': {
      const meta = await openDocBranch(
        root,
        { title: str(args.title), author: branchAuthor(ctx), sessionId: ctx.sessionId, ...(str(args.task).trim() ? { task: str(args.task).trim() } : {}) },
        env
      );
      audit('allow', `doc_branch_open: ${meta.id}`, undefined, meta.title);
      notify(meta.id, 'opened', meta);
      return {
        text: `Opened branch ${meta.id} "${meta.title}". Edit documents with doc_create/doc_update and branch: "${meta.id}", `
          + `review the changes with doc_branch_diff, then propose a merge with doc_branch_propose.`,
        isError: false
      };
    }

    case 'doc_branch_list': {
      const list = await listDocBranches(root, { all: args.all === true }, env);
      if (list.length === 0) return { text: 'No documentation branches.', isError: false };
      return { text: list.map(formatBranchLine).join('\n'), isError: false };
    }

    case 'doc_branch_diff':
      return { text: formatDiff(await diffDocBranch(root, branch, env), args.full === true), isError: false };

    case 'doc_branch_resolve': {
      const result = await resolveDocBranch(root, branch, parseResolutions(args.resolutions), env);
      if (result.status === 'conflict') {
        return {
          text: `Conflicts: ${result.conflicts.length}. The branch is unchanged. Repeat doc_branch_resolve with resolutions by key:\n\n${formatConflicts(result.conflicts)}`,
          isError: false
        };
      }
      if (result.status === 'up-to-date') return { text: `Branch ${branch} already contains main: nothing to pull in.`, isError: false };
      audit('allow', `doc_branch_resolve: ${branch}`, undefined, 'synced');
      notify(branch, 'synced', result.branch);
      return { text: `Main pulled into ${branch}: the branch base is now the current main, no conflicts.`, isError: false };
    }

    case 'doc_branch_propose': {
      const diff = await proposeDocBranch(root, branch, str(args.message), env);
      audit('allow', `doc_branch_propose: ${branch}`, undefined, `${diff.files.length} docs`);
      notify(branch, 'proposed', diff.branch);
      const conflicts = diff.files.reduce((n, f) => n + f.conflicts.length, 0);
      return {
        text: `Branch ${branch} proposed for merge (${diff.files.length} docs). The human will see it in ProjectHub and on the phone.`
          + (conflicts ? ` There are conflicts with main (${conflicts}); better resolve them in advance: doc_branch_resolve.` : ''),
        isError: false
      };
    }

    case 'doc_branch_merge': {
      const docs = Array.isArray(args.docs) ? args.docs.map(str).map((s) => s.trim()).filter(Boolean) : [];
      const resolutions = parseResolutions(args.resolutions);
      const diff = await diffDocBranch(root, branch, env);
      if (diff.branch.status === 'merged' || diff.branch.status === 'closed') return { text: `Branch ${branch} is already ${STATUS_LABEL[diff.branch.status]}.`, isError: true };
      const approval = await approveMerge(scope, diff, docs);
      if (!approval.ok) {
        audit('deny', `doc_branch_merge: ${branch}`, undefined, ctx.permissions?.docMerge ?? 'ask');
        return { text: approval.text, isError: true };
      }
      const result = await mergeDocBranch(root, branch, { ...(docs.length ? { docs } : {}), resolutions, by: branchAuthor(ctx) }, env);
      if (result.status === 'conflict') {
        return { text: `Merge stopped: ${result.conflicts.length} conflicts, main is unchanged.\n\n${formatConflicts(result.conflicts)}`, isError: false };
      }
      if (result.status === 'nothing') return { text: `Nothing to merge in branch ${branch}.`, isError: false };
      audit('allow', `doc_branch_merge: ${branch}`, result.written[0], [...result.written, ...result.removed].join(', '));
      notify(branch, 'merged', result.branch);
      const renumbered = result.renumbered.length ? ` Renumbered: ${result.renumbered.map((r) => `${r.from} → ${r.to}`).join(', ')}.` : '';
      return {
        text: `${result.status === 'merged' ? `Branch ${branch} merged in full` : `Documents merged from branch ${branch}`}: `
          + `${[...result.written, ...result.removed.map((p) => `${p} (removed)`)].join(', ') || 'files already matched'}.${renumbered} `
          + 'Files are written to backlog/ without a commit.',
        isError: false
      };
    }

    case 'doc_branch_close': {
      const meta = await closeDocBranch(root, branch, env);
      audit('allow', `doc_branch_close: ${branch}`, undefined, meta.title);
      notify(branch, 'closed', meta);
      return { text: `Branch ${branch} closed without merging.`, isError: false };
    }
  }
}
