import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, X } from '../common/icons';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { useKnowledgeBaseStore } from '../../store/useKnowledgeBaseStore';

/**
 * Документ базы знаний компании по ссылке `[[kb:doc-N]]` (TASK-223): только чтение, поверх текущего окна.
 * Портал в `document.body`, `z-[9999]` (правило 19, decision-17).
 */
export const KnowledgeBaseDocModal: React.FC = () => {
  const opened = useKnowledgeBaseStore((s) => s.opened);
  const close = useKnowledgeBaseStore((s) => s.close);

  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, close]);

  if (!opened) return null;
  const body = opened.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="kb-doc-modal" onClick={close}>
      <div className="relative flex max-h-[88vh] w-full max-w-4xl flex-col rounded-xl border border-slate-700 bg-ph-elevated text-card-foreground shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border bg-secondary/20 px-6 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="text-[11px] text-muted-foreground">
                {opened.kbName} · {opened.id}
              </div>
              <h2 className="truncate text-base font-semibold">{opened.title}</h2>
            </div>
          </div>
          <button type="button" onClick={close} className="rounded-md p-1.5 text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <MarkdownViewer content={body} />
        </div>
      </div>
    </div>,
    document.body
  );
};
