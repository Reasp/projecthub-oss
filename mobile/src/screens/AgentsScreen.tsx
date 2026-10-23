import { useEffect, useRef, useState } from 'react';
import { PlayIcon, RobotIcon, StopIcon } from '@phosphor-icons/react';
import type { RemoteAgentOutput, RemoteLaunchCheck, RemoteSwarmAgentSummary, RemoteSwarmSummary } from '../../../src/types/remote';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, Confirm, EmptyState, SectionTitle, Sheet, Spinner } from '../components/ui';
import { fieldProps } from '../components/FieldEditor';
import { Screen } from '../components/Screen';
import { useT } from '../i18n/react';
import { agentErrorText, failureText } from '../app/errorText';
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
  const tr = useT();
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
      {target?.agent.error && <div className="mb-2 rounded-lg bg-red-950/60 p-2 text-[13px] text-red-200">{agentErrorText(target.agent)}</div>}
      <pre ref={ref} className="selectable h-[58vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ph-base p-2 font-mono text-[12px] leading-relaxed text-slate-200">
        {output?.truncated ? tr.agents.outputTruncated : ''}
        {output?.text || (loading ? '' : tr.agents.noOutput)}
      </pre>
    </Sheet>
  );
}

function StartAgentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useServices();
  const tr = useT();
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
  // Лимиты расходов хоста до запуска (decision-124): исчерпанный бюджет запрещает запуск, у порога — предупреждение.
  const [launch, setLaunch] = useState<RemoteLaunchCheck | null>(null);
  useEffect(() => {
    setLaunch(null);
    if (!open || !taskId || !roleSlug) return;
    let cancelled = false;
    void store.checkAgentLaunch(taskId, roleSlug).then((res) => {
      if (!cancelled) setLaunch(res);
    });
    return () => {
      cancelled = true;
    };
  }, [open, taskId, roleSlug, store]);
  const blocked = launch?.allowed === false;

  const submit = async () => {
    if (!task || !roleSlug || blocked) return;
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
      title={tr.agents.startTitle}
      footer={
        <Button variant="primary" className="w-full" disabled={!task || !roleSlug || busy || blocked} haptic="medium" onClick={submit}>
          {busy ? <Spinner /> : tr.agents.startOnComputer}
        </Button>
      }
    >
      <label className="text-[12px] text-slate-400">{tr.agents.task}</label>
      <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={`${select} mt-1`}>
        <option value="">{tr.agents.chooseTask}</option>
        {candidates.map((t) => (
          <option key={t.filePath} value={t.id}>
            {t.id} — {t.title}
          </option>
        ))}
      </select>
      <label className="mt-3 block text-[12px] text-slate-400">{tr.agents.role}</label>
      <select value={roleSlug} onChange={(e) => setRoleSlug(e.target.value)} className={`${select} mt-1`}>
        <option value="">{roles.length ? tr.agents.chooseRole : tr.agents.noRoles}</option>
        {roles.map((r) => (
          <option key={r.slug} value={r.slug}>
            {r.name}
            {r.engine ? ` · ${r.engine}` : ''}
          </option>
        ))}
      </select>
      <label className="mt-3 block text-[12px] text-slate-400">{tr.agents.promptLabel}</label>
      <textarea
        {...fieldProps({ value: prompt, onChange: setPrompt, multiline: true, title: tr.agents.promptLabel, placeholder: task ? tr.agents.promptPlaceholder(task.id) : '' })}
        rows={3}
        className={`${select} mt-1`}
      />
      <div className="mt-2 text-[12px] text-slate-500">{tr.agents.worktreeHint}</div>
      {launch && launch.notices.length > 0 && (
        <div className="mt-3 space-y-1.5" data-testid="launch-limits">
          {launch.notices.map((n, i) => (
            <div
              key={i}
              className={`rounded-lg p-2 text-[13px] ${
                n.level === 'block' ? 'bg-red-950/60 text-red-200' : n.level === 'warn' ? 'bg-amber-950/60 text-amber-200' : 'bg-ph-raised text-slate-300'
              }`}
            >
              {failureText({ error: n.text, errorKey: n.textKey })}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** Рои и агенты: статус, вывод, остановка, запуск назначенной задачи (decision-79 п. 8). */
export function AgentsScreen() {
  const { store } = useServices();
  const tr = useT();
  const swarms = useAppState((s) => s.swarms);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [output, setOutput] = useState<{ swarm: RemoteSwarmSummary; agent: RemoteSwarmAgentSummary } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopTarget, setStopTarget] = useState<RemoteSwarmSummary | null>(null);

  // Агент, выбранный на экране «Компьютеры» (TASK-174): вывод открывается, как только рой пришёл с хоста.
  const nav = useAppState((s) => s.nav);
  useEffect(() => {
    if (nav?.kind !== 'swarm') return;
    const swarm = swarms.find((s) => s.id === nav.sessionId);
    if (!swarm) return;
    const agent = swarm.agents.find((a) => a.id === nav.agentId) ?? swarm.agents[0];
    if (agent) setOutput({ swarm, agent });
    store.consumeNav(nav.seq);
  }, [nav, swarms, store]);

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
          <StopIcon size={16} /> {tr.agents.stop}
        </Button>
      )}
    </Card>
  );

  return (
    <Screen onRefresh={() => store.refreshSwarms()}>
      {canWrite && (
        <Button variant="primary" className="mb-2 w-full" onClick={() => setStarting(true)}>
          <PlayIcon size={18} /> {tr.agents.startTask}
        </Button>
      )}
      {swarms.length === 0 ? (
        <EmptyState icon={<RobotIcon size={40} />} title={tr.agents.emptyTitle} hint={tr.agents.emptyHint} />
      ) : (
        <>
          {active.length > 0 && <SectionTitle>{tr.agents.running}</SectionTitle>}
          {active.map(renderSwarm)}
          {finished.length > 0 && <SectionTitle>{tr.agents.finished}</SectionTitle>}
          {finished.map(renderSwarm)}
        </>
      )}
      <AgentOutputSheet target={output} onClose={() => setOutput(null)} />
      <StartAgentSheet open={starting} onClose={() => setStarting(false)} />
      <Confirm
        open={Boolean(stopTarget)}
        title={tr.agents.stopConfirmTitle}
        body={stopTarget?.taskTitle || stopTarget?.taskId}
        confirmText={tr.agents.stop}
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
