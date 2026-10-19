import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, KeyRound, RotateCcw } from '../common/icons';
import type { SecretIssuesState } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { useSecretRestoreStore } from '../../store/useSecretRestoreStore';
import { secretKeyLabel, secretReasonLabel } from './secretLabels';

/**
 * Сообщение о секретах, которые не удалось расшифровать (TASK-141, decision-88 п. 5).
 * Значения не показываются: только что за секрет и почему. Плавающий глобальный контрол —
 * `z-[10000]` через portal (decision-17). «Восстановить…» открывает окно восстановления (TASK-154).
 */
export const SecretIssuesNotice: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<SecretIssuesState | null>(null);
  const openRestore = useSecretRestoreStore((s) => s.open);
  const refreshCount = useSecretRestoreStore((s) => s.refreshCount);

  useEffect(() => {
    if (!window.api?.getSecretIssues) return;
    window.api.getSecretIssues().then(setState).catch(() => undefined);
    void refreshCount();
    const unsubscribe = window.api.onSecretIssuesChanged?.((next) => {
      setState(next);
      void refreshCount();
    });
    return () => {
      unsubscribe?.();
    };
  }, [refreshCount]);

  if (!state || state.issues.length === 0) return null;

  return createPortal(
    <div
      role="alert"
      className="fixed bottom-9 left-4 z-[10000] max-w-lg flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-ph-elevated border border-amber-500/60 shadow-xl text-xs text-amber-50"
    >
      <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="font-semibold text-amber-200">{t.secretIssues.title}</div>
        <ul className="space-y-0.5">
          {state.issues.map((issue) => (
            <li key={`${issue.key}-${issue.at}`}>
              <span className="font-medium">{secretKeyLabel(t.secretIssues, issue.key)}</span>
              <span className="text-amber-100/70"> — {secretReasonLabel(t.secretIssues, issue.reason)}</span>
            </li>
          ))}
        </ul>
        <p className="text-amber-100/80">{t.secretIssues.body}</p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            onClick={openRestore}
            className="px-2.5 py-1 rounded-md bg-amber-900/50 hover:bg-amber-900/80 flex items-center gap-1"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t.secretIssues.restore}
          </button>
          <button
            type="button"
            onClick={() => window.api.showSecretBackup()}
            className="px-2.5 py-1 rounded-md bg-amber-900/50 hover:bg-amber-900/80 flex items-center gap-1"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {t.secretIssues.showBackup}
          </button>
          <button
            type="button"
            onClick={() => window.api.acknowledgeSecretIssues().then(setState)}
            className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-semibold"
          >
            {t.secretIssues.acknowledge}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
