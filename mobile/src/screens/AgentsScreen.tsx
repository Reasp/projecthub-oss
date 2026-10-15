import { useEffect, useRef, useState } from 'react';
import { PlayIcon, RobotIcon, StopIcon } from '@phosphor-icons/react';
import type { RemoteAgentOutput, RemoteSwarmAgentSummary, RemoteSwarmSummary } from '../../../src/types/remote';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, Confirm, EmptyState, SectionTitle, Sheet, Spinner } from '../components/ui';
import { Screen } from '../components/Screen';
import { capabilitiesFor, isActiveStatus, statusLabel } from '../protocol/models';

function tone(status: string): 'success' | 'accent' | 'danger' | 'neutral' {
  if (isActiveStatus(status)) return 'accent';
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'budget_exceeded') return 'danger';
  return 'neutral';
}

/** Хвост вывода агента; пока агент работает, перечитывается раз в 3 с. */
function AgentOutputSheet({ target, onClose }: { target: { swarm: RemoteSwarmSummary; agent: RemoteSwarmAgentSummary } | null; onClose: () => void }) {
  const { store } = useServices();
  const [output, setOutput] = useState<RemoteAgentOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!target) {
      setOutput(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      setLoading(true);
      const res = await store.getAgentOutput(target.swarm.id, target.agent.id);
      if (cancelled) return;
      setLoading(false);
      if (res) setOutput(res);
      if (isActiveStatus(res?.status ?? target.agent.status)) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [target, store]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [output?.text]);

  return (
    <Sheet open={Boolean(target)} onClose={onClose} title={target?.agent.name}>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-slate-400">
        <Badge tone={tone(output?.status ?? target?.agent.status ?? '')}>{statusLabel(output?.status ?? target?.agent.status ?? '')}</Badge>
        {target?.agent.engine && <span>{target.agent.engine}</span>}
        {loading && <Spinner className="h-3 w-3" />}
      </div>
      {target?.agent.error && <div className="mb-2 rounded-lg bg-red-950/60 p-2 text-[13px] text-red-200">{target.agent.error}</div>}
      <pre ref={ref} className="selectable h-[58vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ph-base p-2 font-mono text-[12px] leading-relaxed text-slate-200">
        {output?.truncated ? '… начало вывода не показано\n\n' : ''}
        {output?.text || (loading ? '' : 'Вывода пока нет.')}
      </pre>
    </Sheet>
  );
}

function StartAgentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useServices();
  const tasks = useAppState((s) => s.tasks);
  const roles = useAppState((s) => s.roles);
  const candidates = tasks.filter((t) => t.status !== 'Done');
  const [taskId, setTaskId] = useState('');
  const [roleSlug, setRoleSlug] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void store.loadRoles();
  }, [open, store]);

  const task = candidates.find((t) => t.id === taskId);
  const submit = async () => {
    if (!task || !roleSlug) return;
    setBusy(true);
    const ok = await store.startAssignedAgent(task.id, task.title, roleSlug, prompt.trim());
    setBusy(false);
    if (ok) {
      setPrompt('');
      onClose();
    }
  };

  const select = 'w-full rounded-xl border border-ph-line bg-ph-raised px-3 py-3 text-[15px] outline-none focus:border-indigo-500';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Запустить агента"
      footer={
        <Button variant="primary" className="w-full" disabled={!task || !roleSlug || busy} haptic="medium" onClick={submit}>
          {busy ? <Spinner /> : 'Запустить на ПК'}
        </Button>
      }
    >
      <label className="text-[12px] text-slate-400">Задача</label>
      <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={`${select} mt-1`}>
        <option value="">Выберите задачу</option>
        {candidates.map((t) => (
          <option key={t.filePath} value={t.id}>
            {t.id} — {t.title}
          </option>
        ))}
      </select>
      <label className="mt-3 block text-[12px] text-slate-400">Роль</label>
      <select value={roleSlug} onChange={(e) => setRoleSlug(e.target.value)} className={`${select} mt-1`}>
        <option value="">{roles.length ? 'Выберите роль' : 'Ролей нет'}</option>
        {roles.map((r) => (
          <option key={r.slug} value={r.slug}>
            {r.name}
            {r.engine ? ` · ${r.engine}` : ''}
          </option>
        ))}
      </select>
      <label className="mt-3 block text-[12px] text-slate-400">Промпт (необязательно)</label>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={task ? `Выполни задачу ${task.id}.` : ''} className={`${select} mt-1`} />
      <div className="mt-2 text-[12px] text-slate-500">Агент работает в отдельном worktree на ПК, движок и модель — из роли.</div>
    </Sheet>
  );
}

/** Рои и агенты: статус, вывод, остановка, запуск назначенной задачи (decision-79 п. 8). */
export function AgentsScreen() {
  const { store } = useServices();
  const swarms = useAppState((s) => s.swarms);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [output, setOutput] = useState<{ swarm: RemoteSwarmSummary; agent: RemoteSwarmAgentSummary } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopTarget, setStopTarget] = useState<RemoteSwarmSummary | null>(null);

  const active = swarms.filter((s) => isActiveStatus(s.status));
  const finished = swarms.filter((s) => !isActiveStatus(s.status)).slice(0, 20);

  const renderSwarm = (s: RemoteSwarmSummary) => (
    <Card key={s.id} className="mb-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{s.taskTitle || s.taskId || s.mode}</span>
        <Badge tone={tone(s.status)}>{statusLabel(s.status)}</Badge>
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">
        {s.taskId && `${s.taskId} · `}
        {s.mode}
        {s.origin ? ` · ${s.origin}` : ''}
      </div>
      <ul className="mt-2 divide-y divide-ph-line">
        {s.agents.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => setOutput({ swarm: s, agent: a })} className="flex w-full items-center gap-2 py-2 text-left active:bg-ph-hover">
              <RobotIcon size={18} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-[14px]">{a.name}</span>
              <span className="text-[12px] text-slate-400">{statusLabel(a.status)}</span>
            </button>
          </li>
        ))}
      </ul>
      {canWrite && isActiveStatus(s.status) && (
        <Button size="sm" variant="danger" className="mt-2" haptic="medium" onClick={() => setStopTarget(s)}>
          <StopIcon size={16} /> Остановить
        </Button>
      )}
    </Card>
  );

  return (
    <Screen onRefresh={() => store.refreshSwarms()}>
      {canWrite && (
        <Button variant="primary" className="mb-2 w-full" onClick={() => setStarting(true)}>
          <PlayIcon size={18} /> Запустить задачу агентом
        </Button>
      )}
      {swarms.length === 0 ? (
        <EmptyState icon={<RobotIcon size={40} />} title="Агенты не запускались" hint="Рои и назначенные задачи этого проекта появятся здесь." />
      ) : (
        <>
          {active.length > 0 && <SectionTitle>Работают</SectionTitle>}
          {active.map(renderSwarm)}
          {finished.length > 0 && <SectionTitle>Завершённые</SectionTitle>}
          {finished.map(renderSwarm)}
        </>
      )}
      <AgentOutputSheet target={output} onClose={() => setOutput(null)} />
      <StartAgentSheet open={starting} onClose={() => setStarting(false)} />
      <Confirm
        open={Boolean(stopTarget)}
        title="Остановить агентов?"
        body={stopTarget?.taskTitle || stopTarget?.taskId}
        confirmText="Остановить"
        danger
        onCancel={() => setStopTarget(null)}
        onConfirm={() => {
          const target = stopTarget;
          setStopTarget(null);
          if (target) void store.stopSwarm(target.id);
        }}
      />
    </Screen>
  );
}
