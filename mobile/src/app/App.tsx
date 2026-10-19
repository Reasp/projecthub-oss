import { useEffect, useState, type ReactNode } from 'react';
import { CaretDownIcon, KanbanIcon, RobotIcon, ShieldCheckIcon, SparkleIcon, TerminalWindowIcon, TrayIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { HostSheet } from '../components/HostSheet';
import { useTabSwipe } from '../components/gestures';
import { Button, Spinner } from '../components/ui';
import { profileProblems, type HostProfile } from '../protocol/pairing';
import { routeLabel } from '../protocol/remoteClient';
import { AgentsScreen } from '../screens/AgentsScreen';
import { InboxScreen } from '../screens/InboxScreen';
import { PairingScreen } from '../screens/PairingScreen';
import { ProcessesScreen } from '../screens/ProcessesScreen';
import { StudioScreen } from '../screens/StudioScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { useAppState, useServices } from './context';

type Tab = 'inbox' | 'agents' | 'tasks' | 'processes' | 'studio';

const TABS: Array<{ id: Tab; label: string; icon: (active: boolean) => ReactNode }> = [
  { id: 'inbox', label: 'Входящие', icon: (a) => <TrayIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'agents', label: 'Агенты', icon: (a) => <RobotIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'tasks', label: 'Задачи', icon: (a) => <KanbanIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'processes', label: 'Процессы', icon: (a) => <TerminalWindowIcon size={24} weight={a ? 'fill' : 'regular'} /> },
  { id: 'studio', label: 'Studio', icon: (a) => <SparkleIcon size={24} weight={a ? 'fill' : 'regular'} /> }
];

const STATE_TEXT: Record<string, string> = {
  idle: 'Не подключено',
  connecting: 'Подключение…',
  pairing: 'Рукопожатие…',
  awaiting_approval: 'Подтвердите устройство на ПК',
  reconnecting: 'Переподключение…',
  failed: 'Ошибка подключения'
};

function ConnectionBanner() {
  const { client } = useServices();
  const conn = useAppState((s) => s.conn);
  if (conn.state === 'ready') return null;
  const tone = conn.state === 'failed' ? 'bg-red-950/80 text-red-100' : conn.state === 'awaiting_approval' ? 'bg-amber-950/80 text-amber-100' : 'bg-ph-elevated text-slate-300';
  return (
    <div className={clsx('flex items-center gap-2 px-3 py-2 text-[13px]', tone)}>
      <span className="min-w-0 flex-1">
        {STATE_TEXT[conn.state] ?? conn.state}
        {/* Какой адрес пробуем сейчас: при переборе видно, что клиент не завис (TASK-140.9). */}
        {(conn.state === 'connecting' || conn.state === 'pairing' || (conn.state === 'reconnecting' && !conn.retryInMs)) && conn.endpoint
          ? ` (${conn.endpoint})`
          : ''}
        {conn.retryInMs ? ` через ${Math.round(conn.retryInMs / 1000)} с` : ''}
        {conn.error ? ` — ${conn.error}` : ''}
      </span>
      {(conn.state === 'reconnecting' || conn.state === 'failed') && (
        <Button size="sm" onClick={() => client.retryNow()}>
          Повторить
        </Button>
      )}
    </div>
  );
}

function AwaitingApproval() {
  const { client, forget, platform } = useServices();
  return (
    <div className="flex h-full flex-col items-center justify-center bg-ph-chrome px-6 pt-safe text-center">
      <ShieldCheckIcon size={48} className="text-amber-400" />
      <div className="mt-4 text-[20px] font-semibold">Подтвердите устройство на ПК</div>
      <div className="mt-2 max-w-sm text-[14px] leading-relaxed text-slate-300">
        В ProjectHub на компьютере откройте <b>Remote</b> в строке состояния и одобрите «{platform.deviceName}» в списке
        подключённых устройств. Приложение продолжит само.
      </div>
      <div className="mt-6 flex items-center gap-2 text-[13px] text-slate-400">
        <Spinner className="h-3 w-3" /> Ждём подтверждения…
      </div>
      <div className="mt-8 flex gap-2">
        <Button size="sm" onClick={() => client.retryNow()}>
          Повторить
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void forget()}>
          Другой компьютер
        </Button>
      </div>
    </div>
  );
}

function Shell() {
  const { platform } = useServices();
  const status = useAppState((s) => s.status);
  const projects = useAppState((s) => s.projects);
  const projectPath = useAppState((s) => s.projectPath);
  // Счётчик вкладки «Входящие»: решения HITL и задачи агентов на подтверждение (TASK-155).
  const hitlCount = useAppState((s) => s.hitl.length + s.agentTasks.length);
  const conn = useAppState((s) => s.conn);
  const [tab, setTab] = useState<Tab>('inbox');
  const [hostOpen, setHostOpen] = useState(false);
  const [tasksFocus, setTasksFocus] = useState<string | undefined>();
  const project = projects.find((p) => p.path === projectPath);

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
        <button type="button" onClick={() => setHostOpen(true)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left active:bg-ph-hover">
          <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', conn.state === 'ready' ? 'bg-emerald-400' : conn.state === 'failed' ? 'bg-red-400' : 'bg-amber-400')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold">{project?.name || 'Проект не выбран'}</span>
            <span className="block truncate text-[12px] text-slate-400">
              {status?.machineName || 'ProjectHub'}
              {conn.state === 'ready' && conn.route ? ` · ${routeLabel(conn.route)}` : ''}
            </span>
          </span>
          <CaretDownIcon size={18} className="text-slate-400" />
        </button>
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
        {tab === 'agents' && <AgentsScreen />}
        {tab === 'tasks' && <TasksScreen focusStatus={tasksFocus} />}
        {tab === 'processes' && <ProcessesScreen />}
        {tab === 'studio' && <StudioScreen />}
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
                <span>{t.label}</span>
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

      <HostSheet open={hostOpen} onClose={() => setHostOpen(false)} />
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

/** Корень клиента: сопряжение, пока профиль неполон или подключение не удалось, иначе основной интерфейс. */
export function App({ profile }: { profile: HostProfile }) {
  const { client, platform } = useServices();
  const conn = useAppState((s) => s.conn);
  const complete = profileProblems(profile).length === 0 && platform.cryptoAvailable();

  useEffect(() => {
    if (complete) client.connect(profile);
    return () => client.disconnect();
  }, [client, profile, complete]);

  const showPairing = !complete || conn.state === 'failed';
  return (
    <>
      {showPairing ? <PairingScreen key={profile.hostId + profile.key} initial={client.getProfile() ?? profile} error={conn.state === 'failed' ? conn.error : null} /> : <Shell />}
      <Toasts />
    </>
  );
}
