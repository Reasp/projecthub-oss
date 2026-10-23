import { useState } from 'react';
import { ArrowUUpLeftIcon, CheckIcon, GitMergeIcon, PauseIcon } from '@phosphor-icons/react';
import type { RemoteQueueItem } from '../../../src/types/remote';
import { myQueueItems, pausedReason, returnReasons, reviewableByMe } from '../../../src/utils/teamQueue';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, Sheet } from '../components/ui';
import { fieldProps } from '../components/FieldEditor';
import { useT } from '../i18n/react';
import { capabilitiesFor } from '../protocol/models';

const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'review'> = {
  queued: 'neutral',
  building: 'accent',
  checking: 'accent',
  review: 'review',
  merging: 'accent',
  merged: 'success',
  returned: 'danger',
  cancelled: 'neutral',
  pr: 'success'
};

/** Элемент очереди: проверки, критерии, зависимости; для ревьюера — «Одобрить» и «Вернуть» с комментарием. */
function QueueCard({ item, position, review }: { item: RemoteQueueItem; position?: number; review?: boolean }) {
  const { store } = useServices();
  const tr = useT();
  const [mode, setMode] = useState<'view' | 'return'>('view');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const reasons = item.status === 'returned' ? returnReasons(item, tr.models.appErrors) : [];
  const act = async (approved: boolean) => {
    setBusy(true);
    const ok = await store.reviewQueueItem(item.id, approved, comment);
    setBusy(false);
    if (ok) {
      setMode('view');
      setComment('');
    }
  };
  return (
    <Card className="mb-2">
      <div className="flex items-center gap-2 text-[12px] text-slate-400" data-testid="queue-card">
        <span className="font-mono">#{item.n}</span>
        <span className="font-mono text-slate-200">{item.taskId}</span>
        <span className="ml-auto">
          <Badge tone={TONE[item.status] ?? 'neutral'}>{tr.tasks.queueStatus[item.status] ?? item.status}</Badge>
        </span>
      </div>
      {item.taskTitle && <div className="mt-1 text-[14px] leading-snug">{item.taskTitle}</div>}
      <div className="mt-1 text-[12px] text-slate-400">
        {tr.tasks.author(item.authorId)}
        {position ? ` · ${tr.tasks.queueState(item.n, tr.tasks.queueStatus[item.status] ?? item.status, position)}` : ''}
      </div>
      {item.checks && item.checks.length > 0 && (
        <div className="mt-1 text-[12px] text-slate-300">
          {tr.tasks.checks}: {item.checks.map((c) => `${c.name} — ${c.status}`).join(', ')}
        </div>
      )}
      {item.criteria && (
        <div className="mt-1 text-[12px] text-slate-300">
          {tr.tasks.criteria2}: {item.criteria.done}/{item.criteria.total}
        </div>
      )}
      {item.dependencies && item.dependencies.length > 0 && (
        <div className="mt-1 text-[12px] text-amber-300">
          {tr.tasks.dependencies}: {item.dependencies.join(', ')}
        </div>
      )}
      {reasons.length > 0 && (
        <div className="mt-2 rounded-lg bg-rose-500/10 p-2 text-[12px] text-rose-200" data-testid="queue-reasons">
          <div className="font-semibold">{tr.tasks.returnedWhy}</div>
          <ul className="mt-1 list-disc pl-4">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {review && mode === 'view' && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" className="flex-1" disabled={busy} onClick={() => setMode('return')}>
            <ArrowUUpLeftIcon size={16} /> <span data-testid="queue-return-open">{tr.tasks.returnToAuthor}</span>
          </Button>
          <Button size="sm" variant="success" className="flex-1" disabled={busy} haptic="success" onClick={() => void act(true)}>
            <CheckIcon size={16} /> <span data-testid="queue-approve">{tr.tasks.approve}</span>
          </Button>
        </div>
      )}
      {review && mode === 'return' && (
        <div className="mt-2">
          <textarea
            {...fieldProps({ value: comment, onChange: setComment, multiline: true, title: tr.tasks.sendReturn, placeholder: tr.tasks.returnPlaceholder })}
            rows={3}
            data-testid="queue-comment"
            className="w-full resize-none rounded-lg border border-ph-line bg-ph-base p-2 text-[14px] text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" className="flex-1" disabled={busy} onClick={() => setMode('view')}>
              {tr.common.back}
            </Button>
            <Button size="sm" variant="primary" className="flex-1" disabled={busy || !comment.trim()} haptic="warning" onClick={() => void act(false)}>
              <span data-testid="queue-return-send">{tr.tasks.sendReturn}</span>
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Очередь слияния общего хоста на телефоне (TASK-142.5): что ждёт моего ревью, где мои задачи и почему вернули, вся
 * очередь по порядку. Решения проверяет хост: своё одобрить нельзя, viewer не ревьюит.
 */
export function QueueSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tr = useT();
  const queue = useAppState((s) => s.queue);
  const team = useAppState((s) => s.team);
  const conn = useAppState((s) => s.conn);
  const canDecide = capabilitiesFor(conn.rights, conn.readOnly).write;
  const me = team?.me;
  const toReview = canDecide ? reviewableByMe(queue, me) : [];
  const mine = myQueueItems(queue, me);
  const myFinished = (queue?.finished ?? []).filter((i) => i.authorId === me).slice(0, 5);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <GitMergeIcon size={18} /> {tr.tasks.queue}
        </span>
      }
    >
      {queue?.settings.paused && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-[12px] text-amber-200">
          <PauseIcon size={16} /> {tr.tasks.paused(pausedReason(queue.settings.paused, tr.models.appErrors))}
        </div>
      )}
      {!queue || (queue.active.length === 0 && myFinished.length === 0) ? (
        <div className="py-6 text-center text-[13px] text-slate-500">{tr.tasks.queueEmpty}</div>
      ) : (
        <>
          {toReview.length > 0 && (
            <section data-testid="queue-review-section">
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.tasks.awaitingMyReview}</div>
              {toReview.map((i) => (
                <QueueCard key={i.id} item={i} review />
              ))}
            </section>
          )}
          {(mine.length > 0 || myFinished.length > 0) && (
            <section className="mt-3" data-testid="queue-mine-section">
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.tasks.myItems}</div>
              {mine.map((i) => (
                <QueueCard key={i.id} item={i} position={i.position} />
              ))}
              {myFinished.map((i) => (
                <QueueCard key={i.id} item={i} />
              ))}
            </section>
          )}
          {queue.active.length > 0 && (
            <section className="mt-3">
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.tasks.allItems}</div>
              {queue.active.map((i, idx) => (
                <QueueCard key={i.id} item={i} position={idx + 1} />
              ))}
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}
