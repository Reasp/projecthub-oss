import { findOwningProject } from './pathGuard.js';
import type { HitlRequest } from './hitlTypes.js';
import { keyedHitlText } from './hitlText.js';
import type { ProjectToolContext } from './projectAgentTools.js';
import type { CiJobLog, CiRunsResult } from './ciService.js';
import type { CiRun, CiRunDetail } from './ciProviders.js';

/**
 * Инструменты CI/CD во встроенном MCP ProjectHub (TASK-138.3, decision-109). Чтение — свободно: статус пайплайнов и
 * хвост лога упавшего задания с замаскированными секретами, чтобы агент чинил падение в цикле «до готовности».
 * Перезапуск и ручной запуск задания (деплой) — записывающие действия: только после одобрения человека (HITL).
 * В Automations и при автозапуске назначенных задач — только если роль явно разрешает `ci_rerun` в `allowedTools`.
 */

export const CI_TOOL_NAMES = ['ci_status', 'ci_failed_log', 'ci_rerun'] as const;
export type CiToolName = (typeof CI_TOOL_NAMES)[number];

export function isCiToolName(name: string): name is CiToolName {
  return (CI_TOOL_NAMES as readonly string[]).includes(name);
}

export const CI_TOOLS_AUDIT_RULE = 'ci';

export const CI_TOOL_DEFINITIONS: ReadonlyArray<{ name: CiToolName; description: string; input_schema: Record<string, unknown> }> = [
  {
    name: 'ci_status',
    description:
      'Project CI pipelines (GitHub Actions, GitLab CI, Jenkins) for a branch or commit: status, link, failed jobs. '
      + 'Without a branch or commit, the current branch of the agent\'s working tree is used.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch' },
        sha: { type: 'string', description: 'Commit' },
        limit: { type: 'number', description: 'How many runs to return (default 10)' }
      }
    }
  },
  {
    name: 'ci_failed_log',
    description:
      'Log tail of a run\'s failed jobs (up to three) or of a single job, with secrets masked. Take the provider and run id from ci_status.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['github-actions', 'gitlab-ci', 'jenkins'] },
        runId: { type: 'string', description: 'Run id from ci_status' },
        jobId: { type: 'string', description: 'Job id; without it, the run\'s failed jobs' }
      },
      required: ['provider', 'runId']
    }
  },
  {
    name: 'ci_rerun',
    description:
      'Rerun a run\'s failed jobs or start a manual GitLab job (deploy, jobId). This acts on an external '
      + 'service, so it waits for human approval in ProjectHub. Fix the cause of the failure first.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['github-actions', 'gitlab-ci', 'jenkins'] },
        runId: { type: 'string', description: 'Run id from ci_status' },
        jobId: { type: 'string', description: 'Manual GitLab job to start (deploy); without it, failed jobs are rerun' },
        reason: { type: 'string', description: 'Why rerun: what was fixed' }
      },
      required: ['provider', 'runId']
    }
  }
];

export interface CiToolDeps {
  listProjectRoots(): Promise<string[]>;
  listRuns(projectPath: string, filter: { branch?: string; sha?: string; limit?: number }): Promise<CiRunsResult>;
  getRun(projectPath: string, provider: string, runId: string): Promise<CiRunDetail>;
  failedLogs(projectPath: string, provider: string, runId: string, jobId?: string): Promise<CiJobLog[]>;
  retry(projectPath: string, provider: string, runId: string): Promise<void>;
  playJob(projectPath: string, provider: string, jobId: string): Promise<void>;
  describeTarget(projectPath: string, provider: string): Promise<string>;
  /** Текущая ветка рабочего дерева сессии; нет git — `null`. */
  currentBranch(sessionPath: string): Promise<string | null>;
  recordAutoDecision(info: Omit<HitlRequest, 'id' | 'createdAt'>, decision: 'allow' | 'deny', rule: string, detail?: string): string;
  /** Карточка HITL; без неё запись отклоняется — спросить некого. */
  requestApproval?(request: Omit<HitlRequest, 'id' | 'createdAt'>): Promise<boolean>;
}

export interface CiToolResult {
  text: string;
  isError: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  success: 'success',
  failure: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  manual: 'waiting for manual start'
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function formatRun(run: CiRun): string {
  return `- [${run.provider}] ${run.name}${run.number ? ` #${run.number}` : ''} (id ${run.id}): ${STATUS_LABELS[run.status] ?? run.status}, branch ${run.branch || '—'}, commit ${run.sha.slice(0, 10) || '—'}${run.url ? `, ${run.url}` : ''}`;
}

/** Где человека рядом нет: запись в CI — только с явным разрешением роли. */
function unattended(ctx: ProjectToolContext): boolean {
  return ctx.origin === 'automation' || ctx.origin === 'assigned';
}

export async function callCiTool(name: string, args: Record<string, unknown>, ctx: ProjectToolContext, deps: CiToolDeps): Promise<CiToolResult> {
  if (!isCiToolName(name)) return { text: `Unknown tool: ${name}`, isError: true };
  const root = findOwningProject(await deps.listProjectRoots(), ctx.sessionPath);
  if (!root) return { text: 'The session is not linked to a registered ProjectHub project.', isError: true };

  try {
    if (name === 'ci_status') {
      const sha = str(args.sha);
      const branch = str(args.branch) || (sha ? '' : ((await deps.currentBranch(ctx.sessionPath)) ?? ''));
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
      const res = await deps.listRuns(root, { ...(branch ? { branch } : {}), ...(sha ? { sha } : {}), limit });
      if (!res.providers.length) {
        return { text: 'CI is not configured for the project: no GitHub or GitLab repository connection (or gh login) and no Jenkins job set.', isError: true };
      }
      const lines = [
        `CI: ${res.providers.map((p) => `${p.label} via "${p.via}"`).join(', ')}`,
        `Filter: ${branch ? `branch ${branch}` : ''}${branch && sha ? ', ' : ''}${sha ? `commit ${sha}` : ''}${!branch && !sha ? 'all branches' : ''}`,
        `Summary: ${res.summary ? (STATUS_LABELS[res.summary] ?? res.summary) : 'no runs'}`,
        ...res.runs.slice(0, limit).map(formatRun),
        ...res.errors.map((e) => `Error: ${e}`)
      ];
      const failed = res.runs.slice(0, limit).filter((r) => r.status === 'failure');
      if (failed.length) lines.push('Failed job logs: ci_failed_log with provider and runId.');
      return { text: lines.join('\n'), isError: !res.ok };
    }

    const provider = str(args.provider);
    const runId = str(args.runId);
    if (!provider || !runId) return { text: 'provider and runId from ci_status are required.', isError: true };

    if (name === 'ci_failed_log') {
      const logs = await deps.failedLogs(root, provider, runId, str(args.jobId) || undefined);
      if (!logs.length) return { text: `Run ${runId} has no failed jobs.`, isError: false };
      const text = logs
        .map((l) => {
          const head = `### ${l.job.name}${l.job.stage ? ` (${l.job.stage})` : ''}: ${STATUS_LABELS[l.job.status] ?? l.job.status}${l.job.failedStep ? `, step "${l.job.failedStep}"` : ''}`;
          const cut = l.truncated ? `\n(last lines of ${l.totalLines})` : '';
          return `${head}${cut}\n\`\`\`\n${l.text}\n\`\`\``;
        })
        .join('\n\n');
      return { text, isError: false };
    }

    // ci_rerun
    const jobId = str(args.jobId);
    const run = await deps.getRun(root, provider, runId);
    const job = jobId ? run.jobs.find((j) => j.id === jobId) : undefined;
    if (jobId && !job) return { text: `Job ${jobId} not found in run ${runId}.`, isError: true };
    if (!jobId && !run.jobs.some((j) => j.status === 'failure') && provider !== 'jenkins') {
      return { text: `Nothing to rerun in run ${runId}: no failed jobs.`, isError: true };
    }
    const action = job ? `started manual job "${job.name}"` : 'reran failed jobs';
    const where = await deps.describeTarget(root, provider);
    const info = {
      sessionId: ctx.sessionId,
      projectPath: root,
      type: 'command' as const,
      ...keyedHitlText({
        code: job ? 'ci_play' : 'ci_rerun',
        ...(job ? { params: { job: job.name } } : {}),
        lines: [
          { code: 'ciRun', params: { run: `${run.name}${run.number ? ` #${run.number}` : ''}`, branch: run.branch || '—', url: run.url } },
          ...(where ? [{ code: 'text', params: { text: where } }] : []),
          ...(str(args.reason) ? [{ code: 'ciReason', params: { reason: str(args.reason) } }] : [])
        ]
      }),
      command: `ci_rerun ${provider} ${runId}${jobId ? ` ${jobId}` : ''}`,
      origin: ctx.origin,
      engine: ctx.engine,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
      ...(ctx.memberId ? { memberId: ctx.memberId } : {}),
      ...(ctx.role ? { role: ctx.role } : {}),
      tool: name
    };
    if (unattended(ctx) && !ctx.permissions?.allowedTools?.includes('ci_rerun')) {
      deps.recordAutoDecision(info, 'deny', CI_TOOLS_AUDIT_RULE, 'unattended-not-allowed');
      return {
        text: 'CI reruns from Automations and auto-start are allowed only if the role explicitly allows ci_rerun. Tell the human a rerun is needed.',
        isError: true
      };
    }
    if (!deps.requestApproval) {
      deps.recordAutoDecision(info, 'deny', CI_TOOLS_AUDIT_RULE, 'no-approver');
      return { text: 'A CI rerun requires human approval, and no one is available to approve right now. Ask the human to rerun it in ProjectHub.', isError: true };
    }
    const approved = await deps.requestApproval(info).catch(() => false);
    if (!approved) return { text: 'The human did not approve the rerun. Do not run it another way.', isError: true };
    if (job) await deps.playJob(root, provider, job.id);
    else await deps.retry(root, provider, runId);
    return { text: `Done: ${action}, ${run.url}. Check the status with ci_status in a minute or two.`, isError: false };
  } catch (err) {
    return { text: `CI error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
