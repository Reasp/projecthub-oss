import { useTranslation } from '../../i18n/useTranslation';

type Risk = 'low' | 'moderate' | 'high';

const TONE: Record<Risk, string> = {
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  moderate: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  high: 'bg-red-500/15 text-red-300 border-red-500/40'
};

/** Класс риска запроса HITL (TASK-140.4, decision-112): считает хост, причина — в подсказке. */
export function RiskBadge({ risk, reason }: { risk?: Risk; reason?: string }) {
  const { t } = useTranslation();
  if (!risk) return null;
  const label = risk === 'high' ? t.aiStudio.approval.riskHigh : risk === 'moderate' ? t.aiStudio.approval.riskModerate : t.aiStudio.approval.riskLow;
  return (
    <span
      data-testid="hitl-risk"
      title={[reason, t.aiStudio.approval.riskPhoneHint].filter(Boolean).join('. ')}
      className={`text-[11px] border px-2 py-0.5 rounded-full font-medium ${TONE[risk]}`}
    >
      {label}
      {reason ? ` · ${reason}` : ''}
    </span>
  );
}
