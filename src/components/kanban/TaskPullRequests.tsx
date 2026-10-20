import React, { useEffect, useState } from 'react';
import { GitPullRequest, Check, XCircle, CheckCircle2, Clock, ExternalLink, RefreshCw } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { CiStatusIcon } from '../ci/CiRuns';
import type { CiRunsResult, PullRequest, TaskPullRequestsResult } from '../../types/electron';

interface Props {
  projectPath: string;
  taskId: string;
}

/**
 * PR задачи в карточке (TASK-138.2, decision-105): ссылки из `references` и PR с номером задачи в ветке
 * или заголовке, со статусом хостинга. Без подключения и `gh` main сеть не трогает и вернёт пустой список.
 */
export const TaskPullRequests: React.FC<Props> = ({ projectPath, taskId }) => {
  const { t } = useTranslation();
  const [result, setResult] = useState<TaskPullRequestsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!window.api?.getTaskPullRequests) return;
    let cancelled = false;
    setLoading(true);
    window.api
      .getTaskPullRequests(projectPath, taskId)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) setResult({ ok: false, prs: [], unresolved: [], error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, taskId, reloadKey]);

  // CI (TASK-138.3): ветки открытых PR и ветка задачи из поля `branch`, без повторов.
  const ciBranches = result
    ? [...new Set([...result.prs.filter((p) => p.state === 'OPEN' && p.sourceBranch).map((p) => p.sourceBranch), ...(result.branch ? [result.branch] : [])])].slice(0, 3)
    : [];

  if (!result || (!result.prs.length && !result.unresolved.length && !result.error && !ciBranches.length)) return null;

  const stateBadge = (pr: PullRequest) => {
    const cls =
      pr.state === 'MERGED'
        ? 'bg-purple-500/10 text-purple-300 border-purple-500/30'
        : pr.state === 'CLOSED'
          ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
          : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30';
    const Icon = pr.state === 'MERGED' ? Check : pr.state === 'CLOSED' ? XCircle : GitPullRequest;
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${cls}`}>
        <Icon className="w-3 h-3" />
        {pr.state === 'OPEN' && pr.draft ? t.prs.draftBadge : pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : 'Open'}
      </span>
    );
  };

  const checks = (pr: PullRequest) => {
    const [Icon, cls, label] =
      pr.checksStatus === 'SUCCESS'
        ? [CheckCircle2, 'text-emerald-400', t.pr.allChecksPassed]
        : pr.checksStatus === 'FAILURE'
          ? [XCircle, 'text-rose-400', t.pr.checksFailed]
          : pr.checksStatus === 'PENDING'
            ? [Clock, 'text-amber-400', t.pr.checksRunning]
            : [null, '', ''];
    if (!Icon) return null;
    return (
      <span title={label} className="shrink-0">
        <Icon className={`w-3 h-3 ${cls}`} aria-label={label} />
      </span>
    );
  };

  const review = (pr: PullRequest) => {
    if (pr.state !== 'OPEN' || !pr.reviewDecision) return null;
    const label = pr.reviewDecision === 'APPROVED' ? t.prs.reviewApproved : pr.reviewDecision === 'CHANGES_REQUESTED' ? t.prs.reviewChanges : t.prs.reviewRequired;
    const cls = pr.reviewDecision === 'APPROVED' ? 'text-emerald-300' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'text-rose-300' : 'text-amber-300';
    return <span className={`text-[10px] ${cls}`}>{label}</span>;
  };

  return (
    <div className="flex flex-col gap-1 text-[11px] shrink-0" data-testid="task-pull-requests">
      <div className="flex items-center gap-2 text-slate-400">
        <GitPullRequest className="w-3 h-3 text-indigo-400" />
        <span className="font-medium">{t.prs.taskPrsTitle}</span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          title={t.pr.refresh}
          className="p-0.5 rounded text-slate-500 hover:text-slate-200 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {result.prs.map((pr) => (
        <button
          key={`${pr.provider}-${pr.number}`}
          type="button"
          onClick={() => pr.url && void window.api.openExternal(pr.url)}
          title={pr.url}
          className="flex items-center gap-2 text-left px-2 py-1 rounded-md hover:bg-slate-800/50 min-w-0"
        >
          {stateBadge(pr)}
          <span className="font-mono text-slate-400 shrink-0">#{pr.number}</span>
          <span className="text-slate-200 truncate min-w-0 flex-1">{pr.title}</span>
          {checks(pr)}
          {review(pr)}
          <ExternalLink className="w-3 h-3 text-slate-500 shrink-0" />
        </button>
      ))}
      {result.unresolved.map((url) => (
        <button
          key={url}
          type="button"
          onClick={() => void window.api.openExternal(url)}
          className="flex items-center gap-1 px-2 text-indigo-400 hover:text-indigo-300 hover:underline truncate text-left"
          title={url}
        >
          <ExternalLink className="w-3 h-3 shrink-0" />
          <span className="truncate">{url}</span>
        </button>
      ))}
      {result.error && <span className="px-2 text-amber-300/80">{t.prs.taskPrsUnresolved.replace('{error}', result.error)}</span>}
      {ciBranches.map((branch) => (
        <TaskCiLine key={`${branch}-${reloadKey}`} projectPath={projectPath} branch={branch} />
      ))}
    </div>
  );
};

/** Последний пайплайн ветки задачи: сводный статус и ссылка (TASK-138.3). Без CI проекта строки нет. */
const TaskCiLine: React.FC<{ projectPath: string; branch: string }> = ({ projectPath, branch }) => {
  const { t } = useTranslation();
  const [res, setRes] = useState<CiRunsResult | null>(null);

  useEffect(() => {
    if (!window.api?.ci) return;
    let cancelled = false;
    window.api.ci
      .runs(projectPath, { branch, limit: 5 })
      .then((r) => {
        if (!cancelled) setRes(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath, branch]);

  const latest = res?.runs[0];
  if (!res || !latest || !res.summary) return null;
  return (
    <button
      type="button"
      onClick={() => latest.url && void window.api.openExternal(latest.url)}
      title={latest.url}
      data-testid="task-ci-line"
      className="flex items-center gap-2 text-left px-2 py-1 rounded-md hover:bg-slate-800/50 min-w-0"
    >
      <CiStatusIcon status={res.summary} label={t.ci.status[res.summary]} className="w-3 h-3" />
      <span className="text-slate-400 shrink-0">{t.ci.taskTitle}</span>
      <span className="font-mono text-indigo-300 truncate">{branch}</span>
      <span className="text-slate-300 truncate min-w-0 flex-1">
        {latest.name}
        {latest.number ? ` #${latest.number}` : ''} · {t.ci.status[res.summary]}
      </span>
      <ExternalLink className="w-3 h-3 text-slate-500 shrink-0" />
    </button>
  );
};
