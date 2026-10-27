/**
 * Действия человека над ветками документации (TASK-194, decision-151): окно ProjectHub (IPC `docs:branches:*`) и
 * телефон (RPC `doc_branches`, `doc_branch_diff`, `doc_branch_merge`, `doc_branch_close`) идут одним путём —
 * решение пишется в аудит HITL с источником, событие уходит в шину.
 */
import { appEventBus } from './eventBus';
import { hitlService } from './hitlService';
import {
  closeDocBranch,
  diffDocBranch,
  listDocBranches,
  mergeDocBranch,
  type DocBranchDiff,
  type DocBranchMergeResult,
  type DocBranchMeta,
  type DocBranchResolutions
} from './docBranches';
import type { HitlDecisionSource } from './hitlTypes';
import type { RemoteDocBranchDiff } from '../../src/types/remote';

export const DOC_BRANCH_MERGE_RULE = 'doc-branch-merge';

export interface DocBranchSummary extends DocBranchMeta {
  docs: Array<{ docId: string; title: string; path: string; change: 'added' | 'modified' | 'removed'; conflicts: number }>;
  conflicts: number;
}

export interface DocBranchesOverview {
  /** Проект в git-репозитории: без него веток нет. */
  available: boolean;
  branches: DocBranchSummary[];
}

function sourceLabel(source: HitlDecisionSource): string {
  if (source.kind === 'remote') return source.deviceName ? `human (${source.deviceName})` : 'human (device)';
  return 'human (ProjectHub)';
}

export function summarize(diff: DocBranchDiff): DocBranchSummary {
  const docs = diff.files.map((f) => ({ docId: f.docId, title: f.title, path: f.path, change: f.change, conflicts: f.conflicts.length }));
  return { ...diff.branch, docs, conflicts: docs.reduce((n, d) => n + d.conflicts, 0) };
}

/** Открытые и предложенные ветки с изменёнными документами. */
export async function docBranchesOverview(projectPath: string): Promise<DocBranchesOverview> {
  let branches: DocBranchMeta[];
  try {
    branches = await listDocBranches(projectPath);
  } catch {
    return { available: false, branches: [] };
  }
  const out: DocBranchSummary[] = [];
  for (const meta of branches) {
    try {
      out.push(summarize(await diffDocBranch(projectPath, meta.id)));
    } catch {
      out.push({ ...meta, docs: [], conflicts: 0 });
    }
  }
  return { available: true, branches: out };
}

/**
 * Дифф ветки для телефона: без текстов базы и ветки — только то, что изменится в основной, и конфликты разделов.
 * Тексты конфликтов обрезаются: экран телефона показывает начало раздела, решение — кнопкой стороны.
 */
export function remoteDocBranchDiff(diff: DocBranchDiff): RemoteDocBranchDiff {
  const clip = (s: string | null) => (s === null ? null : s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s);
  return {
    branch: { id: diff.branch.id, title: diff.branch.title, status: diff.branch.status, ...(diff.branch.author ? { author: diff.branch.author } : {}), ...(diff.branch.proposal ? { proposal: diff.branch.proposal } : {}) },
    files: diff.files.map((f) => ({
      path: f.path,
      docId: f.docId,
      title: f.title,
      change: f.change,
      parts: f.parts.map((p) => p.label),
      mainChanged: f.mainChanged,
      ...(f.renumberedFrom ? { renumberedFrom: f.renumberedFrom } : {}),
      conflicts: f.conflicts.map((c) => ({ key: c.key, label: c.label, ours: clip(c.ours), theirs: clip(c.theirs) })),
      main: f.main,
      merged: f.merged
    }))
  };
}

export async function mergeDocBranchAsHuman(
  projectPath: string,
  branchId: string,
  options: { docs?: string[]; resolutions?: DocBranchResolutions },
  source: HitlDecisionSource
): Promise<DocBranchMergeResult> {
  const result = await mergeDocBranch(projectPath, branchId, { ...options, by: sourceLabel(source) });
  if (result.status === 'merged' || result.status === 'partial') {
    hitlService.recordHumanDecision(
      {
        sessionId: source.kind === 'remote' ? `remote-${source.deviceId ?? 'device'}` : 'ui',
        projectPath,
        type: 'file_write',
        title: `Documentation branch accepted: ${branchId}${result.status === 'partial' ? ' (some documents)' : ''}`,
        tool: 'doc_branch_merge',
        ...(result.written[0] ? { filePath: result.written[0] } : {}),
        ...(result.branch.author ? { agentName: result.branch.author } : {})
      },
      'allow',
      source,
      DOC_BRANCH_MERGE_RULE,
      [...result.written, ...result.removed].join(', ')
    );
    appEventBus.publish({ type: 'docs:branchChanged', projectPath, branchId, event: 'merged', title: result.branch.title, at: Date.now() });
  }
  return result;
}

export async function closeDocBranchAsHuman(projectPath: string, branchId: string, source: HitlDecisionSource): Promise<DocBranchMeta> {
  const meta = await closeDocBranch(projectPath, branchId);
  hitlService.recordHumanDecision(
    {
      sessionId: source.kind === 'remote' ? `remote-${source.deviceId ?? 'device'}` : 'ui',
      projectPath,
      type: 'file_write',
      title: `Documentation branch rejected: ${branchId}`,
      tool: 'doc_branch_close',
      ...(meta.author ? { agentName: meta.author } : {})
    },
    'deny',
    source,
    DOC_BRANCH_MERGE_RULE,
    meta.title
  );
  appEventBus.publish({ type: 'docs:branchChanged', projectPath, branchId, event: 'closed', title: meta.title, at: Date.now() });
  return meta;
}
