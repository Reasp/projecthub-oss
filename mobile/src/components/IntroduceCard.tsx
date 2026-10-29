import { useEffect, useMemo, useState } from 'react';
import { LinkSimpleIcon } from '@phosphor-icons/react';
import { useServices } from '../app/context';
import { failureText } from '../app/errorText';
import { safeStorage } from '../platform/pageStore';
import type { PhoneFleetHost } from '../protocol/fleet';
import { useT } from '../i18n/react';
import { Button, Sheet } from './ui';
import {
  introduceComputers,
  introduceHostSetKey,
  introducePairKey,
  loadPairedPeers,
  offeredIntroductions,
  parseDismissedIntroductions,
  planIntroductions,
  rememberDismissed,
  type DismissedIntroductions,
  type IntroduceHost,
  type IntroduceOutcome,
  type IntroducePair
} from '../../../src/utils/fleetIntroduce';

/** Снятые пары — несекретная настройка интерфейса, в хранилище страницы рядом с прочими (`ph_mobile_pref:`). */
const DISMISSED_KEY = 'ph_mobile_pref:introduce:dismissed';

function loadDismissed(): DismissedIntroductions | null {
  try {
    const raw = safeStorage()?.getItem(DISMISSED_KEY);
    return raw ? parseDismissedIntroductions(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveDismissed(value: DismissedIntroductions): void {
  try {
    safeStorage()?.setItem(DISMISSED_KEY, JSON.stringify(value));
  } catch {
    // приватный режим — снятые пары предложатся снова
  }
}

/**
 * Знакомство ПК через телефон (TASK-186, [[decision-143]]): если на связи хотя бы два ПК с полными правами и не все
 * они сопряжены между собой, телефон предлагает познакомить их. Пары человек видит списком, снимает лишние (TASK-232)
 * и подтверждает один раз; снятые не предлагаются снова, пока не изменится набор ПК.
 */
export function IntroduceCard({ fleet }: { fleet: PhoneFleetHost[] }) {
  const { rpcTo, store } = useServices();
  const tr = useT();
  const eligible = useMemo<IntroduceHost[]>(
    () =>
      fleet
        .filter((h) => h.online && h.overview?.actions === 'full')
        .map((h) => ({ id: h.profileId, hostId: h.hostId, name: h.machineName || h.hostId, ...(h.via ? { via: h.via } : {}) })),
    [fleet]
  );
  // Перепроверять пары только когда меняется сам набор ПК, а не каждый снимок дерева.
  const key = introduceHostSetKey(eligible);
  const hostIds = useMemo(() => (key ? key.split('|') : []), [key]);
  const [pairs, setPairs] = useState<IntroducePair[]>([]);
  // Снятые, а не выбранные: перепланирование (ПК моргнул связью) не возвращает галочку, от которой человек отказался.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
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
      setPairs(offeredIntroductions(planIntroductions(known, paired), hostIds, loadDismissed()));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- набор ПК задаёт `key`, а не ссылка на массив
  }, [key, checkTick, rpcTo]);

  if (pairs.length === 0 && failures.length === 0) return null;

  const chosen = pairs.filter((p) => !unchecked.has(introducePairKey(p)));

  const toggle = (pairKey: string, on: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(pairKey);
      else next.add(pairKey);
      return next;
    });

  /** Снятые пары запоминаются и по «Познакомить», и при закрытии листа. */
  const rememberUnchecked = (): boolean => {
    if (!pairs.some((p) => unchecked.has(introducePairKey(p)))) return false;
    saveDismissed(rememberDismissed(pairs, unchecked, hostIds, loadDismissed()));
    setUnchecked(new Set());
    setCheckTick((n) => n + 1);
    return true;
  };

  const close = () => {
    if (progress) return;
    setOpen(false);
    rememberUnchecked();
  };

  const run = async () => {
    rememberUnchecked();
    setFailures([]);
    if (chosen.length === 0) {
      setOpen(false);
      return;
    }
    setProgress({ done: 0, total: chosen.length });
    const outcomes = await introduceComputers(chosen, rpcTo, (done, total) => setProgress({ done, total }));
    setProgress(null);
    const failed = outcomes.filter((o) => o.status === 'failed');
    const added = outcomes.filter((o) => o.status === 'added').length;
    setFailures(failed);
    if (failed.length === 0) setOpen(false);
    store.showToast(tr.fleet.introduceDone(added), failed.length ? 'error' : 'success');
    setCheckTick((n) => n + 1);
  };

  const viaMark = (p: IntroducePair) =>
    [p.to, p.peer]
      .filter((h) => h.via)
      .map((h) => tr.fleet.introduceVia(h.name, h.via ?? ''))
      .join(' · ');

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
        onClose={close}
        title={tr.fleet.introduceAction}
        footer={
          <Button variant="primary" className="w-full" disabled={progress !== null || pairs.length === 0} onClick={() => void run()} data-testid="fleet-introduce-confirm">
            {progress
              ? tr.fleet.introduceRunning(progress.done, progress.total)
              : pairs.length === 0
                ? tr.fleet.introduceAction
                : chosen.length === 0
                  ? tr.fleet.introduceSkipAll
                : tr.fleet.introduceConfirmCount(chosen.length)}
          </Button>
        }
      >
        <div className="space-y-2 px-4 pb-3">
          <ul className="space-y-1 text-[14px]">
            {pairs.map((p) => {
              const pairKey = introducePairKey(p);
              const mark = viaMark(p);
              return (
                <li key={pairKey}>
                  <label className="flex items-start gap-2 py-1">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!unchecked.has(pairKey)}
                      disabled={progress !== null}
                      onChange={(e) => toggle(pairKey, e.target.checked)}
                      data-testid="fleet-introduce-pair"
                    />
                    <span>
                      {tr.fleet.introducePair(p.to.name, p.peer.name)}
                      {mark && <span className="block text-[12px] text-amber-300/90">{mark}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] leading-snug text-slate-400">{tr.fleet.introduceSheetHint}</p>
          <p className="text-[12px] leading-snug text-slate-500">{tr.fleet.introduceUncheckHint}</p>
          {failures.map((f) => (
            <p key={introducePairKey(f.pair)} className="text-[12px] text-red-300">
              {tr.fleet.introduceFailed(tr.fleet.introducePair(f.pair.to.name, f.pair.peer.name), failureText(f))}
            </p>
          ))}
        </div>
      </Sheet>
    </>
  );
}
