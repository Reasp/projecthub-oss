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
      'Пайплайны CI проекта (GitHub Actions, GitLab CI, Jenkins) по ветке или коммиту: статус, ссылка, упавшие задания. '
      + 'Без ветки и коммита — текущая ветка рабочего дерева агента.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Ветка' },
        sha: { type: 'string', description: 'Коммит' },
        limit: { type: 'number', description: 'Сколько запусков вернуть (по умолчанию 10)' }
      }
    }
  },
  {
    name: 'ci_failed_log',
    description:
      'Хвост лога упавших заданий запуска (до трёх) или одного задания, секреты замаскированы. Провайдер и id запуска — из ci_status.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['github-actions', 'gitlab-ci', 'jenkins'] },
        runId: { type: 'string', description: 'Id запуска из ci_status' },
        jobId: { type: 'string', description: 'Id задания; без него — упавшие задания запуска' }
      },
      required: ['provider', 'runId']
    }
  },
  {
    name: 'ci_rerun',
    description:
      'Перезапустить упавшие задания запуска или запустить ручное задание GitLab (деплой, jobId). Действие во внешнем '
      + 'сервисе: ждёт одобрения человека в ProjectHub. Сначала исправь причину падения.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['github-actions', 'gitlab-ci', 'jenkins'] },
        runId: { type: 'string', description: 'Id запуска из ci_status' },
        jobId: { type: 'string', description: 'Ручное задание GitLab для запуска (деплой); без него — перезапуск упавших' },
        reason: { type: 'string', description: 'Зачем перезапуск: что исправлено' }
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
  queued: 'в очереди',
  running: 'идёт',
  success: 'успех',
  failure: 'упал',
  cancelled: 'отменён',
  skipped: 'пропущен',
  manual: 'ждёт ручного запуска'
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function formatRun(run: CiRun): string {
  return `- [${run.provider}] ${run.name}${run.number ? ` #${run.number}` : ''} (id ${run.id}): ${STATUS_LABELS[run.status] ?? run.status}, ветка ${run.branch || '—'}, коммит ${run.sha.slice(0, 10) || '—'}${run.url ? `, ${run.url}` : ''}`;
}

/** Где человека рядом нет: запись в CI — только с явным разрешением роли. */
function unattended(ctx: ProjectToolContext): boolean {
  return ctx.origin === 'automation' || ctx.origin === 'assigned';
}

export async function callCiTool(name: string, args: Record<string, unknown>, ctx: ProjectToolContext, deps: CiToolDeps): Promise<CiToolResult> {
  if (!isCiToolName(name)) return { text: `Неизвестный инструмент: ${name}`, isError: true };
  const root = findOwningProject(await deps.listProjectRoots(), ctx.sessionPath);
  if (!root) return { text: 'Сессия не привязана к зарегистрированному проекту ProjectHub.', isError: true };

  try {
    if (name === 'ci_status') {
      const sha = str(args.sha);
      const branch = str(args.branch) || (sha ? '' : ((await deps.currentBranch(ctx.sessionPath)) ?? ''));
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
      const res = await deps.listRuns(root, { ...(branch ? { branch } : {}), ...(sha ? { sha } : {}), limit });
      if (!res.providers.length) {
        return { text: 'CI для проекта не настроен: нет подключения к GitHub или GitLab репозитория (или входа gh) и не задано задание Jenkins.', isError: true };
      }
      const lines = [
        `CI: ${res.providers.map((p) => `${p.label} через «${p.via}»`).join(', ')}`,
        `Фильтр: ${branch ? `ветка ${branch}` : ''}${branch && sha ? ', ' : ''}${sha ? `коммит ${sha}` : ''}${!branch && !sha ? 'все ветки' : ''}`,
        `Сводка: ${res.summary ? (STATUS_LABELS[res.summary] ?? res.summary) : 'запусков нет'}`,
        ...res.runs.slice(0, limit).map(formatRun),
        ...res.errors.map((e) => `Ошибка: ${e}`)
      ];
      const failed = res.runs.slice(0, limit).filter((r) => r.status === 'failure');
      if (failed.length) lines.push('Лог упавших заданий: ci_failed_log с provider и runId.');
      return { text: lines.join('\n'), isError: !res.ok };
    }

    const provider = str(args.provider);
    const runId = str(args.runId);
    if (!provider || !runId) return { text: 'Нужны provider и runId из ci_status.', isError: true };

    if (name === 'ci_failed_log') {
      const logs = await deps.failedLogs(root, provider, runId, str(args.jobId) || undefined);
      if (!logs.length) return { text: `В запуске ${runId} нет упавших заданий.`, isError: false };
      const text = logs
        .map((l) => {
          const head = `### ${l.job.name}${l.job.stage ? ` (${l.job.stage})` : ''}: ${STATUS_LABELS[l.job.status] ?? l.job.status}${l.job.failedStep ? `, шаг «${l.job.failedStep}»` : ''}`;
          const cut = l.truncated ? `\n(последние строки из ${l.totalLines})` : '';
          return `${head}${cut}\n\`\`\`\n${l.text}\n\`\`\``;
        })
        .join('\n\n');
      return { text, isError: false };
    }

    // ci_rerun
    const jobId = str(args.jobId);
    const run = await deps.getRun(root, provider, runId);
    const job = jobId ? run.jobs.find((j) => j.id === jobId) : undefined;
    if (jobId && !job) return { text: `Задание ${jobId} не найдено в запуске ${runId}.`, isError: true };
    if (!jobId && !run.jobs.some((j) => j.status === 'failure') && provider !== 'jenkins') {
      return { text: `В запуске ${runId} нечего перезапускать: упавших заданий нет.`, isError: true };
    }
    const action = job ? `запуск ручного задания «${job.name}»` : 'перезапуск упавших заданий';
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
      ...(ctx.role ? { role: ctx.role } : {}),
      tool: name
    };
    if (unattended(ctx) && !ctx.permissions?.allowedTools?.includes('ci_rerun')) {
      deps.recordAutoDecision(info, 'deny', CI_TOOLS_AUDIT_RULE, 'unattended-not-allowed');
      return {
        text: 'Перезапуск CI из Automations и автозапуска разрешён, только если роль явно разрешает ci_rerun. Сообщи человеку, что нужен перезапуск.',
        isError: true
      };
    }
    if (!deps.requestApproval) {
      deps.recordAutoDecision(info, 'deny', CI_TOOLS_AUDIT_RULE, 'no-approver');
      return { text: 'Перезапуск CI требует одобрения человека, а одобрить сейчас некому. Попросите человека перезапустить в ProjectHub.', isError: true };
    }
    const approved = await deps.requestApproval(info).catch(() => false);
    if (!approved) return { text: 'Человек не одобрил перезапуск. Не запускай его другим способом.', isError: true };
    if (job) await deps.playJob(root, provider, job.id);
    else await deps.retry(root, provider, runId);
    return { text: `Готово: ${action}, ${run.url}. Статус — ci_status через минуту-другую.`, isError: false };
  } catch (err) {
    return { text: `Ошибка CI: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
