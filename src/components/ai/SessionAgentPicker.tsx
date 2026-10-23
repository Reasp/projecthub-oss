import React, { useEffect } from 'react';
import { User } from '../common/icons';
import type { AIProviderConfig, StudioSessionAgent } from '../../types/electron';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useTranslation } from '../../i18n/useTranslation';
import { accountDisplayName } from '../../lib/cliAccountEngines';
import { sessionRequestConfig, withClaudeAccount, withSelection } from '../../lib/studioSessionAgent';
import { ModelSelectorDropdown } from './ModelSelectorDropdown';
import { ComposerMenu } from './ComposerMenu';

interface SessionAgentPickerProps {
  projectPath: string;
  /** Агент вкладки (уже с подстановкой общего выбора для старых вкладок). */
  agent: StudioSessionAgent;
  config: AIProviderConfig;
  onChange: (agent: StudioSessionAgent) => void;
}

/**
 * Агент вкладки Agents Studio (TASK-170): модель (Claude Code или профиль OpenAI-совместимого сервера,
 * например Ollama в локальной сети) и для Claude Code — аккаунт. Аккаунт вкладки перекрывает привязку проекта.
 */
export const SessionAgentPicker: React.FC<SessionAgentPickerProps> = ({ projectPath, agent, config, onChange }) => {
  const { t } = useTranslation();
  const overview = useClaudeAccountsStore((s) => s.overview);
  const projectAccount = useClaudeAccountsStore((s) => s.projectAccounts[projectPath]);
  const { refresh, loadProjectAccount, openManager } = useClaudeAccountsStore.getState();

  useEffect(() => {
    if (!overview) void refresh().catch(() => undefined);
  }, [overview, refresh]);

  useEffect(() => {
    if (projectPath) void loadProjectAccount(projectPath);
  }, [projectPath, loadProjectAccount]);

  const accounts = overview?.accounts ?? [];
  const showAccount = agent.provider === 'anthropic' && accounts.length > 1;
  const own = agent.claudeAccountId ? accounts.find((a) => a.id === agent.claudeAccountId) : undefined;
  const projectName = projectAccount ? accountDisplayName(projectAccount.account, t.claudeAccounts.defaultName) : '…';
  const label = own ? accountDisplayName(own, t.claudeAccounts.defaultName) : projectName;

  return (
    <>
      <ModelSelectorDropdown
        config={sessionRequestConfig(config, agent)}
        placement="above"
        onSelect={(selection) => onChange(withSelection(agent, selection))}
      />
      {showAccount && (
        <ComposerMenu
          title={t.aiStudio.input.accountTitle.replace('{name}', label)}
          heading={t.aiStudio.input.accountHeading}
          testId="session-account-menu"
          chevron
          trigger={
            <>
              <User className={`w-3.5 h-3.5 ${own ? 'text-amber-300' : ''}`} />
              <span className="max-w-[110px] truncate">{label}</span>
            </>
          }
          items={[
            {
              key: 'project',
              label: t.aiStudio.input.accountFromProject.replace('{name}', projectName),
              checked: !own,
              onSelect: () => onChange(withClaudeAccount(agent, null))
            },
            ...accounts.map((account) => ({
              key: account.id,
              label: accountDisplayName(account, t.claudeAccounts.defaultName),
              checked: own?.id === account.id,
              onSelect: () => onChange(withClaudeAccount(agent, account.id))
            })),
            { key: 'manage', label: t.claudeAccounts.manageAccounts, onSelect: openManager }
          ]}
        />
      )}
    </>
  );
};
