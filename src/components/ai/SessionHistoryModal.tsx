import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, Search, Smartphone, Trash2, X } from '../common/icons';
import { useAIStudioStore, type AISession } from '../../store/useAIStudioStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import { selectionLabel, sessionUpdatedAt } from '../../utils/studioRemote';

/**
 * История диалогов Agents Studio (TASK-140.10, decision-83): закрытые вкладки не удаляются, а уходят сюда.
 * Свежие сверху, поиск по названию и тексту, «Открыть» возвращает сессию во вкладки.
 */
export const SessionHistoryModal: React.FC<{ projectPath: string; onClose: () => void }> = ({ projectPath, onClose }) => {
  const { t } = useTranslation();
  const dialog = useDialog();
  const reopenSession = useAIStudioStore((s) => s.reopenSession);
  const [sessions, setSessions] = useState<AISession[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    void (window.api?.listAISessions?.(projectPath) ?? Promise.resolve([] as AISession[]))
      .then((list) => {
        if (alive) setSessions(list.filter((s) => typeof s.archivedAt === 'number' && s.messages.length > 0));
      })
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, [projectPath]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessions ?? [])
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.messages.some((m) => m.role === 'user' && m.content.toLowerCase().includes(q)))
      .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
  }, [sessions, query]);

  const open = (s: AISession) => {
    reopenSession(projectPath, s, true);
    onClose();
  };

  const remove = async (s: AISession) => {
    const ok = await dialog.confirm({
      title: t.aiStudio.historyDeleteTitle,
      message: t.aiStudio.historyDeleteMessage.replace('{title}', s.title),
      confirmText: t.aiStudio.historyDelete,
      danger: true
    });
    if (!ok) return;
    await window.api?.deleteAISession?.(projectPath, s.id);
    setSessions((prev) => (prev ?? []).filter((x) => x.id !== s.id));
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ph-line bg-ph-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t.aiStudio.historyTitle}
      >
        <div className="flex items-center gap-2 border-b border-ph-line px-4 py-3">
          <History className="h-4 w-4 text-indigo-300" />
          <div className="flex-1 text-sm font-semibold text-slate-100">{t.aiStudio.historyTitle}</div>
          <button type="button" onClick={onClose} className="ph-icon-button" aria-label={t.common.close}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-ph-line px-4 py-2">
          <div className="flex items-center gap-2 rounded-lg border border-ph-line bg-ph-chrome px-2">
            <Search className="h-3.5 w-3.5 text-slate-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.aiStudio.historySearch}
              className="w-full bg-transparent py-1.5 text-xs text-slate-200 outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions === null ? (
            <div className="p-6 text-center text-xs text-slate-500">{t.common.loading}</div>
          ) : visible.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">{query ? t.aiStudio.historyNothingFound : t.aiStudio.historyEmpty}</div>
          ) : (
            <ul className="divide-y divide-ph-line">
              {visible.map((s) => {
                const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
                const model = selectionLabel(s.lastSelection);
                return (
                  <li key={s.id} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-ph-hover/50">
                    <button type="button" onClick={() => open(s)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-100">
                        {s.origin === 'phone' && <Smartphone className="h-3 w-3 shrink-0 text-sky-300" aria-label={t.aiStudio.fromPhone} />}
                        <span className="truncate">{s.title}</span>
                      </div>
                      {lastUser && <div className="mt-0.5 truncate text-[11px] text-slate-400">{lastUser.content}</div>}
                      <div className="mt-0.5 text-[10px] text-slate-500">
                        {new Date(sessionUpdatedAt(s)).toLocaleString()}
                        {model ? ` · ${model}` : ''}
                        {` · ${s.messages.filter((m) => m.role === 'user').length} ${t.aiStudio.historyPrompts}`}
                      </div>
                    </button>
                    <button type="button" onClick={() => open(s)} className="ph-icon-button shrink-0" title={t.aiStudio.historyOpen}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => void remove(s)} className="ph-icon-button shrink-0 opacity-0 group-hover:opacity-100" title={t.aiStudio.historyDelete}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
