import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Gauge } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import type { ClaudeUsageData } from '../../types/electron';
import { QUOTA_HIGH_PERCENT, formatQuotaReset, quotaView, type QuotaView, type QuotaWindowView } from '../../lib/subscriptionQuota';

/**
 * Остаток окон подписки Claude Code перед запуском плана или Swarm (TASK-134.5, decision-98).
 *
 * Только информирует: запуск не блокируется. Лимиты берутся из того же кэша main-процесса, что и окно
 * Usage (`claude -p /usage` не чаще раза в 45 с, без токенов модели), запрос идёт после отрисовки.
 */

interface SubscriptionQuotaNoticeProps {
  projectPath: string;
  /** Аккаунты подписки; `undefined` в списке — аккаунт проекта. */
  accountIds: (string | undefined)[];
  /** Сколько запусков пойдут одновременно на одном аккаунте и где (подпись предупреждения). */
  parallel?: { n: number; kind: 'plan' | 'swarm' };
  /** Пояснить, что USD-бюджет на подписке — оценка по ценам API. */
  budgetNote?: boolean;
  /** Подписи аккаунтов показывать, даже когда аккаунт один (профилей несколько). */
  showAccountNames?: boolean;
}

interface LoadedUsage {
  usage?: ClaudeUsageData;
  failed?: boolean;
}

const keyOf = (accountId: string | undefined) => accountId ?? '';

export const SubscriptionQuotaNotice: React.FC<SubscriptionQuotaNoticeProps> = ({
  projectPath,
  accountIds,
  parallel,
  budgetNote,
  showAccountNames
}) => {
  const { t, language } = useTranslation();
  const q = t.subscriptionQuota;
  const [loaded, setLoaded] = useState<Record<string, LoadedUsage>>({});
  const accountsKey = [...new Set(accountIds.map(keyOf))].sort().join('|');
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const keys = accountsKey.split('|');
    setLoaded({});
    for (const key of keys) {
      const query = key ? { accountId: key } : { projectPath };
      window.api
        .getClaudeUsage(false, query)
        .then((usage) => {
          if (seq === requestSeq.current) setLoaded((prev) => ({ ...prev, [key]: { usage } }));
        })
        .catch(() => {
          if (seq === requestSeq.current) setLoaded((prev) => ({ ...prev, [key]: { failed: true } }));
        });
    }
  }, [accountsKey, projectPath]);

  const views = useMemo(
    () => accountsKey.split('|').map((key) => ({ key, view: quotaView(loaded[key]?.usage, loaded[key]?.failed) })),
    [accountsKey, loaded]
  );

  const multiple = views.length > 1 || showAccountNames;
  const parallelWarn = parallel && parallel.n > 1;
  const attention = parallelWarn || views.some(({ view }) => view.level === 'high' || view.level === 'exhausted');

  const windowText = (label: string, window: QuotaWindowView | undefined) => {
    if (!window) return null;
    const reset = formatQuotaReset(window.resetsAt, language);
    return (
      <span className={window.usedPercent >= QUOTA_HIGH_PERCENT ? 'text-amber-300' : 'text-foreground/90'}>
        {label}: {q.left.replace('{left}', String(window.leftPercent))}
        {reset && <span className="text-muted-foreground/70"> · {q.resets.replace('{time}', reset)}</span>}
      </span>
    );
  };

  const accountRow = (key: string, view: QuotaView) => (
    <div key={key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid="subscription-quota-row">
      {multiple && view.accountName && (
        <span className="text-muted-foreground/70">{q.account.replace('{name}', view.accountName)}:</span>
      )}
      {view.noData ? (
        <span className={view.noData === 'loading' ? 'text-muted-foreground' : 'text-amber-300/90'}>{q.noData[view.noData]}</span>
      ) : (
        <>
          {windowText(q.session, view.session)}
          {windowText(q.weekly, view.weekly)}
        </>
      )}
      {view.stale && <span className="text-muted-foreground/70">{q.stale.replace('{reason}', q.noData[view.stale])}</span>}
      {view.level === 'exhausted' && <span className="text-rose-300">{q.exhausted}</span>}
      {view.level === 'high' && <span className="text-amber-300">{q.high}</span>}
    </div>
  );

  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 text-[11px] space-y-1 ${
        attention ? 'border-amber-700/50 bg-amber-950/30' : 'border-white/10 bg-white/[0.02]'
      }`}
      data-testid="subscription-quota"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 font-medium text-foreground/90">
            <Gauge className="w-3 h-3 text-violet-300" />
            <span>{q.title}</span>
          </div>
          {views.map(({ key, view }) => accountRow(key, view))}
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('projecthub:open-claude-usage'))}
          className="shrink-0 px-2 py-1 rounded border border-white/10 bg-black/30 hover:bg-black/50 text-[10px] text-muted-foreground transition"
        >
          {q.openUsage}
        </button>
      </div>
      {parallelWarn && (
        <div className="flex items-start gap-1 text-amber-200" data-testid="subscription-quota-parallel">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            {(parallel.kind === 'plan' ? q.parallelPlan : q.parallelSwarm).replace('{n}', String(parallel.n))} {q.notBlocking}
          </span>
        </div>
      )}
      {budgetNote && <div className="text-muted-foreground/80">{q.budgetNote}</div>}
    </div>
  );
};
