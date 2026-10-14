import React from 'react';
import { ShieldAlert, ShieldCheck } from '../common/icons';
import { useHitlStore } from '../../store/useHitlStore';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Бейдж единого HITL-контура в шапке (TASK-57): число запросов всех сессий, ожидающих решения;
 * клик открывает Центр решений.
 */
export const HitlBadge: React.FC = () => {
  const { t } = useTranslation();
  const pendingCount = useHitlStore((s) => s.pending.length);
  const openCenter = useHitlStore((s) => s.openCenter);

  const hasPending = pendingCount > 0;
  return (
    <button
      type="button"
      onClick={() => openCenter(hasPending ? 'queue' : undefined)}
      title={hasPending ? t.hitl.badgePending.replace('{count}', String(pendingCount)) : t.hitl.badgeTooltip}
      className={`ph-status-item ${hasPending ? 'ph-status-item-warning font-semibold' : ''}`}
    >
      {hasPending ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
      {hasPending && <span>{pendingCount}</span>}
    </button>
  );
};
