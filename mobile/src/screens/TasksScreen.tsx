import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwiseIcon, CheckSquareIcon, GitMergeIcon, KanbanIcon, PlusIcon, SquareIcon, UserIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteTaskSummary } from '../../../src/types/remote';
import { isMyTask, returnReasons, reviewableByMe, taskHolder, taskQueueState } from '../../../src/utils/teamQueue';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, EmptyState, Sheet, Spinner } from '../components/ui';
import { fieldProps } from '../components/FieldEditor';
import { useT } from '../i18n/react';
import { capabilitiesFor, criteriaProgress, groupTasksByStatus, KANBAN_STATUSES } from '../protocol/models';
import { QueueSheet } from './QueueSheet';

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'review' | 'success'> = {
  'To Do': 'neutral',
  'In Progress': 'accent',
  Review: 'review',
  Done: 'success'
};

function TaskCard({ task, onOpen }: { task: RemoteTaskSummary; onOpen: () => void }) {
  const { done, total } = criteriaProgress(task);
  const team = useAppState((s) => s.team);
  const queue = useAppState((s) => s.queue);
  // Общий хост (TASK-142.5): кто ведёт задачу и где она в очереди слияния.
  const holder = team ? taskHolder(task) : undefined;
  const inQueue = taskQueueState(queue, task.id).active;
  return (
    <Card className="mb-2" onClick={onOpen}>
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span className="font-mono">{task.id}</span>
        {String(task.priority).toLowerCase() === 'high' && <Badge tone="warning">high</Badge>}
        {holder && (
          <span className={clsx('ml-auto flex items-center gap-1', holder === team?.me && 'text-indigo-300')}>
            <UserIcon size={12} /> {holder}
          </span>
        )}
        {inQueue && <Badge tone="review">#{inQueue.n}</Badge>}
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
}

function TaskSheet({ task, onClose }: { task: RemoteTaskSummary | null; onClose: () => void }) {
  const { store } = useServices();
  const tr = useT();
  const conn = useAppState((s) => s.conn);
  const tasks = useAppState((s) => s.tasks);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const team = useAppState((s) => s.team);
  const queue = useAppState((s) => s.queue);
  const [busy, setBusy] = useState(false);
  // Карточка читает свежую версию задачи из стора: после переключения критерия она обновляется.
  const current = task ? (tasks.find((t) => t.filePath === task.filePath) ?? task) : null;
  const holder = current && team ? taskHolder(current) : undefined;
  const mine = Boolean(current && team && isMyTask(current, team.me));
  const qs = current ? taskQueueState(queue, current.id) : {};
  const reasons = qs.last?.status === 'returned' && !qs.active ? returnReasons(qs.last) : [];
  const run = async (op: () => Promise<boolean>) => {
    setBusy(true);
    await op();
    setBusy(false);
  };

  return (
    <Sheet open={Boolean(current)} onClose={onClose} title={current?.id}>
      {current && (
        <>
          <div className="text-[16px] font-medium leading-snug">{current.title}</div>
          {team && (
            <div className="mt-3 space-y-2" data-testid="task-team">
              {holder && <div className="text-[13px] text-slate-300">{tr.tasks.heldBy(holder)}</div>}
              {qs.active && (
                <div className="text-[13px] text-indigo-300" data-testid="task-queue-state">
                  {tr.tasks.queueState(qs.active.n, tr.tasks.queueStatus[qs.active.status] ?? qs.active.status, qs.active.position)}
                </div>
              )}
              {!qs.active && qs.last && (
                <div className="text-[13px] text-slate-400">{tr.tasks.lastResult(qs.last.n, tr.tasks.queueStatus[qs.last.status] ?? qs.last.status)}</div>
              )}
              {reasons.length > 0 && (
                <div className="rounded-lg bg-rose-500/10 p-2 text-[12px] text-rose-200" data-testid="task-return-reasons">
                  <div className="font-semibold">{tr.tasks.returnedWhy}</div>
                  <ul className="mt-1 list-disc pl-4">
                    {reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  {!holder && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => store.takeTask(current))}>
                      <span data-testid="task-take">{tr.tasks.take}</span>
                    </Button>
                  )}
                  {mine && !qs.active && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => store.enqueueTask(current))}>
                      <GitMergeIcon size={16} /> <span data-testid="task-enqueue">{tr.tasks.enqueue}</span>
                    </Button>
                  )}
                  {mine && !qs.active && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => store.releaseTask(current))}>
                      {tr.tasks.release}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.tasks.status}</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {KANBAN_STATUSES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={current.status === s ? 'primary' : 'secondary'}
                disabled={!canWrite}
                haptic="selection"
                onClick={() => void store.setTaskStatus(current, s)}
              >
                {s}
              </Button>
            ))}
          </div>
          {current.criteria.length > 0 && (
            <>
              <div className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.tasks.criteria}</div>
              <ul className="mt-2 space-y-1">
                {current.criteria.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      disabled={!canWrite}
                      onClick={() => void store.toggleCriterion(current, i, !c.completed)}
                      className="flex w-full items-start gap-2 rounded-lg p-2 text-left active:bg-ph-hover disabled:active:bg-transparent"
                    >
                      {c.completed ? (
                        <CheckSquareIcon size={20} weight="fill" className="shrink-0 text-emerald-400" />
                      ) : (
                        <SquareIcon size={20} className="shrink-0 text-slate-500" />
                      )}
                      <span className={clsx('text-[14px] leading-snug', c.completed && 'text-slate-400 line-through')}>{c.text.replace(/^#\d+\s*/, '')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!canWrite && <div className="mt-4 text-[12px] text-slate-400">{tr.tasks.readOnlyHint}</div>}
        </>
      )}
    </Sheet>
  );
}

function CreateTaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useServices();
  const tr = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const ok = await store.createTask(title.trim(), description.trim());
    setBusy(false);
    if (ok) {
      setTitle('');
      setDescription('');
      onClose();
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={tr.tasks.newTask}
      footer={
        <Button variant="primary" className="w-full" disabled={!title.trim() || busy} onClick={submit}>
          {busy ? <Spinner /> : tr.tasks.create}
        </Button>
      }
    >
      <input
        {...fieldProps({ value: title, onChange: setTitle, maxLength: 110, placeholder: tr.tasks.titlePlaceholder })}
        className="w-full rounded-xl border border-ph-line bg-ph-raised px-3 py-3 text-[15px] outline-none focus:border-indigo-500"
      />
      <textarea
        {...fieldProps({ value: description, onChange: setDescription, multiline: true, placeholder: tr.tasks.descriptionPlaceholder })}
        rows={6}
        className="mt-2 w-full rounded-xl border border-ph-line bg-ph-raised px-3 py-3 text-[15px] outline-none focus:border-indigo-500"
      />
    </Sheet>
  );
}

/** Kanban задач Backlog.md: колонки прокручиваются вбок со снапом, задача открывается листом. */
export function TasksScreen({ focusStatus, focusTask, onFocusTaskShown }: { focusStatus?: string; focusTask?: string; onFocusTaskShown?: () => void }) {
  const { store } = useServices();
  const tr = useT();
  const tasks = useAppState((s) => s.tasks);
  const loaded = useAppState((s) => s.tasksLoaded);
  const projectPath = useAppState((s) => s.projectPath);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const team = useAppState((s) => s.team);
  const queue = useAppState((s) => s.queue);
  const [onlyMine, setOnlyMine] = useState(false);
  const shown = useMemo(() => (onlyMine && team ? tasks.filter((t) => isMyTask(t, team.me)) : tasks), [onlyMine, team, tasks]);
  const columns = useMemo(() => groupTasksByStatus(shown), [shown]);
  const [active, setActive] = useState(0);
  const [openTask, setOpenTask] = useState<RemoteTaskSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const waitingReview = reviewableByMe(queue, team?.me).length;
  const board = useRef<HTMLDivElement>(null);

  const scrollTo = (index: number) => {
    const el = board.current;
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
  };

  useEffect(() => {
    if (!focusStatus) return;
    const idx = columns.findIndex((c) => c.status === focusStatus);
    if (idx >= 0) requestAnimationFrame(() => scrollTo(idx));
    // переходим только при смене запрошенной колонки
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columns меняются при каждом обновлении задач
  }, [focusStatus]);

  // Задача с общей доски области (TASK-181): открыть её карточку, когда задачи проекта загрузятся.
  useEffect(() => {
    if (!focusTask || !loaded) return;
    const task = tasks.find((t) => t.filePath === focusTask);
    if (task) setOpenTask(task);
    onFocusTaskShown?.();
  }, [focusTask, loaded, tasks, onFocusTaskShown]);

  if (!projectPath) return <EmptyState icon={<KanbanIcon size={40} />} title={tr.common.noProject} hint={tr.tasks.noProjectHint} />;
  if (!loaded)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2 pt-3" data-swipe-ignore>
        {columns.map((c, i) => (
          <button
            key={c.status}
            type="button"
            onClick={() => scrollTo(i)}
            className={clsx(
              'shrink-0 rounded-full px-3 py-1.5 text-[13px]',
              i === active ? 'bg-indigo-500 text-white' : 'bg-ph-raised text-slate-300'
            )}
          >
            {c.status} <span className="opacity-70">{c.tasks.length}</span>
          </button>
        ))}
        {team && (
          <button
            type="button"
            data-testid="tasks-mine"
            onClick={() => setOnlyMine(!onlyMine)}
            className={clsx('shrink-0 rounded-full px-3 py-1.5 text-[13px]', onlyMine ? 'bg-indigo-500 text-white' : 'bg-ph-raised text-slate-300')}
          >
            {tr.tasks.mine}
          </button>
        )}
        {queue && (
          <button
            type="button"
            data-testid="tasks-queue"
            aria-label={tr.tasks.queue}
            onClick={() => setQueueOpen(true)}
            className="flex shrink-0 items-center gap-1 rounded-full bg-ph-raised px-3 py-1.5 text-[13px] text-slate-300"
          >
            <GitMergeIcon size={14} /> {queue.active.length}
            {waitingReview > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] text-black">{waitingReview}</span>}
          </button>
        )}
        <button
          type="button"
          aria-label={tr.tasks.refresh}
          onClick={() => void Promise.all([store.refreshTasks(), store.refreshTeam(), store.refreshQueue()])}
          className="ml-auto shrink-0 rounded-full p-1.5 text-slate-400 active:bg-ph-hover"
        >
          <ArrowClockwiseIcon size={18} />
        </button>
      </div>
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
              c.tasks.map((t) => <TaskCard key={t.filePath} task={t} onOpen={() => setOpenTask(t)} />)
            )}
          </section>
        ))}
      </div>
      {canWrite && (
        <button
          type="button"
          aria-label={tr.tasks.newTask}
          onClick={() => setCreating(true)}
          className="fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-10 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500 text-white shadow-lg shadow-black/40 active:scale-95"
        >
          <PlusIcon size={26} />
        </button>
      )}
      <TaskSheet task={openTask} onClose={() => setOpenTask(null)} />
      <CreateTaskSheet open={creating} onClose={() => setCreating(false)} />
      <QueueSheet open={queueOpen} onClose={() => setQueueOpen(false)} />
    </div>
  );
}
