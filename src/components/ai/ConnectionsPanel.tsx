import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Key, Pencil, Plus, RefreshCw, Trash2, X } from '../common/icons';
import type { AIProviderConfig, LlmProfileView, LlmProviderPreset } from '../../types/electron';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import { addOptionGroups, hasAnthropicKey, legacyIcon, legacyProviderOf, presetIcon, type AddOption } from '../../lib/connections';
import { CLI_ENGINE_ENV, CLI_ENGINE_NAME } from '../../lib/cliAccountEngines';
import { ClaudeAccountRow, ClaudeAccountWarnings, cleanIpcError, useClaudeAccountActions } from './ClaudeAccountParts';
import { ConnectionRow, connectionBadge } from './ConnectionRow';
import { LlmProfileEditor, draftFromPreset, draftFromProfile, type ProfileDraft } from './LlmProfileEditor';
import { ProviderIcon } from './ProviderIcon';

const LEGACY_NAMES: Record<string, string> = { openrouter: 'OpenRouter', deepseek: 'DeepSeek', ollama: 'Ollama', custom: 'Custom OpenAI' };

/** Ключ и test id пункта «Добавить»: у CLI-движков — вместе с движком. */
function optionKey(option: AddOption): string {
  if (option.kind === 'preset') return option.presetId;
  if (option.kind === 'cli-account' || option.kind === 'cli-directory') return `${option.kind}-${option.engine}`;
  return option.kind;
}

interface ConnectionsPanelProps {
  /** Форма настроек Studio: ключ Anthropic и старое подключение живут в ней и сохраняются кнопкой «Сохранить». */
  form: AIProviderConfig;
  onFormChange: (patch: Partial<AIProviderConfig>) => void;
}

type Editing = { target: 'new' | string; draft: ProfileDraft } | null;

/**
 * Подключения Agents Studio (TASK-172): аккаунты Claude Code, ключ Anthropic API, профили серверов моделей
 * и старое подключение — одним списком со значком провайдера. «Добавить» — выбор провайдера и форма подключения.
 */
export const ConnectionsPanel: React.FC<ConnectionsPanelProps> = ({ form, onFormChange }) => {
  const { t } = useTranslation();
  const c = t.aiConnections;
  const dialog = useDialog();
  const accounts = useClaudeAccountsStore((s) => s.overview?.accounts) ?? [];
  const engineAccounts = useClaudeAccountsStore((s) => s.overview?.engineAccounts) ?? [];
  const statusesLoading = useClaudeAccountsStore((s) => s.statusesLoading);
  const refreshStatuses = useClaudeAccountsStore((s) => s.refreshStatuses);
  const claude = useClaudeAccountActions();

  const [presets, setPresets] = useState<LlmProviderPreset[]>([]);
  const [profiles, setProfiles] = useState<LlmProfileView[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [adding, setAdding] = useState(false);
  const [keyEditor, setKeyEditor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);

  const reloadProfiles = useCallback(async () => setProfiles(await window.api.listLlmProfiles()), []);
  useEffect(() => {
    void window.api.getLlmProviderPresets().then(setPresets);
    void reloadProfiles();
  }, [reloadProfiles]);

  const groups = useMemo(() => addOptionGroups(presets), [presets]);
  const presetOf = (id: string) => presets.find((p) => p.id === id);
  const legacy = legacyProviderOf(form);
  const anthropicKey = hasAnthropicKey(form);

  const pick = (option: AddOption) => {
    setAdding(false);
    setError(null);
    if (option.kind === 'claude-account') void claude.create();
    else if (option.kind === 'claude-directory') void claude.connect('dialog');
    else if (option.kind === 'cli-account') void claude.create(option.engine);
    else if (option.kind === 'cli-directory') void claude.connect('dialog', option.engine);
    else if (option.kind === 'anthropic-key') setKeyEditor('');
    else {
      const preset = presetOf(option.presetId);
      if (preset) setEditing({ target: 'new', draft: draftFromPreset(preset) });
    }
  };

  const removeProfile = async (profile: LlmProfileView) => {
    if (!(await dialog.confirm(t.llmProfiles.deleteConfirm.replace('{name}', profile.name)))) return;
    await window.api.deleteLlmProfile(profile.id);
    await reloadProfiles();
    // Профиль был моделью по умолчанию — выбор снимается, модель задаётся заново.
    if (form.provider === 'openai-compatible' && form.profileId === profile.id) onFormChange({ profileId: undefined, model: '' });
  };

  const removeKey = async () => {
    if (!(await dialog.confirm(c.removeKey + '?'))) return;
    onFormChange({ apiKey: '', ...(form.provider === 'anthropic' ? { engine: 'claude-cli' as const } : {}) });
  };

  const migrateLegacy = async () => {
    if (!legacy) return;
    setLegacyBusy(true);
    setError(null);
    try {
      const profile = await window.api.importLegacyLlmProfile(legacy);
      await reloadProfiles();
      onFormChange({ provider: 'openai-compatible', profileId: profile.id, engine: undefined });
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setLegacyBusy(false);
    }
  };

  const optionLabel = (option: AddOption): { label: string; hint?: string; disabled?: string } => {
    switch (option.kind) {
      case 'claude-account':
        return { label: c.claudeAccount, hint: c.claudeAccountHint };
      case 'claude-directory':
        return { label: c.claudeDirectory, hint: c.claudeDirectoryHint };
      case 'cli-account':
      case 'cli-directory': {
        const fill = (text: string) => text.replace('{engine}', CLI_ENGINE_NAME[option.engine]).replace('{env}', CLI_ENGINE_ENV[option.engine]);
        return option.kind === 'cli-account' ? { label: fill(c.cliAccount), hint: fill(c.cliAccountHint) } : { label: fill(c.cliDirectory), hint: fill(c.cliDirectoryHint) };
      }
      case 'anthropic-key':
        return {
          label: c.providerAnthropicApi,
          hint: c.anthropicKeyHint,
          disabled: legacy ? c.anthropicKeyBlocked : anthropicKey ? c.anthropicKeyExists : undefined
        };
      default:
        return { label: option.name, hint: presetOf(option.presetId)?.baseUrl || undefined };
    }
  };

  const renderGroup = (title: string, options: AddOption[]) => (
    <div>
      <div className="text-[11px] text-slate-500 mb-1.5">{title}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map((option) => {
          const { label, hint, disabled } = optionLabel(option);
          return (
            <button
              key={optionKey(option)}
              type="button"
              disabled={!!disabled}
              title={disabled ?? hint}
              onClick={() => pick(option)}
              data-testid={`connection-add-${optionKey(option)}`}
              className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-ph-line bg-ph-base hover:border-slate-600 hover:bg-ph-hover text-left transition disabled:opacity-40 disabled:hover:border-ph-line"
            >
              <ProviderIcon icon={option.icon} className="w-4 h-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs text-slate-100 truncate">{label}</span>
                {hint && <span className="block text-[11px] text-slate-500 truncate">{hint}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const keyForm = (
    <div className="mt-2 p-3 rounded-lg border border-indigo-500/30 bg-ph-raised space-y-2">
      <label className="font-medium text-slate-200 text-[11px] flex items-center gap-1.5">
        <Key className="w-3.5 h-3.5 text-indigo-400" />
        {c.providerAnthropicApi}
      </label>
      <input
        type="password"
        autoComplete="off"
        value={keyEditor ?? ''}
        onChange={(e) => setKeyEditor(e.target.value)}
        placeholder={anthropicKey ? t.llmProfiles.apiKeyStored : c.keyPlaceholder}
        className="w-full bg-ph-hover border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-500 font-mono focus:outline-none focus:border-indigo-500"
        data-testid="anthropic-key-input"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">{c.keyApplyHint}</span>
        <div className="flex gap-2">
          <button type="button" className="ph-btn ph-btn-secondary" onClick={() => setKeyEditor(null)}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="ph-btn ph-btn-primary"
            disabled={!keyEditor?.trim()}
            onClick={() => {
              onFormChange({ apiKey: keyEditor!.trim() });
              setKeyEditor(null);
            }}
          >
            {c.keyDone}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <section className="space-y-3" data-testid="connections-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-slate-100">{c.title}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{c.description}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void refreshStatuses(true)}
            disabled={statusesLoading}
            className="ph-icon-button"
            title={t.claudeAccounts.refresh}
            aria-label={t.claudeAccounts.refresh}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusesLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            className={`ph-btn ${adding ? 'ph-btn-secondary' : 'ph-btn-primary'}`}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            data-testid="connection-add"
          >
            {adding ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{adding ? t.common.cancel : c.add}</span>
          </button>
        </div>
      </div>

      <ClaudeAccountWarnings actions={claude} />

      {adding && (
        <div className="p-3 rounded-lg bg-ph-panel border border-ph-line space-y-3" data-testid="connection-add-picker">
          <div className="text-xs font-medium text-slate-200">{c.addTitle}</div>
          {renderGroup(c.groupSubscription, groups.subscription)}
          {renderGroup(c.groupApiKey, groups.apiKey)}
          {renderGroup(c.groupServer, groups.server)}
        </div>
      )}

      <ul className="space-y-1.5">
        {accounts.map((account) => (
          <ClaudeAccountRow key={account.id} account={account} actions={claude} />
        ))}
        {engineAccounts.map((account) => (
          <ClaudeAccountRow key={account.id} account={account} actions={claude} />
        ))}

        {(anthropicKey || keyEditor !== null) && (
          <ConnectionRow
            icon="anthropic"
            providerLabel={c.providerAnthropicApi}
            name={c.providerAnthropicApi}
            details={anthropicKey ? c.keyStored : c.noKey}
            testId="connection-anthropic-key"
            actions={
              anthropicKey && keyEditor === null ? (
                <>
                  <button type="button" className="ph-icon-button" title={c.changeKey} aria-label={c.changeKey} onClick={() => setKeyEditor('')}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="ph-icon-button hover:text-rose-300" title={c.removeKey} aria-label={c.removeKey} onClick={() => void removeKey()}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : undefined
            }
          >
            {keyEditor !== null && keyForm}
          </ConnectionRow>
        )}

        {legacy && (
          <ConnectionRow
            icon={legacyIcon(legacy)}
            providerLabel={LEGACY_NAMES[legacy]}
            name={LEGACY_NAMES[legacy]}
            badges={<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">{c.legacyBadge}</span>}
            details={c.legacyHint}
            title={c.legacyHint}
            testId="connection-legacy"
            actions={
              <button type="button" className="ph-btn ph-btn-secondary" disabled={legacyBusy} onClick={() => void migrateLegacy()}>
                {c.legacyMigrate}
              </button>
            }
          />
        )}

        {profiles.map((profile) => {
          const preset = presetOf(profile.presetId);
          const isEditing = editing?.target === profile.id;
          return (
            <ConnectionRow
              key={profile.id}
              icon={presetIcon(profile.presetId, profile.local)}
              providerLabel={preset?.name ?? profile.presetId}
              name={profile.name}
              title={profile.baseUrl}
              testId={`connection-profile-${profile.id}`}
              badges={profile.local ? <span className={connectionBadge}>{c.local}</span> : undefined}
              details={
                <>
                  <span className="font-mono">{profile.baseUrl}</span>
                  <span className="text-slate-500"> · {profile.hasApiKey ? c.keyStored : c.noKey}</span>
                </>
              }
              actions={
                isEditing ? undefined : (
                  <>
                    <button type="button" className="ph-icon-button" title={c.editProfile} aria-label={c.editProfile} onClick={() => setEditing({ target: profile.id, draft: draftFromProfile(profile) })}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" className="ph-icon-button hover:text-rose-300" title={c.deleteProfile} aria-label={c.deleteProfile} onClick={() => void removeProfile(profile)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )
              }
            >
              {isEditing && editing && (
                <LlmProfileEditor
                  initial={editing.draft}
                  preset={preset}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    void reloadProfiles();
                  }}
                />
              )}
            </ConnectionRow>
          );
        })}

        {editing?.target === 'new' && (
          <ConnectionRow
            icon={presetIcon(editing.draft.profile.presetId, editing.draft.profile.local)}
            providerLabel={presetOf(editing.draft.profile.presetId)?.name ?? ''}
            name={editing.draft.profile.name}
            testId="connection-profile-new"
          >
            <LlmProfileEditor
              initial={editing.draft}
              preset={presetOf(editing.draft.profile.presetId)}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void reloadProfiles();
              }}
            />
          </ConnectionRow>
        )}
      </ul>

      {(claude.error || error) && <div className="text-[11px] text-rose-300 break-words">{claude.error || error}</div>}
    </section>
  );
};
