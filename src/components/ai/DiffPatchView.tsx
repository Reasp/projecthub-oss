import React from 'react';

interface DiffPatchViewProps {
  patch: string;
  /** Tailwind-класс высоты области прокрутки. */
  maxHeightClass?: string;
}

/** Unified diff с подсветкой строк — общий для карточки шага и карточки одобрения записи (TASK-271). */
export const DiffPatchView: React.FC<DiffPatchViewProps> = ({ patch, maxHeightClass = 'max-h-72' }) => {
  const patchLines = (patch || '').split('\n');

  return (
    <div className={`p-3 bg-ph-base font-mono text-[11px] leading-relaxed ${maxHeightClass} overflow-y-auto overflow-x-auto text-slate-300 select-text`}>
      <pre className="whitespace-pre">
        {patchLines.map((line, idx) => {
          const isAdd = line.startsWith('+') && !line.startsWith('+++');
          const isDel = line.startsWith('-') && !line.startsWith('---');
          const isHeader = line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@');

          return (
            <div
              key={idx}
              className={`${
                isAdd
                  ? 'bg-emerald-500/15 text-emerald-300 px-1 -mx-1 font-semibold'
                  : isDel
                  ? 'bg-rose-500/15 text-rose-300 px-1 -mx-1 line-through decoration-rose-500/50'
                  : isHeader
                  ? 'text-indigo-400 font-semibold mt-1 select-none'
                  : 'text-slate-400'
              }`}
            >
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
};
