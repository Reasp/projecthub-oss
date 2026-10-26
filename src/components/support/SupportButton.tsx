import React from 'react';
import { Heart } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { SUPPORT_ENABLED, SUPPORT_URL, useSupportStore } from './supportStore';

/** Кнопка «Support» в строке состояния открытой редакции, рядом с диагностикой (TASK-144.6). */
export const SupportButton: React.FC = () => {
  const { t } = useTranslation();
  const openSupport = useSupportStore((s) => s.openSupport);
  if (!SUPPORT_ENABLED || !SUPPORT_URL) return null;
  return (
    <button type="button" onClick={() => openSupport('button')} title={t.support.buttonTooltip} className="ph-status-item">
      <Heart className="w-3.5 h-3.5 shrink-0 text-rose-400" />
      <span>{t.support.button}</span>
    </button>
  );
};
