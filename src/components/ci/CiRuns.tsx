import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Clock, Loader2, PlayCircle, RotateCw, ExternalLink, ChevronDown, ChevronRight, RefreshCw, Workflow } from '../common/icons';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { useDialogStore } from '../../store/useDialogStore';
import type { CiJobLog, CiProviderId, CiRun, CiRunDetail, CiRunsResult, CiStatus, ConnectionView, JenkinsSetting } from '../../types/electron';

const cleanIpcError = ipcErrorText;

const STATUS_CLASS: Record<CiStatus, string> = {
  success: 'text-emerald-400',
  failure: 'text-rose-400',
  running: 'text-amber-400',
  queued: 'text-slate-400',
  manual: 'text-indigo-300',
  cancelled: 'text-slate-500',
  skipped: 'text-slate-500'
};

/** Значок статуса пайплайна или задания CI (TASK-138.3). */
export const CiStatusIcon: React.FC<{ status: CiStatus; label: string; className?: string }> = ({ status, label, className = 'w-3.5 h-3.5' }) => {
  const Icon = status === 'success' ? CheckCircle2 : status === 'failure' ? XCircle : status === 'running' ? Loader2 : status === 'manual' ? PlayCircle : Clock;
  return (
    <span title={label} className="shrink-0 inline-flex">
      <Icon className={`${className} ${STATUS_CLASS[status]} ${status === 'running' ? 'animate-spin' : ''}`} aria-label={label} />
    </span>
  );
};

interface Props {
  projectPath: string;
  branch?: string;
  /** Коммит головы PR: его запуски подсвечиваются. */
  headSha?: string;
}

/**
 * Пайплайны ветки во всех CI проекта (TASK-138.3, decision-109): GitHub Actions, GitLab CI, Jenkins. Задания запуска,
 * хвост лога упавшего задания с замаскированными секретами, перезапуск упавших и запуск ручного задания — после
 * подтверждения человеком. Внизу — задание Jenkins проекта.
 */
export const CiRuns: React.FC<Props> = ({ projectPath, branch, headSha }) => {
  const { t } = useTranslation();
  const confirm = useDialogStore((s) => s.confirm);
  const [result, setResult] = useState<CiRunsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<CiRunDetail | null>(null);
  const [logs, setLogs] = useState<Record<string, CiJobLog | 'loading'>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api.ci
      .runs(projectPath, branch ? { branch } : {})
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) setError(cleanIpcError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, branch, reloadKey]);

  const runKey = (run: CiRun) => `${run.provider}:${run.id}`;
  const providerLabel = (id: CiProviderId) => result?.providers.find((p) => p.id === id)?.label ?? id;

  const toggleRun = useCallback(
    async (run: CiRun) => {
      const key = runKey(run);
      if (open === key) {
        setOpen(null);
        return;
      }
      setOpen(key);
      setDetail(null);
      setLogs({});
      try {
        setDetail(await window.api.ci.run(projectPath, run.provider, run.id));
      } catch (err) {
        setError(cleanIpcError(err));
      }
    },
    [open, projectPath]
  );

  const toggleLog = async (run: CiRunDetail, jobId: string) => {
    if (logs[jobId]) {
      setLogs(({ [jobId]: _drop, ...rest }) => rest);
      return;
    }
    setLogs((l) => ({ ...l, [jobId]: 'loading' }));
    try {
      const [log] = await window.api.ci.logs(projectPath, run.provider, run.id, jobId);
      if (log) setLogs((l) => ({ ...l, [jobId]: log }));
    } catch (err) {
      setLogs(({ [jobId]: _drop, ...rest }) => rest);
      setError(cleanIpcError(err));
    }
  };

  const retry = async (run: CiRunDetail, job?: { id: string; name: string }) => {
    const provider = providerLabel(run.provider);
    const ok = await confirm(
      job
        ? { title: t.ci.playConfirmTitle, message: t.ci.playConfirm.replace('{name}', job.name).replace('{provider}', provider), confirmText: t.ci.play }
        : { title: t.ci.retryConfirmTitle, message: t.ci.retryConfirm.replace('{name}', `${run.name}${run.number ? ` #${run.number}` : ''}`).replace('{provider}', provider), confirmText: t.ci.retry }
    );
    if (!ok) return;
    try {
      await window.api.ci.retry(projectPath, run.provider, run.id, job?.id);
      setNotice(t.ci.started.replace('{provider}', provider));
      setReloadKey((k) => k + 1);
      setOpen(null);
    } catch (err) {
      setError(cleanIpcError(err));
    }
  };

  const statusLabel = (s: CiStatus) => t.ci.status[s];

  return (
    <div className="max-w-3xl space-y-3 text-xs" data-testid="ci-runs">
      <div className="flex items-center gap-2 text-slate-400">
        <Workflow className="w-3.5 h-3.5 text-indigo-400" />
        <span className="font-medium text-slate-300">{result?.providers.map((p) => `${p.label} ${t.ci.via.replace('{via}', p.via)}`).join(' · ') || t.ci.tab}</span>
        {branch && <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-indigo-300">{branch}</span>}
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="ml-auto p-1 rounded text-slate-500 hover:text-slate-200 disabled:opacity-50"
          aria-label="refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="text-rose-300">{t.ci.loadError.replace('{error}', error)}</div>}
      {notice && <div className="text-emerald-300">{notice}</div>}
      {result?.errors.map((e) => (
        <div key={e} className="text-amber-300">
          {t.ci.loadError.replace('{error}', e)}
        </div>
      ))}
      {result && !result.providers.length && <div className="text-slate-400">{t.ci.noProviders}</div>}
      {result && result.providers.length > 0 && !result.runs.length && !loading && <div className="text-slate-500">{t.ci.noRuns}</div>}

      <div className="divide-y divide-slate-800/60 border border-slate-800 rounded-lg overflow-hidden">
        {result?.runs.map((run) => {
          const key = runKey(run);
          const expanded = open === key;
          const current = Boolean(headSha && run.sha && headSha.startsWith(run.sha.slice(0, 7)));
          return (
            <div key={key} className={current ? 'bg-indigo-500/5' : ''} data-testid="ci-run">
              <button type="button" onClick={() => void toggleRun(run)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/40">
                {expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
                <CiStatusIcon status={run.status} label={statusLabel(run.status)} />
                <span className="text-slate-200 font-medium truncate">
                  {run.name}
                  {run.number ? ` #${run.number}` : ''}
                </span>
                <span className="text-slate-500">{statusLabel(run.status)}</span>
                <span className="text-slate-500 font-mono text-[10px]">{run.sha.slice(0, 7)}</span>
                <span className="ml-auto text-slate-500 text-[10px] shrink-0">{providerLabel(run.provider)}</span>
              </button>
              {expanded && (
                <div className="px-8 pb-3 space-y-2">
                  {!detail ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        {detail.url && (
                          <button type="button" onClick={() => void window.api.openExternal(detail.url)} className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            <ExternalLink className="w-3 h-3" />
                            {t.ci.openRun}
                          </button>
                        )}
                        {(detail.jobs.some((j) => j.status === 'failure') || (detail.provider === 'jenkins' && detail.status === 'failure')) && (
                          <button
                            type="button"
                            onClick={() => void retry(detail)}
                            data-testid="ci-retry"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-700 text-slate-200 hover:bg-slate-800"
                          >
                            <RotateCw className="w-3 h-3" />
                            {t.ci.retry}
                          </button>
                        )}
                      </div>
                      {detail.jobs.map((job) => {
                        const log = logs[job.id];
                        return (
                          <div key={job.id} className="space-y-1">
                            <div className="flex items-center gap-2">
                              <CiStatusIcon status={job.status} label={statusLabel(job.status)} className="w-3 h-3" />
                              <span className="text-slate-300">{job.name}</span>
                              {job.stage && <span className="text-slate-500">· {job.stage}</span>}
                              {job.failedStep && <span className="text-rose-300/80 truncate">· {job.failedStep}</span>}
                              <span className="ml-auto flex items-center gap-2 shrink-0">
                                {job.status === 'manual' && detail.provider === 'gitlab-ci' && (
                                  <button type="button" onClick={() => void retry(detail, job)} className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200" data-testid="ci-play">
                                    <PlayCircle className="w-3 h-3" />
                                    {t.ci.play}
                                  </button>
                                )}
                                {(job.status === 'failure' || job.status === 'success') && (
                                  <button type="button" onClick={() => void toggleLog(detail, job.id)} className="text-slate-400 hover:text-slate-200" data-testid="ci-log-toggle">
                                    {log ? t.ci.hideLog : t.ci.log}
                                  </button>
                                )}
                              </span>
                            </div>
                            {log === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
                            {log && log !== 'loading' && (
                              <div className="space-y-1">
                                <div className="text-[10px] text-slate-500">{log.truncated ? t.ci.logTruncated.replace('{total}', String(log.totalLines)) : t.ci.logMasked}</div>
                                <pre className="max-h-80 overflow-auto bg-ph-base border border-slate-800 rounded p-2 font-mono text-[11px] text-slate-300 whitespace-pre-wrap" data-testid="ci-log">
                                  {log.text}
                                </pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <JenkinsSettings projectPath={projectPath} onSaved={() => setReloadKey((k) => k + 1)} />
    </div>
  );
};

/** Задание Jenkins проекта: подключение из слоя подключений и путь задания (TASK-138.3). */
const JenkinsSettings: React.FC<{ projectPath: string; onSaved: () => void }> = ({ projectPath, onSaved }) => {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [setting, setSetting] = useState<JenkinsSetting | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [job, setJob] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.api.connections.list(), window.api.ci.getJenkins(projectPath)]).then(([list, current]) => {
      if (cancelled) return;
      const jenkins = list.filter((c) => c.serviceId === 'jenkins');
      setConnections(jenkins);
      setSetting(current);
      setConnectionId(current?.connectionId ?? jenkins[0]?.id ?? '');
      setJob(current?.job ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const save = async (value: JenkinsSetting | null) => {
    try {
      const saved = await window.api.ci.setJenkins(projectPath, value);
      setSetting(saved);
      setMessage({ ok: true, text: t.ci.jenkinsSaved });
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: cleanIpcError(err) });
    }
  };

  return (
    <div className="border border-slate-800 rounded-lg" data-testid="ci-jenkins">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-slate-400 hover:text-slate-200">
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>{t.ci.jenkinsTitle}</span>
        {setting && <span className="font-mono text-[11px] text-slate-300">{setting.job}</span>}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {!connections.length ? (
            <div className="text-slate-500">{t.ci.jenkinsNoConnection}</div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                aria-label={t.ci.jenkinsConnection}
                className="bg-slate-800/80 border border-slate-700/60 rounded px-1.5 py-1 text-[11px] text-slate-200"
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                value={job}
                onChange={(e) => setJob(e.target.value)}
                placeholder="folder/app"
                aria-label={t.ci.jenkinsJob}
                data-testid="ci-jenkins-job"
                className="flex-1 min-w-[160px] bg-slate-800/80 border border-slate-700/60 rounded px-2 py-1 font-mono text-[11px] text-slate-200"
              />
              <button
                type="button"
                onClick={() => void save({ connectionId, job })}
                disabled={!connectionId || !job.trim()}
                className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
              >
                {t.ci.jenkinsSave}
              </button>
              {setting && (
                <button type="button" onClick={() => void save(null)} className="px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:text-white">
                  {t.ci.jenkinsRemove}
                </button>
              )}
            </div>
          )}
          <div className="text-[10px] text-slate-500">{t.ci.jenkinsHint}</div>
          {message && <div className={message.ok ? 'text-emerald-300' : 'text-rose-300'}>{message.text}</div>}
        </div>
      )}
    </div>
  );
};
