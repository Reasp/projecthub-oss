import { useEffect, useState } from 'react';
import { Wallet } from '../common/icons';
import type { AgentLaunchCheckInput, AgentLaunchVerdictView } from '../../types/electron';
import { ipcFailureText } from '../../i18n/useTranslation';

/**
 * Ограничения запуска агента до нажатия «Запустить» (точки расширения, decision-123 п. 4; бюджеты Team, decision-124).
 * В открытой редакции примечаний нет, и компонент ничего не рисует. Текст — по коду примечания на языке окна, без кода — текст хоста.
 */
export function useLaunchCheck(input: AgentLaunchCheckInput | null): AgentLaunchVerdictView | null {
  const [verdict, setVerdict] = useState<AgentLaunchVerdictView | null>(null);
  const key = input ? JSON.stringify(input) : '';
  useEffect(() => {
    setVerdict(null);
    if (!key || !window.api?.checkAgentLaunch) return;
    let cancelled = false;
    window.api
      .checkAgentLaunch(JSON.parse(key) as AgentLaunchCheckInput)
      .then((res) => {
        if (!cancelled) setVerdict(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);
  return verdict;
}

/** Самое строгое примечание крупно, остальные — строками ниже; ничего не обрезается. */
export function LaunchLimitsNotice({ verdict }: { verdict: AgentLaunchVerdictView | null }) {
  if (!verdict || verdict.notices.length === 0) return null;
  const order = { block: 0, warn: 1, info: 2 } as const;
  const sorted = [...verdict.notices].sort((a, b) => order[a.level] - order[b.level]);
  const tone = (level: 'info' | 'warn' | 'block') =>
    level === 'block' ? 'text-rose-300' : level === 'warn' ? 'text-amber-300' : 'text-slate-400';
  return (
    <div data-testid="launch-limits" className="flex items-start gap-2 text-[11px]">
      <Wallet className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone(sorted[0].level)}`} />
      <div className="min-w-0 space-y-0.5">
        {sorted.map((n, i) => (
          <div key={i} className={`break-words ${tone(n.level)}`}>
            {ipcFailureText({ error: n.text, errorKey: n.textKey })}
          </div>
        ))}
      </div>
    </div>
  );
}
