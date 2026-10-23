import React, { useEffect, useMemo, useState } from 'react';
import { parsePeerPairingLink } from '../../utils/remotePairingLink';
import { createPortal } from 'react-dom';
import {
  X,
  Server,
  Plus,
  RefreshCw,
  Wifi,
  Globe,
  Play,
  Square,
  RotateCw,
  Check,
  Ban,
  Bot,
  ListChecks,
  Activity,
  AlertTriangle,
  Trash2,
  Link2,
  Unlink
} from '../common/icons';
import { catalogDraft, discoveredHosts, useFederationStore, type RemoteHostTab } from '../../store/useFederationStore';
import { useTranslation } from '../../i18n/useTranslation';
import { appFailureText } from '../../lib/appErrorText';
import { useDialog } from '../../hooks/useDialog';
import { parseAssignee } from '../../utils/assignee';
import type { FederationPeerState, FederationTransport, RemoteQueueItem } from '../../types/remote';
import { isMyTask, myQueueItems, returnReasons, reviewableByMe, taskHolder, taskQueueState } from '../../utils/teamQueue';

/**
 * Hub-режим федерации (TASK-66, decision-11 п.4): проекты, задачи, процессы, агенты и очередь
 * HITL другого компьютера в этом же интерфейсе, с явной пометкой хоста.
 *
 * Модалка рендерится через `createPortal` в `document.body` c `z-[9999]` — по правилу 19
 * infra-dev (decision-17): инлайн внутри сайдбара она оказалась бы за `backdrop-filter` предка.
 */

const statusDot: Record<FederationPeerState['status'], string> = {
  idle: 'bg-slate-500',
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-400',
  offline: 'bg-slate-600',
  error: 'bg-red-500'
};

interface AddPeerForm {
  hostId: string;
  machineName: string;
  transport: FederationTransport;
  address: string;
  secretKey: string;
  hostKey: string;
  pin: string;
}

const emptyForm: AddPeerForm = {
  hostId: '',
  machineName: '',
  transport: 'lan',
  address: '',
  secretKey: '',
  hostKey: '',
  pin: ''
};

export const RemoteHostsModal: React.FC = () => {
  const { t } = useTranslation();
  const dialog = useDialog();
  const {
    isOpen,
    close,
    peers,
    catalog,
    selectedHostId,
    selectHost,
    activeTab,
    setActiveTab,
    data,
    refreshPeers,
    refreshCatalog,
    addPeer,
    removePeer,
    connectPeer,
    disconnectPeer,
    loadHostData,
    selectRemoteProject,
    decideRemoteApproval,
    runRemoteAssignedAgent,
    remoteProcessAction,
    remoteTeamAction,
    remoteQueueReview
  } = useFederationStore();
  const [onlyMine, setOnlyMine] = useState(false);
  const [returning, setReturning] = useState<{ itemId: string; comment: string } | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<AddPeerForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  /** Форма заполнена ссылкой или найденным ПК (decision-143): подключение — только кнопкой человека. */
  const [fromDraft, setFromDraft] = useState(false);
  const addDraft = useFederationStore((s) => s.addDraft);

  useEffect(() => {
    if (!isOpen || !addDraft) return;
    const draft = useFederationStore.getState().takeAddDraft();
    if (!draft) return;
    setForm({
      ...emptyForm,
      hostId: draft.hostId ?? '',
      machineName: draft.machineName ?? '',
      transport: draft.transport ?? 'lan',
      address: draft.address ?? '',
      secretKey: draft.secretKey ?? '',
      hostKey: draft.hostKey ?? '',
      pin: draft.pin ?? ''
    });
    setFormError(null);
    setFromDraft(Boolean(draft.hostId));
    setIsAdding(true);
  }, [isOpen, addDraft]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    void refreshPeers();
    void refreshCatalog();
  }, [isOpen, refreshPeers, refreshCatalog]);

  const selectedPeer = useMemo(() => peers.find((p) => p.hostId === selectedHostId) || null, [peers, selectedHostId]);
  const hostData = selectedHostId ? data[selectedHostId] : undefined;

  /** Хосты из каталога релея/LAN, с которыми ещё не сопряжены — их можно добавить в один клик. */
  const discovered = useMemo(() => discoveredHosts(catalog, peers), [catalog, peers]);

  if (!isOpen) return null;

  const submitPeer = async () => {
    setFormError(null);
    if (!form.hostId.trim() || !form.address.trim()) {
      setFormError(t.federation.fieldHostId);
      return;
    }
    setIsSubmitting(true);
    const result = await addPeer({
      hostId: form.hostId.trim(),
      machineName: form.machineName.trim() || undefined,
      transport: form.transport,
      address: form.address.trim(),
      secretKey: form.secretKey.trim() || undefined,
      hostKey: form.hostKey.trim() || undefined,
      pin: form.pin.trim() || undefined
    });
    setIsSubmitting(false);
    if (result.ok) {
      setFromDraft(false);
      setIsAdding(false);
      setForm(emptyForm);
    } else {
      setFormError(result.error || t.federation.notConnected);
    }
  };

  const handleRemove = async (hostId: string) => {
    const confirmed = await dialog.confirm({ message: t.federation.removeConfirm, title: t.federation.remove });
    if (confirmed) await removePeer(hostId);
  };

  const renderTab = () => {
    if (!selectedPeer) {
      return <div className="flex-1 flex items-center justify-center text-sm text-slate-500">{t.federation.selectHostHint}</div>;
    }

    if (selectedPeer.status !== 'connected') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <AlertTriangle className="w-8 h-8 text-amber-400" />
          <p className="text-sm text-slate-300">{selectedPeer.error ? appFailureText(selectedPeer, t.appErrors) : t.federation.notConnected}</p>
          <p className="text-xs text-slate-500 max-w-md">{t.federation.offlineHint}</p>
          <button
            type="button"
            onClick={() => void connectPeer(selectedPeer.hostId)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
          >
            <Link2 className="w-3.5 h-3.5" />
            {t.federation.connect}
          </button>
        </div>
      );
    }

    if (hostData?.isLoading && !hostData.tasks.length) {
      return <div className="flex-1 flex items-center justify-center text-sm text-slate-500">{t.federation.loading}</div>;
    }

    if (activeTab === 'overview') {
      const catalogEntry = catalog.find((h) => h.hostId === selectedPeer.hostId);
      const stats = [
        { label: t.federation.overviewProjects, value: hostData?.projects.length ?? 0, icon: Server },
        { label: t.federation.overviewProcesses, value: hostData?.processes.length ?? 0, icon: Activity },
        { label: t.federation.overviewAgents, value: hostData?.swarms.length ?? 0, icon: Bot },
        { label: t.federation.overviewHitl, value: hostData?.approvals.length ?? 0, icon: ListChecks }
      ];

      return (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {stats.map((s) => (
              <div key={s.label} className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <s.icon className="w-3.5 h-3.5" />
                  {s.label}
                </div>
                <div className="text-xl font-semibold text-slate-100 mt-1">{s.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3 text-xs text-slate-400 space-y-1">
            <div>
              {t.federation.overviewVersion}: <span className="text-slate-200">{catalogEntry?.appVersion || '—'}</span>
            </div>
            <div>
              {t.federation.overviewProtocol}: <span className="text-slate-200">{selectedPeer.protocolVersion ?? '—'}</span>
            </div>
            <div>
              {t.federation.activeProject}: <span className="text-slate-200">{hostData?.activeProjectPath || '—'}</span>
            </div>
          </div>

          <div className="space-y-1">
            {hostData?.projects.length ? (
              hostData.projects.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  onClick={() => void selectRemoteProject(selectedPeer.hostId, p.path)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition ${
                    hostData.activeProjectPath === p.path
                      ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-200'
                      : 'border-slate-700/60 bg-slate-900/40 text-slate-300 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="font-medium">{p.name || p.path}</div>
                  <div className="text-[11px] text-slate-500 truncate">{p.path}</div>
                </button>
              ))
            ) : (
              <p className="text-xs text-slate-500">{t.federation.noProjects}</p>
            )}
          </div>
        </div>
      );
    }

    if (activeTab === 'tasks') {
      const team = hostData?.team ?? null;
      // Общий хост команды (TASK-142.5): свои задачи, «Взять себе», постановка в очередь слияния.
      const teamDo = async (action: 'take_task' | 'release_task' | 'queue_enqueue', taskId: string) => {
        const res = await remoteTeamAction(selectedPeer.hostId, action, taskId);
        setTeamError(res.ok ? null : res.error || null);
      };
      const tasks = (hostData?.tasks ?? []).filter((task) => !onlyMine || isMyTask(task, team?.me));
      return (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {team && (
            <label className="flex items-center gap-2 text-[11px] text-slate-400" data-testid="remote-tasks-mine">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              {t.federation.teamMine}
            </label>
          )}
          {teamError && <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{teamError}</div>}
          {tasks.length ? (
            tasks.map((task) => {
              const assigned = parseAssignee(task.assignee?.[0]);
              const roleSlug = assigned?.kind === 'agent' ? assigned.roleSlug : null;
              const holder = team ? taskHolder(task) : undefined;
              const mine = Boolean(team && isMyTask(task, team.me));
              const qs = taskQueueState(hostData?.queue, task.id);
              return (
                <div key={task.id} className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-200 truncate">
                        {task.id} — {task.title}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {task.status}
                        {assigned ? ` · ${assigned.raw}` : ''}
                        {holder ? ` · ${t.federation.teamHeldBy.replace('{name}', holder)}` : ''}
                        {qs.active ? ` · #${qs.active.n} ${t.federation.queueStatus[qs.active.status]}, ${t.federation.queuePlace.replace('{position}', String(qs.active.position))}` : ''}
                      </div>
                      {!qs.active && qs.last?.status === 'returned' && mine && (
                        <div className="mt-1 text-[11px] text-rose-300" data-testid="remote-task-returned">
                          {t.federation.queueReturnedWhy}: {returnReasons(qs.last).join(' · ')}
                        </div>
                      )}
                    </div>
                    {team && (
                      <div className="flex shrink-0 gap-1">
                        {!holder && (
                          <button type="button" data-testid="remote-task-take" onClick={() => void teamDo('take_task', task.id)} className="rounded-md border border-indigo-500/60 px-2 py-1 text-[11px] text-indigo-200 hover:bg-indigo-500/10">
                            {t.federation.teamTake}
                          </button>
                        )}
                        {mine && !qs.active && (
                          <button type="button" data-testid="remote-task-enqueue" onClick={() => void teamDo('queue_enqueue', task.id)} className="rounded-md border border-emerald-500/60 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/10">
                            {t.federation.teamEnqueue}
                          </button>
                        )}
                        {mine && !qs.active && (
                          <button type="button" onClick={() => void teamDo('release_task', task.id)} className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800">
                            {t.federation.teamRelease}
                          </button>
                        )}
                      </div>
                    )}
                    {roleSlug && hostData?.activeProjectPath && (
                      <button
                        type="button"
                        title={t.federation.runAssigned}
                        onClick={() =>
                          void runRemoteAssignedAgent(selectedPeer.hostId, {
                            projectPath: hostData?.activeProjectPath as string,
                            taskId: task.id,
                            taskTitle: task.title,
                            roleSlug
                          })
                        }
                        className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-[11px] font-medium text-white transition"
                      >
                        <Play className="w-3 h-3" />
                        {t.federation.runAssigned}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-xs text-slate-500">{t.federation.noTasks}</p>
          )}
        </div>
      );
    }

    if (activeTab === 'queue') {
      const queue = hostData?.queue ?? null;
      const me = hostData?.team?.me;
      const canReview = new Set(reviewableByMe(queue, me).map((i) => i.id));
      const mineIds = new Set(myQueueItems(queue, me).map((i) => i.id));
      const card = (item: RemoteQueueItem, position?: number) => (
        <div key={item.id} className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3 text-xs" data-testid="remote-queue-item">
          <div className="flex items-center gap-2">
            <span className="font-mono text-slate-500">#{item.n}</span>
            <span className="font-semibold text-slate-200">{item.taskId}</span>
            <span className="min-w-0 flex-1 truncate text-slate-300">{item.taskTitle}</span>
            <span className="text-indigo-300">{t.federation.queueStatus[item.status]}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {item.authorId} · {item.branch} → {item.base}
            {position ? ` · ${t.federation.queuePlace.replace('{position}', String(position))}` : ''}
            {mineIds.has(item.id) ? ' · ★' : ''}
          </div>
          {item.checks && item.checks.length > 0 && (
            <div className="mt-1 text-[11px] text-slate-400">
              {t.federation.queueChecks}: {item.checks.map((c) => `${c.name} — ${c.status}`).join(', ')}
            </div>
          )}
          {item.criteria && (
            <div className="mt-0.5 text-[11px] text-slate-400">
              {t.federation.queueCriteria}: {item.criteria.done}/{item.criteria.total}
            </div>
          )}
          {item.dependencies && item.dependencies.length > 0 && (
            <div className="mt-0.5 text-[11px] text-amber-300">
              {t.federation.queueDependencies}: {item.dependencies.join(', ')}
            </div>
          )}
          {item.status === 'returned' && (
            <div className="mt-1 text-[11px] text-rose-300">
              {t.federation.queueReturnedWhy}: {returnReasons(item).join(' · ')}
            </div>
          )}
          {canReview.has(item.id) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {returning?.itemId === item.id ? (
                <>
                  <input
                    value={returning.comment}
                    onChange={(e) => setReturning({ itemId: item.id, comment: e.target.value })}
                    placeholder={t.federation.queueCommentPlaceholder}
                    data-testid="remote-queue-comment"
                    className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    disabled={!returning.comment.trim()}
                    data-testid="remote-queue-return-send"
                    onClick={async () => {
                      const res = await remoteQueueReview(selectedPeer.hostId, item.id, false, returning.comment);
                      setTeamError(res.ok ? null : res.error || null);
                      if (res.ok) setReturning(null);
                    }}
                    className="rounded-md border border-rose-500/60 px-2 py-1 text-[11px] text-rose-200 disabled:opacity-40"
                  >
                    {t.federation.queueReturn}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="remote-queue-approve"
                    onClick={async () => {
                      const res = await remoteQueueReview(selectedPeer.hostId, item.id, true);
                      setTeamError(res.ok ? null : res.error || null);
                    }}
                    className="rounded-md bg-emerald-600/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                  >
                    {t.federation.queueApprove}
                  </button>
                  <button type="button" data-testid="remote-queue-return" onClick={() => setReturning({ itemId: item.id, comment: '' })} className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300">
                    {t.federation.queueReturn}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      );
      return (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {teamError && <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">{teamError}</div>}
          {queue?.settings.paused && <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">{t.federation.queuePaused.replace('{reason}', queue.settings.paused.reason)}</div>}
          {!queue || (queue.active.length === 0 && queue.finished.length === 0) ? (
            <p className="text-xs text-slate-500">{t.federation.queueEmpty}</p>
          ) : (
            <>
              {queue.active.map((item, idx) => card(item, idx + 1))}
              {queue.finished.slice(0, 10).map((item) => card(item))}
            </>
          )}
        </div>
      );
    }

    if (activeTab === 'processes') {
      return (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {hostData?.processes.length ? (
            hostData.processes.map((proc) => (
              <div key={proc.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/60 bg-slate-900/60 p-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">{proc.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {proc.status}
                    {proc.port ? ` · :${proc.port}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    title={t.federation.restartProcess}
                    onClick={() => void remoteProcessAction(selectedPeer.hostId, 'restart', proc.id)}
                    className="p-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t.federation.stopProcess}
                    onClick={() => void remoteProcessAction(selectedPeer.hostId, 'stop', proc.id)}
                    className="p-1.5 rounded-md bg-red-600/70 hover:bg-red-500 text-white transition"
                  >
                    <Square className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-slate-500">{t.federation.noProcesses}</p>
          )}
        </div>
      );
    }

    if (activeTab === 'agents') {
      return (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {hostData?.swarms.length ? (
            hostData.swarms.map((swarm) => (
              <div key={swarm.id} className="rounded-lg border border-slate-700/60 bg-slate-900/60 p-3">
                <div className="text-xs font-semibold text-slate-200">
                  {swarm.taskId ? `${swarm.taskId} — ` : ''}
                  {swarm.taskTitle || swarm.mode}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {swarm.status} · {swarm.origin || swarm.mode}
                </div>
                <div className="mt-2 space-y-1">
                  {swarm.agents.map((agent) => (
                    <div key={agent.id} className="flex items-center justify-between text-[11px] text-slate-400">
                      <span className="truncate">
                        {agent.name}
                        {agent.roleSlug ? ` · ${agent.roleSlug}` : ''}
                      </span>
                      <span className={agent.status === 'running' ? 'text-emerald-400' : 'text-slate-500'}>{agent.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-slate-500">{t.federation.noAgents}</p>
          )}
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {hostData?.approvals.length ? (
          hostData.approvals.map((req) => (
            <div key={req.requestId} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="text-xs font-semibold text-amber-100">{req.title || req.tool || req.type}</div>
              {req.command && <pre className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap break-all">{req.command}</pre>}
              {req.filePath && <div className="mt-1 text-[11px] text-slate-500 truncate">{req.filePath}</div>}
              <div className="text-[11px] text-slate-500 mt-1">
                {req.agentName || req.sessionId}
                {req.role ? ` · ${req.role}` : ''}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => void decideRemoteApproval(selectedPeer.hostId, req.requestId, true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-[11px] font-medium text-white transition"
                >
                  <Check className="w-3 h-3" />
                  {t.federation.approve}
                </button>
                <button
                  type="button"
                  onClick={() => void decideRemoteApproval(selectedPeer.hostId, req.requestId, false)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-[11px] font-medium text-slate-100 transition"
                >
                  <Ban className="w-3 h-3" />
                  {t.federation.deny}
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-500">{t.federation.noApprovals}</p>
        )}
      </div>
    );
  };

  const tabs: Array<{ id: RemoteHostTab; label: string }> = [
    { id: 'overview', label: t.federation.tabOverview },
    { id: 'tasks', label: t.federation.tabTasks },
    { id: 'processes', label: t.federation.tabProcesses },
    { id: 'agents', label: t.federation.tabAgents },
    { id: 'hitl', label: t.federation.tabHitl },
    // Вкладка очереди — только у хоста с очередью слияния (модуль Team).
    ...(selectedHostId && data[selectedHostId]?.queue ? [{ id: 'queue' as const, label: t.federation.tabQueue }] : [])
  ];

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-5xl h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              {t.federation.title}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">{t.federation.subtitle}</p>
          </div>
          <button type="button" onClick={close} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Список хостов */}
          <div className="w-64 shrink-0 border-r border-slate-800 flex flex-col">
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <div>
                <div className="text-[11px] text-slate-500 mb-1.5">{t.federation.hostsSection}</div>
                {peers.length ? (
                  <div className="space-y-1">
                    {peers.map((peer) => (
                      <div
                        key={peer.hostId}
                        className={`group rounded-lg border px-2.5 py-2 cursor-pointer transition ${
                          peer.hostId === selectedHostId
                            ? 'border-indigo-500/60 bg-indigo-500/10'
                            : 'border-slate-700/60 bg-slate-900/40 hover:bg-slate-800/60'
                        }`}
                        onClick={() => selectHost(peer.hostId)}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[peer.status]}`} />
                          <span className="text-xs font-medium text-slate-200 truncate flex-1">{peer.machineName}</span>
                          {peer.status === 'connected' && peer.sessionProtocol && (
                            <span
                              className={`text-[10px] px-1 rounded ${peer.sessionProtocol === 2 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}
                              data-testid="peer-protocol"
                            >
                              {peer.sessionProtocol === 2 ? t.federation.protocolV2 : t.federation.protocolV1}
                            </span>
                          )}
                          {peer.transport === 'lan' ? (
                            <Wifi className="w-3 h-3 text-slate-500" />
                          ) : (
                            <Globe className="w-3 h-3 text-slate-500" />
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                          {t.federation.status[peer.status]}
                          {peer.rights ? ` · ${t.federation.rights[peer.rights]}` : ''}
                        </div>
                        <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition">
                          {peer.status === 'connected' ? (
                            <button
                              type="button"
                              title={t.federation.disconnect}
                              onClick={(e) => {
                                e.stopPropagation();
                                void disconnectPeer(peer.hostId);
                              }}
                              className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
                            >
                              <Unlink className="w-3 h-3" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              title={t.federation.connect}
                              onClick={(e) => {
                                e.stopPropagation();
                                void connectPeer(peer.hostId);
                              }}
                              className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
                            >
                              <Link2 className="w-3 h-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            title={t.federation.remove}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRemove(peer.hostId);
                            }}
                            className="p-1 rounded bg-slate-800 hover:bg-red-600/70 text-slate-400 hover:text-white"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 space-y-1">
                    <p>{t.federation.noPeers}</p>
                    <p className="text-[11px] text-slate-600">{t.federation.noPeersHint}</p>
                  </div>
                )}
              </div>

              {discovered.length > 0 && (
                <div>
                  <div className="text-[11px] text-slate-500 mb-1.5">{t.federation.discoveredSection}</div>
                  <div className="space-y-1">
                    {discovered.map((host) => (
                      <button
                        key={host.hostId}
                        type="button"
                        onClick={() => useFederationStore.getState().openAdd(catalogDraft(host))}
                        className="w-full text-left rounded-lg border border-slate-700/60 bg-slate-900/40 hover:bg-slate-800/60 px-2.5 py-2 transition"
                      >
                        <div className="text-xs text-slate-200 truncate">{host.machineName}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {host.isOnline ? host.platform : t.federation.status.offline}
                          {host.protocolIncompatible ? ` · ${t.federation.protocolMismatch}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setFromDraft(false);
                  setIsAdding(true);
                }}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
              >
                <Plus className="w-3.5 h-3.5 text-indigo-400" />
                {t.federation.addPeer}
              </button>
            </div>
          </div>

          {/* Контент хоста */}
          <div className="flex-1 flex flex-col min-w-0">
            {isAdding ? (
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                <h3 className="text-xs font-semibold text-slate-200">{t.federation.addPeerTitle}</h3>
                {fromDraft && (
                  <p className="text-[11px] text-slate-400" data-testid="peer-draft-hint">
                    {form.secretKey || form.hostKey ? t.federation.draftFromLinkHint : t.federation.draftNeedsPinHint}
                  </p>
                )}
                <label className="block">
                  <span className="text-[11px] text-slate-500">{t.federation.fieldPairingLink}</span>
                  <input
                    data-testid="peer-pairing-link"
                    placeholder={t.federation.fieldPairingLinkHint}
                    onChange={(e) => {
                      const value = e.target.value.trim();
                      if (!value) return;
                      const parsed = parsePeerPairingLink(value);
                      if (!parsed) {
                        setFormError(t.federation.pairingLinkInvalid);
                        return;
                      }
                      setFormError(null);
                      setForm({
                        ...form,
                        hostId: parsed.hostId,
                        transport: parsed.transport,
                        address: parsed.address || form.address,
                        secretKey: parsed.secretKey || form.secretKey,
                        hostKey: parsed.hostKey || form.hostKey,
                        pin: parsed.pin || form.pin
                      });
                    }}
                    className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </label>
                {[
                  { key: 'hostId' as const, label: t.federation.fieldHostId },
                  { key: 'machineName' as const, label: t.federation.fieldMachineName }
                ].map((field) => (
                  <label key={field.key} className="block">
                    <span className="text-[11px] text-slate-500">{field.label}</span>
                    <input
                      value={form[field.key]}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                  </label>
                ))}

                <label className="block">
                  <span className="text-[11px] text-slate-500">{t.federation.fieldTransport}</span>
                  <select
                    value={form.transport}
                    onChange={(e) => setForm({ ...form, transport: e.target.value as FederationTransport })}
                    className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="lan">{t.federation.transportLan}</option>
                    <option value="relay">{t.federation.transportRelay}</option>
                  </select>
                </label>

                <label className="block">
                  <span className="text-[11px] text-slate-500">{t.federation.fieldAddress}</span>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    placeholder={form.transport === 'lan' ? t.federation.fieldAddressLanHint : t.federation.fieldAddressRelayHint}
                    className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </label>

                <label className="block">
                  <span className="text-[11px] text-slate-500">{t.federation.fieldHostKey}</span>
                  <input
                    value={form.hostKey}
                    onChange={(e) => setForm({ ...form, hostKey: e.target.value })}
                    className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 font-mono text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </label>

                {[
                  { key: 'secretKey' as const, label: t.federation.fieldSecretKey },
                  { key: 'pin' as const, label: t.federation.fieldPin }
                ].map((field) => (
                  <label key={field.key} className="block">
                    <span className="text-[11px] text-slate-500">{field.label}</span>
                    <input
                      type="password"
                      value={form[field.key]}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-ph-raised border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                  </label>
                ))}

                {formError && <p className="text-[11px] text-red-400">{formError}</p>}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void submitPeer()}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition"
                  >
                    {t.federation.save}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFromDraft(false);
                      setIsAdding(false);
                      setFormError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
                  >
                    {t.federation.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-800">
                  <div className="flex items-center gap-1">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition ${
                          activeTab === tab.id ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {tab.label}
                        {tab.id === 'hitl' && hostData?.approvals.length ? ` (${hostData.approvals.length})` : ''}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    title={t.federation.refresh}
                    disabled={!selectedHostId}
                    onClick={() => selectedHostId && void loadHostData(selectedHostId)}
                    className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 disabled:opacity-40 transition"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${hostData?.isLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {hostData?.error && (
                  <div className="px-4 py-2 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/30">{hostData.error}</div>
                )}

                {renderTab()}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
