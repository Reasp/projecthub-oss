import React from 'react';
import { GitMerge } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Баннер «Слияние не завершено» (decision-157): в панели Git и над остальными вкладками проекта (TASK-139.6) —
 * незакрытый конфликт задачи ломает её frontmatter, и канбан без баннера не объясняет почему.
 */
export const MergeInProgressBanner: React.FC<{ count: number; onResolve: () => void; className?: string }> = ({ count, onResolve, className = 'mx-4 mt-2' }) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="merge-conflicts-banner"
      className={`${className} flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-950/60 border border-amber-700/60 text-amber-200 text-xs shrink-0`}
    >
      <GitMerge className="w-4 h-4 shrink-0" />
      <span className="flex-1">{t.mergeConflicts.banner.replace('{count}', String(count))}</span>
      <button
        type="button"
        onClick={onResolve}
        className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-medium transition"
      >
        {t.mergeConflicts.resolveButton}
      </button>
    </div>
  );
};
