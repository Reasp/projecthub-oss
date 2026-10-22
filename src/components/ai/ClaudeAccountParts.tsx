import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, LogOut, Pencil, Trash2 } from '../common/icons';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useDialogStore } from '../../store/useDialogStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { ClaudeAccountView, CliAccountEngine } from '../../types/electron';
import { CLI_ENGINE_NAME, CLI_ENGINE_ENV, accountEngineOf } from '../../lib/cliAccountEngines';
import { ConnectionRow, connectionBadge } from './ConnectionRow';

export function cleanIpcError(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

/**
 * Действия над профилями аккаунтов Claude Code (TASK-152.2, decision-87): создать и войти, подключить каталог,
 * переименовать, удалить, выйти. Общие для списка подключений (TASK-172) и окна «Аккаунты Claude Code».
 */
export function useClaudeAccountActions() {
  const { t } = useTranslation();
  const { refresh, refreshStatuses, refreshStatus, openLogin } = useClaudeAccountsStore();
  const dialog = useDialogStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh().then(() => refreshStatuses(false)).catch((err) => setError(cleanIpcError(err)));
  }, [refresh, refreshStatuses]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
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
    },
    [refresh]
  );

  const askName = (title: string, defaultValue = '') =>
    dialog.prompt({ title, message: t.claudeAccounts.namePrompt, defaultValue, placeholder: t.claudeAccounts.namePlaceholder });

  const fill = (text: string, engine: CliAccountEngine) => text.replace('{engine}', CLI_ENGINE_NAME[engine]).replace('{env}', CLI_ENGINE_ENV[engine]);

  const create = async (engine: CliAccountEngine = 'claude-cli') => {
    const name = await askName(engine === 'claude-cli' ? t.claudeAccounts.addManaged : fill(t.aiConnections.cliAccount, engine));
    if (!name?.trim()) return;
    await run('create', async () => {
      const account = await window.api.claudeAccounts.create(name, engine);
      await refresh();
      openLogin(account.id);
    });
  };

  const connect = async (source: 'dialog' | 'processEnv', engine: CliAccountEngine = 'claude-cli') => {
    const name = await askName(engine === 'claude-cli' ? t.claudeAccounts.connectExisting : fill(t.aiConnections.cliDirectory, engine));
    if (!name?.trim()) return;
    await run('connect', async () => {
      const account = await window.api.claudeAccounts.connectExternal({ name, source, engine });
      if (account) await refreshStatus(account.id, true);
    });
  };

  const rename = async (account: ClaudeAccountView) => {
    const name = await askName(t.claudeAccounts.rename, account.name);
    if (!name?.trim() || name.trim() === account.name) return;
    await run(`rename:${account.id}`, () => window.api.claudeAccounts.rename(account.id, name));
  };

  const remove = async (account: ClaudeAccountView) => {
    const engine = accountEngineOf(account);
    const template = engine !== 'claude-cli'
      ? fill(t.claudeAccounts.cliRemoveMessage, engine)
      : account.kind === 'external' ? t.claudeAccounts.removeExternalMessage : t.claudeAccounts.removeManagedMessage;
    const ok = await dialog.confirm({
      title: t.claudeAccounts.removeTitle.replace('{name}', account.name),
      message: template.replace('{dir}', account.configDir).replace('{count}', String(account.projectCount)),
      confirmText: t.claudeAccounts.remove,
      danger: true
    });
    if (!ok) return;
    await run(`remove:${account.id}`, () => window.api.claudeAccounts.remove(account.id));
  };

  const logout = async (account: ClaudeAccountView) => {
    const ok = await dialog.confirm({
      title: t.claudeAccounts.logoutTitle.replace('{name}', account.name),
      message: account.kind === 'external'
        ? t.claudeAccounts.logoutExternalMessage.replace('{dir}', account.configDir)
        : account.engine ? t.claudeAccounts.cliLogoutMessage : t.claudeAccounts.logoutMessage,
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

  return { busy, error, create, connect, rename, remove, logout, login: openLogin };
}

export type ClaudeAccountActions = ReturnType<typeof useClaudeAccountActions>;

/** Предупреждения: CLAUDE_CONFIG_DIR процесса не подключён, у профилей общий вход. */
export const ClaudeAccountWarnings: React.FC<{ actions: ClaudeAccountActions }> = ({ actions }) => {
  const { t } = useTranslation();
  const { overview, sharedLogin } = useClaudeAccountsStore();
  const accounts = overview?.accounts ?? [];
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const processDir = overview?.processConfigDir;
  const processDirConnected = Boolean(overview?.processConfigDirAccountId);

  return (
    <>
      {processDir && !processDirConnected && (
        <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="font-medium">{t.claudeAccounts.processEnvTitle}</div>
            <div className="break-words">{t.claudeAccounts.processEnvMessage.replace('{dir}', processDir)}</div>
            <button type="button" className="ph-btn ph-btn-secondary" onClick={() => void actions.connect('processEnv')} disabled={actions.busy !== null}>
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
    </>
  );
};

/** Строка аккаунта Claude Code: статус входа, вход или выход, переименование, удаление. */
export const ClaudeAccountRow: React.FC<{ account: ClaudeAccountView; actions: ClaudeAccountActions }> = ({ account, actions }) => {
  const { t } = useTranslation();
  const status = useClaudeAccountsStore((s) => s.statuses[account.id]);
  const disabled = actions.busy !== null;
  const engine = accountEngineOf(account);

  const statusText = !status ? (
    <span className="text-slate-500">{t.claudeAccounts.checking}</span>
  ) : status.unsupported ? (
    <span className="text-slate-400">{t.claudeAccounts.cliStatusUnsupported}</span>
  ) : status.error ? (
    <span className="text-rose-300">{t.claudeAccounts.statusError.replace('{error}', status.error)}</span>
  ) : status.loggedIn && engine !== 'claude-cli' ? (
    <span className="text-emerald-300">{t.claudeAccounts.cliLoggedIn.replace('{method}', status.authMethod ?? '—')}</span>
  ) : status.loggedIn ? (
    <span className="text-emerald-300" data-testid="claude-account-email">
      {status.email ?? '—'}
      {status.subscriptionType ? ` · ${status.subscriptionType}` : ''}
    </span>
  ) : (
    <span className="text-amber-300">{t.claudeAccounts.notLoggedIn}</span>
  );

  return (
    <ConnectionRow
      icon={engine === 'claude-cli' ? 'claude' : 'cli'}
      providerLabel={engine === 'claude-cli' ? t.aiConnections.providerClaudeCode : CLI_ENGINE_NAME[engine]}
      name={account.name}
      title={account.configDir}
      testId={`claude-account-${account.id}`}
      badges={
        <>
          {account.isDefault && <span className={connectionBadge}>{t.claudeAccounts.defaultBadge}</span>}
          {account.kind === 'external' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 shrink-0">{t.claudeAccounts.externalBadge}</span>
          )}
        </>
      }
      details={
        <>
          {statusText}
          <span className="text-slate-500"> · {t.claudeAccounts.projectsCount.replace('{count}', String(account.projectCount))}</span>
        </>
      }
      actions={
        <>
          {status?.loggedIn && engine !== 'gemini-cli' ? (
            <button type="button" className="ph-icon-button" title={t.claudeAccounts.logout} aria-label={t.claudeAccounts.logout} disabled={disabled} onClick={() => void actions.logout(account)}>
              <LogOut className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button type="button" className="ph-btn ph-btn-primary" disabled={disabled} onClick={() => actions.login(account.id)}>
              {t.claudeAccounts.login}
            </button>
          )}
          <button type="button" className="ph-icon-button" title={t.claudeAccounts.rename} aria-label={t.claudeAccounts.rename} disabled={disabled} onClick={() => void actions.rename(account)}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {!account.isDefault && (
            <button type="button" className="ph-icon-button hover:text-rose-300" title={t.claudeAccounts.remove} aria-label={t.claudeAccounts.remove} disabled={disabled} onClick={() => void actions.remove(account)}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      }
    >
      {account.isHomeClaudeDir && <div className="text-[11px] text-amber-300/90 leading-snug mt-1.5 ml-10">{t.claudeAccounts.homeClaudeDirWarning}</div>}
    </ConnectionRow>
  );
};
