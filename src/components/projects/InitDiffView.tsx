import React, { useMemo } from 'react';
import { collapseUnchanged, lineDiff, lineDiffStats } from '../../lib/lineDiff';

interface InitDiffViewProps {
  title: string;
  before: string;
  after: string;
  labels: { tooLarge: string; same: string; gap: string };
}

/** Построчный дифф двух версий файла в предпросмотре инициализации и обновления шаблона (TASK-156). */
export const InitDiffView: React.FC<InitDiffViewProps> = ({ title, before, after, labels }) => {
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = ops ? lineDiffStats(ops) : null;
  const changed = stats ? stats.added + stats.removed > 0 : true;
  return (
    <div className="rounded-lg border border-slate-800 bg-ph-base" data-testid="init-diff">
      <div className="flex items-center justify-between px-2.5 py-1 border-b border-slate-800 text-[10px] text-slate-400">
        <span>{title}</span>
        {stats && changed && (
          <span>
            <span className="text-emerald-400">+{stats.added}</span> <span className="text-rose-400">−{stats.removed}</span>
          </span>
        )}
      </div>
      {ops === null ? (
        <div className="p-2 text-[11px] text-slate-500">{labels.tooLarge}</div>
      ) : !changed ? (
        <div className="p-2 text-[11px] text-slate-500">{labels.same}</div>
      ) : (
        <pre className="text-[11px] font-mono p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
          {collapseUnchanged(ops).map((row, i) =>
            row.op === 'gap' ? (
              <div key={i} className="text-slate-600 italic select-none">
                {labels.gap.replace('{count}', String(row.count))}
              </div>
            ) : (
              <div key={i} className={row.op === 'add' ? 'bg-emerald-500/10 text-emerald-300' : row.op === 'del' ? 'bg-rose-500/10 text-rose-300' : 'text-slate-500'}>
                {row.op === 'add' ? '+ ' : row.op === 'del' ? '− ' : '  '}
                {row.text}
              </div>
            )
          )}
        </pre>
      )}
    </div>
  );
};
