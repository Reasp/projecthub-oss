import { useState } from 'react';
import { ArrowUUpLeftIcon, CheckCircleIcon, CheckIcon, CircleIcon, ImageIcon, WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { Badge, Button, Sheet, Spinner } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { checkStatusText, outcomeText, projectName, type FeedSource } from '../protocol/inbox';
import { capabilitiesFor } from '../protocol/models';
import { fieldProps } from '../components/FieldEditor';
import { useT } from '../i18n/react';
import type { RemoteReviewItem, RemoteReviewScreenshot } from '../../../src/types/remote';

/** Скриншот проверки `ui-smoke`: грузится по нажатию, частями с того ПК, где лежит отчёт. */
function Shot({ source, item, shot }: { source: FeedSource; item: RemoteReviewItem; shot: RemoteReviewScreenshot }) {
  const { inbox } = useServices();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (url) return <img src={url} alt={shot.name} data-testid="review-shot-img" className="mt-2 w-full rounded-lg border border-ph-line" />;
  return (
    <button
      type="button"
      disabled={loading || !source.online}
      data-testid="review-shot"
      onClick={async () => {
        setLoading(true);
        setUrl(await inbox.screenshot(source, item, shot.relPath));
        setLoading(false);
      }}
      className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-ph-line px-3 py-2 text-left text-[13px] text-slate-300 active:bg-ph-hover disabled:opacity-50"
    >
      {loading ? <Spinner /> : <ImageIcon size={18} />}
      <span className="min-w-0 flex-1 truncate">{shot.name}</span>
      {shot.checkName && <span className="shrink-0 text-[11px] text-slate-500">{shot.checkName}</span>}
    </button>
  );
}

/**
 * Проверка задачи из Review на телефоне (TASK-140.5, [[decision-117]] п. 4): критерии приёмки с вердиктом цикла
 * «до готовности», чеки, скриншоты `ui-smoke`. «Принять» переводит в Done, «Вернуть» — в работу с комментарием и,
 * если по задаче работала роль, перезапуском агента.
 */
export function ReviewSheet({ source, item, open, onClose }: { source: FeedSource; item: RemoteReviewItem; open: boolean; onClose: () => void }) {
  const { inbox, platform } = useServices();
  const tr = useT();
  const [mode, setMode] = useState<'view' | 'return'>('view');
  const [comment, setComment] = useState('');
  const [restart, setRestart] = useState(Boolean(item.roleSlug));
  const [busy, setBusy] = useState(false);
  const caps = capabilitiesFor(source.rights, Boolean(source.hostReadOnly));
  const canDecide = caps.decide && source.online;
  const report = item.report;
  const shownShots = new Set(item.criteria.flatMap((c) => (c.screenshots ?? []).map((s) => s.relPath)));
  const otherShots = (report?.screenshots ?? []).filter((s) => !shownShots.has(s.relPath));

  const act = async (action: 'done' | 'return') => {
    setBusy(true);
    platform.haptic(action === 'done' ? 'success' : 'warning');
    const ok = await inbox.review(source, item, action, comment, action === 'return' && restart && caps.write);
    setBusy(false);
    if (ok) onClose();
  };

  const footer = !canDecide ? (
    <div className="text-[12px] text-slate-400">{source.online ? tr.inbox.noRights : tr.inbox.offlineShort(source.machineName)}</div>
  ) : mode === 'view' ? (
    <div className="flex gap-2">
      <Button variant="secondary" className="flex-1" disabled={busy} haptic={null} onClick={() => setMode('return')}>
        <ArrowUUpLeftIcon size={18} /> <span data-testid="review-return-open">{tr.inbox.returnTask}</span>
      </Button>
      <Button variant="success" className="flex-1" disabled={busy} haptic={null} onClick={() => act('done')}>
        <CheckIcon size={18} /> <span data-testid="review-accept">{tr.inbox.accept}</span>
      </Button>
    </div>
  ) : (
    <div>
      <textarea
        {...fieldProps({ value: comment, onChange: setComment, multiline: true, title: tr.inbox.returnToAgent, placeholder: tr.inbox.returnPlaceholder })}
        rows={3}
        autoFocus
        data-testid="review-comment"
        className="w-full resize-none rounded-lg border border-ph-line bg-ph-base p-2 text-[14px] text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
      />
      {item.roleSlug && caps.write && (
        <label className="mt-2 flex items-center gap-2 text-[13px] text-slate-300">
          <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} data-testid="review-restart" />
          {tr.inbox.restartAgent(item.roleSlug)}
        </label>
      )}
      <div className="mt-2 flex gap-2">
        <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setMode('view')}>
          {tr.common.back}
        </Button>
        <Button variant="primary" className="flex-1" disabled={busy || !comment.trim()} haptic={null} onClick={() => act('return')}>
          <span data-testid="review-return-send">{tr.inbox.returnToAgent}</span>
        </Button>
      </div>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title={`${item.id} · ${item.title}`} footer={footer}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
        <Badge tone="accent">{source.machineName}</Badge>
        <Badge>{projectName(item.projectPath)}</Badge>
        {report?.outcome && <Badge tone={report.outcome === 'success' ? 'success' : 'warning'}>{outcomeText(report.outcome)}</Badge>}
        {report && <span>{tr.inbox.iterations(report.iterations)}</span>}
        {typeof report?.costUsd === 'number' && <span>${report.costUsd.toFixed(2)}</span>}
      </div>

      {report?.summary && (
        <div className="mt-3 rounded-lg bg-ph-base p-2 text-[13px]">
          <Markdown text={report.summary} />
        </div>
      )}

      <div className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.inbox.acceptanceCriteria}</div>
      {item.criteria.length === 0 && <div className="mt-1 text-[13px] text-slate-400">{tr.inbox.noCriteria}</div>}
      <ul className="mt-1 space-y-2" data-testid="review-criteria">
        {item.criteria.map((c) => {
          const ok = c.completed || c.accepted;
          return (
            <li key={c.index} className="rounded-lg bg-ph-base p-2">
              <div className="flex items-start gap-2">
                {ok ? (
                  <CheckCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0 text-emerald-400" />
                ) : c.accepted === false ? (
                  <XCircleIcon size={18} weight="fill" className="mt-0.5 shrink-0 text-rose-400" />
                ) : (
                  <CircleIcon size={18} className="mt-0.5 shrink-0 text-slate-500" />
                )}
                <div className="min-w-0 flex-1 text-[14px] leading-snug">
                  {c.text}
                  {c.ui && (
                    <span className="ml-1 align-middle">
                      <Badge>ui</Badge>
                    </span>
                  )}
                </div>
              </div>
              {c.evidence && <div className="mt-1 pl-6 text-[12px] text-slate-400">{c.evidence}</div>}
              {c.accepted === false && c.reason && <div className="mt-1 pl-6 text-[12px] text-rose-300">{c.reason}</div>}
              {(c.screenshots ?? []).map((s) => (
                <div key={s.relPath} className="pl-6">
                  <Shot source={source} item={item} shot={s} />
                </div>
              ))}
            </li>
          );
        })}
      </ul>

      {report && report.checks.length > 0 && (
        <>
          <div className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.inbox.checks}</div>
          <ul className="mt-1 space-y-1.5" data-testid="review-checks">
            {report.checks.map((check, i) => {
              const bad = check.status === 'failed' || check.status === 'timeout' || check.status === 'error';
              return (
                <li key={`${check.name}-${i}`} className="rounded-lg bg-ph-base p-2">
                  <div className="flex items-center gap-2 text-[14px]">
                    {bad ? <WarningCircleIcon size={16} className="shrink-0 text-rose-400" /> : <CheckCircleIcon size={16} className={clsx('shrink-0', check.status === 'passed' ? 'text-emerald-400' : 'text-slate-500')} />}
                    <span className="min-w-0 flex-1 truncate">{check.name}</span>
                    <Badge tone={bad ? 'danger' : check.status === 'passed' ? 'success' : 'neutral'}>{checkStatusText(check.status)}</Badge>
                  </div>
                  {(typeof check.passedTests === 'number' || typeof check.failedTests === 'number') && (
                    <div className="mt-0.5 pl-6 text-[12px] text-slate-400">
                      {tr.inbox.testsLine(check.passedTests ?? 0, check.failedTests ?? 0)}
                    </div>
                  )}
                  {check.detail && <pre className="selectable mt-1 whitespace-pre-wrap break-words pl-6 font-mono text-[11px] text-slate-400">{check.detail}</pre>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {otherShots.length > 0 && (
        <>
          <div className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{tr.inbox.uiSmokeShots}</div>
          {otherShots.map((s) => (
            <Shot key={s.relPath} source={source} item={item} shot={s} />
          ))}
        </>
      )}

      {!report && <div className="mt-4 text-[12px] text-slate-500">{tr.inbox.noReport}</div>}
    </Sheet>
  );
}
