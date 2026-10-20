import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AISettingsModal } from './AISettingsModal';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { OPEN_AI_SETTINGS_EVENT, type OpenAiSettingsDetail } from '../../lib/modelRouteText';

/**
 * Открывает настройки AI из любого места приложения по событию `projecthub:open-ai-settings`
 * (TASK-134.2, decision-75): панель плана и сообщения об ошибке выбора модели ведут сюда, а не только
 * AI Studio. С назначением в событии окно открывается на вкладке «Назначения» с этой строкой (TASK-134.3).
 * Окно рендерится порталом в `document.body` и монтируется в момент открытия, поэтому оказывается поверх
 * уже открытой модалки задачи (decision-17).
 */
export const AISettingsHost: React.FC = () => {
  const [open, setOpen] = useState<OpenAiSettingsDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenAiSettingsDetail>).detail ?? {};
      // Настройки могли ещё не загружаться (AI Studio не открывали): форма со значениями по умолчанию
      // при сохранении затёрла бы настоящие.
      void useAIStudioStore
        .getState()
        .fetchConfig()
        .finally(() => {
          if (!cancelled) setOpen({ ...detail });
        });
    };
    window.addEventListener(OPEN_AI_SETTINGS_EVENT, handleOpen);
    return () => {
      cancelled = true;
      window.removeEventListener(OPEN_AI_SETTINGS_EVENT, handleOpen);
    };
  }, []);

  if (!open) return null;
  return createPortal(
    <AISettingsModal
      isOpen
      onClose={() => setOpen(null)}
      {...(open.purpose ? { initialTab: 'assignments' as const, focusPurpose: open.purpose } : {})}
    />,
    document.body
  );
};
