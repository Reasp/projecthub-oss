import type { HitlEngine, HitlLineParam, HitlOrigin, HitlRequest, HitlTextLine } from './hitlTypes.js';
import { keyedHitlText } from './hitlText.js';
import type { TrackerRunSummary, TrackerSyncStatusView } from './trackerTypes.js';
import { findOwningProject } from './pathGuard.js';

/**
 * Инструменты синка трекера во встроенном MCP ProjectHub (TASK-128, decision-103 п. 8). Чтение — свободно,
 * запись во внешний сервис (`tracker_sync_run`) — только после одобрения человека (HITL).
 */

export const TRACKER_TOOL_NAMES = ['tracker_sync_status', 'tracker_sync_preview', 'tracker_sync_run'] as const;
export type TrackerToolName = (typeof TRACKER_TOOL_NAMES)[number];

export function isTrackerToolName(name: string): name is TrackerToolName {
  return (TRACKER_TOOL_NAMES as readonly string[]).includes(name);
}

export const TRACKER_TOOLS_AUDIT_RULE = 'tracker-sync';

export const TRACKER_TOOL_DEFINITIONS: ReadonlyArray<{ name: TrackerToolName; description: string; input_schema: Record<string, unknown> }> = [
  {
    name: 'tracker_sync_status',
    description:
      'Синхронизация задач проекта с внешним трекером (ClickUp): включена ли, какой список, соответствие статусов, '
      + 'сколько задач связано, итог последнего запуска.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'tracker_sync_preview',
    description:
      'План синхронизации без записи: какие задачи будут импортированы, выгружены, какие поля уйдут в трекер или придут '
      + 'из него, конфликты и статусы без соответствия. Вызывай перед tracker_sync_run.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'tracker_sync_run',
    description:
      'Выполнить синхронизацию: записать изменения в трекер и в backlog/. Пишет во внешний сервис, поэтому ждёт '
      + 'одобрения человека в ProjectHub.',
    input_schema: { type: 'object', properties: {} }
  }
];

export interface TrackerToolContext {
  sessionPath: string;
  sessionId: string;
  origin: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
}

export interface TrackerToolDeps {
  listProjectRoots(): Promise<string[]>;
  getStatus(projectPath: string): Promise<TrackerSyncStatusView>;
  preview(projectPath: string): Promise<TrackerRunSummary>;
  run(projectPath: string): Promise<TrackerRunSummary>;
  recordAutoDecision(info: Omit<HitlRequest, 'id' | 'createdAt'>, decision: 'allow' | 'deny', rule: string, detail?: string): string;
  /** Карточка HITL; без неё запуск отклоняется — спросить некого. */
  requestApproval?(request: Omit<HitlRequest, 'id' | 'createdAt'>): Promise<boolean>;
}

export interface TrackerToolResult {
  text: string;
  isError: boolean;
}

const KIND_LABELS: Record<string, string> = {
  import: 'импорт из трекера',
  export: 'выгрузка в трекер',
  push: 'изменения в трекер',
  pull: 'изменения в backlog',
  conflict: 'конфликты',
  missingRemote: 'нет в трекере',
  missingLocal: 'нет в проекте',
  unmappedStatus: 'статус без соответствия',
  error: 'ошибки'
};

/** Текст итога для модели и для карточки HITL. */
export function formatRunSummary(summary: TrackerRunSummary, limit = 40): string {
  const head = summary.ok ? (summary.dryRun ? 'План синхронизации' : 'Синхронизация выполнена') : `Не выполнено: ${summary.error ?? 'ошибки в журнале'}`;
  const counts = Object.entries(summary.counts)
    .map(([k, v]) => `${KIND_LABELS[k] ?? k}: ${v}`)
    .join(', ');
  const lines = summary.entries.slice(0, limit).map((e) => {
    const who = [e.taskId, e.externalId ? `#${e.externalId}` : ''].filter(Boolean).join(' ');
    const fields = e.fields?.length ? ` [${e.fields.join(', ')}]` : '';
    return `- ${KIND_LABELS[e.kind] ?? e.kind}: ${who}${e.title ? ` «${e.title}»` : ''}${fields}${e.detail ? ` — ${e.detail}` : ''}`;
  });
  const more = summary.entries.length > limit ? [`… ещё ${summary.entries.length - limit}`] : [];
  return [head, counts || 'изменений нет', ...lines, ...more].join('\n');
}

/** План синхронизации строками карточки HITL (TASK-202.8): виды записей — кодом словаря, данные задач как есть. */
export function trackerHitlLines(summary: TrackerRunSummary, limit = 40): HitlTextLine[] {
  const kind = (k: string): HitlLineParam => (k in KIND_LABELS ? { code: `trackerKind.${k}` } : k);
  const counts = Object.entries(summary.counts).map(([k, v]) => ({ code: 'trackerCount', params: { kind: kind(k), count: String(v) } }));
  const entries = summary.entries.slice(0, limit).map((e) => {
    const who = [e.taskId, e.externalId ? `#${e.externalId}` : ''].filter(Boolean).join(' ');
    const fields = e.fields?.length ? ` [${e.fields.join(', ')}]` : '';
    return { code: 'trackerEntry', params: { kind: kind(e.kind), rest: `${who}${e.title ? ` «${e.title}»` : ''}${fields}${e.detail ? ` — ${e.detail}` : ''}` } };
  });
  return [
    counts.length ? { code: 'trackerCounts', params: { list: counts } } : { code: 'trackerNoChanges' },
    ...entries,
    ...(summary.entries.length > limit ? [{ code: 'trackerMore', params: { count: String(summary.entries.length - limit) } }] : [])
  ];
}

/** Есть ли в плане запись в трекер или в проект. */
function hasChanges(summary: TrackerRunSummary): boolean {
  return ['import', 'export', 'push', 'pull'].some((k) => (summary.counts as Record<string, number>)[k]);
}

export async function callTrackerTool(name: string, _args: Record<string, unknown>, ctx: TrackerToolContext, deps: TrackerToolDeps): Promise<TrackerToolResult> {
  if (!isTrackerToolName(name)) return { text: `Неизвестный инструмент: ${name}`, isError: true };
  const root = findOwningProject(await deps.listProjectRoots(), ctx.sessionPath);
  if (!root) return { text: 'Сессия не привязана к зарегистрированному проекту ProjectHub.', isError: true };

  try {
    if (name === 'tracker_sync_status') {
      const s = await deps.getStatus(root);
      return {
        text: JSON.stringify(
          {
            enabled: s.config.enabled,
            tracker: s.config.adapter,
            target: s.config.target,
            statusMap: s.config.statusMap,
            conflictPolicy: s.config.conflictPolicy,
            exportLabel: s.config.exportLabel || null,
            connectionSelected: Boolean(s.connectionId),
            intervalMinutes: s.intervalMinutes,
            linkedTasks: s.linkedTasks,
            running: s.running,
            lastRun: s.lastRun ? formatRunSummary(s.lastRun, 15) : null
          },
          null,
          2
        ),
        isError: false
      };
    }

    const plan = await deps.preview(root);
    if (name === 'tracker_sync_preview') return { text: formatRunSummary(plan), isError: !plan.ok };
    if (!plan.ok) return { text: formatRunSummary(plan), isError: true };
    if (!hasChanges(plan)) return { text: `${formatRunSummary(plan)}\nЗаписывать нечего.`, isError: false };

    const info = {
      sessionId: ctx.sessionId,
      projectPath: root,
      type: 'command' as const,
      ...keyedHitlText({ code: 'tracker_sync', lines: trackerHitlLines(plan, 25) }),
      command: 'tracker_sync_run',
      origin: ctx.origin,
      engine: ctx.engine,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
      ...(ctx.role ? { role: ctx.role } : {}),
      tool: name
    };
    if (!deps.requestApproval) {
      deps.recordAutoDecision(info, 'deny', TRACKER_TOOLS_AUDIT_RULE, 'no-approver');
      return { text: 'Синхронизация пишет во внешний сервис и требует одобрения человека, а одобрить сейчас некому. Попросите человека нажать «Синхронизировать» в ProjectHub.', isError: true };
    }
    const approved = await deps.requestApproval(info).catch(() => false);
    if (!approved) return { text: 'Человек не одобрил синхронизацию. Не запускай её другим способом.', isError: true };
    const result = await deps.run(root);
    return { text: formatRunSummary(result), isError: !result.ok };
  } catch (err) {
    return { text: `Ошибка синхронизации: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
