import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Bot, Loader2, Square, Terminal, Workflow } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { studioCliText } from '../../i18n/studioCliText';
import type { CliBackgroundSnapshot, CliBackgroundTask } from '../../types/electron';

/** Как часто обновлять открытый вывод идущей задачи. */
const OUTPUT_POLL_MS = 2000;

type OutputState = { text: string; truncated: boolean; totalBytes: number } | 'unavailable';

const KIND_ICON: Record<CliBackgroundTask['kind'], React.FC<{ className?: string }>> = {
  shell: Terminal,
  agent: Bot,
  mcp: Activity,
  workflow: Workflow,
  other: Activity
};

const STATUS_CLASS: Record<CliBackgroundTask['status'], string> = {
  running: 'text-sky-300',
  completed: 'text-emerald-300',
  failed: 'text-rose-300',
  stopped: 'text-slate-400'
};

/**
 * Фоновые задачи Claude Code идущего хода вкладки (TASK-290, decision-211): что держит ход после ответа модели,
 * хвост вывода каждой задачи и остановка — запросами `get_task_output`/`stop_task` в stdin хода.
 */
export const BackgroundTasksBar: React.FC<{ sessionId: string; snapshot: CliBackgroundSnapshot | undefined }> = ({ sessionId, snapshot }) => {
  const language = useProjectStore((s) => s.language);
  const c = studioCliText(language);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputState | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [stopError, setStopError] = useState<string | null>(null);

  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot]);
  const openTask = openTaskId ? tasks.find((t) => t.taskId === openTaskId) : undefined;
  const openRunning = openTask?.status === 'running';

  const loadOutput = useCallback(
    async (taskId: string) => {
      const res = await window.api.cliBackgroundTaskOutput(sessionId, taskId).catch(() => null);
      setOutput(res ? { text: res.output, truncated: res.truncated, totalBytes: res.totalBytes } : 'unavailable');
    },
    [sessionId]
  );

  // Открытый вывод идущей задачи обновляется, закончившейся — читается последний раз.
  useEffect(() => {
    if (!openTaskId) return;
    void loadOutput(openTaskId);
    if (!openRunning) return;
    const timer = window.setInterval(() => void loadOutput(openTaskId), OUTPUT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [openTaskId, openRunning, loadOutput]);

  // Новый ход вкладки — новый список задач: открытый вывод прошлого хода не показывается.
  useEffect(() => {
    if (openTaskId && !tasks.some((t) => t.taskId === openTaskId)) {
      setOpenTaskId(null);
      setOutput(null);
    }
  }, [openTaskId, tasks]);

  const stop = async (taskIds: string[]) => {
    setStopError(null);
    setStopping((s) => ({ ...s, ...Object.fromEntries(taskIds.map((id) => [id, true])) }));
    const results = await Promise.all(taskIds.map((id) => window.api.stopCliBackgroundTask(sessionId, id).catch(() => false)));
    setStopping((s) => {
      const next = { ...s };
      for (const id of taskIds) delete next[id];
      return next;
    });
    if (results.some((ok) => !ok)) setStopError(c.bgStopFailed);
  };

  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.status === 'running');

  return (
    <div className="mx-4 mt-2 rounded-md border border-slate-600/50 bg-slate-800/60 px-3 py-2 text-xs" data-testid="studio-background-tasks">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-slate-300 font-medium">
          {running.length > 0 ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
          {c.bgTitle} ({running.length}/{tasks.length})
        </span>
        {running.length > 1 && (
          <button
            type="button"
            className="ph-btn ph-btn-ghost h-6 px-1.5 ml-auto text-rose-300"
            onClick={() => void stop(running.map((t) => t.taskId))}
            data-testid="studio-background-stop-all"
          >
            <Square className="w-3 h-3" />
            {c.bgStopAll}
          </button>
        )}
      </div>
      {snapshot?.waiting && (
        <p className="mt-1 text-amber-200/90" data-testid="studio-background-waiting">
          {c.bgWaiting}
        </p>
      )}
      <ul className="mt-1.5 space-y-1">
        {tasks.map((task) => {
          const Icon = KIND_ICON[task.kind];
          const isOpen = openTaskId === task.taskId;
          return (
            <li key={task.taskId} data-testid="studio-background-task" data-status={task.status}>
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                <span className="shrink-0 text-slate-400">{c.bgKind[task.kind]}</span>
                <span className="min-w-0 truncate text-slate-200" title={task.summary ?? task.description}>
                  {task.description}
                </span>
                <span className={`shrink-0 ${STATUS_CLASS[task.status]}`}>{c.bgStatus[task.status]}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {task.kind !== 'agent' && (
                    <button
                      type="button"
                      className="ph-btn ph-btn-ghost h-6 px-1.5"
                      onClick={() => {
                        setOutput(null);
                        setOpenTaskId(isOpen ? null : task.taskId);
                      }}
                      data-testid="studio-background-output"
                    >
                      {isOpen ? c.bgHideOutput : c.bgShowOutput}
                    </button>
                  )}
                  {task.status === 'running' && (
                    <button
                      type="button"
                      className="ph-btn ph-btn-ghost h-6 px-1.5 text-rose-300"
                      disabled={!!stopping[task.taskId]}
                      onClick={() => void stop([task.taskId])}
                      title={c.bgStop}
                      data-testid="studio-background-stop"
                    >
                      {stopping[task.taskId] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                      {c.bgStop}
                    </button>
                  )}
                </span>
              </div>
              {isOpen && (
                <div className="mt-1 ml-5">
                  {output === 'unavailable' ? (
                    <p className="text-slate-400">{c.bgOutputUnavailable}</p>
                  ) : output && output.text ? (
                    <>
                      {output.truncated && <p className="text-slate-500">{c.bgOutputTruncated(Math.ceil(output.totalBytes / 1024))}</p>}
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900/80 p-2 font-mono text-[11px] text-slate-300" data-testid="studio-background-output-text">
                        {output.text}
                      </pre>
                    </>
                  ) : output ? (
                    <p className="text-slate-400">{c.bgOutputEmpty}</p>
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {stopError && <p className="mt-1 text-rose-300">{stopError}</p>}
    </div>
  );
};
