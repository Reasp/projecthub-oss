import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, LogOut, Pencil, Plus, RefreshCw, Trash2, User } from '../common/icons';
import { ClaudeLogo } from '../common/BrandLogo';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useDialogStore } from '../../store/useDialogStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { ClaudeAccountView } from '../../types/electron';

function cleanIpcError(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

/**
 * Профили аккаунтов Claude Code (TASK-152.2, decision-87): статус входа каждого, вход во встроенном
 * терминале, выход, переименование, удаление, новый профиль и подключение существующего каталога.
 */
export const ClaudeAccountsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { overview, statuses, sharedLogin, statusesLoading, refresh, refreshStatuses, refreshStatus, openLogin } = useClaudeAccountsStore();
  const dialog = useDialogStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh().then(() => refreshStatuses(false)).catch((err) => setError(cleanIpcError(err)));
  }, [refresh, refreshStatuses]);

  const accounts = overview?.accounts ?? [];
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setBusy(null);
    }
  };

  const askName = (title: string, defaultValue = '') =>
    dialog.prompt({ title, message: t.claudeAccounts.namePrompt, defaultValue, placeholder: t.claudeAccounts.namePlaceholder });

  const handleCreate = async () => {
    const name = await askName(t.claudeAccounts.addManaged);
    if (!name?.trim()) return;
    await run('create', async () => {
      const account = await window.api.claudeAccounts.create(name);
      await refresh();
      openLogin(account.id);
    });
  };

  const handleConnect = async (source: 'dialog' | 'processEnv') => {
    const name = await askName(t.claudeAccounts.connectExisting);
    if (!name?.trim()) return;
    await run('connect', async () => {
      const account = await window.api.claudeAccounts.connectExternal({ name, source });
      if (account) await refreshStatus(account.id, true);
    });
  };

  const handleRename = async (account: ClaudeAccountView) => {
    const name = await askName(t.claudeAccounts.rename, account.name);
    if (!name?.trim() || name.trim() === account.name) return;
    await run(`rename:${account.id}`, () => window.api.claudeAccounts.rename(account.id, name));
  };

  const handleRemove = async (account: ClaudeAccountView) => {
    const ok = await dialog.confirm({
      title: t.claudeAccounts.removeTitle.replace('{name}', account.name),
      message: (account.kind === 'external' ? t.claudeAccounts.removeExternalMessage : t.claudeAccounts.removeManagedMessage)
        .replace('{dir}', account.configDir)
        .replace('{count}', String(account.projectCount)),
      confirmText: t.claudeAccounts.remove,
      danger: true
    });
    if (!ok) return;
    await run(`remove:${account.id}`, () => window.api.claudeAccounts.remove(account.id));
  };

  const handleLogout = async (account: ClaudeAccountView) => {
    const ok = await dialog.confirm({
      title: t.claudeAccounts.logoutTitle.replace('{name}', account.name),
      message: account.kind === 'external' ? t.claudeAccounts.logoutExternalMessage.replace('{dir}', account.configDir) : t.claudeAccounts.logoutMessage,
      confirmText: t.claudeAccounts.logout,
      danger: account.kind === 'external'
    });
    if (!ok) return;
    await run(`logout:${account.id}`, async () => {
      await window.api.claudeAccounts.logout(account.id);
      await refreshStatus(account.id, false);
      void useAIStudioStore.getState().fetchClaudeAuth(undefined, true);
    });
  };

  const processDir = overview?.processConfigDir;
  const processDirConnected = Boolean(overview?.processConfigDirAccountId);

  return (
    <div className="p-4 rounded-lg bg-ph-panel border border-ph-line space-y-3" data-testid="claude-accounts-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-slate-100 font-medium text-xs">
            <ClaudeLogo className="w-4 h-4" />
            <span>{t.claudeAccounts.title}</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{t.claudeAccounts.description}</p>
        </div>
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

      {processDir && !processDirConnected && (
        <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="font-medium">{t.claudeAccounts.processEnvTitle}</div>
            <div className="break-words">{t.claudeAccounts.processEnvMessage.replace('{dir}', processDir)}</div>
            <button type="button" className="ph-btn ph-btn-secondary" onClick={() => void handleConnect('processEnv')} disabled={busy !== null}>
              {t.claudeAccounts.processEnvConnect}
            </button>
          </div>
        </div>
      )}

      {sharedLogin.map((group) => (
        <div key={group.join('|')} className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {(overview?.platform === 'darwin' ? t.claudeAccounts.sharedLoginMac : t.claudeAccounts.sharedLoginOther).replace(
              '{names}',
              group.map((id) => `«${nameOf(id)}»`).join(', ')
            )}
          </span>
        </div>
      ))}

      <ul className="space-y-2">
        {accounts.map((account) => {
          const status = statuses[account.id];
          return (
            <li key={account.id} className="p-2.5 rounded-lg bg-ph-base border border-ph-line space-y-1.5" data-testid={`claude-account-${account.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="text-xs font-medium text-slate-100 truncate">{account.name}</span>
                {account.isDefault && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{t.claudeAccounts.defaultBadge}</span>
                )}
                {account.kind === 'external' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">{t.claudeAccounts.externalBadge}</span>
                )}
                <span className="text-[10px] text-slate-500 ml-auto shrink-0">
                  {t.claudeAccounts.projectsCount.replace('{count}', String(account.projectCount))}
                </span>
              </div>
              <div className="text-[11px] font-mono text-slate-500 truncate" title={account.configDir}>{account.configDir}</div>
              {account.isHomeClaudeDir && <div className="text-[11px] text-amber-300/90 leading-snug">{t.claudeAccounts.homeClaudeDirWarning}</div>}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-[11px] flex-1 min-w-0">
                  {!status ? (
                    <span className="text-slate-500">{t.claudeAccounts.checking}</span>
                  ) : status.error ? (
                    <span className="text-rose-300 break-words">{t.claudeAccounts.statusError.replace('{error}', status.error)}</span>
                  ) : status.loggedIn ? (
                    <span className="text-emerald-300 flex items-center gap-1.5 min-w-0">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate" data-testid="claude-account-email">
                        {t.claudeAccounts.loggedInAs.replace('{email}', status.email ?? '—')}
                        {status.subscriptionType ? ` · ${status.subscriptionType}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="text-amber-300">{t.claudeAccounts.notLoggedIn}</span>
                  )}
                </div>
                {status?.loggedIn ? (
                  <button type="button" className="ph-btn ph-btn-secondary" disabled={busy !== null} onClick={() => void handleLogout(account)}>
                    <LogOut className="w-3.5 h-3.5" />
                    <span>{t.claudeAccounts.logout}</span>
                  </button>
                ) : (
                  <button type="button" className="ph-btn ph-btn-primary" disabled={busy !== null} onClick={() => openLogin(account.id)}>
                    <span>{t.claudeAccounts.login}</span>
                  </button>
                )}
                <button type="button" className="ph-icon-button" title={t.claudeAccounts.rename} disabled={busy !== null} onClick={() => void handleRename(account)}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {!account.isDefault && (
                  <button type="button" className="ph-icon-button hover:text-rose-300" title={t.claudeAccounts.remove} disabled={busy !== null} onClick={() => void handleRemove(account)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {error && <div className="text-[11px] text-rose-300 break-words">{error}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className="ph-btn ph-btn-secondary" disabled={busy !== null} onClick={() => void handleCreate()} data-testid="claude-account-add">
          <Plus className="w-3.5 h-3.5" />
          <span>{t.claudeAccounts.addManaged}</span>
        </button>
        <button type="button" className="ph-btn ph-btn-secondary" disabled={busy !== null} onClick={() => void handleConnect('dialog')} title={t.claudeAccounts.connectHint}>
          <FolderOpen className="w-3.5 h-3.5" />
          <span>{t.claudeAccounts.connectExisting}</span>
        </button>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">{t.claudeAccounts.connectHint}</p>
    </div>
  );
};
