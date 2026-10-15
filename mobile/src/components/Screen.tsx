import { useRef, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useHaptic } from '../app/context';
import { PULL_TRIGGER, usePullToRefresh } from './gestures';

/** Прокручиваемый экран вкладки с «потянуть для обновления». */
export function Screen({ children, onRefresh, className }: { children: ReactNode; onRefresh?: () => Promise<void>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const haptic = useHaptic();
  const handlers = usePullToRefresh(
    ref,
    (d) => setPull(d),
    (triggered) => {
      setPull(0);
      if (triggered && onRefresh && !refreshing) {
        haptic('medium');
        setRefreshing(true);
        onRefresh().finally(() => setRefreshing(false));
      }
    }
  );
  const shown = refreshing ? PULL_TRIGGER * 0.6 : pull;

  return (
    <div ref={ref} className={clsx('relative h-full overflow-y-auto overscroll-contain', className)} {...(onRefresh ? handlers : {})}>
      {onRefresh && (
        <div className="pointer-events-none flex justify-center overflow-hidden text-slate-400" style={{ height: shown }}>
          <ArrowClockwiseIcon
            size={20}
            className={clsx('mt-2', refreshing && 'animate-spin')}
            style={{ transform: refreshing ? undefined : `rotate(${pull * 4}deg)`, opacity: Math.min(1, shown / PULL_TRIGGER) }}
          />
        </div>
      )}
      <div className="px-3 pb-6 pt-3">{children}</div>
    </div>
  );
}
