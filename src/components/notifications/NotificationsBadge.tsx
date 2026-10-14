import React from 'react';
import { Bell, BellOff, BellRing } from '../common/icons';
import { useNotificationStore } from '../../store/useNotificationStore';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Бейдж уведомлений в шапке (TASK-63): состояние доставки и вход в настройки каналов,
 * тихих часов и Telegram-бота. Число — уведомления, доставленные за текущую сессию окна.
 */
export const NotificationsBadge: React.FC = () => {
  const { t } = useTranslation();
  const settings = useNotificationStore((s) => s.settings);
  const historyCount = useNotificationStore((s) => s.history.length);
  const openSettings = useNotificationStore((s) => s.openSettings);

  const muted = settings ? !settings.enabled : false;
  const Icon = muted ? BellOff : historyCount > 0 ? BellRing : Bell;

  return (
    <button
      type="button"
      onClick={openSettings}
      title={muted ? t.notifications.badgeMuted : t.notifications.badgeTooltip}
      className={`ph-status-item ${muted ? 'opacity-70' : ''}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {historyCount > 0 && <span>{historyCount > 99 ? '99+' : historyCount}</span>}
    </button>
  );
};
