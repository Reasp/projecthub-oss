import React from 'react';
import { Workflow } from '../common/icons';
import { useAutomationsStore } from '../../store/useAutomationsStore';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Бейдж Automations в шапке (TASK-74): число активных правил и вход в модалку. Янтарный цвет —
 * есть правило на паузе по дневному лимиту или проектное правило ждёт подтверждения.
 */
export const AutomationsBadge: React.FC = () => {
  const { t } = useTranslation();
  const rules = useAutomationsStore((s) => s.rules);
  const open = useAutomationsStore((s) => s.open);

  const now = Date.now();
  const active = rules.filter((r) => r.active).length;
  const attention = rules.some((r) => (r.state.pausedUntil ?? 0) > now || r.trust === 'changed');

  return (
    <button
      type="button"
      onClick={() => open()}
      title={attention ? t.automations.badgePaused : t.automations.badgeTooltip}
      className={`ph-status-item ${attention ? 'text-amber-300' : ''}`}
    >
      <Workflow className="w-3.5 h-3.5" />
      <span>{t.automations.title}</span>
      {active > 0 && <span className="tabular-nums">{active}</span>}
    </button>
  );
};
