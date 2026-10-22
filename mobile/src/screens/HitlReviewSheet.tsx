import { useEffect, useState } from 'react';
import { FingerprintIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useServices } from '../app/context';
import { Badge, Button, Sheet, Spinner } from '../components/ui';
import { diffLineKind, hitlText, type HitlItem } from '../protocol/models';
import { useT } from '../i18n/react';
import type { RemoteHitlDetail } from '../../../src/types/remote';

const LINE_CLASS: Record<ReturnType<typeof diffLineKind>, string> = {
  add: 'bg-emerald-950/60 text-emerald-200',
  del: 'bg-rose-950/60 text-rose-200',
  hunk: 'text-sky-300',
  meta: 'text-slate-500',
  context: 'text-slate-300'
};

/**
 * Запрос высокого риска целиком перед одобрением с телефона (TASK-140.6, [[decision-114]] п. 3): команда без
 * усечения и дифф правки. «Одобрить» спрашивает биометрию; дифф, не поместившийся на телефон, одобряется только на ПК.
 */
export function HitlReviewSheet({ item, open, onClose }: { item: HitlItem; open: boolean; onClose: () => void }) {
  const { store, platform } = useServices();
  const tr = useT();
  const [detail, setDetail] = useState<RemoteHitlDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void store.loadHitlDetail(item.requestId).then((d) => {
      if (!alive) return;
      setDetail(d);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open, item.requestId, store]);

  const truncated = Boolean(detail?.diff?.truncated || detail?.detailsTruncated);
  const text = hitlText(detail ? { title: detail.title, details: detail.details, textKey: detail.textKey ?? item.textKey } : item, tr.models.hitlText);
  const decide = async (approve: boolean) => {
    setBusy(true);
    platform.haptic(approve ? 'heavy' : 'warning');
    const ok = approve ? await store.approveWithBiometric(item.requestId) : await store.decideHitl(item.requestId, false);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={tr.inbox.hitlReviewTitle}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={busy} haptic={null} onClick={() => decide(false)}>
            <XIcon size={18} /> {tr.inbox.reject}
          </Button>
          <Button
            variant="success"
            className="flex-1"
            disabled={busy || loading || !detail || truncated}
            haptic={null}
            onClick={() => decide(true)}
          >
            <FingerprintIcon size={18} /> <span data-testid="hitl-biometric-approve">{tr.inbox.approve}</span>
          </Button>
        </div>
      }
    >
      <div className="text-[15px] font-medium leading-snug">{text.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
        {(detail?.tool || item.tool) && <Badge tone="warning">{detail?.tool || item.tool}</Badge>}
        <Badge tone="danger">{tr.inbox.risk[detail?.risk ?? item.risk ?? 'high']}</Badge>
      </div>
      {(detail?.riskReason || item.riskReason) && <div className="mt-1 text-[12px] text-slate-500">{detail?.riskReason || item.riskReason}</div>}

      {loading && (
        <div className="mt-4 flex justify-center">
          <Spinner />
        </div>
      )}
      {!loading && !detail && <div className="mt-4 text-[13px] text-slate-400">{tr.inbox.hitlLoadFailed}</div>}

      {detail?.command && (
        <>
          <div className="mt-3 text-[12px] uppercase tracking-wide text-slate-500">{tr.inbox.fullCommand}</div>
          <pre data-testid="hitl-full-command" className="selectable mt-1 whitespace-pre-wrap break-all rounded-lg bg-ph-base p-2 font-mono text-[12px] text-slate-100">
            $ {detail.command}
          </pre>
        </>
      )}
      {detail && text.details && !detail.command && (
        <pre className="selectable mt-3 whitespace-pre-wrap break-words rounded-lg bg-ph-base p-2 font-mono text-[12px] text-slate-200">{text.details}</pre>
      )}
      {detail?.diff && (
        <>
          <div className="mt-3 text-[12px] uppercase tracking-wide text-slate-500">{tr.inbox.changesOf(detail.diff.filePath)}</div>
          <div data-testid="hitl-full-diff" className="selectable mt-1 overflow-x-auto rounded-lg bg-ph-base py-1 font-mono text-[12px]">
            {detail.diff.patch.split('\n').map((line, i) => (
              <div key={i} className={clsx('whitespace-pre px-2', LINE_CLASS[diffLineKind(line)])}>
                {line || ' '}
              </div>
            ))}
          </div>
        </>
      )}
      {!detail?.diff && detail?.filePath && !detail.command && <div className="mt-3 font-mono text-[12px] text-slate-300">{detail.filePath}</div>}
      {truncated && (
        <div className="mt-3 rounded-lg border border-amber-900/60 p-2 text-[13px] text-amber-200">
          {tr.inbox.diffTooLarge}
        </div>
      )}
    </Sheet>
  );
}
