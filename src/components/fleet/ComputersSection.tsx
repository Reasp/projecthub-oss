import React, { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Laptop, Loader2, MessageSquare, Monitor, Settings, ShieldAlert, Terminal, WifiOff } from '../common/icons';
import { useFleetStore, fleetHosts } from '../../store/useFleetStore';
import { useFederationStore } from '../../store/useFederationStore';
import { useHitlStore } from '../../store/useHitlStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import {
  fleetTotals,
  splitQuietProjects,
  type FleetHostEntry,
  type OverviewActions,
  type OverviewAttention,
  type OverviewPendingRequest,
  type OverviewProject,
  type OverviewSession,
  type OverviewSessionState
} from '../../utils/fleetOverview';

/**
 * Раздел «Компьютеры» сайдбара (TASK-174, decision-129 п. 10): этот ПК и удалённые хосты hub-режима, под ними —
 * громкие проекты и их сессии. Внимание поднимается вверх: «ждёт» и «работает» видны на строке компьютера.
 */

const DOT: Record<OverviewAttention, string> = {
  waiting: 'bg-amber-400',
  failed: 'bg-rose-500',
  running: 'bg-emerald-400 animate-pulse',
  quiet: 'bg-slate-600'
};

const STATE_TEXT: Record<OverviewSessionState, string> = {
  waiting: 'text-amber-300',
  failed: 'text-rose-300',
  running: 'text-emerald-300',
  idle: 'text-slate-400',
  done: 'text-slate-500'
};

function sessionIcon(kind: OverviewSession['kind']) {
  if (kind === 'studio') return MessageSquare;
  if (kind === 'terminal') return Terminal;
  return Bot;
}

/** «5 мин назад», «вчера» — по языку интерфейса. */
export function relativeTime(at: number, language: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(language === 'en' ? 'en' : 'ru', { numeric: 'auto' });
  const sec = Math.round((at - now) / 1000);
  if (Math.abs(sec) < 60) return rtf.format(sec, 'second');
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  const hours = Math.round(min / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

const Count: React.FC<{ tone: 'amber' | 'emerald' | 'rose'; children: React.ReactNode }> = ({ tone, children }) => (
  <span
    className={`shrink-0 h-4 px-1 rounded text-[10px] font-medium tabular-nums flex items-center ${
      tone === 'amber' ? 'bg-amber-500/20 text-amber-300' : tone === 'rose' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'
    }`}
  >
    {children}
  </span>
);

export const ComputersSection: React.FC = () => {
  const { t, language } = useTranslation();
  const dialog = useDialog();
  const fleet = useFleetStore();
  const peers = useFederationStore((s) => s.peers);
  const openManage = useFederationStore((s) => s.open);
  const [, setTick] = useState(0);

  useEffect(() => {
    useFleetStore.getState().init();
    // «Был в сети 5 минут назад» стареет и без событий.
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const hosts = fleetHosts('', fleet.local, peers, fleet.remote, fleet.lastSeen);
  const totals = fleetTotals(hosts);
  const fmt = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

  const decide = async (host: FleetHostEntry, req: OverviewPendingRequest, approved: boolean) => {
    const res = await fleet.decide(host.self ? null : host.hostId, req.requestId, approved);
    if (!res.ok) await dialog.alert({ message: fmt(t.fleet.decideError, { error: res.error || '' }) });
  };

  const openLocalSession = async (project: OverviewProject, session: OverviewSession) => {
    const projects = useProjectStore.getState().projects;
    const info = projects.find((p) => p.path === project.path);
    if (info) useProjectStore.getState().selectProject(info);
    if (session.kind === 'studio') {
      const studio = useAIStudioStore.getState();
      await studio.loadSessions(project.path);
      if ((useAIStudioStore.getState().sessions[project.path] || []).some((s) => s.id === session.id)) {
        studio.switchSession(project.path, session.id);
      } else {
        const fromDisk = (await window.api.listAISessions(project.path)).find((s) => s.id === session.id);
        if (fromDisk) studio.reopenSession(project.path, fromDisk);
      }
      useSwarmStore.getState().requestAiView('studio');
      useProjectStore.getState().setActiveTab('ai');
    } else if (session.kind === 'swarm') {
      const swarm = useSwarmStore.getState();
      await swarm.loadSwarmsAction(project.path);
      swarm.setActiveSwarmId(project.path, session.id);
      swarm.requestAiView('swarm');
      useProjectStore.getState().setActiveTab('ai');
    } else {
      // Вывод терминала — во встроенном терминале проекта, если сессия идёт в нём.
      useProjectStore.getState().setTerminalOpen(true);
    }
  };

  const openSession = (host: FleetHostEntry, project: OverviewProject, session: OverviewSession) => {
    if (host.self) {
      useFleetStore.getState().closeRemoteSession();
      void openLocalSession(project, session);
      return;
    }
    fleet.openRemoteSession({ hostId: host.hostId, machineName: host.machineName, projectPath: project.path, projectName: project.name, session });
  };

  const renderPending = (host: FleetHostEntry, actions: OverviewActions, req: OverviewPendingRequest) => {
    if (actions === 'none') return null;
    const high = req.risk === 'high';
    return (
      <div key={req.requestId} className="flex items-center gap-1 mt-0.5" onClick={(e) => e.stopPropagation()}>
        {!high && (
          <button
            type="button"
            onClick={() => void decide(host, req, true)}
            className="h-5 px-1.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-[10px] text-white"
            data-testid={`fleet-approve-${req.requestId}`}
          >
            {t.fleet.approve}
          </button>
        )}
        <button type="button" onClick={() => void decide(host, req, false)} className="h-5 px-1.5 rounded bg-ph-raised hover:bg-ph-hover text-[10px] text-slate-200">
          {t.fleet.deny}
        </button>
        {high &&
          (host.self ? (
            <button type="button" onClick={() => useHitlStore.getState().openCenter('queue')} className="h-5 px-1.5 rounded text-[10px] text-amber-300 hover:bg-ph-hover">
              {t.fleet.openRequest}
            </button>
          ) : (
            <span className="text-[10px] text-amber-300/80 truncate" title={t.fleet.highRiskRemote}>
              <ShieldAlert className="w-3 h-3 inline -mt-0.5" /> {t.fleet.highRiskRemote}
            </span>
          ))}
      </div>
    );
  };

  const renderSession = (host: FleetHostEntry, actions: OverviewActions, project: OverviewProject, s: OverviewSession) => {
    const Icon = sessionIcon(s.kind);
    const active = fleet.remoteSession && fleet.remoteSession.hostId === host.hostId && fleet.remoteSession.session.id === s.id;
    return (
      <div
        key={`${s.kind}:${s.id}`}
        role="button"
        tabIndex={0}
        onClick={() => openSession(host, project, s)}
        onKeyDown={(e) => e.key === 'Enter' && openSession(host, project, s)}
        className={`pl-10 pr-2 py-1 cursor-pointer hover:bg-ph-hover ${active ? 'bg-ph-hover' : ''}`}
        title={`${t.fleet.kinds[s.kind]} · ${t.fleet.states[s.state]}${s.agentName ? ` · ${s.agentName}` : ''}`}
        data-testid={`fleet-session-${s.id}`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={`w-3 h-3 shrink-0 ${STATE_TEXT[s.state]}`} />
          <span className="truncate text-xs text-slate-200 flex-1">{s.title}</span>
          <span className={`shrink-0 text-[10px] ${STATE_TEXT[s.state]}`}>{t.fleet.states[s.state]}</span>
        </div>
        {s.detail && <div className={`pl-[18px] truncate text-[11px] ${s.state === 'waiting' ? 'text-amber-200/90' : 'text-slate-500'}`}>{s.detail}</div>}
        {s.pending && <div className="pl-[18px]">{s.pending.map((req) => renderPending(host, actions, req))}</div>}
      </div>
    );
  };

  const renderProject = (host: FleetHostEntry, actions: OverviewActions, p: OverviewProject) => {
    const key = `${host.hostId}|${p.path}`;
    // Громкий проект раскрыт по умолчанию, тихий — свёрнут; клик меняет это.
    const loud = p.attention !== 'quiet';
    const open = fleet.openProjects[key] ?? loud;
    const onProject = () => {
      if (host.self) {
        const info = useProjectStore.getState().projects.find((x) => x.path === p.path);
        if (info) useProjectStore.getState().selectProject(info);
      }
      fleet.toggleProject(host.hostId, p.path);
    };
    return (
      <div key={key}>
        <button type="button" onClick={onProject} className="w-full pl-6 pr-2 h-6 flex items-center gap-1.5 hover:bg-ph-hover text-left" title={p.path} data-testid={`fleet-project-${p.name}`}>
          {open ? <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[p.attention]}`} />
          <span className="truncate text-xs text-slate-200 flex-1">{p.name}</span>
          {p.counts.waiting > 0 && <Count tone="amber">{p.counts.waiting}</Count>}
          {p.counts.running > 0 && <Count tone="emerald">{p.counts.running}</Count>}
          {p.tasks.review > 0 && <span className="shrink-0 text-[10px] text-violet-300" title={fmt(t.fleet.tasksReview, { n: p.tasks.review })}>R{p.tasks.review}</span>}
        </button>
        {open && (
          <div>
            {p.processes.failed > 0 && (
              <div className="pl-10 pr-2 text-[11px] text-rose-300 truncate">{fmt(t.fleet.processesFailed, { names: (p.processes.failedNames || []).join(', ') })}</div>
            )}
            {p.sessions.length === 0 && <div className="pl-10 pr-2 py-0.5 text-[11px] text-slate-500">{t.fleet.noSessions}</div>}
            {p.sessions.map((s) => renderSession(host, actions, p, s))}
            {p.moreSessions > 0 && <div className="pl-10 pr-2 py-0.5 text-[11px] text-slate-500">{fmt(t.fleet.moreSessions, { n: p.moreSessions })}</div>}
          </div>
        )}
      </div>
    );
  };

  const renderHost = (host: (typeof hosts)[number]) => {
    const collapsed = Boolean(fleet.collapsedHosts[host.hostId]);
    const name = host.machineName || (host.self ? t.fleet.thisPc : host.hostId);
    if (!host.online) {
      return (
        <div key={host.hostId} className="pl-3 pr-2 h-6 flex items-center gap-1.5 text-slate-500" title={host.error || ''} data-testid={`fleet-host-${host.hostId}`}>
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate text-xs">{name}</span>
          <span className="truncate text-[11px] flex-1 text-right">
            {t.fleet.offline} · {host.lastSeenAt ? fmt(t.fleet.lastSeen, { time: relativeTime(host.lastSeenAt, language) }) : t.fleet.neverSeen}
          </span>
        </div>
      );
    }
    const overview = host.overview;
    const counts = overview?.counts;
    const { visible, quiet } = splitQuietProjects(overview?.projects ?? [], host.self ? useProjectStore.getState().selectedProject?.path : null);
    const showQuiet = Boolean(fleet.showQuiet[host.hostId]);
    const HostIcon = host.self ? Laptop : Monitor;
    return (
      <div key={host.hostId} data-testid={`fleet-host-${host.hostId}`}>
        <button type="button" onClick={() => fleet.toggleHost(host.hostId)} className="w-full pl-2 pr-2 h-7 flex items-center gap-1.5 hover:bg-ph-hover text-left">
          {collapsed ? <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" /> : <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />}
          <HostIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="truncate text-xs font-medium text-slate-100 flex-1">
            {name}
            {host.self && <span className="ml-1 text-[10px] font-normal text-slate-500">{t.fleet.thisPc}</span>}
          </span>
          {host.state?.loading && !overview && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
          {overview?.actions === 'none' && <span className="text-[10px] text-slate-500">{t.fleet.readOnly}</span>}
          {counts && counts.waiting > 0 && <Count tone="amber">{fmt(t.fleet.waiting, { n: counts.waiting })}</Count>}
          {counts && counts.failed > 0 && <Count tone="rose">{fmt(t.fleet.failed, { n: counts.failed })}</Count>}
          {counts && counts.running > 0 && <Count tone="emerald">{fmt(t.fleet.running, { n: counts.running })}</Count>}
        </button>
        {!collapsed && (
          <div className="pb-1">
            {host.state?.unsupported && <div className="pl-6 pr-2 text-[11px] text-slate-500">{t.fleet.unsupported}</div>}
            {!host.state?.unsupported && host.state?.error && !overview && <div className="pl-6 pr-2 text-[11px] text-rose-300 truncate">{host.state.error}</div>}
            {overview && overview.projects.length === 0 && <div className="pl-6 pr-2 text-[11px] text-slate-500">{t.fleet.noProjects}</div>}
            {visible.map((p) => renderProject(host, overview!.actions, p))}
            {quiet.length > 0 && (
              <>
                {showQuiet && quiet.map((p) => renderProject(host, overview!.actions, p))}
                <button type="button" onClick={() => fleet.toggleQuiet(host.hostId)} className="pl-6 pr-2 h-5 text-[11px] text-slate-500 hover:text-slate-300" data-testid={`fleet-quiet-${host.hostId}`}>
                  {showQuiet ? t.fleet.hideQuiet : fmt(t.fleet.moreProjects, { n: quiet.length })}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="shrink-0 flex flex-col max-h-[50%] min-h-0 border-b border-ph-line" data-testid="fleet-section">
      <div className="h-7 pl-2 pr-2 flex items-center gap-1 shrink-0">
        <button type="button" onClick={fleet.toggleSection} className="flex items-center gap-1 flex-1 min-w-0 text-left">
          {fleet.collapsed ? <ChevronRight className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
          <span className="ph-section-title truncate">{t.fleet.title}</span>
        </button>
        {totals.waiting > 0 && <Count tone="amber">{fmt(t.fleet.waiting, { n: totals.waiting })}</Count>}
        {totals.running > 0 && <Count tone="emerald">{fmt(t.fleet.running, { n: totals.running })}</Count>}
        <span className="text-[10px] text-slate-500 tabular-nums shrink-0" title={fmt(t.fleet.online, { online: totals.online, total: totals.total })}>
          {totals.online}/{totals.total}
        </span>
        <button type="button" onClick={() => openManage()} title={t.fleet.manage} className="ph-icon-button" aria-label={t.fleet.manage}>
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
      {!fleet.collapsed && <div className="overflow-y-auto min-h-0">{hosts.map(renderHost)}</div>}
    </div>
  );
};
