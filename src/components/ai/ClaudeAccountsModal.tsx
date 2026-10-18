import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from '../common/icons';
import { ClaudeAccountsPanel } from './ClaudeAccountsPanel';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useTranslation } from '../../i18n/useTranslation';

/** Окно «Аккаунты Claude Code» (TASK-152): открывается из бейджа проекта. */
export const ClaudeAccountsModal: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useClaudeAccountsStore((s) => s.isManagerOpen);
  const close = useClaudeAccountsStore((s) => s.closeManager);
  const loginOpen = useClaudeAccountsStore((s) => s.loginAccountId !== null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loginOpen) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, loginOpen, close]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-xl bg-ph-elevated border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{t.claudeAccounts.title}</h2>
          <button onClick={close} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" title={t.claudeAccounts.close}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          <ClaudeAccountsPanel />
        </div>
      </div>
    </div>,
    document.body
  );
};
