import { useState, type ReactNode } from 'react';
import {
  BellIcon,
  CheckIcon,
  ClipboardTextIcon,
  FingerprintIcon,
  GearSixIcon,
  ListChecksIcon,
  RobotIcon,
  ShieldCheckIcon,
  TrayIcon,
  WarningIcon,
  WifiSlashIcon,
  XIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { HitlReviewSheet } from './HitlReviewSheet';
import { ReviewSheet } from './ReviewSheet';
import { useAppState, useServices } from '../app/context';
import { useInboxFeed } from '../app/useInbox';
import { Badge, Button, Card, EmptyState, SectionTitle } from '../components/ui';
import { Screen } from '../components/Screen';
import { checksSummary, criteriaDone, projectName, timeAgo, type FeedSource } from '../protocol/inbox';
import { inScope } from '../protocol/scope';
import { canApproveInApp, capabilitiesFor, type AgentTaskGroup, type HitlItem } from '../protocol/models';
import { useT } from '../i18n/react';
import type { Dict } from '../i18n';
import type { RemoteInboxEvent, RemoteReviewItem } from '../../../src/types/remote';

/** Почему нет кнопки для `high`: в браузере биометрии нет вовсе, в приложении ключ регистрируется при сопряжении по QR. */
function highRiskHint(tr: Dict, app: boolean): string {
  return app ? tr.inbox.highRiskHintApp : tr.inbox.highRiskHintWeb;
}

/** Имя компьютера у записи, когда ПК больше одного; без связи — пометка «нет связи». */
function HostTag({ source, multi }: { source: FeedSource; multi: boolean }) {
  const tr = useT();
  if (!multi && source.online) return null;
  return (
    <span data-testid="inbox-host" className={clsx('inline-flex items-center gap-1', !source.online && 'text-amber-300')}>
      {!source.online && <WifiSlashIcon size={12} />}
      <Badge tone={source.online ? 'accent' : 'warning'}>{source.online ? source.machineName : tr.inbox.hostOffline(source.machineName)}</Badge>
    </span>
  );
}

function canDecideOn(source: FeedSource): boolean {
  return source.online && capabilitiesFor(source.rights, Boolean(source.hostReadOnly)).decide;
}

function NoRightsHint({ source }: { source: FeedSource }) {
  const tr = useT();
  return (
    <div className="mt-2 text-[12px] text-slate-400">
      {source.online ? tr.inbox.noRights : tr.inbox.offlineDecideLater(source.machineName)}
    </div>
  );
}

function HitlCard({ source, item, multi }: { source: FeedSource; item: HitlItem; multi: boolean }) {
  const { store, platform, inbox, switchHost } = useServices();
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // Подписка на соединение: кнопка появляется, как только хост подтвердит ключ подтверждения этого сопряжения.
  const biometric = useAppState((s) => s.conn.biometricConfirm) && source.active && store.canConfirmBiometric();
  const decide = async (approve: boolean) => {
    setBusy(true);
    platform.haptic(approve ? 'success' : 'warning');
    await inbox.decideHitl(source, item, approve);
    setBusy(false);
  };
  const who = [item.agentName, item.role].filter(Boolean).join(' · ');
  const canDecide = canDecideOn(source);
  return (
    <Card className="mb-2 border-amber-900/60">
      <div className="flex items-start gap-2">
        <ShieldCheckIcon size={20} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium leading-snug">{item.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            <HostTag source={source} multi={multi} />
            {who && <span>{who}</span>}
            {item.projectPath && <Badge>{projectName(item.projectPath)}</Badge>}
            {item.tool && <Badge tone="warning">{item.tool}</Badge>}
            {item.risk && (
              <Badge tone={item.risk === 'high' ? 'danger' : item.risk === 'moderate' ? 'warning' : 'success'}>
                <span data-testid="hitl-risk">{tr.inbox.risk[item.risk]}</span>
              </Badge>
            )}
          </div>
          {item.riskReason && <div className="mt-0.5 text-[12px] text-slate-500">{item.riskReason}</div>}
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
            <XIcon size={18} /> {tr.inbox.reject}
          </Button>
          {canApproveInApp(item) ? (
            <Button variant="success" className="flex-1" disabled={busy} haptic={null} onClick={() => decide(true)}>
              <CheckIcon size={18} /> {tr.inbox.approve}
            </Button>
          ) : !source.active ? (
            // Высокий риск с другого ПК: запрос целиком и биометрия — на открытом ПК (decision-117 п. 7).
            <Button variant="success" className="flex-1" disabled={busy} haptic={null} onClick={() => switchHost(source.profileId)}>
              <FingerprintIcon size={18} /> <span data-testid="hitl-open-host">{tr.inbox.openHost}</span>
            </Button>
          ) : canApproveInApp(item, biometric) ? (
            // Высокий риск: сначала запрос целиком, затем биометрия (decision-114).
            <Button variant="success" className="flex-1" disabled={busy} haptic={null} onClick={() => setReviewing(true)}>
              <FingerprintIcon size={18} /> <span data-testid="hitl-review-open">{tr.inbox.reviewAndApprove}</span>
            </Button>
          ) : (
            <div className="flex-1 self-center text-[12px] leading-snug text-slate-400">{highRiskHint(tr, platform.confirm !== undefined)}</div>
          )}
        </div>
      ) : (
        <NoRightsHint source={source} />
      )}
      {reviewing && <HitlReviewSheet item={item} open={reviewing} onClose={() => setReviewing(false)} />}
    </Card>
  );
}

/**
 * Задачи, которые завёл агент: исполнение ждёт человека (decision-89). Подтверждаются ровно те задачи,
 * что видны в карточке, — по id (TASK-155). Отклонить — удалить задачу на ПК, как и в окне.
 */
function AgentTaskCard({ source, group, multi }: { source: FeedSource; group: AgentTaskGroup; multi: boolean }) {
  const { inbox, platform } = useServices();
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const approve = async (ids: string[]) => {
    setBusy(true);
    platform.haptic('success');
    await inbox.approveAgentTasks(source, group.projectPath, ids);
    setBusy(false);
  };
  const all = group.tasks.map((t) => t.id);
  const canDecide = canDecideOn(source);
  return (
    <Card className="mb-2 border-violet-900/60">
      <div className="flex items-start gap-2">
        <ListChecksIcon size={20} className="mt-0.5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium leading-snug">
            {group.tasks.length > 1 ? tr.inbox.agentCreatedTasks(group.tasks.length) : tr.inbox.agentCreatedTask}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            <HostTag source={source} multi={multi} />
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
            <CheckIcon size={18} /> {group.tasks.length > 1 ? tr.inbox.confirmAll(group.tasks.length) : tr.common.confirm}
          </Button>
        </div>
      ) : (
        <NoRightsHint source={source} />
      )}
    </Card>
  );
}

/** Задача в Review: прогресс критериев и чеков; по нажатию — проверка целиком. */
function ReviewCard({ source, item, multi }: { source: FeedSource; item: RemoteReviewItem; multi: boolean }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const crit = criteriaDone(item);
  const checks = checksSummary(item);
  const shots = item.report?.screenshots.length ?? 0;
  return (
    <>
      <Card className="mb-2 border-violet-900/40" onClick={() => setOpen(true)}>
        <div className="flex items-start gap-2" data-testid="review-card">
          <ClipboardTextIcon size={20} className="mt-0.5 shrink-0 text-purple-300" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium leading-snug">
              <span className="font-mono text-[12px] text-slate-400">{item.id}</span> {item.title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
              <HostTag source={source} multi={multi} />
              <Badge>{projectName(item.projectPath)}</Badge>
              {crit.total > 0 && (
                <Badge tone={crit.done === crit.total ? 'success' : 'review'}>
                  {tr.inbox.criteriaBadge(crit.done, crit.total)}
                </Badge>
              )}
              {checks && <Badge tone={checks.failed > 0 ? 'danger' : 'success'}>{checks.text}</Badge>}
              {shots > 0 && <Badge>{tr.inbox.screenshotsBadge(shots)}</Badge>}
            </div>
          </div>
        </div>
      </Card>
      {open && <ReviewSheet source={source} item={item} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

const EVENT_ICON: Record<RemoteInboxEvent['kind'], ReactNode> = {
  agent_done: <RobotIcon size={18} className="shrink-0 text-emerald-400" />,
  agent_failed: <RobotIcon size={18} className="shrink-0 text-rose-400" />,
  automation_failed: <GearSixIcon size={18} className="shrink-0 text-rose-400" />,
  automation_suspended: <GearSixIcon size={18} className="shrink-0 text-amber-400" />,
  agent_note: <BellIcon size={18} className="shrink-0 text-indigo-300" />
};

function EventRow({ source, event, multi }: { source: FeedSource; event: RemoteInboxEvent; multi: boolean }) {
  const { inbox } = useServices();
  const tr = useT();
  const note = event.kind === 'agent_note';
  const warn = event.level === 'error' || event.level === 'warning';
  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl border border-ph-line bg-ph-elevated p-3" data-testid={`inbox-event-${event.kind}`}>
      {note && warn ? <WarningIcon size={18} className="shrink-0 text-amber-400" /> : EVENT_ICON[event.kind]}
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium leading-snug">{event.title}</div>
        {event.body && <div className={clsx('selectable mt-0.5 whitespace-pre-wrap break-words text-[13px]', note ? 'text-slate-200' : 'text-slate-400')}>{event.body}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <HostTag source={source} multi={multi} />
          {event.projectPath && <Badge>{projectName(event.projectPath)}</Badge>}
          {event.taskId && <span className="font-mono">{event.taskId}</span>}
          <span>{timeAgo(event.at)}</span>
        </div>
      </div>
      {canDecideOn(source) && (
        <button type="button" aria-label={tr.inbox.dismiss} data-testid="inbox-dismiss" onClick={() => void inbox.dismiss(source, [event.id])} className="-mr-1 rounded-full p-1.5 text-slate-500 active:bg-ph-hover">
          <XIcon size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * «Входящие» — всё, что ждёт человека, со всех ПК телефона (TASK-140.5, [[decision-117]]): запросы HITL, задачи
 * агентов на подтверждение, задачи в Review с критериями и чеками, итоги агентов, сбои Automations и сообщения
 * агентов. У записи — имя компьютера; действие уходит тому ПК, с которого она пришла.
 */
export function InboxScreen({ onOpenReview }: { onOpenReview: () => void }) {
  const { store, pool, inbox } = useServices();
  const tr = useT();
  // Область нижнего меню (TASK-181) вместо фишек компьютеров: «Все», компьютер или проект.
  const scope = useAppState((s) => s.scope);
  const feed = useInboxFeed(scope);
  const tasks = useAppState((s) => s.tasks);
  const multi = scope.kind === 'all' && feed.hosts.length > 1;
  const activeId = feed.sources.find((s) => s.active)?.profileId;
  const legacyReview = feed.legacyActive && activeId && inScope(scope, activeId, scope.kind === 'project' ? scope.projectPath : undefined) ? tasks.filter((t) => t.status === 'Review') : [];
  const empty = feed.hitl.length === 0 && feed.agentGroups.length === 0 && feed.review.length === 0 && feed.events.length === 0 && legacyReview.length === 0;
  const dismissAll = async () => {
    for (const source of feed.sources) {
      const ids = feed.events.filter((e) => e.source.profileId === source.profileId).map((e) => e.item.id);
      if (ids.length > 0 && canDecideOn(source)) await inbox.dismiss(source, ids);
    }
  };

  return (
    <Screen
      onRefresh={() =>
        Promise.all([store.refreshHitl(), store.refreshAgentTasks(), store.refreshInbox(), store.refreshTasks(), pool.refreshAllInboxes()]).then(() => undefined)
      }
    >
      {empty && <EmptyState icon={<TrayIcon size={40} />} title={tr.inbox.emptyTitle} hint={tr.inbox.emptyHint} />}

      {feed.hitl.length > 0 && (
        <>
          <SectionTitle>{tr.inbox.sectionHitl}</SectionTitle>
          {feed.hitl.map(({ source, item }) => (
            <HitlCard key={`${source.profileId}:${item.requestId}`} source={source} item={item} multi={multi} />
          ))}
        </>
      )}

      {feed.agentGroups.length > 0 && (
        <>
          <SectionTitle>{tr.inbox.sectionAgentTasks}</SectionTitle>
          {feed.agentGroups.map(({ source, item }) => (
            <AgentTaskCard key={`${source.profileId}:${item.projectPath}\n${item.reporter}`} source={source} group={item} multi={multi} />
          ))}
        </>
      )}

      {feed.review.length > 0 && (
        <>
          <SectionTitle>{tr.inbox.sectionReview}</SectionTitle>
          {feed.review.map(({ source, item }) => (
            <ReviewCard key={`${source.profileId}:${item.projectPath}:${item.id}`} source={source} item={item} multi={multi} />
          ))}
        </>
      )}

      {legacyReview.length > 0 && (
        <>
          <SectionTitle>{tr.inbox.sectionReview}</SectionTitle>
          <Card onClick={onOpenReview}>
            <div className="flex items-center justify-between">
              <span className="text-[15px]">{tr.inbox.legacyReviewTasks}</span>
              <Badge tone="review">{legacyReview.length}</Badge>
            </div>
            <div className="mt-1 truncate text-[13px] text-slate-400">{legacyReview.map((t) => t.id).join(', ')}</div>
          </Card>
        </>
      )}

      {feed.events.length > 0 && (
        <>
          <SectionTitle
            action={
              <button type="button" onClick={() => void dismissAll()} className="text-[12px] text-slate-400 active:text-slate-200" data-testid="inbox-dismiss-all">
                {tr.inbox.clearEvents}
              </button>
            }
          >
            {tr.inbox.sectionEvents}
          </SectionTitle>
          {feed.events.map(({ source, item }) => (
            <EventRow key={`${source.profileId}:${item.id}`} source={source} event={item} multi={multi} />
          ))}
        </>
      )}
    </Screen>
  );
}
