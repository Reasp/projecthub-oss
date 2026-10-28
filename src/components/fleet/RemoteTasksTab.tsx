import React, { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Loader2, Plus, Search, Square, X } from '../common/icons';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { criteriaProgress, groupTasksByStatus } from '../../utils/remoteTaskBoard';
import { taskStatusOptions } from '../../utils/remoteProject';
import { parseTaskBody } from '../../../electron/services/backlogTaskFormat';
import type { DocRefNavigation } from '../../hooks/useDocRefs';
import type { RemoteTaskSummary } from '../../types/remote';
import type { RemoteCall } from './RemoteProjectView';

/** Вкладка «Задачи» проекта удалённого ПК (TASK-229): доска по статусам и карточка задачи справа. */

function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const PRIORITY_DOT: Record<string, string> = { high: 'bg-rose-400', medium: 'bg-amber-400', low: 'bg-slate-500' };

interface Props {
  host: string;
  tasks: RemoteTaskSummary[] | null;
  error: string | null;
  canWrite: boolean;
  call: RemoteCall;
  reloadTasks: () => Promise<void>;
  reloadTick: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  refs: DocRefNavigation;
}

export const RemoteTasksTab: React.FC<Props> = ({ host, tasks, error, canWrite, call, reloadTasks, reloadTick, selectedId, onSelect, refs }) => {
  const { t } = useTranslation();
  const tt = t.fleet.project.tasks;
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const columns = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = tasks ?? [];
    return groupTasksByStatus(q ? list.filter((x) => x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)) : list);
  }, [tasks, filter]);
  const selected = tasks?.find((x) => x.id === selectedId) ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await reloadTasks();
      return true;
    } catch (err) {
      setActionError(ipcErrorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!title.trim()) return;
    const ok = await run(() => call('create_task', { title: title.trim(), description }));
    if (ok) {
      setTitle('');
      setDescription('');
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-3 py-2 flex items-center gap-2 shrink-0">
          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={tt.filter}
              className="w-full h-7 pl-7 pr-2 rounded-md bg-ph-raised text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="h-7 px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs text-white flex items-center gap-1"
              data-testid="remote-task-new"
            >
              <Plus className="w-3.5 h-3.5" /> {tt.newTask}
            </button>
          )}
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />}
          {actionError && <span className="text-[11px] text-rose-300 truncate">{fmt(tt.actionError, { error: actionError })}</span>}
        </div>

        {creating && (
          <div className="mx-3 mb-2 p-2 rounded-md border border-ph-line bg-ph-raised/50 space-y-2 shrink-0">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder={tt.titlePlaceholder}
              className="w-full h-7 px-2 rounded bg-ph-panel text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder={tt.descriptionPlaceholder}
              className="w-full resize-y px-2 py-1 rounded bg-ph-panel text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="h-7 px-2.5 rounded-md bg-ph-raised hover:bg-ph-hover text-xs text-slate-200">
                {tt.cancel}
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !title.trim()}
                className="h-7 px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs text-white"
              >
                {tt.create}
              </button>
            </div>
          </div>
        )}

        {error && <div className="px-3 text-xs text-rose-300">{fmt(t.fleet.project.loadError, { error })}</div>}
        {!tasks && !error && <Loader2 className="mx-3 w-4 h-4 animate-spin text-slate-500" />}
        {tasks && tasks.length === 0 && <div className="px-3 text-xs text-slate-500">{tt.empty}</div>}

        {tasks && tasks.length > 0 && (
          <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto px-3 pb-3">
            {columns.map((col) => (
              <div key={col.status} className="w-64 shrink-0 flex flex-col min-h-0 rounded-md bg-ph-raised/40" data-testid={`remote-task-column-${col.status}`}>
                <div className="h-8 px-2 flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium text-slate-200 truncate flex-1">{col.status}</span>
                  <span className="text-[10px] text-slate-500 tabular-nums">{col.tasks.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-1.5 space-y-1.5">
                  {col.tasks.map((task) => {
                    const progress = criteriaProgress(task);
                    return (
                      <button
                        key={task.filePath || task.id}
                        type="button"
                        onClick={() => onSelect(task.id)}
                        className={`w-full text-left rounded-md px-2 py-1.5 border ${
                          task.id === selectedId ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-ph-line bg-ph-panel hover:bg-ph-hover'
                        }`}
                        data-testid={`remote-task-${task.id}`}
                      >
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                          <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[String(task.priority).toLowerCase()] ?? PRIORITY_DOT.medium}`} />
                          <span className="truncate">{task.id}</span>
                          {progress.total > 0 && (
                            <span className="ml-auto tabular-nums">
                              {progress.done}/{progress.total}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-100 line-clamp-3 break-words">{task.title}</div>
                        {task.assignee && task.assignee.length > 0 && <div className="mt-0.5 text-[10px] text-slate-500 truncate">{task.assignee.join(', ')}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <RemoteTaskCard
          key={selected.filePath}
          host={host}
          task={selected}
          canWrite={canWrite}
          busy={busy}
          call={call}
          run={run}
          reloadTick={reloadTick}
          onClose={() => onSelect(null)}
          refs={refs}
        />
      )}
    </div>
  );
};

interface CardProps {
  host: string;
  task: RemoteTaskSummary;
  canWrite: boolean;
  busy: boolean;
  call: RemoteCall;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  reloadTick: number;
  onClose: () => void;
  refs: DocRefNavigation;
}

const RemoteTaskCard: React.FC<CardProps> = ({ host, task, canWrite, busy, call, run, reloadTick, onClose, refs }) => {
  const { t } = useTranslation();
  const tt = t.fleet.project.tasks;
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const filePath = task.filePath;

  // Текст задачи — отдельным RPC: в списке хост отдаёт только заголовки и критерии.
  useEffect(() => {
    let cancelled = false;
    call<{ content: string }>('get_task', { filePath })
      .then((res) => {
        if (cancelled) return;
        setBody(parseTaskBody(String(res?.content ?? '').replace(/\r\n/g, '\n')).description);
        setBodyError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = ipcErrorText(err);
        setBodyError(/Unknown RPC method/i.test(message) ? fmt(tt.bodyUnsupported, { host }) : fmt(t.fleet.project.loadError, { error: message }));
      });
    return () => {
      cancelled = true;
    };
  }, [call, filePath, reloadTick, host, tt.bodyUnsupported, t.fleet.project.loadError]);

  return (
    <div className="w-[420px] shrink-0 border-l border-ph-line flex flex-col min-h-0" data-testid="remote-task-card">
      <div className="px-3 py-2 flex items-start gap-2 border-b border-ph-line shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-slate-500">{task.id}</div>
          <div className="text-sm text-slate-100 break-words">{task.title}</div>
        </div>
        <button type="button" onClick={onClose} className="ph-icon-button" title={t.fleet.project.close} aria-label={t.fleet.project.close}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-center text-xs">
          <span className="text-slate-500">{tt.status}</span>
          {canWrite ? (
            <select
              value={task.status}
              disabled={busy}
              onChange={(e) => void run(() => call('update_task_status', { filePath, newStatus: e.target.value }))}
              className="h-7 px-1.5 rounded bg-ph-raised text-xs text-slate-100 focus:outline-none"
              data-testid="remote-task-status"
            >
              {taskStatusOptions(task.status).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-slate-200">{task.status}</span>
          )}
          <span className="text-slate-500">{tt.priority}</span>
          <span className="text-slate-200">{task.priority}</span>
          {task.assignee && task.assignee.length > 0 && (
            <>
              <span className="text-slate-500">{tt.assignee}</span>
              <span className="text-slate-200 break-all">{task.assignee.join(', ')}</span>
            </>
          )}
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{tt.criteria}</div>
          {task.criteria.length === 0 && <div className="text-xs text-slate-500">{tt.noCriteria}</div>}
          <div className="space-y-1">
            {task.criteria.map((c, index) => {
              const Icon = c.completed ? CheckSquare : Square;
              return (
                <button
                  key={index}
                  type="button"
                  disabled={!canWrite || busy}
                  onClick={() => void run(() => call('toggle_task_criterion', { filePath, index, completed: !c.completed }))}
                  className="w-full flex items-start gap-2 text-left text-xs disabled:cursor-default"
                  data-testid={`remote-task-criterion-${index}`}
                >
                  <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${c.completed ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className={c.completed ? 'text-slate-400 line-through' : 'text-slate-200'}>{c.text}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          {bodyError && <div className="text-xs text-slate-500">{bodyError}</div>}
          {body === null && !bodyError && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
          {body !== null && <MarkdownViewer content={body} emptyMessage={tt.noDescription} refs={refs} />}
        </div>
      </div>
    </div>
  );
};
