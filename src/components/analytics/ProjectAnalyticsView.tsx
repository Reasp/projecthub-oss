import React from 'react';
import {
  BarChart2,
  Tag,
  Target,
  Database,
  Activity,
  User
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import {
  countStatuses,
  resolveDoneStatus,
  statusLabel,
  statusVisual,
  OTHER_STATUS_VISUAL
} from '../../utils/taskStatus';
import { useTranslation } from '../../i18n/useTranslation';

export const ProjectAnalyticsView: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProject,
    tasks,
    milestones,
    gitLogs,
    gitRepoDetails,
    backlogConfig
  } = useProjectStore();

  if (!selectedProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
        <BarChart2 className="w-12 h-12 text-indigo-400/40 mb-3" />
        <h3 className="text-sm font-semibold text-white mb-1">{t.header.selectProjectHint}</h3>
        <p className="text-xs text-slate-400 max-w-sm">
          {t.analytics.selectProjectToView}
        </p>
      </div>
    );
  }

  // Task Statistics
  const totalTasks = tasks.length;
  // Метрики считаются по набору статусов проекта (TASK-68, decision-24): «завершено» —
  // это Done, если он есть в конфиге, иначе последний статус. Задачи со статусом вне
  // конфига попадают в агрегат «прочие», но всегда учитываются в общем количестве.
  const statuses = backlogConfig.statuses;
  const statusCounts = countStatuses(statuses, tasks.map((task) => task.status));
  const doneStatus = resolveDoneStatus(statuses);
  const doneTasks = doneStatus ? statusCounts.byStatus[doneStatus] || 0 : 0;
  const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const statusRows = [
    ...[...statuses].reverse().map((status) => ({
      key: status,
      label: statusLabel(status, t.kanban),
      count: statusCounts.byStatus[status] || 0,
      visual: statusVisual(status)
    })),
    ...(statusCounts.other > 0
      ? [
          {
            key: '__other__',
            label: t.kanban.otherStatuses,
            count: statusCounts.other,
            visual: OTHER_STATUS_VISUAL
          }
        ]
      : [])
  ];

  // Acceptance Criteria Statistics
  let totalCriteria = 0;
  let completedCriteria = 0;
  for (const t of tasks) {
    if (t.acceptanceCriteria) {
      totalCriteria += t.acceptanceCriteria.length;
      completedCriteria += t.acceptanceCriteria.filter((c) => c.completed).length;
    }
  }
  const criteriaRate = totalCriteria > 0 ? Math.round((completedCriteria / totalCriteria) * 100) : 0;

  // Label Frequency
  const labelCounts: Record<string, number> = {};
  for (const t of tasks) {
    if (t.labels) {
      for (const l of t.labels) {
        labelCounts[l] = (labelCounts[l] || 0) + 1;
      }
    }
  }
  const sortedLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Git Authors Statistics
  const authorCounts: Record<string, number> = {};
  for (const c of gitLogs) {
    const author = c.author_name || t.analytics.unknownAuthor;
    authorCounts[author] = (authorCounts[author] || 0) + 1;
  }
  const sortedAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]);

  // Milestone Stats
  const completedMilestones = milestones.filter((m) => m.status === 'Completed').length;
  const milestoneProgressRate = milestones.length > 0 ? Math.round((completedMilestones / milestones.length) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-ph-panel text-xs">
      {/* Заголовок вида — как у остальных вкладок (decision-73) */}
      <div className="h-11 px-4 flex items-center gap-3 border-b border-ph-line shrink-0">
        <h1 className="text-[13px] font-medium text-slate-100">{t.analytics.title}</h1>
        <span className="text-xs text-slate-500 truncate">{t.analytics.subtitle}</span>
      </div>

      <div className="p-4 space-y-4">
      {/*
        Ключевые показатели одной строкой с разделителями, без «плиток» с цветными цифрами и иконками:
        цвет у полоски прогресса, цифры нейтральные.
      */}
      <div className="grid grid-cols-2 lg:grid-cols-4 rounded-lg border border-ph-line bg-ph-elevated divide-x divide-ph-line">
        {[
          {
            label: t.analytics.taskCompletionRate,
            value: `${completionRate}%`,
            detail: `${doneTasks} / ${totalTasks} ${t.kanban.done.toLowerCase()}`,
            bar: completionRate
          },
          {
            label: t.analytics.criteriaCompleted,
            value: `${criteriaRate}%`,
            detail: `${completedCriteria} / ${totalCriteria} ${t.kanban.criteriaCount}`,
            bar: criteriaRate
          },
          {
            label: t.analytics.tasksByMilestone,
            value: `${completedMilestones} / ${milestones.length}`,
            detail: `${milestoneProgressRate}%`,
            bar: milestoneProgressRate
          },
          {
            label: t.analytics.gitActivity,
            value: String(gitLogs.length),
            detail: `${gitRepoDetails?.currentBranch || 'main'} · ${
              gitRepoDetails?.isClean
                ? t.header.statusClean
                : t.header.statusChanges.replace('{count}', String(gitRepoDetails?.files.length ?? 0))
            }`,
            bar: null as number | null
          }
        ].map((kpi) => (
          <div key={kpi.label} className="px-4 py-3 min-w-0">
            <div className="text-[11px] text-slate-400 truncate">{kpi.label}</div>
            <div className="mt-1 flex items-baseline gap-2 min-w-0">
              <span className="text-xl font-semibold text-slate-100 tabular-nums">{kpi.value}</span>
              <span className="text-[11px] text-slate-500 truncate">{kpi.detail}</span>
            </div>
            {kpi.bar !== null && (
              <div className="w-full h-1 rounded-full bg-ph-raised mt-2 overflow-hidden">
                <div className="h-full bg-emerald-500/80 rounded-full" style={{ width: `${kpi.bar}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Main Grid: Status Breakdown, Tags, Git Contributors, RAG, Milestones */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 1. Task Status Breakdown */}
        <div className="p-4 rounded-lg bg-ph-elevated border border-ph-line flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-xs font-medium text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-slate-500" />
              {t.analytics.tasksByStatus}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">{t.common.all}: {totalTasks}</span>
          </div>

          <div className="space-y-3.5">
            {statusRows.map((row) => (
              <div key={row.key}>
                <div className="flex justify-between text-[11px] mb-1.5">
                  <span className={`${row.visual.chartText} font-medium flex items-center gap-1.5`}>
                    <span className={`w-2.5 h-2.5 rounded-full ${row.visual.chartDot} inline-block shadow-sm`} />{' '}
                    {row.label}
                  </span>
                  <span className="font-mono text-slate-300">
                    {row.count} ({totalTasks > 0 ? Math.round((row.count / totalTasks) * 100) : 0}%)
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full ${row.visual.chartBar} transition-all duration-500`}
                    style={{ width: `${totalTasks > 0 ? (row.count / totalTasks) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 2. Popular Tags */}
        <div className="p-4 rounded-lg bg-ph-elevated border border-ph-line flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-xs font-medium text-white flex items-center gap-2">
              <Tag className="w-4 h-4 text-slate-500" />
              {t.analytics.tasksByTag}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">{Object.keys(labelCounts).length} tags</span>
          </div>

          {sortedLabels.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 italic py-6">
              {t.kanban.noTasks}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {sortedLabels.map(([label, count]) => {
                const pct = totalTasks > 0 ? Math.round((count / totalTasks) * 100) : 0;
                return (
                  <div
                    key={label}
                    className="flex items-center justify-between px-2.5 py-2 rounded-md hover:bg-ph-hover/60 text-[11px]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-slate-200 truncate">
                        {label}
                      </span>
                      <span className="text-slate-400 truncate">{count}</span>
                    </div>
                    <span className="font-mono text-slate-500 font-medium shrink-0 ml-2">{pct}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. Git Authors / Contributors */}
        <div className="p-4 rounded-lg bg-ph-elevated border border-ph-line flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-xs font-medium text-white flex items-center gap-2">
              <User className="w-4 h-4 text-slate-500" />
              {t.analytics.topContributors}
            </h3>
            <span className="text-[11px] font-mono text-slate-400">{sortedAuthors.length}</span>
          </div>

          {sortedAuthors.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 italic py-6">
              {t.git.noChanges}
            </div>
          ) : (
            <div className="space-y-2.5">
              {sortedAuthors.map(([author, count]) => (
                <div
                  key={author}
                  className="flex items-center justify-between px-2.5 py-2 rounded-md hover:bg-ph-hover/60 text-[11px]"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-sm">
                      {author.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-slate-200 font-semibold">{author}</div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {Math.round((count / (gitLogs.length || 1)) * 100)}%
                      </div>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 font-mono text-[11px] font-semibold border border-slate-700/60">
                    {count} commits
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 4. RAG Knowledge Base Stats */}
        <div className="p-4 rounded-lg bg-ph-elevated border border-ph-line flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-xs font-medium text-white flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-500" />
              {t.rag.title}
            </h3>
            <span
              className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                selectedProject.ragStatus?.ready
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                  : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              }`}
            >
              {selectedProject.ragStatus?.ready ? t.rag.ready : t.rag.notIndexed}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">
            <div className="px-2.5 py-2 rounded-md hover:bg-ph-hover/60 flex flex-col justify-between">
              <span className="text-slate-400 text-[11px]">{t.rag.chunksCount}</span>
              <span className="text-lg font-semibold text-slate-100 tabular-nums mt-0.5">
                {selectedProject.ragStatus?.chunksCount ?? '—'}
              </span>
            </div>

            <div className="px-2.5 py-2 rounded-md hover:bg-ph-hover/60 flex flex-col justify-between">
              <span className="text-slate-400 text-[11px]">Model</span>
              <span className="text-xs font-mono text-slate-300 truncate mt-0.5" title={selectedProject.ragStatus?.model || 'BAAI/bge-small-en-v1.5'}>
                {selectedProject.ragStatus?.model || 'bge-small-en-v1.5'}
              </span>
            </div>

            <div className="px-2.5 py-2 rounded-md hover:bg-ph-hover/60 flex flex-col justify-between sm:col-span-2">
              <span className="text-slate-400 text-[11px]">{t.rag.lastIndexed}</span>
              <span className="text-xs font-mono text-slate-300 mt-1">
                {selectedProject.ragStatus?.builtAt || t.rag.notIndexed}
              </span>
            </div>
          </div>
        </div>

        {/* 5. Milestones Progress Breakdown */}
        {milestones.length > 0 && (
          <div className="p-4 rounded-lg bg-ph-elevated border border-ph-line flex flex-col gap-3 lg:col-span-2">
            <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
              <h3 className="text-xs font-medium text-white flex items-center gap-2">
                <Target className="w-4 h-4 text-slate-500" />
                {t.milestones.title}
              </h3>
              <span className="text-[11px] font-mono text-slate-400">
                {completedMilestones} / {milestones.length}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {milestones.map((m) => {
                const milestoneTasks = tasks.filter((t) => t.milestone === m.id);
                const doneMTasks = milestoneTasks.filter((t) => t.status === 'Done').length;
                const mPct = milestoneTasks.length > 0 ? Math.round((doneMTasks / milestoneTasks.length) * 100) : (m.status === 'Completed' ? 100 : 0);

                return (
                  <div key={m.id} className="p-3.5 rounded-xl bg-ph-elevated border border-slate-800/80 flex flex-col justify-between gap-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-semibold text-white truncate">{m.title}</h4>
                        <span className="text-[11px] text-slate-400 font-mono">ID: {m.id}</span>
                      </div>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border shrink-0 ${
                          m.status === 'Completed'
                            ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                            : 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20'
                        }`}
                      >
                        {m.status}
                      </span>
                    </div>

                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-mono">
                        <span>{doneMTasks}/{milestoneTasks.length}</span>
                        <span>{mPct}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            m.status === 'Completed' ? 'bg-emerald-500' : 'bg-indigo-500'
                          }`}
                          style={{ width: `${mPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};
