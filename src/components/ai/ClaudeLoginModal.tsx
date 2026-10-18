import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RefreshCw, CheckCircle2 } from '../common/icons';
import { ClaudeLogo } from '../common/BrandLogo';
import { PtyTabTerminal } from '../terminal/PtyTabTerminal';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { ClaudeAccountAuthStatus, PtySession } from '../../types/electron';

/**
 * Вход в профиль аккаунта Claude Code (TASK-152.2, decision-87 п. 9): `claude auth login` во встроенном
 * терминале с каталогом профиля, а не во внешнем окне `cmd`. После выхода процесса статус перечитывается.
 */
export const ClaudeLoginModal: React.FC = () => {
  const { t } = useTranslation();
  const accountId = useClaudeAccountsStore((s) => s.loginAccountId);
  const closeLogin = useClaudeAccountsStore((s) => s.closeLogin);
  const overview = useClaudeAccountsStore((s) => s.overview);
  const [session, setSession] = useState<PtySession | null>(null);
  const [exited, setExited] = useState(false);
  const [status, setStatus] = useState<ClaudeAccountAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const account = overview?.accounts.find((a) => a.id === accountId);

  useEffect(() => {
    if (!accountId) return;
    let disposed = false;
    let sessionId: string | null = null;
    setSession(null);
    setExited(false);
    setStatus(null);
    setError(null);
    const { overview: known, refresh: refreshAccounts, refreshStatus } = useClaudeAccountsStore.getState();
    if (!known) void refreshAccounts().catch(() => undefined);

    const offExit = window.api?.onPtyExit?.(({ sessionId: exitedId }) => {
      if (exitedId !== sessionId) return;
      setExited(true);
      void refreshStatus(accountId, true).then((next) => {
        if (!disposed) setStatus(next);
        // AI Studio и строка состояния показывают статус аккаунта проекта — перечитать.
        void useAIStudioStore.getState().fetchClaudeAuth(undefined, true);
      });
    });

    window.api
      .createPtySession({ type: 'claude-login', claudeAccountId: accountId, projectPath: '', cols: 100, rows: 24 })
      .then((created) => {
        if (disposed) {
          void window.api.killPty(created.id);
          return;
        }
        sessionId = created.id;
        setSession(created);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
      });

    return () => {
      disposed = true;
      offExit?.();
      if (sessionId) void window.api.killPty(sessionId);
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && exited) closeLogin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accountId, exited, closeLogin]);

  if (!accountId) return null;

  const name = account?.name ?? accountId;

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" data-testid="claude-login-modal">
      <div className="w-full max-w-3xl bg-ph-elevated border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ClaudeLogo className="w-4 h-4 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white truncate">{t.claudeAccounts.loginTitle.replace('{name}', name)}</h2>
              {account && <p className="text-[11px] text-slate-500 font-mono truncate">{account.configDir}</p>}
            </div>
          </div>
          <button onClick={closeLogin} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" title={t.claudeAccounts.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="px-5 pt-3 text-xs text-slate-400 leading-relaxed">{t.claudeAccounts.loginHint}</p>

        <div className="m-4 h-[320px] rounded-lg border border-ph-line overflow-hidden bg-ph-base">
          {error ? (
            <div className="p-4 text-xs text-rose-300">{error}</div>
          ) : session ? (
            <PtyTabTerminal session={session} isActive />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-slate-500 gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
            </div>
          )}
        </div>

        <div className="px-5 pb-4 flex items-center justify-between gap-3 text-xs">
          <div className="min-w-0 text-slate-400">
            {exited && status?.loggedIn && (
              <span className="flex items-center gap-1.5 text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t.claudeAccounts.loggedInAs.replace('{email}', status.email ?? '—')}
                {status.subscriptionType ? ` · ${status.subscriptionType}` : ''}
              </span>
            )}
            {exited && status && !status.loggedIn && <span className="text-amber-300">{t.claudeAccounts.loginNotCompleted}</span>}
            {exited && !status && <span>{t.claudeAccounts.checking}</span>}
          </div>
          <button type="button" onClick={closeLogin} className={exited ? 'ph-btn ph-btn-primary' : 'ph-btn ph-btn-secondary'}>
            {t.claudeAccounts.close}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
