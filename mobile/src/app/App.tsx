import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpenTextIcon, CaretDownIcon, GearSixIcon, KanbanIcon, MicrophoneIcon, ShieldCheckIcon, SparkleIcon, TerminalWindowIcon, TrayIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { SettingsSheet } from '../components/SettingsSheet';
import { useTabSwipe } from '../components/gestures';
import { Button, Spinner } from '../components/ui';
import type { Dict } from '../i18n';
import { useT } from '../i18n/react';
import { isActiveStatus } from '../protocol/models';
import { profileProblems, type HostProfile } from '../protocol/pairing';
import { routeLabel } from '../protocol/remoteClient';
import { AgentsScreen } from '../screens/AgentsScreen';
import { ComputersScreen } from '../screens/ComputersScreen';
import { DocsScreen } from '../screens/DocsScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { PairingScreen } from '../screens/PairingScreen';
import { ProcessesScreen } from '../screens/ProcessesScreen';
import { StudioScreen } from '../screens/StudioScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { VoiceScreen } from '../screens/VoiceScreen';
import { FieldEditorHost } from '../components/FieldEditor';
import { useAppState, useHostSummaries, useServices } from './context';
import { useInboxFeed } from './useInbox';

/** Нижнее меню (TASK-140.16): «Агенты» — раздел Studio, на их месте документация проекта (TASK-140.17). */
type Tab = 'inbox' | 'docs' | 'tasks' | 'processes' | 'studio';
type StudioSection = 'chat' | 'agents';

const TABS: Array<{ id: Tab; label: (tr: Dict) => string; icon: (active: boolean) => ReactNode }> = [
  { id: 'inbox', label: (tr) => tr.shell.tabs.inbox, icon: (a) => <TrayIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'docs', label: (tr) => tr.shell.tabs.docs, icon: (a) => <BookOpenTextIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'tasks', label: (tr) => tr.shell.tabs.tasks, icon: (a) => <KanbanIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'processes', label: (tr) => tr.shell.tabs.processes, icon: (a) => <TerminalWindowIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'studio', label: (tr) => tr.shell.tabs.studio, icon: (a) => <SparkleIcon size={24} weight={a ? 'fill' : 'regular'} /> }
];

function ConnectionBanner() {
  const { client } = useServices();
  const tr = useT();
  const conn = useAppState((s) => s.conn);
  if (conn.state === 'ready') return null;
  const tone = conn.state === 'failed' ? 'bg-red-950/80 text-red-100' : conn.state === 'awaiting_approval' ? 'bg-amber-950/80 text-amber-100' : 'bg-ph-elevated text-slate-300';
  return (
    <div className={clsx('flex items-center gap-2 px-3 py-2 text-[13px]', tone)}>
      <span className="min-w-0 flex-1">
        {tr.shell.conn[conn.state] ?? conn.state}
        {/* Какой адрес пробуем сейчас: при переборе видно, что клиент не завис (TASK-140.9). */}
        {(conn.state === 'connecting' || conn.state === 'pairing' || (conn.state === 'reconnecting' && !conn.retryInMs)) && conn.endpoint
          ? ` (${conn.endpoint})`
          : ''}
        {conn.retryInMs ? tr.shell.retryIn(Math.round(conn.retryInMs / 1000)) : ''}
        {conn.error ? ` — ${conn.error}` : ''}
      </span>
      {(conn.state === 'reconnecting' || conn.state === 'failed') && (
        <Button size="sm" onClick={() => client.retryNow()}>
          {tr.common.retry}
        </Button>
      )}
    </div>
  );
}

function AwaitingApproval() {
  const { client, addHost, platform } = useServices();
  const tr = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center bg-ph-chrome px-6 pt-safe text-center">
      <ShieldCheckIcon size={48} className="text-amber-400" />
      <div className="mt-4 text-[20px] font-semibold">{tr.shell.awaiting.title}</div>
      <div className="mt-2 max-w-sm text-[14px] leading-relaxed text-slate-300">
        {tr.shell.awaiting.before}
        <b>Remote</b>
        {tr.shell.awaiting.after(platform.deviceName)}
      </div>
      <div className="mt-6 flex items-center gap-2 text-[13px] text-slate-400">
        <Spinner className="h-3 w-3" /> {tr.shell.awaiting.waiting}
      </div>
      <div className="mt-8 flex gap-2">
        <Button size="sm" onClick={() => client.retryNow()}>
          {tr.common.retry}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => addHost()}>
          {tr.shell.awaiting.otherComputer}
        </Button>
      </div>
    </div>
  );
}

/** Studio: чат с агентом и рои агентов проекта — два раздела одной вкладки (TASK-140.16). */
function StudioHub({ section, onSection }: { section: StudioSection; onSection: (s: StudioSection) => void }) {
  const { platform } = useServices();
  const tr = useT();
  const running = useAppState((s) => s.swarms.filter((w) => isActiveStatus(w.status)).length);
  const sections: StudioSection[] = ['chat', 'agents'];
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-2" role="tablist" aria-label={tr.shell.tabs.studio}>
        <div className="flex gap-1 rounded-xl bg-ph-raised p-1">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === section}
              data-testid={`studio-section-${s}`}
              onClick={() => {
                if (s === section) return;
                platform.haptic('selection');
                onSection(s);
              }}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]',
                s === section ? 'bg-ph-elevated font-medium text-slate-100' : 'text-slate-400 active:bg-ph-hover'
              )}
            >
              {tr.shell.studioSections[s]}
              {s === 'agents' && running > 0 && (
                <span className="min-w-[18px] rounded-full bg-indigo-500 px-1 text-center text-[11px] font-semibold leading-[18px] text-white">{running}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">{section === 'chat' ? <StudioScreen /> : <AgentsScreen />}</div>
    </div>
  );
}

function Shell() {
  const { platform, store } = useServices();
  const tr = useT();
  const status = useAppState((s) => s.status);
  const projects = useAppState((s) => s.projects);
  const projectPath = useAppState((s) => s.projectPath);
  // Счётчик вкладки «Входящие»: что ждёт решения на всех ПК — HITL, задачи агентов, задачи в Review (TASK-140.5).
  const hitlCount = useInboxFeed().actionable;
  const conn = useAppState((s) => s.conn);
  // Решения, которые ждут на других компьютерах телефона (TASK-140.2): видно, не открывая переключатель.
  const summaries = useHostSummaries();
  const othersPending = Object.values(summaries).reduce((n, s) => n + s.pending, 0);
  const [tab, setTab] = useState<Tab>('inbox');
  const [studioSection, setStudioSection] = useState<StudioSection>('chat');
  const [hostOpen, setHostOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [tasksFocus, setTasksFocus] = useState<string | undefined>();
  const project = projects.find((p) => p.path === projectPath);

  // Переход с экрана «Компьютеры» (TASK-174): сессия Studio — чат, агент роя — раздел «Агенты» (вывод откроет он сам),
  // терминал — «Входящие», где его запросы.
  const nav = useAppState((s) => s.nav);
  useEffect(() => {
    if (!nav) return;
    if (nav.kind === 'studio') {
      setTab('studio');
      setStudioSection('chat');
      void store.openStudioSession(nav.sessionId);
      store.consumeNav(nav.seq);
    } else if (nav.kind === 'swarm') {
      setTab('studio');
      setStudioSection('agents');
    } else {
      if (nav.kind === 'terminal') setTab('inbox');
      store.consumeNav(nav.seq);
    }
  }, [nav, store]);

  const go = (next: Tab) => {
    if (next === tab) return;
    platform.haptic('selection');
    setTab(next);
  };
  const swipe = useTabSwipe((dir) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    const next = TABS[dir === 'left' ? Math.min(TABS.length - 1, idx + 1) : Math.max(0, idx - 1)];
    go(next.id);
  });

  // Хост не отдаёт данные неодобренному устройству — вместо пустых экранов объясняем, что сделать на ПК.
  if (conn.state === 'awaiting_approval') return <AwaitingApproval />;

  return (
    <div className="flex h-full flex-col bg-ph-chrome">
      <header className="shrink-0 border-b border-ph-line bg-ph-chrome pt-safe">
        <div className="flex items-center">
          <button type="button" onClick={() => setHostOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-4 pr-2 text-left active:bg-ph-hover">
            <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', conn.state === 'ready' ? 'bg-emerald-400' : conn.state === 'failed' ? 'bg-red-400' : 'bg-amber-400')} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{project?.name || tr.common.noProject}</span>
              <span className="block truncate text-[12px] text-slate-400">
                {status?.machineName || 'ProjectHub'}
                {conn.state === 'ready' && conn.route ? ` · ${routeLabel(conn.route)}` : ''}
              </span>
            </span>
            {othersPending > 0 && (
              <span data-testid="others-pending" className="shrink-0 rounded-full bg-amber-500 px-2 text-[12px] font-semibold leading-[20px] text-black">
                +{othersPending}
              </span>
            )}
            <CaretDownIcon size={18} className="shrink-0 text-slate-400" />
          </button>
          <button
            type="button"
            data-testid="open-voice"
            aria-label={tr.voice.open}
            onClick={() => {
              platform.haptic('selection');
              setVoiceOpen(true);
            }}
            className="shrink-0 self-stretch px-3 text-slate-300 active:bg-ph-hover"
          >
            <MicrophoneIcon size={22} />
          </button>
          <button
            type="button"
            data-testid="open-settings"
            aria-label={tr.shell.settings}
            onClick={() => {
              platform.haptic('selection');
              setSettingsOpen(true);
            }}
            className="shrink-0 self-stretch px-4 text-slate-300 active:bg-ph-hover"
          >
            <GearSixIcon size={22} />
          </button>
        </div>
        <ConnectionBanner />
      </header>

      <main className="min-h-0 flex-1" {...swipe}>
        {tab === 'inbox' && (
          <InboxScreen
            onOpenReview={() => {
              setTasksFocus('Review');
              go('tasks');
            }}
          />
        )}
        {tab === 'docs' && <DocsScreen />}
        {tab === 'tasks' && <TasksScreen focusStatus={tasksFocus} />}
        {tab === 'processes' && <ProcessesScreen />}
        {tab === 'studio' && <StudioHub section={studioSection} onSection={setStudioSection} />}
      </main>

      <nav className="shrink-0 border-t border-ph-line bg-ph-chrome pb-safe" role="tablist">
        <div className="flex">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => go(t.id)}
                className={clsx('relative flex flex-1 flex-col items-center gap-0.5 pb-1.5 pt-2 text-[10.5px]', active ? 'text-indigo-400' : 'text-slate-400')}
              >
                {t.icon(active)}
                <span>{t.label(tr)}</span>
                {t.id === 'inbox' && hitlCount > 0 && (
                  <span className="absolute left-1/2 top-1 ml-2 min-w-[18px] rounded-full bg-amber-500 px-1 text-center text-[11px] font-semibold leading-[18px] text-black">
                    {hitlCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      <ComputersScreen open={hostOpen} onClose={() => setHostOpen(false)} onOpenInbox={() => go('inbox')} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <VoiceScreen open={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </div>
  );
}

function Toasts() {
  const { store } = useServices();
  const toast = useAppState((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => store.dismissToast(toast.id), toast.kind === 'error' ? 4500 : 2200);
    return () => clearTimeout(t);
  }, [toast, store]);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[10000] flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+56px)]">
      <div
        role="status"
        className={clsx(
          'ph-fade-enter pointer-events-auto max-w-sm rounded-xl px-4 py-2.5 text-[14px] shadow-lg shadow-black/40',
          toast.kind === 'error' ? 'bg-red-900 text-red-50' : toast.kind === 'success' ? 'bg-emerald-800 text-emerald-50' : 'bg-ph-elevated text-slate-100'
        )}
        onClick={() => store.dismissToast(toast.id)}
      >
        {toast.text}
      </div>
    </div>
  );
}

/**
 * Корень клиента: сопряжение, пока профиль неполон, подключение не удалось или добавляется ещё один компьютер, иначе
 * основной интерфейс. Подключение заново — только по явному действию (`seq`): обновления профиля от клиента (токен,
 * адреса) соединение не рвут.
 */
export function App({ profile, seq, adding }: { profile: HostProfile; seq: number; adding: boolean }) {
  const { client, platform, profiles } = useServices();
  const conn = useAppState((s) => s.conn);
  const complete = !adding && profileProblems(profile).length === 0 && platform.cryptoAvailable();
  const profileRef = useRef(profile);
  profileRef.current = profile;

  useEffect(() => {
    if (complete) client.connect(profileRef.current);
    return () => client.disconnect();
  }, [client, seq, complete]);

  const showPairing = !complete || conn.state === 'failed';
  return (
    <>
      {showPairing ? (
        <PairingScreen
          key={`${seq}:${profile.hostId}:${profile.key}`}
          initial={(!adding && client.getProfile()?.id === profile.id && client.getProfile()) || profile}
          error={!adding && conn.state === 'failed' ? conn.error : null}
          canCancel={profiles.profiles.length > 0 && (adding || profiles.profiles.length > 1)}
        />
      ) : (
        <Shell />
      )}
      <FieldEditorHost />
      <Toasts />
    </>
  );
}
