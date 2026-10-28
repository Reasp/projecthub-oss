import { useEffect, useMemo, useState } from 'react';
import { LinkSimpleIcon } from '@phosphor-icons/react';
import { useServices } from '../app/context';
import { failureText } from '../app/errorText';
import type { PhoneFleetHost } from '../protocol/fleet';
import { useT } from '../i18n/react';
import { Button, Sheet } from './ui';
import {
  introduceComputers,
  loadPairedPeers,
  planIntroductions,
  type IntroduceHost,
  type IntroduceOutcome,
  type IntroducePair
} from '../../../src/utils/fleetIntroduce';

/**
 * Знакомство ПК через телефон (TASK-186, [[decision-143]]): если на связи хотя бы два ПК с полными правами и не все
 * они сопряжены между собой, телефон предлагает познакомить их. Пары человек видит списком и подтверждает один раз.
 */
export function IntroduceCard({ fleet }: { fleet: PhoneFleetHost[] }) {
  const { rpcTo, store } = useServices();
  const tr = useT();
  const eligible = useMemo<IntroduceHost[]>(
    () =>
      fleet
        .filter((h) => h.online && h.overview?.actions === 'full')
        .map((h) => ({ id: h.profileId, hostId: h.hostId, name: h.machineName || h.hostId })),
    [fleet]
  );
  // Перепроверять пары только когда меняется сам набор ПК, а не каждый снимок дерева.
  const key = eligible
    .map((h) => h.hostId)
    .sort()
    .join('|');
  const [pairs, setPairs] = useState<IntroducePair[]>([]);
  const [checkTick, setCheckTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<IntroduceOutcome[]>([]);

  useEffect(() => {
    if (eligible.length < 2) {
      setPairs([]);
      return;
    }
    let cancelled = false;
    void loadPairedPeers(eligible, rpcTo).then(({ paired, errors }) => {
      if (cancelled) return;
      // ПК, не сказавший, с кем сопряжён, в знакомство не идёт: иначе ему выдали бы лишние токены.
      const known = eligible.filter((h) => !errors[h.hostId]);
      setPairs(planIntroductions(known, paired));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- набор ПК задаёт `key`, а не ссылка на массив
  }, [key, checkTick, rpcTo]);

  if (pairs.length === 0 && failures.length === 0) return null;

  const run = async () => {
    setFailures([]);
    setProgress({ done: 0, total: pairs.length });
    const outcomes = await introduceComputers(pairs, rpcTo, (done, total) => setProgress({ done, total }));
    setProgress(null);
    const failed = outcomes.filter((o) => o.status === 'failed');
    const added = outcomes.filter((o) => o.status === 'added').length;
    setFailures(failed);
    if (failed.length === 0) setOpen(false);
    store.showToast(tr.fleet.introduceDone(added), failed.length ? 'error' : 'success');
    setCheckTick((n) => n + 1);
  };

  return (
    <>
      {pairs.length > 0 && (
        <div className="mt-3 rounded-xl border border-indigo-500/40 bg-indigo-950/40 p-3" data-testid="fleet-introduce">
          <div className="flex items-center gap-2 text-[15px] font-medium text-indigo-100">
            <LinkSimpleIcon size={18} className="shrink-0" />
            {tr.fleet.introduceTitle}
          </div>
          <div className="mt-1 text-[13px] leading-snug text-slate-300">{tr.fleet.introduceHint(pairs.length)}</div>
          <Button size="sm" variant="primary" className="mt-2" onClick={() => setOpen(true)} data-testid="fleet-introduce-open">
            {tr.fleet.introduceAction}
          </Button>
        </div>
      )}
      <Sheet
        open={open}
        onClose={() => !progress && setOpen(false)}
        title={tr.fleet.introduceAction}
        footer={
          <Button variant="primary" className="w-full" disabled={progress !== null || pairs.length === 0} onClick={() => void run()} data-testid="fleet-introduce-confirm">
            {progress ? tr.fleet.introduceRunning(progress.done, progress.total) : tr.fleet.introduceConfirm}
          </Button>
        }
      >
        <div className="space-y-2 px-4 pb-3">
          <ul className="space-y-1 text-[14px]">
            {pairs.map((p) => (
              <li key={`${p.to.hostId}>${p.peer.hostId}`}>{tr.fleet.introducePair(p.to.name, p.peer.name)}</li>
            ))}
          </ul>
          <p className="text-[12px] leading-snug text-slate-400">{tr.fleet.introduceSheetHint}</p>
          {failures.map((f) => (
            <p key={`${f.pair.to.hostId}>${f.pair.peer.hostId}`} className="text-[12px] text-red-300">
              {tr.fleet.introduceFailed(tr.fleet.introducePair(f.pair.to.name, f.pair.peer.name), failureText(f))}
            </p>
          ))}
        </div>
      </Sheet>
    </>
  );
}
