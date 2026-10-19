import { useState } from 'react';
import { CheckIcon, ListChecksIcon, ShieldCheckIcon, TrayIcon, XIcon } from '@phosphor-icons/react';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, EmptyState, SectionTitle } from '../components/ui';
import { Screen } from '../components/Screen';
import { capabilitiesFor, groupAgentTasks, type AgentTaskGroup, type HitlItem } from '../protocol/models';

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function HitlCard({ item, canDecide }: { item: HitlItem; canDecide: boolean }) {
  const { store, platform } = useServices();
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    platform.haptic(approve ? 'success' : 'warning');
    await store.decideHitl(item.requestId, approve);
    setBusy(false);
  };
  const who = [item.agentName, item.role].filter(Boolean).join(' · ');
  return (
    <Card className="mb-2 border-amber-900/60">
      <div className="flex items-start gap-2">
        <ShieldCheckIcon size={20} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium leading-snug">{item.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            {who && <span>{who}</span>}
            {item.projectPath && <Badge>{projectName(item.projectPath)}</Badge>}
            {item.tool && <Badge tone="warning">{item.tool}</Badge>}
          </div>
        </div>
      </div>
      {(item.command || item.filePath || item.details) && (
        <pre className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ph-base p-2 font-mono text-[12px] text-slate-200">
          {item.command ? `$ ${item.command}` : item.filePath}
          {item.details && !item.command ? `\n${item.details}` : ''}
        </pre>
      )}
      {canDecide ? (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={busy} haptic={null} onClick={() => decide(false)}>
            <XIcon size={18} /> Отклонить
          </Button>
          <Button variant="success" className="flex-1" disabled={busy} haptic={null} onClick={() => decide(true)}>
            <CheckIcon size={18} /> Одобрить
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-slate-400">У этого устройства нет права на решения — решите на ПК.</div>
      )}
    </Card>
  );
}

/**
 * Задачи, которые завёл агент: исполнение ждёт человека (decision-89). Подтверждаются ровно те задачи,
 * что видны в карточке, — по id (TASK-155). Отклонить — удалить задачу на ПК, как и в окне.
 */
function AgentTaskCard({ group, canDecide }: { group: AgentTaskGroup; canDecide: boolean }) {
  const { store, platform } = useServices();
  const [busy, setBusy] = useState(false);
  const approve = async (ids: string[]) => {
    setBusy(true);
    platform.haptic('success');
    await store.approveAgentTasks(group.projectPath, ids);
    setBusy(false);
  };
  const all = group.tasks.map((t) => t.id);
  return (
    <Card className="mb-2 border-violet-900/60">
      <div className="flex items-start gap-2">
        <ListChecksIcon size={20} className="mt-0.5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium leading-snug">
            {group.tasks.length > 1 ? `Агент завёл задачи: ${group.tasks.length}` : 'Агент завёл задачу'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            {group.reporter && <span>{group.reporter}</span>}
            <Badge>{projectName(group.projectPath)}</Badge>
          </div>
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {group.tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 rounded-lg bg-ph-base px-2 py-1.5">
            <span className="shrink-0 font-mono text-[12px] text-slate-400">{task.id}</span>
            <span className="min-w-0 flex-1 truncate text-[14px]">{task.title}</span>
            {canDecide && group.tasks.length > 1 && (
              <Button variant="secondary" size="sm" className="shrink-0" disabled={busy} haptic={null} onClick={() => approve([task.id])}>
                <CheckIcon size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canDecide ? (
        <div className="mt-3">
          <Button variant="success" className="w-full" disabled={busy} haptic={null} onClick={() => approve(all)}>
            <CheckIcon size={18} /> {group.tasks.length > 1 ? `Подтвердить все (${group.tasks.length})` : 'Подтвердить'}
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-slate-400">У этого устройства нет права на решения — подтвердите на ПК.</div>
      )}
    </Card>
  );
}

/**
 * «Входящие» — всё, что ждёт человека. Сейчас здесь очередь HITL, задачи агентов на подтверждение и задачи
 * в Review; полная лента с критериями, чеками и событиями агентов — [[TASK-140.5]].
 */
export function InboxScreen({ onOpenReview }: { onOpenReview: () => void }) {
  const { store } = useServices();
  const hitl = useAppState((s) => s.hitl);
  const agentTasks = useAppState((s) => s.agentTasks);
  const tasks = useAppState((s) => s.tasks);
  const conn = useAppState((s) => s.conn);
  const caps = capabilitiesFor(conn.rights, conn.readOnly);
  const review = tasks.filter((t) => t.status === 'Review');
  const agentGroups = groupAgentTasks(agentTasks);

  return (
    <Screen onRefresh={() => Promise.all([store.refreshHitl(), store.refreshAgentTasks(), store.refreshTasks()]).then(() => undefined)}>
      <SectionTitle>Ждут решения</SectionTitle>
      {hitl.length === 0 && agentGroups.length === 0 ? (
        <EmptyState icon={<TrayIcon size={40} />} title="Агентам ничего не нужно" hint="Запросы на одобрение появятся здесь." />
      ) : (
        hitl.map((item) => <HitlCard key={item.requestId} item={item} canDecide={caps.decide} />)
      )}

      {agentGroups.length > 0 && (
        <>
          <SectionTitle>Задачи от агентов</SectionTitle>
          {agentGroups.map((group) => (
            <AgentTaskCard key={`${group.projectPath}\n${group.reporter}`} group={group} canDecide={caps.decide} />
          ))}
        </>
      )}

      {review.length > 0 && (
        <>
          <SectionTitle>На проверке</SectionTitle>
          <Card onClick={onOpenReview}>
            <div className="flex items-center justify-between">
              <span className="text-[15px]">Задачи в Review</span>
              <Badge tone="review">{review.length}</Badge>
            </div>
            <div className="mt-1 truncate text-[13px] text-slate-400">{review.map((t) => t.id).join(', ')}</div>
          </Card>
        </>
      )}

      <div className="mt-6 rounded-xl border border-dashed border-ph-line p-3 text-[12px] leading-snug text-slate-400">
        Скоро здесь же: проверка задач по критериям приёмки и скриншотам, завершившиеся агенты и сбои Automations.
      </div>
    </Screen>
  );
}
