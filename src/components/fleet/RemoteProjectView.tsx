import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bot, ListTodo, Loader2, Monitor, RefreshCw, WifiOff, X } from '../common/icons';
import { useFleetStore, type OpenRemoteProject, type RemoteProjectTab } from '../../store/useFleetStore';
import { useFederationStore } from '../../store/useFederationStore';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { findDocById, resolveRemoteRef } from '../../utils/remoteDocs';
import type { DocRefNavigation } from '../../hooks/useDocRefs';
import type { RemoteDocEntry, RemoteDocsList, RemoteTaskSummary } from '../../types/remote';
import { RemoteTasksTab } from './RemoteTasksTab';
import { RemoteAgentsTab } from './RemoteAgentsTab';
import { RemoteDocsTab } from './RemoteDocsTab';

/**
 * Проект удалённого ПК в основной области (TASK-229): задачи, сессии агентов и документация — всё RPC хоста, как на
 * телефоне. Открывается кликом по проекту удалённого компьютера в разделе «Компьютеры»; сессия поверх него —
 * `RemoteSessionView`.
 */

export type RemoteCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** Перечитать задачи после события хоста не чаще, чем раз в это время. */
const EVENT_DEBOUNCE_MS = 400;

export const RemoteProjectView: React.FC = () => {
  const open = useFleetStore((s) => s.remoteProject);
  if (!open) return null;
  return <RemoteProjectPanel key={`${open.hostId}|${open.projectPath}`} open={open} />;
};

const TABS: Array<{ id: RemoteProjectTab; icon: typeof ListTodo }> = [
  { id: 'tasks', icon: ListTodo },
  { id: 'agents', icon: Bot },
  { id: 'docs', icon: BookOpen }
];

const RemoteProjectPanel: React.FC<{ open: OpenRemoteProject }> = ({ open }) => {
  const { t } = useTranslation();
  const setTab = useFleetStore((s) => s.setRemoteProjectTab);
  const close = useFleetStore((s) => s.closeRemoteProject);
  const remote = useFleetStore((s) => s.remote[open.hostId]);
  const online = useFederationStore((s) => s.peers.find((p) => p.hostId === open.hostId)?.status === 'connected');
  const { hostId, projectPath } = open;
  const project = remote?.overview?.projects.find((p) => p.path === projectPath);
  // Действия в проекте могут быть уже, чем на хосте (права устройства по проектам, TASK-180).
  const canWrite = (project?.actions ?? remote?.overview?.actions ?? 'none') === 'full';

  const call = useCallback<RemoteCall>(
    (method, params = {}) => window.api.federationCall(hostId, method, { projectPath, ...params }),
    [hostId, projectPath]
  );

  const [tasks, setTasks] = useState<RemoteTaskSummary[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [docs, setDocs] = useState<RemoteDocEntry[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedDocPath, setSelectedDocPath] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const list = await call<RemoteTaskSummary[]>('get_tasks');
      setTasks(Array.isArray(list) ? list : []);
      setTasksError(null);
    } catch (err) {
      setTasksError(ipcErrorText(err));
    }
  }, [call]);

  const loadDocs = useCallback(async () => {
    try {
      const res = await call<RemoteDocsList>('get_docs');
      setDocs(Array.isArray(res?.docs) ? res.docs : []);
      setDocsError(null);
    } catch (err) {
      setDocsError(ipcErrorText(err));
    }
  }, [call]);

  // Списки задач и документов нужны всем вкладкам: по ним разрешаются ссылки `[[id]]`.
  useEffect(() => {
    if (!online) return;
    void loadTasks();
    void loadDocs();
  }, [online, loadTasks, loadDocs]);

  // Задачи меняют и другие устройства: хост рассылает `backlog:changed`.
  useEffect(() => {
    return window.api.onFederationEvent((payload) => {
      if (payload.hostId !== hostId || payload.event !== 'backlog:changed') return;
      const changed = (payload.data as { projectPath?: string } | undefined)?.projectPath;
      if (changed && changed !== projectPath) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void loadTasks(), EVENT_DEBOUNCE_MS);
    });
  }, [hostId, projectPath, loadTasks]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const refresh = () => {
    void loadTasks();
    void loadDocs();
    setReloadTick((n) => n + 1);
  };

  // Ссылки в задачах и документах ведут внутри этого проекта, а не в локальный проект окна.
  const refs = useMemo<DocRefNavigation>(
    () => ({
      resolve: (ref) => resolveRemoteRef(ref, docs ?? [], tasks ?? []),
      open: (ref) => {
        if (ref.kind === 'task') {
          const task = (tasks ?? []).find((x) => x.id.toLowerCase() === ref.id);
          if (!task) return;
          setSelectedTaskId(task.id);
          setTab('tasks');
        } else if (ref.kind === 'doc' || ref.kind === 'decision') {
          const doc = findDocById(docs ?? [], ref.id);
          if (!doc) return;
          setSelectedDocPath(doc.path);
          setTab('docs');
        }
      }
    }),
    [docs, tasks, setTab]
  );

  const host = open.machineName;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-ph-panel" data-testid="fleet-remote-project">
      <div className="h-10 px-3 flex items-center gap-2 border-b border-ph-line shrink-0">
        <Monitor className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="text-xs text-slate-400 truncate max-w-[160px]">{host}</span>
        <span className="text-slate-600">/</span>
        <span className="text-sm text-slate-100 truncate max-w-[240px]" title={projectPath}>
          {open.projectName}
        </span>
        <div className="flex items-center gap-1 ml-3" role="tablist">
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={open.tab === id}
              onClick={() => setTab(id)}
              className={`h-7 px-2.5 rounded-md flex items-center gap-1.5 text-xs ${
                open.tab === id ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:bg-ph-hover hover:text-slate-200'
              }`}
              data-testid={`remote-project-tab-${id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.fleet.project.tabs[id]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {online && !canWrite && remote?.overview && (
          <span className="text-[11px] text-slate-500 truncate" title={fmt(t.fleet.project.readOnly, { host })}>
            {t.fleet.readOnly}
          </span>
        )}
        <button type="button" onClick={refresh} disabled={!online} className="ph-icon-button disabled:opacity-40" title={t.fleet.project.refresh} aria-label={t.fleet.project.refresh}>
          <RefreshCw className="w-4 h-4" />
        </button>
        <button type="button" onClick={close} className="ph-icon-button" title={t.fleet.project.close} aria-label={t.fleet.project.close}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {!online ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-slate-400">
          <WifiOff className="w-4 h-4" /> {fmt(t.fleet.project.offline, { host })}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          {open.tab === 'tasks' && (
            <RemoteTasksTab
              host={host}
              tasks={tasks}
              error={tasksError}
              canWrite={canWrite}
              call={call}
              reloadTasks={loadTasks}
              reloadTick={reloadTick}
              selectedId={selectedTaskId}
              onSelect={setSelectedTaskId}
              refs={refs}
            />
          )}
          {open.tab === 'agents' && <RemoteAgentsTab open={open} project={project} canWrite={canWrite} call={call} reloadTick={reloadTick} />}
          {open.tab === 'docs' && (
            <RemoteDocsTab docs={docs} error={docsError} call={call} selectedPath={selectedDocPath} onSelect={setSelectedDocPath} refs={refs} reloadTick={reloadTick} />
          )}
        </div>
      )}
      {online && tasks === null && docs === null && !tasksError && !docsError && (
        <Loader2 className="absolute top-14 right-4 w-4 h-4 animate-spin text-slate-500" />
      )}
    </div>
  );
};
