import React from 'react';
import { CheckCircle2, Circle, ListTodo, Loader2 } from '../common/icons';
import { todoProgress, type TodoItem } from '../../lib/agentToolView';
import { useTranslation } from '../../i18n/useTranslation';

interface AgentTodoListProps {
  items: TodoItem[];
  /** Ответ ещё идёт: текущий пункт крутится, как в терминале Claude Code. */
  live?: boolean;
  /** Без рамки и заголовка — внутри развёрнутого шага TodoWrite. */
  bare?: boolean;
}

/** План агента из `TodoWrite` списком со статусами пунктов (TASK-271). */
export const AgentTodoList: React.FC<AgentTodoListProps> = ({ items, live = false, bare = false }) => {
  const { t } = useTranslation();
  const { done, total } = todoProgress(items);

  const list = (
    <ul className="space-y-1" aria-label={t.aiStudio.todos.title}>
      {items.map((item, idx) => {
        const statusText =
          item.status === 'completed'
            ? t.aiStudio.todos.statusCompleted
            : item.status === 'in_progress'
            ? t.aiStudio.todos.statusInProgress
            : t.aiStudio.todos.statusPending;
        return (
          <li key={idx} className="flex items-start gap-2 text-xs leading-relaxed" title={statusText}>
            <span className="mt-0.5 shrink-0" aria-label={statusText}>
              {item.status === 'completed' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              ) : item.status === 'in_progress' ? (
                live ? (
                  <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-amber-400" />
                )
              ) : (
                <Circle className="w-3.5 h-3.5 text-slate-600" />
              )}
            </span>
            <span
              className={
                item.status === 'completed'
                  ? 'text-slate-500 line-through decoration-slate-600'
                  : item.status === 'in_progress'
                  ? 'text-amber-200 font-medium'
                  : 'text-slate-300'
              }
            >
              {item.status === 'in_progress' && live && item.activeForm ? item.activeForm : item.content}
            </span>
          </li>
        );
      })}
    </ul>
  );

  if (bare) return items.length > 0 ? list : <span className="text-[11px] text-slate-500">{t.aiStudio.todos.empty}</span>;

  return (
    <div className="my-2 rounded-xl bg-ph-elevated border border-slate-800/90 px-3.5 py-2.5 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <ListTodo className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="font-semibold text-slate-200">{t.aiStudio.todos.title}</span>
        {total > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-800 text-slate-400 border border-slate-700/60">
            {t.aiStudio.todos.progress.replace('{done}', String(done)).replace('{total}', String(total))}
          </span>
        )}
      </div>
      {items.length > 0 ? list : <span className="text-[11px] text-slate-500">{t.aiStudio.todos.empty}</span>}
    </div>
  );
};
