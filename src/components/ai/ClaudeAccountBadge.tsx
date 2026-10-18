import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, User } from '../common/icons';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useTranslation } from '../../i18n/useTranslation';

interface ClaudeAccountBadgeProps {
  projectPath: string;
}

/**
 * Бейдж аккаунта Claude Code проекта в шапке (TASK-152.3): чья квота расходуется, и выбор аккаунта.
 * Привязка пишется в реестр машины, не в файлы проекта. Пока профиль один, бейдж не показывается.
 */
export const ClaudeAccountBadge: React.FC<ClaudeAccountBadgeProps> = ({ projectPath }) => {
  const { t } = useTranslation();
  const overview = useClaudeAccountsStore((s) => s.overview);
  const projectAccount = useClaudeAccountsStore((s) => s.projectAccounts[projectPath]);
  const { refresh, loadProjectAccount, setProjectAccount, openManager } = useClaudeAccountsStore.getState();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overview) void refresh().catch(() => undefined);
  }, [overview, refresh]);

  useEffect(() => {
    void loadProjectAccount(projectPath);
  }, [projectPath, loadProjectAccount, overview]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const accounts = overview?.accounts ?? [];
  if (accounts.length < 2 && projectAccount?.source !== 'project') return null;

  const current = projectAccount?.account;
  const select = async (accountId: string) => {
    setOpen(false);
    await setProjectAccount(projectPath, accountId === 'default' ? null : accountId);
    // AI Studio показывает статус аккаунта проекта — перечитать под новым аккаунтом.
    void useAIStudioStore.getState().fetchClaudeAuth(projectPath);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t.claudeAccounts.badgeTitle.replace('{name}', current?.name ?? '…')}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-slate-300 hover:bg-ph-hover hover:text-white transition whitespace-nowrap shrink-0"
        data-testid="claude-account-badge"
      >
        <User className="w-3.5 h-3.5 text-amber-300" />
        <span className="max-w-[120px] truncate">{current?.name ?? '…'}</span>
        <ChevronDown className="w-3 h-3 text-slate-500" />
      </button>
      {open && position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: position.top, right: position.right }}
            className="fixed z-[10000] w-64 rounded-lg border border-slate-700 bg-ph-elevated shadow-2xl p-1 text-xs"
            data-testid="claude-account-menu"
          >
            <div className="px-2.5 py-1.5 text-[11px] text-slate-500">{t.claudeAccounts.badgeMenuTitle}</div>
            {accounts.map((account) => {
              const active = current?.id === account.id;
              return (
                <button
                  key={account.id}
                  role="menuitemradio"
                  aria-checked={active}
                  type="button"
                  onClick={() => void select(account.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition ${
                    active ? 'bg-indigo-500/15 text-white' : 'text-slate-300 hover:bg-ph-hover'
                  }`}
                >
                  <Check className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-indigo-300' : 'opacity-0'}`} />
                  <span className="truncate flex-1">{account.name}</span>
                  {account.isDefault && <span className="text-[10px] text-slate-500">{t.claudeAccounts.defaultBadge}</span>}
                </button>
              );
            })}
            <div className="px-2.5 py-1.5 text-[11px] text-slate-500 leading-snug border-t border-ph-line mt-1">{t.claudeAccounts.newSessionsHint}</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openManager();
              }}
              className="w-full px-2.5 py-1.5 rounded-md text-left text-slate-300 hover:bg-ph-hover"
            >
              {t.claudeAccounts.manageAccounts}
            </button>
          </div>,
          document.body
        )}
    </>
  );
};
