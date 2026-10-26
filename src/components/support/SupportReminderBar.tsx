import React, { useEffect, useRef } from 'react';
import { Heart, X } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { useProjectStore } from '../../store/useProjectStore';
import { useHitlStore } from '../../store/useHitlStore';
import { useAutomationsStore } from '../../store/useAutomationsStore';
import { taskStage } from '../../utils/taskStatus';
import { countNewlyDone } from '../../lib/supportReminder';
import { SUPPORT_ENABLED, SUPPORT_URL, useSupportStore } from './supportStore';

const isDone = (status: string) => taskStage(status) === 'done';

/**
 * Мягкое напоминание о поддержке над строкой состояния (TASK-144.6): полоса в потоке раскладки, а не окно поверх
 * работы. Показывается не чаще раза в ~2 недели и только тем, у кого задачи доходят до Done; скрыта, пока открыт
 * центр решений HITL или Automations. Счётчик завершённых задач ведёт этот же компонент.
 */
export const SupportReminderBar: React.FC = () => {
  if (!SUPPORT_ENABLED || !SUPPORT_URL) return null;
  return <SupportReminderBarInner />;
};

const SupportReminderBarInner: React.FC = () => {
  const { t } = useTranslation();
  const tasks = useProjectStore((s) => s.tasks);
  const projectPath = useProjectStore((s) => s.selectedProject?.path);
  const hitlOpen = useHitlStore((s) => s.isCenterOpen);
  const automationsOpen = useAutomationsStore((s) => s.isOpen);
  const visible = useSupportStore((s) => s.reminderVisible);
  const noteDone = useSupportStore((s) => s.noteDone);
  const openSupport = useSupportStore((s) => s.openSupport);
  const remindLater = useSupportStore((s) => s.remindLater);
  const snapshot = useRef<{ projectPath?: string; statuses: Map<string, string> }>({ statuses: new Map() });

  useEffect(() => {
    const prev = snapshot.current;
    if (prev.projectPath === projectPath) noteDone(countNewlyDone(prev.statuses, tasks, isDone));
    snapshot.current = { projectPath, statuses: new Map(tasks.map((task) => [task.id, task.status])) };
  }, [tasks, projectPath, noteDone]);

  if (!visible || hitlOpen || automationsOpen) return null;
  return (
    <div
      className="h-8 shrink-0 flex items-center gap-3 px-3 bg-ph-elevated border-t border-ph-line text-xs text-slate-300 select-none"
      role="note"
    >
      <Heart className="w-3.5 h-3.5 shrink-0 text-rose-400" />
      <span className="flex-1 min-w-0 truncate">{t.support.reminderText}</span>
      <button
        type="button"
        onClick={() => openSupport('reminder')}
        className="px-2.5 py-0.5 rounded bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/40"
      >
        {t.support.reminderSupport}
      </button>
      <button type="button" onClick={remindLater} className="px-2 py-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700/50">
        {t.support.reminderLater}
      </button>
      <button type="button" onClick={remindLater} title={t.support.reminderLater} className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/50">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
