import React from 'react';
import { FolderOpen, FolderPlus, X } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { studioCliText } from '../../i18n/studioCliText';

/**
 * Каталоги `/add-dir` вкладки над полем ввода (TASK-285): видно, к чему у Claude Code вкладки есть доступ сверх её
 * папки, и каждый каталог снимается крестиком.
 */
export const AddDirsBar: React.FC<{ dirs: string[] | undefined; onRemove: (dir: string) => void; onAdd: () => void }> = ({ dirs, onRemove, onAdd }) => {
  const language = useProjectStore((s) => s.language);
  if (!dirs?.length) return null;
  const c = studioCliText(language);
  return (
    <div className="mx-4 mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="studio-add-dirs" title={c.addDirHint}>
      <span className="flex items-center gap-1 text-slate-400 shrink-0">
        <FolderOpen className="w-3.5 h-3.5" />
        {c.addDirTitle}:
      </span>
      {dirs.map((dir) => (
        <span
          key={dir}
          className="flex max-w-full items-center gap-1 rounded-md border border-slate-600/50 bg-slate-800/60 pl-2 pr-0.5 py-0.5 text-slate-200"
          data-testid="studio-add-dir"
        >
          <span className="truncate font-mono" title={dir}>{dir}</span>
          <button
            type="button"
            onClick={() => onRemove(dir)}
            className="ph-btn ph-btn-ghost h-5 px-1 shrink-0"
            title={c.addDirRemove(dir)}
            aria-label={c.addDirRemove(dir)}
            data-testid="studio-add-dir-remove"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="ph-btn ph-btn-ghost h-6 px-1.5 shrink-0"
        title={c.addDirMore}
        aria-label={c.addDirMore}
        data-testid="studio-add-dir-more"
      >
        <FolderPlus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
