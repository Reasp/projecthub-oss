import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon, BookOpenTextIcon, CaretRightIcon, KanbanIcon, SparkleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { useFleet, useScopeActions } from '../app/useFleet';
import { Screen } from '../components/Screen';
import { Badge, Card, EmptyState, SectionTitle, Spinner } from '../components/ui';
import { useT } from '../i18n/react';
import { criteriaProgress } from '../protocol/models';
import type { PhoneFleetHost } from '../protocol/fleet';
import type { RpcMethod } from '../protocol/remoteClient';
import { groupScopedTasks, hostInScope, loadScopedTasks, scopeProjects, type ScopedTask, type ScopeProjectRef, type ScopeRpc } from '../protocol/scope';
import { DOT, SessionRow } from './ComputersScreen';

/**
 * Вкладки нижнего меню вне проекта (TASK-181, [[decision-139]]): область «Все» или компьютер. Задачи — общей доской
 * по всем проектам области, Studio — сессиями всех проектов, Документы — выбором проекта (документация живёт в нём).
 */

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'review' | 'success'> = {
  'To Do': 'neutral',
  'In Progress': 'accent',
  Review: 'review',
  Done: 'success'
};

/** Нет компьютеров в сети или проектов в области — общая пустая заглушка. */
function ScopeEmpty({ fleet, icon }: { fleet: PhoneFleetHost[]; icon: ReactNode }) {
  const tr = useT();
  const scope = useAppState((s) => s.scope);
  const offline = scope.kind !== 'all' && !fleet.find((h) => h.profileId === scope.profileId)?.online;
  return <EmptyState icon={icon} title={offline ? tr.fleet.scopeOffline : tr.fleet.scopeEmpty} />;
}

function hostOf(fleet: PhoneFleetHost[], ref: ScopeProjectRef): PhoneFleetHost | undefined {
  return fleet.find((h) => h.profileId === ref.profileId);
}

/** Общая доска задач области: колонки по статусу, у карточки — проект и компьютер; задача открывается в своём проекте. */
export function ScopeTasks() {
  const { client, pool, platform } = useServices();
  const tr = useT();
  const scope = useAppState((s) => s.scope);
  const fleet = useFleet();
  const actions = useScopeActions();
  const refs = useMemo(() => scopeProjects(fleet, scope), [fleet, scope]);
  // Перечитываем доску при смене набора проектов, а не при каждом обновлении счётчиков дерева.
  const refsKey = refs.map((r) => `${r.profileId}|${r.projectPath}`).join('\n');
  const [state, setState] = useState<{ key: string; tasks: ScopedTask[]; failed: ScopeProjectRef[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const board = useRef<HTMLDivElement>(null);
  const refsRef = useRef(refs);
  refsRef.current = refs;

  const load = useCallback(async () => {
    const list = refsRef.current;
    const key = list.map((r) => `${r.profileId}|${r.projectPath}`).join('\n');
    setLoading(true);
    const rpcFor = (ref: ScopeProjectRef): ScopeRpc | null => {
      if (ref.active) return <T,>(method: RpcMethod, params: Record<string, unknown>) => client.rpc<T>(method, params);
      return pool.isReady(ref.profileId) ? <T,>(method: RpcMethod, params: Record<string, unknown>) => pool.rpc<T>(ref.profileId, method, params) : null;
    };
    const res = await loadScopedTasks(list, rpcFor);
    setState({ key, ...res });
    setLoading(false);
  }, [client, pool]);

  useEffect(() => {
    void load();
  }, [refsKey, load]);

  const columns = useMemo(() => groupScopedTasks(state?.tasks ?? []), [state]);
  const multiHost = new Set(refs.map((r) => r.profileId)).size > 1;

  const scrollTo = (index: number) => {
    const el = board.current;
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  };

  if (refs.length === 0) return <ScopeEmpty fleet={fleet} icon={<KanbanIcon size={40} />} />;
  if (!state)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  return (
    <div className="flex h-full flex-col" data-testid="scope-tasks">
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2 pt-3" data-swipe-ignore>
        {columns.map((c, i) => (
          <button
            key={c.status}
            type="button"
            onClick={() => scrollTo(i)}
            className={clsx('shrink-0 rounded-full px-3 py-1.5 text-[13px]', i === active ? 'bg-indigo-500 text-white' : 'bg-ph-raised text-slate-300')}
          >
            {c.status} <span className="opacity-70">{c.tasks.length}</span>
          </button>
        ))}
        <button type="button" aria-label={tr.tasks.refresh} onClick={() => void load()} className="ml-auto shrink-0 rounded-full p-1.5 text-slate-400 active:bg-ph-hover">
          {loading ? <Spinner className="h-[18px] w-[18px]" /> : <ArrowClockwiseIcon size={18} />}
        </button>
      </div>
      {state.failed.length > 0 && (
        <div className="px-4 pb-1 text-[12px] text-amber-300/80">{tr.fleet.tasksFailed(state.failed.map((r) => r.projectName).join(', '))}</div>
      )}
      <div
        ref={board}
        data-swipe-ignore
        className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          const idx = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (idx !== active) setActive(idx);
        }}
      >
        {columns.map((c) => (
          <section key={c.status} className="h-full w-full shrink-0 snap-start overflow-y-auto px-3 pb-24">
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
            </div>
            {c.tasks.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-slate-500">{tr.tasks.empty}</div>
            ) : (
              c.tasks.map(({ ref, task }) => {
                const { done, total } = criteriaProgress(task);
                return (
                  <Card
                    key={`${ref.profileId}|${task.filePath}`}
                    className="mb-2"
                    onClick={() => {
                      const host = hostOf(fleet, ref);
                      if (!host) return;
                      platform.haptic('selection');
                      actions.open(host, ref.projectPath, 'task', task.filePath);
                    }}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="font-mono">{task.id}</span>
                      {String(task.priority).toLowerCase() === 'high' && <Badge tone="warning">high</Badge>}
                      <span className="ml-auto min-w-0 truncate text-indigo-300/90" data-testid="scope-task-project">
                        {multiHost ? `${ref.machineName} · ${ref.projectName}` : ref.projectName}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-3 text-[14px] leading-snug">{task.title}</div>
                    {total > 0 && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ph-raised">
                          <div className="h-full bg-emerald-500" style={{ width: `${(done / total) * 100}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-400">
                          {done}/{total}
                        </span>
                      </div>
                    )}
                  </Card>
                );
              })
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Проекты области списком по компьютерам: нажатие делает проект областью. */
export function ProjectPicker({ hint }: { hint?: string }) {
  const { platform } = useServices();
  const scope = useAppState((s) => s.scope);
  const fleet = useFleet();
  const actions = useScopeActions();
  const hosts = fleet.filter((h) => h.online && hostInScope(scope, h.profileId) && (h.overview?.projects.length ?? 0) > 0);
  return (
    <div data-testid="scope-projects">
      {hint && <div className="px-1 pb-1 text-[13px] text-slate-400">{hint}</div>}
      {hosts.map((host) => (
        <div key={host.profileId}>
          {(scope.kind === 'all' || hosts.length > 1) && <SectionTitle>{host.machineName}</SectionTitle>}
          <ul className="space-y-0.5">
            {host.overview!.projects.map((p) => (
              <li key={p.path}>
                <button
                  type="button"
                  data-testid={`scope-project-${p.name}`}
                  onClick={() => {
                    platform.haptic('selection');
                    actions.select({ kind: 'project', profileId: host.profileId, projectPath: p.path }, host);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2.5 text-left active:bg-ph-hover"
                >
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[p.attention])} />
                  <span className="min-w-0 flex-1 truncate text-[15px]">{p.name}</span>
                  <CaretRightIcon size={14} className="shrink-0 text-slate-500" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Документы вне проекта: документация живёт в проекте — выбрать его. */
export function ScopeDocs() {
  const tr = useT();
  const scope = useAppState((s) => s.scope);
  const fleet = useFleet();
  if (scopeProjects(fleet, scope).length === 0) return <ScopeEmpty fleet={fleet} icon={<BookOpenTextIcon size={40} />} />;
  return (
    <Screen>
      <ProjectPicker hint={tr.fleet.docsPick} />
    </Screen>
  );
}

/** Studio вне проекта: сессии всех проектов области по вниманию, ниже — выбор проекта для нового чата. */
export function ScopeSessions() {
  const { platform, store, pool } = useServices();
  const tr = useT();
  const scope = useAppState((s) => s.scope);
  const fleet = useFleet();
  const actions = useScopeActions();
  const groups = fleet
    .filter((h) => h.online && hostInScope(scope, h.profileId))
    .flatMap((host) => (host.overview?.projects ?? []).filter((p) => p.sessions.length > 0).map((p) => ({ host, p })));
  if (scopeProjects(fleet, scope).length === 0) return <ScopeEmpty fleet={fleet} icon={<SparkleIcon size={40} />} />;
  return (
    <Screen onRefresh={() => Promise.all([store.refreshOverview(), ...fleet.filter((h) => !h.active).map((h) => pool.refreshOverview(h.profileId))]).then(() => undefined)}>
      <div data-testid="scope-sessions">
        {groups.length === 0 && <div className="px-1 py-3 text-[13px] text-slate-500">{tr.fleet.noSessions}</div>}
        {groups.map(({ host, p }) => (
          <div key={`${host.profileId}|${p.path}`} className="mb-2">
            <SectionTitle>{scope.kind === 'all' ? `${host.machineName} · ${p.name}` : p.name}</SectionTitle>
            <ul className="rounded-xl bg-ph-elevated px-1">
              {p.sessions.map((s) => (
                <SessionRow
                  key={`${s.kind}:${s.id}`}
                  session={s}
                  onOpen={() => {
                    platform.haptic('selection');
                    actions.open(host, p.path, s.kind, s.id, s.agentId);
                  }}
                />
              ))}
            </ul>
          </div>
        ))}
        <div className="mt-4">
          <ProjectPicker hint={tr.fleet.studioNew} />
        </div>
      </div>
    </Screen>
  );
}
