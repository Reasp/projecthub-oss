import React from 'react';
import { FolderOpen, Plus, RefreshCw } from '../common/icons';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useTranslation } from '../../i18n/useTranslation';
import { ClaudeAccountRow, ClaudeAccountWarnings, useClaudeAccountActions } from './ClaudeAccountParts';

/**
 * Профили аккаунтов Claude Code (TASK-152.2, decision-87) для окна «Аккаунты Claude Code» из бейджа проекта.
 * В настройках Agents Studio те же строки живут в общем списке подключений (TASK-172).
 */
export const ClaudeAccountsPanel: React.FC = () => {
  const { t } = useTranslation();
  const overview = useClaudeAccountsStore((s) => s.overview);
  const statusesLoading = useClaudeAccountsStore((s) => s.statusesLoading);
  const refreshStatuses = useClaudeAccountsStore((s) => s.refreshStatuses);
  const actions = useClaudeAccountActions();
  const accounts = [...(overview?.accounts ?? []), ...(overview?.engineAccounts ?? [])];

  return (
    <div className="space-y-3" data-testid="claude-accounts-panel">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-slate-400 leading-relaxed">{t.claudeAccounts.description}</p>
        <button
          type="button"
          onClick={() => void refreshStatuses(true)}
          disabled={statusesLoading}
          className="ph-btn ph-btn-secondary shrink-0"
          title={t.claudeAccounts.refresh}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${statusesLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <ClaudeAccountWarnings actions={actions} />

      <ul className="space-y-2">
        {accounts.map((account) => (
          <ClaudeAccountRow key={account.id} account={account} actions={actions} />
        ))}
      </ul>

      {actions.error && <div className="text-[11px] text-rose-300 break-words">{actions.error}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className="ph-btn ph-btn-secondary" disabled={actions.busy !== null} onClick={() => void actions.create()} data-testid="claude-account-add">
          <Plus className="w-3.5 h-3.5" />
          <span>{t.claudeAccounts.addManaged}</span>
        </button>
        <button type="button" className="ph-btn ph-btn-secondary" disabled={actions.busy !== null} onClick={() => void actions.connect('dialog')} title={t.claudeAccounts.connectHint}>
          <FolderOpen className="w-3.5 h-3.5" />
          <span>{t.claudeAccounts.connectExisting}</span>
        </button>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">{t.claudeAccounts.connectHint}</p>
    </div>
  );
};
