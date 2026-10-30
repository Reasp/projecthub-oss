import React from 'react';
import { GitBranch, Loader2, HelpCircle, Square, X } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { studioCliText } from '../../i18n/studioCliText';
import type { StudioSideQuestion } from '../../store/useAIStudioStore';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { ProviderErrorCard } from './ProviderErrorCard';

/**
 * Побочный вопрос `/btw` над полем ввода (TASK-283): ответ по разговору вкладки, который в сам разговор не попадает,
 * как в Claude Code. Здесь же — подсказка, если `/btw` без вопроса или `/fork` ответвлять нечего.
 */
export const SideQuestionPanel: React.FC<{ side: StudioSideQuestion | undefined; onClose: () => void }> = ({ side, onClose }) => {
  const language = useProjectStore((s) => s.language);
  if (!side) return null;
  const c = studioCliText(language);
  const running = side.status === 'running';
  return (
    <div className="mx-4 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs" data-testid="studio-side-question">
      <div className="flex items-center gap-2">
        {side.command === 'fork' ? <GitBranch className="w-3.5 h-3.5 text-amber-300 shrink-0" /> : <HelpCircle className="w-3.5 h-3.5 text-amber-300 shrink-0" />}
        <span className="font-medium text-amber-200 shrink-0">{side.command === 'fork' ? '/fork' : c.btwTitle}</span>
        {side.question && <span className="text-slate-300 truncate" title={side.question}>{side.question}</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto ph-btn ph-btn-ghost h-6 px-1.5 shrink-0"
          title={running ? c.btwStop : c.close}
          aria-label={running ? c.btwStop : c.close}
          data-testid="studio-side-question-close"
        >
          {running ? <Square className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="mt-1.5 max-h-64 overflow-y-auto" data-testid="studio-side-question-answer">
        {side.status === 'notice' ? (
          <p className="text-slate-300">{side.notice}</p>
        ) : side.status === 'error' ? (
          <ProviderErrorCard error={side.error || ''} info={side.providerError} />
        ) : side.answer ? (
          <MarkdownViewer content={side.answer} emptyMessage={null} className="text-slate-200" />
        ) : (
          <span className="flex items-center gap-1.5 text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {c.btwAnswering}
          </span>
        )}
      </div>
      {side.command === 'btw' && side.status !== 'notice' && <p className="mt-1.5 text-[11px] text-slate-500">{c.btwHint}</p>}
    </div>
  );
};
