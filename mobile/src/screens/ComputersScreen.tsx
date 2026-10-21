import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  DotsThreeIcon,
  LockKeyIcon,
  PlusIcon,
  RobotIcon,
  TerminalWindowIcon,
  WarningIcon,
  WifiSlashIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useHostSummaries, useLastSeen, usePoolOverviews, useServices } from '../app/context';
import { ComputerSheet } from '../components/ComputerSheet';
import { RouteBadge } from '../components/RouteBadge';
import { Badge, Button, SectionTitle, Sheet } from '../components/ui';
import { useT } from '../i18n/react';
import { timeAgo } from '../protocol/inbox';
import type { HitlItem } from '../protocol/models';
import { phoneFleetHosts, projectKey, type PhoneFleetHost } from '../protocol/fleet';
import { activeProfile, catalogEntries } from '../protocol/profiles';
import {
  fleetTotals,
  splitQuietProjects,
  type OverviewAttention,
  type OverviewPendingRequest,
  type OverviewProject,
  type OverviewSession,
  type OverviewSessionState
} from '../../../src/utils/fleetOverview';

/**
 * Экран «Компьютеры» (TASK-174, decision-129 п. 11) вместо `HostSheet`: сводка сверху, закреплённые шапки компьютеров,
 * проект одной строкой со значками, сессии аккордеоном — раскрыт один проект. Выбор проекта задаёт контекст вкладок,
 * выбор сессии открывает Studio или вывод агента на нужном ПК с автопереключением.
 */

const DOT: Record<OverviewAttention, string> = {
  waiting: 'bg-amber-400',
  failed: 'bg-red-400',
  running: 'bg-emerald-400',
  quiet: 'bg-slate-600'
};

const STATE_TONE: Record<OverviewSessionState, string> = {
  waiting: 'text-amber-300',
  failed: 'text-red-300',
  running: 'text-emerald-300',
  idle: 'text-slate-400',
  done: 'text-slate-500'
};

function KindIcon({ kind, className }: { kind: OverviewSession['kind']; className?: string }) {
  if (kind === 'studio') return <ChatCircleIcon size={18} className={className} />;
  if (kind === 'terminal') return <TerminalWindowIcon size={18} className={className} />;
  return <RobotIcon size={18} className={className} />;
}

function Pill({ tone, children }: { tone: 'amber' | 'emerald' | 'red' | 'violet'; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded-full px-1.5 text-[12px] font-semibold leading-[20px] tabular-nums',
        tone === 'amber' && 'bg-amber-500 text-black',
        tone === 'emerald' && 'bg-emerald-500/20 text-emerald-300',
        tone === 'red' && 'bg-red-500/20 text-red-300',
        tone === 'violet' && 'bg-violet-500/20 text-violet-300'
      )}
    >
      {children}
    </span>
  );
}

export interface ComputersScreenProps {
  open: boolean;
  onClose: () => void;
  /** Запрос `high`: его проверяют во «Входящих» открытого ПК, с диффом и биометрией. */
  onOpenInbox: () => void;
}

export function ComputersScreen({ open, onClose, onOpenInbox }: ComputersScreenProps) {
  const { store, platform, profiles, switchHost, addHost, enrollHost, inbox } = useServices();
  const tr = useT();
  const conn = useAppState((s) => s.conn);
  const status = useAppState((s) => s.status);
  const projectPath = useAppState((s) => s.projectPath);
  const overview = useAppState((s) => s.overview);
  const overviewUnsupported = useAppState((s) => s.overviewUnsupported);
  const hosts = useAppState((s) => s.hosts);
  const summaries = useHostSummaries();
  const overviews = usePoolOverviews();
  const lastSeen = useLastSeen();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showQuiet, setShowQuiet] = useState<Record<string, boolean>>({});
  const [computer, setComputer] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const active = activeProfile(profiles);
  const catalog = catalogEntries(profiles, active, hosts);

  const fleet = useMemo(
    () =>
      phoneFleetHosts({
        profiles: profiles.profiles,
        activeId: active?.id ?? null,
        active: { overview, unsupported: overviewUnsupported, connection: conn.state, route: conn.route, machineName: status?.machineName },
        summaries,
        overviews,
        lastSeen
      }),
    [profiles.profiles, active?.id, overview, overviewUnsupported, conn.state, conn.route, status?.machineName, summaries, overviews, lastSeen]
  );
  const totals = fleetTotals(fleet);

  // Раскрыт один проект: выбранный человеком, иначе первый ждущий решения.
  const autoOpen = useMemo(() => {
    for (const h of fleet) for (const p of h.overview?.projects ?? []) if (p.attention === 'waiting') return projectKey(h.profileId, p.path);
    return null;
  }, [fleet]);
  const openKey = expanded ?? autoOpen;

  const goTo = (host: PhoneFleetHost) => {
    if (!host.active) switchHost(host.profileId);
  };

  const selectProject = (host: PhoneFleetHost, p: OverviewProject) => {
    platform.haptic('selection');
    if (host.active) void store.selectProject(p.path);
    else {
      // Новый ПК загрузится с этим проектом: он запоминается до переключения.
      void store.requestNav({ hostId: host.hostId, projectPath: p.path, kind: 'project', sessionId: '' });
      switchHost(host.profileId);
    }
    onClose();
  };

  const openSession = (host: PhoneFleetHost, p: OverviewProject, s: OverviewSession) => {
    platform.haptic('selection');
    void store.requestNav({ hostId: host.hostId, projectPath: p.path, kind: s.kind, sessionId: s.id, ...(s.agentId ? { agentId: s.agentId } : {}) });
    goTo(host);
    onClose();
  };

  const decide = async (host: PhoneFleetHost, s: OverviewSession, req: OverviewPendingRequest, approve: boolean) => {
    const source = { profileId: host.profileId, machineName: host.machineName, online: host.online, active: host.active, hitl: [], agentTasks: [], review: [], events: [] };
    const item = { requestId: req.requestId, sessionId: s.id, title: req.title } as HitlItem;
    // Решение уходит тому ПК, с которого строка, его соединением; дерево обновит событие `overview:changed`.
    if ((await inbox.decideHitl(source, item, approve)) && host.active) void store.refreshOverview();
  };

  const reviewHigh = (host: PhoneFleetHost) => {
    platform.haptic('selection');
    goTo(host);
    onOpenInbox();
    onClose();
  };

  const enroll = async (hostId: string) => {
    setEnrolling(hostId);
    try {
      if (await enrollHost(hostId)) {
        platform.haptic('success');
        onClose();
      }
    } finally {
      setEnrolling(null);
    }
  };

  const renderPending = (host: PhoneFleetHost, s: OverviewSession, req: OverviewPendingRequest, canDecide: boolean) => (
    <div key={req.requestId} className="mt-1.5 flex flex-wrap items-center gap-2">
      {canDecide && req.risk !== 'high' && (
        <>
          <Button size="sm" variant="success" data-testid={`fleet-approve-${req.requestId}`} onClick={() => void decide(host, s, req, true)}>
            {tr.fleet.approve}
          </Button>
          <Button size="sm" onClick={() => void decide(host, s, req, false)}>
            {tr.fleet.deny}
          </Button>
        </>
      )}
      {canDecide && req.risk === 'high' && (
        <Button size="sm" variant="primary" onClick={() => reviewHigh(host)}>
          <LockKeyIcon size={14} /> {tr.fleet.reviewHigh}
        </Button>
      )}
      {req.risk && <span className={clsx('text-[12px]', req.risk === 'high' ? 'text-red-300' : 'text-slate-400')}>{tr.inbox.risk[req.risk]}</span>}
    </div>
  );

  const renderSession = (host: PhoneFleetHost, p: OverviewProject, s: OverviewSession, canDecide: boolean) => (
    <li key={`${s.kind}:${s.id}`} className="border-t border-ph-line/60 first:border-t-0">
      <button
        type="button"
        data-testid={`fleet-session-${s.id}`}
        onClick={() => openSession(host, p, s)}
        className="flex w-full items-start gap-2.5 py-2.5 pl-2 pr-1 text-left active:bg-ph-hover"
      >
        <KindIcon kind={s.kind} className={clsx('mt-0.5 shrink-0', STATE_TONE[s.state])} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px]">{s.title}</span>
            <span className={clsx('shrink-0 text-[12px]', STATE_TONE[s.state])}>{tr.fleet.states[s.state]}</span>
          </span>
          <span className={clsx('block truncate text-[13px]', s.state === 'waiting' ? 'text-amber-200' : 'text-slate-400')}>
            {s.detail || (s.kind === 'terminal' ? tr.fleet.terminalHint : tr.fleet.kinds[s.kind])}
          </span>
        </span>
      </button>
      {s.pending && <div className="pb-2 pl-9">{s.pending.map((req) => renderPending(host, s, req, canDecide))}</div>}
    </li>
  );

  const renderProject = (host: PhoneFleetHost, p: OverviewProject, canDecide: boolean) => {
    const key = projectKey(host.profileId, p.path);
    const isOpen = openKey === key;
    const current = host.active && p.path === projectPath;
    return (
      <li key={key} className={clsx('rounded-xl', isOpen && 'bg-ph-elevated')}>
        <div className="flex items-center">
          <button
            type="button"
            data-testid={`fleet-project-${p.name}`}
            onClick={() => {
              platform.haptic('selection');
              setExpanded(isOpen ? '' : key);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-2 text-left active:bg-ph-hover"
          >
            {isOpen ? <CaretDownIcon size={14} className="shrink-0 text-slate-500" /> : <CaretRightIcon size={14} className="shrink-0 text-slate-500" />}
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[p.attention])} />
            <span className={clsx('min-w-0 flex-1 truncate text-[15px]', current && 'font-semibold text-indigo-200')}>{p.name}</span>
            {p.processes.failed > 0 && <WarningIcon size={16} className="shrink-0 text-red-400" />}
            {p.counts.waiting > 0 && <Pill tone="amber">{p.counts.waiting}</Pill>}
            {p.counts.failed > 0 && <Pill tone="red">{p.counts.failed}</Pill>}
            {p.counts.running > 0 && <Pill tone="emerald">{p.counts.running}</Pill>}
            {p.tasks.review > 0 && <Pill tone="violet">R{p.tasks.review}</Pill>}
          </button>
          <button type="button" aria-label={tr.fleet.openProject} onClick={() => selectProject(host, p)} className="shrink-0 rounded-xl px-3 py-2.5 text-slate-400 active:bg-ph-hover">
            <ArrowRightIcon size={18} />
          </button>
        </div>
        {isOpen && (
          <div className="pb-1 pl-4 pr-1">
            {p.processes.failed > 0 && <div className="pb-1 text-[13px] text-red-300">{tr.fleet.failedProcesses((p.processes.failedNames ?? []).join(', '))}</div>}
            {(p.tasks.inProgress > 0 || p.tasks.review > 0) && (
              <div className="pb-1 text-[12px] text-slate-500">
                {[p.tasks.inProgress > 0 ? tr.fleet.inProgress(p.tasks.inProgress) : '', p.tasks.review > 0 ? tr.fleet.review(p.tasks.review) : ''].filter(Boolean).join(' · ')}
              </div>
            )}
            {p.sessions.length === 0 ? (
              <div className="py-2 text-[13px] text-slate-500">{tr.fleet.noSessions}</div>
            ) : (
              <ul>{p.sessions.map((s) => renderSession(host, p, s, canDecide))}</ul>
            )}
            {p.moreSessions > 0 && <div className="py-1 text-[12px] text-slate-500">{tr.fleet.moreSessions(p.moreSessions)}</div>}
          </div>
        )}
      </li>
    );
  };

  const renderHost = (host: PhoneFleetHost) => {
    const header = (
      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b border-ph-line bg-ph-panel px-4 py-2">
        {host.online ? (
          <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', host.overview ? DOT[host.overview.attention] : 'bg-emerald-400')} />
        ) : (
          <WifiSlashIcon size={16} className="shrink-0 text-slate-500" />
        )}
        <button
          type="button"
          data-testid={`fleet-host-${host.profileId}`}
          onClick={() => {
            platform.haptic('selection');
            if (host.active) setComputer(host.profileId);
            else {
              switchHost(host.profileId);
              onClose();
            }
          }}
          className="min-w-0 flex-1 text-left"
        >
          <span className={clsx('block truncate text-[15px] font-semibold', !host.online && 'font-normal text-slate-500')}>{host.machineName}</span>
          <span className="block truncate text-[12px] text-slate-500">
            {host.online
              ? [host.active ? tr.fleet.current : '', host.overview?.actions === 'none' ? tr.fleet.viewOnly : '', host.via ? tr.shell.via(host.via) : ''].filter(Boolean).join(' · ') ||
                ' '
              : host.connecting
                ? tr.fleet.connecting
                : `${tr.fleet.offline} · ${host.lastSeenAt ? tr.fleet.lastSeen(timeAgo(host.lastSeenAt)) : tr.fleet.neverSeen}`}
          </span>
        </button>
        {host.online && host.active && <RouteBadge route={host.route} />}
        {host.overview && host.overview.counts.waiting > 0 && <Pill tone="amber">{host.overview.counts.waiting}</Pill>}
        {host.overview && host.overview.counts.running > 0 && <Pill tone="emerald">{host.overview.counts.running}</Pill>}
        <button
          type="button"
          aria-label={tr.shell.computerDetails}
          data-testid={`host-more-${host.profileId}`}
          onClick={() => setComputer(host.profileId)}
          className="-mr-2 shrink-0 rounded-xl px-2 py-1.5 text-slate-400 active:bg-ph-hover"
        >
          <DotsThreeIcon size={20} weight="bold" />
        </button>
      </div>
    );
    // Офлайн-компьютер — одна серая строка: устаревшие «работает» и «ждёт» ввели бы в заблуждение.
    if (!host.online) return <section key={host.profileId}>{header}</section>;
    const projects = host.overview?.projects ?? [];
    const { visible, quiet } = splitQuietProjects(projects, host.active ? projectPath : null);
    const canDecide = (host.overview?.actions ?? 'none') !== 'none';
    const quietOpen = Boolean(showQuiet[host.profileId]);
    return (
      <section key={host.profileId} className="pb-2">
        {header}
        {host.unsupported && <div className="py-2 text-[13px] text-slate-500">{tr.fleet.unsupported}</div>}
        {host.overview && projects.length === 0 && <div className="py-2 text-[13px] text-slate-500">{tr.fleet.noProjects}</div>}
        <ul className="mt-1 space-y-0.5">
          {visible.map((p) => renderProject(host, p, canDecide))}
          {quietOpen && quiet.map((p) => renderProject(host, p, canDecide))}
        </ul>
        {quiet.length > 0 && (
          <button
            type="button"
            data-testid={`fleet-quiet-${host.profileId}`}
            onClick={() => setShowQuiet((prev) => ({ ...prev, [host.profileId]: !quietOpen }))}
            className="mt-0.5 w-full rounded-xl py-2 pl-2 text-left text-[13px] text-slate-400 active:bg-ph-hover"
          >
            {quietOpen ? tr.fleet.hideQuiet : tr.fleet.moreProjects(quiet.length)}
          </button>
        )}
      </section>
    );
  };

  return (
    <Sheet open={open} onClose={onClose} title={tr.fleet.title}>
      <div data-testid="fleet-screen">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]" data-testid="fleet-summary">
          {totals.waiting > 0 && <Badge tone="warning">{tr.fleet.summaryWaiting(totals.waiting)}</Badge>}
          {totals.failed > 0 && <Badge tone="danger">{tr.fleet.summaryFailed(totals.failed)}</Badge>}
          {totals.running > 0 && <Badge tone="success">{tr.fleet.summaryRunning(totals.running)}</Badge>}
          {totals.waiting + totals.failed + totals.running === 0 && <Badge>{tr.fleet.allQuiet}</Badge>}
          <span className="text-slate-500">{tr.fleet.summaryOnline(totals.online, totals.total)}</span>
        </div>

        {fleet.map(renderHost)}

        <Button
          variant="ghost"
          className="mt-1 w-full"
          onClick={() => {
            onClose();
            addHost();
          }}
        >
          <PlusIcon size={18} /> {tr.shell.addComputer}
        </Button>

        {catalog.some((c) => c.state === 'enrollable') && (
          <>
            <SectionTitle>{tr.shell.federation}</SectionTitle>
            <ul className="space-y-1">
              {catalog
                .filter((c) => c.state === 'enrollable')
                .map(({ host: h }) => (
                  <li key={h.hostId} className="flex items-center gap-2 rounded-xl px-2 py-2">
                    <span className={clsx('h-2 w-2 shrink-0 rounded-full', h.isOnline ? 'bg-emerald-400' : 'bg-slate-600')} />
                    <span className="min-w-0 flex-1 truncate text-[14px]">{h.machineName || h.hostId}</span>
                    <Button size="sm" variant="primary" disabled={enrolling !== null} onClick={() => void enroll(h.hostId)}>
                      {enrolling === h.hostId ? '…' : tr.shell.enroll}
                    </Button>
                  </li>
                ))}
            </ul>
            <div className="mt-1 px-1 text-[12px] text-slate-500">{tr.shell.federationHint}</div>
          </>
        )}
      </div>
      <ComputerSheet profileId={computer} onClose={() => setComputer(null)} onDone={onClose} />
    </Sheet>
  );
}
