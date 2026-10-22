import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  DesktopIcon,
  DotsThreeIcon,
  LockKeyIcon,
  PlusIcon,
  RobotIcon,
  StackIcon,
  TerminalWindowIcon,
  WarningIcon,
  WifiSlashIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { useFleet, useScopeActions } from '../app/useFleet';
import { ComputerSheet, useRetryHost } from '../components/ComputerSheet';
import { IntroduceCard } from '../components/IntroduceCard';
import { RouteBadge } from '../components/RouteBadge';
import { Screen } from '../components/Screen';
import { Badge, Button, SectionTitle, Spinner } from '../components/ui';
import { useT } from '../i18n/react';
import { timeAgo } from '../protocol/inbox';
import type { HitlItem } from '../protocol/models';
import { projectKey, type PhoneFleetHost } from '../protocol/fleet';
import { activeProfile, catalogEntries } from '../protocol/profiles';
import { samePath, type Scope } from '../protocol/scope';
import {
  fleetTotals,
  overviewSessionDetail,
  splitQuietProjects,
  type OverviewAttention,
  type OverviewPendingRequest,
  type OverviewProject,
  type OverviewSession,
  type OverviewSessionState
} from '../../../src/utils/fleetOverview';

/**
 * «Обзор» — главная страница телефона (TASK-181, [[decision-139]]; дерево — TASK-174, [[decision-129]] п. 11):
 * «Все компьютеры» → компьютеры → проекты → сессии. Выбранный узел — область нижнего меню. Раскрыт один проект:
 * выбранный человеком, иначе первый ждущий решения.
 */

export const DOT: Record<OverviewAttention, string> = {
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

export function Pill({ tone, children }: { tone: 'amber' | 'emerald' | 'red' | 'violet'; children: ReactNode }) {
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

/** Строка сессии: на «Обзоре» внутри проекта, в Studio вне проекта — списком по области. */
export function SessionRow({ session: s, onOpen, children }: { session: OverviewSession; onOpen: () => void; children?: ReactNode }) {
  const tr = useT();
  return (
    <li className="border-t border-ph-line/60 first:border-t-0">
      <button type="button" data-testid={`fleet-session-${s.id}`} onClick={onOpen} className="flex w-full items-start gap-2.5 py-2.5 pl-2 pr-1 text-left active:bg-ph-hover">
        <KindIcon kind={s.kind} className={clsx('mt-0.5 shrink-0', STATE_TONE[s.state])} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px]">{s.title}</span>
            <span className={clsx('shrink-0 text-[12px]', STATE_TONE[s.state])}>{tr.fleet.states[s.state]}</span>
          </span>
          <span className={clsx('block truncate text-[13px]', s.state === 'waiting' ? 'text-amber-200' : 'text-slate-400')}>
            {overviewSessionDetail(s, tr.models.hitlText) || (s.kind === 'terminal' ? tr.fleet.terminalHint : tr.fleet.kinds[s.kind])}
          </span>
        </span>
      </button>
      {children}
    </li>
  );
}

export interface ComputersScreenProps {
  /** Запрос `high`: его проверяют во «Входящих» открытого ПК, с диффом и биометрией. */
  onOpenInbox: () => void;
  /** Процессы проекта: страница поверх вкладки, проект уже выбран областью. */
  onOpenProcesses: () => void;
}

export function ComputersScreen({ onOpenInbox, onOpenProcesses }: ComputersScreenProps) {
  const { store, pool, platform, profiles, switchHost, addHost, enrollHost, inbox } = useServices();
  const tr = useT();
  const projectPath = useAppState((s) => s.projectPath);
  const scope = useAppState((s) => s.scope);
  const hosts = useAppState((s) => s.hosts);
  const fleet = useFleet();
  const actions = useScopeActions();
  const retry = useRetryHost();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showQuiet, setShowQuiet] = useState<Record<string, boolean>>({});
  const [computer, setComputer] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const active = activeProfile(profiles);
  const catalog = catalogEntries(profiles, active, hosts);
  const totals = fleetTotals(fleet);

  const autoOpen = useMemo(() => {
    if (scope.kind === 'project') return projectKey(scope.profileId, scope.projectPath);
    for (const h of fleet) for (const p of h.overview?.projects ?? []) if (p.attention === 'waiting') return projectKey(h.profileId, p.path);
    return null;
  }, [fleet, scope]);
  const openKey = expanded ?? autoOpen;

  const choose = (next: Scope, host?: PhoneFleetHost) => {
    platform.haptic('selection');
    actions.select(next, host);
  };

  const decide = async (host: PhoneFleetHost, s: OverviewSession, req: OverviewPendingRequest, approve: boolean) => {
    const source = { profileId: host.profileId, machineName: host.machineName, online: host.online, active: host.active, hitl: [], agentTasks: [], review: [], events: [] };
    const item = { requestId: req.requestId, sessionId: s.id, title: req.title, ...(req.textKey ? { textKey: req.textKey } : {}) } as HitlItem;
    // Решение уходит тому ПК, с которого строка, его соединением; дерево обновит событие `overview:changed`.
    if ((await inbox.decideHitl(source, item, approve)) && host.active) void store.refreshOverview();
  };

  const reviewHigh = (host: PhoneFleetHost) => {
    platform.haptic('selection');
    if (!host.active) switchHost(host.profileId);
    onOpenInbox();
  };

  const enroll = async (hostId: string) => {
    setEnrolling(hostId);
    try {
      if (await enrollHost(hostId)) platform.haptic('success');
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

  const renderProject = (host: PhoneFleetHost, p: OverviewProject, canDecide: boolean) => {
    const key = projectKey(host.profileId, p.path);
    const isOpen = openKey === key;
    const selected = scope.kind === 'project' && scope.profileId === host.profileId && samePath(scope.projectPath, p.path);
    const current = host.active && p.path === projectPath;
    const projectScope: Scope = { kind: 'project', profileId: host.profileId, projectPath: p.path };
    return (
      <li key={key} className={clsx('rounded-xl', selected ? 'bg-indigo-950/70 ring-1 ring-indigo-500/60' : isOpen && 'bg-ph-elevated')}>
        <div className="flex items-center">
          <button
            type="button"
            aria-label={isOpen ? tr.fleet.collapse : tr.fleet.expand}
            onClick={() => {
              platform.haptic('selection');
              setExpanded(isOpen ? '' : key);
            }}
            className="shrink-0 rounded-xl py-2.5 pl-2 pr-1.5 text-slate-500 active:bg-ph-hover"
          >
            {isOpen ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
          </button>
          <button
            type="button"
            data-testid={`fleet-project-${p.name}`}
            aria-pressed={selected}
            onClick={() => {
              choose(projectScope, host);
              setExpanded(key);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pr-2 text-left active:bg-ph-hover"
          >
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[p.attention])} />
            <span className={clsx('min-w-0 flex-1 truncate text-[15px]', (selected || current) && 'font-semibold', selected && 'text-indigo-100')}>{p.name}</span>
            {p.processes.failed > 0 && <WarningIcon size={16} className="shrink-0 text-red-400" />}
            {p.counts.waiting > 0 && <Pill tone="amber">{p.counts.waiting}</Pill>}
            {p.counts.failed > 0 && <Pill tone="red">{p.counts.failed}</Pill>}
            {p.counts.running > 0 && <Pill tone="emerald">{p.counts.running}</Pill>}
            {p.tasks.review > 0 && <Pill tone="violet">R{p.tasks.review}</Pill>}
          </button>
        </div>
        {isOpen && (
          <div className="pb-1 pl-6 pr-1">
            {(p.tasks.inProgress > 0 || p.tasks.review > 0) && (
              <div className="pb-1 text-[12px] text-slate-500">
                {[p.tasks.inProgress > 0 ? tr.fleet.inProgress(p.tasks.inProgress) : '', p.tasks.review > 0 ? tr.fleet.review(p.tasks.review) : ''].filter(Boolean).join(' · ')}
              </div>
            )}
            <button
              type="button"
              data-testid={`fleet-processes-${p.name}`}
              onClick={() => {
                actions.select(projectScope, host);
                onOpenProcesses();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg py-2 pl-2 pr-1 text-left active:bg-ph-hover"
            >
              <StackIcon size={18} className={clsx('shrink-0', p.processes.failed > 0 ? 'text-red-400' : 'text-slate-400')} />
              <span className="min-w-0 flex-1 text-[14px]">{tr.fleet.processes}</span>
              <span className={clsx('shrink-0 text-[12px]', p.processes.failed > 0 ? 'text-red-300' : 'text-slate-500')}>
                {host.unsupported
                  ? ''
                  : p.processes.failed > 0 && p.processes.failedNames?.length
                    ? p.processes.failedNames.join(', ')
                    : tr.fleet.processesCount(p.processes.running, p.processes.failed)}
              </span>
              <CaretRightIcon size={14} className="shrink-0 text-slate-500" />
            </button>
            {/* Старый хост: подсказка обновиться уже есть у компьютера. */}
            {p.sessions.length === 0 ? (
              !host.unsupported && <div className="py-2 pl-2 text-[13px] text-slate-500">{tr.fleet.noSessions}</div>
            ) : (
              <ul>
                {p.sessions.map((s) => (
                  <SessionRow
                    key={`${s.kind}:${s.id}`}
                    session={s}
                    onOpen={() => {
                      platform.haptic('selection');
                      actions.open(host, p.path, s.kind, s.id, s.agentId);
                    }}
                  >
                    {s.pending && <div className="pb-2 pl-9">{s.pending.map((req) => renderPending(host, s, req, canDecide))}</div>}
                  </SessionRow>
                ))}
              </ul>
            )}
            {p.moreSessions > 0 && <div className="py-1 pl-2 text-[12px] text-slate-500">{tr.fleet.moreSessions(p.moreSessions)}</div>}
          </div>
        )}
      </li>
    );
  };

  const renderHost = (host: PhoneFleetHost) => {
    const selected = scope.kind === 'host' && scope.profileId === host.profileId;
    const folded = Boolean(collapsed[host.profileId]);
    // Одна строка без текста ошибки (TASK-191): почему нет связи — в карточке компьютера по значку.
    const offlineLine = host.connecting
      ? tr.fleet.connecting
      : [tr.fleet.offline, host.lastSeenAt ? tr.fleet.lastSeen(timeAgo(host.lastSeenAt)) : tr.fleet.neverSeen].join(' · ');
    const header = (
      <div className={clsx('flex items-center gap-1 rounded-xl', selected && 'bg-indigo-950/70 ring-1 ring-indigo-500/60')}>
        <button
          type="button"
          aria-label={folded ? tr.fleet.expand : tr.fleet.collapse}
          onClick={() => setCollapsed((prev) => ({ ...prev, [host.profileId]: !folded }))}
          className="shrink-0 rounded-xl py-2.5 pl-2 pr-1 text-slate-500 active:bg-ph-hover"
        >
          {folded || !host.online ? <CaretRightIcon size={14} /> : <CaretDownIcon size={14} />}
        </button>
        {!host.online && (
          <button
            type="button"
            aria-label={tr.shell.connDetails}
            data-testid={`fleet-host-conn-${host.profileId}`}
            onClick={() => setComputer(host.profileId)}
            className="flex shrink-0 items-center self-stretch rounded-xl px-1 active:bg-ph-hover"
          >
            {host.connecting ? <Spinner className="h-3.5 w-3.5" /> : <WifiSlashIcon size={16} className="text-slate-500" />}
          </button>
        )}
        <button
          type="button"
          data-testid={`fleet-host-${host.profileId}`}
          aria-pressed={selected}
          onClick={() => choose({ kind: 'host', profileId: host.profileId }, host)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left active:bg-ph-hover"
        >
          {host.online && <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', host.overview ? DOT[host.overview.attention] : 'bg-emerald-400')} />}
          <span className="min-w-0 flex-1">
            <span className={clsx('block truncate text-[15px] font-semibold', !host.online && 'font-normal text-slate-500', selected && 'text-indigo-100')}>{host.machineName}</span>
            <span className="block truncate text-[12px] text-slate-500" data-testid={`fleet-host-line-${host.profileId}`}>
              {host.online
                ? [host.active ? tr.fleet.current : '', host.overview?.actions === 'none' && !host.unsupported ? tr.fleet.viewOnly : '', host.via ? tr.shell.via(host.via) : '']
                    .filter(Boolean)
                    .join(' · ') || ' '
                : offlineLine}
            </span>
          </span>
          {host.online && host.active && <RouteBadge route={host.route} />}
          {host.overview && host.overview.counts.waiting > 0 && <Pill tone="amber">{host.overview.counts.waiting}</Pill>}
          {host.overview && host.overview.counts.running > 0 && <Pill tone="emerald">{host.overview.counts.running}</Pill>}
        </button>
        {!host.online && !host.connecting && (
          <button
            type="button"
            aria-label={tr.shell.reconnect}
            data-testid={`fleet-host-retry-${host.profileId}`}
            onClick={() => retry(host.profileId)}
            className="shrink-0 rounded-xl px-2 py-2 text-slate-400 active:bg-ph-hover"
          >
            <ArrowClockwiseIcon size={18} />
          </button>
        )}
        <button
          type="button"
          aria-label={tr.shell.computerDetails}
          data-testid={`host-more-${host.profileId}`}
          onClick={() => setComputer(host.profileId)}
          className="shrink-0 rounded-xl px-2 py-2 text-slate-400 active:bg-ph-hover"
        >
          <DotsThreeIcon size={20} weight="bold" />
        </button>
      </div>
    );
    // Офлайн-компьютер — одна серая строка: устаревшие «работает» и «ждёт» ввели бы в заблуждение.
    if (!host.online || folded) return <section key={host.profileId}>{header}</section>;
    const projects = host.overview?.projects ?? [];
    const { visible, quiet } = splitQuietProjects(projects, host.active ? projectPath : null);
    const canDecide = (host.overview?.actions ?? 'none') !== 'none';
    const quietOpen = Boolean(showQuiet[host.profileId]);
    return (
      <section key={host.profileId} className="pb-2">
        {header}
        <div className="pl-4">
          {host.unsupported && <div className="py-1.5 pl-2 text-[12px] text-amber-300/80">{tr.fleet.unsupported}</div>}
          {host.overview && projects.length === 0 && <div className="py-2 pl-2 text-[13px] text-slate-500">{tr.fleet.noProjects}</div>}
          <ul className="mt-0.5 space-y-0.5">
            {/* Права устройства на проект бывают уже, чем на хост (TASK-180): кнопки решений — по проекту. */}
            {visible.map((p) => renderProject(host, p, canDecide && (p.actions ?? 'full') !== 'none'))}
            {quietOpen && quiet.map((p) => renderProject(host, p, canDecide && (p.actions ?? 'full') !== 'none'))}
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
        </div>
      </section>
    );
  };

  const allSelected = scope.kind === 'all';
  return (
    <Screen
      onRefresh={() =>
        Promise.all([store.refreshAll(), ...fleet.filter((h) => !h.active).map((h) => pool.refreshOverview(h.profileId))]).then(() => undefined)
      }
    >
      <div data-testid="fleet-screen">
        <button
          type="button"
          data-testid="fleet-all"
          aria-pressed={allSelected}
          onClick={() => choose({ kind: 'all' })}
          className={clsx('mb-1 flex w-full items-center gap-2.5 rounded-xl px-2 py-2.5 text-left active:bg-ph-hover', allSelected && 'bg-indigo-950/70 ring-1 ring-indigo-500/60')}
        >
          <DesktopIcon size={20} className={clsx('shrink-0', allSelected ? 'text-indigo-300' : 'text-slate-400')} />
          <span className="min-w-0 flex-1">
            <span className={clsx('block text-[16px] font-semibold', allSelected && 'text-indigo-100')}>{tr.fleet.all}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-500" data-testid="fleet-summary">
              {totals.waiting > 0 && <Badge tone="warning">{tr.fleet.summaryWaiting(totals.waiting)}</Badge>}
              {totals.failed > 0 && <Badge tone="danger">{tr.fleet.summaryFailed(totals.failed)}</Badge>}
              {totals.running > 0 && <Badge tone="success">{tr.fleet.summaryRunning(totals.running)}</Badge>}
              {totals.waiting + totals.failed + totals.running === 0 && <span>{tr.fleet.allQuiet}</span>}
              <span>· {tr.fleet.summaryOnline(totals.online, totals.total)}</span>
            </span>
          </span>
        </button>

        <div className="ml-2 border-l border-ph-line/70 pl-1">{fleet.map(renderHost)}</div>

        <IntroduceCard fleet={fleet} />

        <Button variant="ghost" className="mt-2 w-full" onClick={() => addHost()}>
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
      <ComputerSheet profileId={computer} onClose={() => setComputer(null)} />
    </Screen>
  );
}
