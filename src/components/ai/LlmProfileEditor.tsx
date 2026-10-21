import React, { useState } from 'react';
import { Key } from '../common/icons';
import type { LlmCompatFlags, LlmProfile, LlmProfileView, LlmProviderPreset } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { cleanIpcError } from './ClaudeAccountParts';

/**
 * Форма профиля OpenAI-совместимого сервера (TASK-70.1, decision-39) в списке подключений (TASK-172):
 * пресет выбран в окне «Добавить», здесь — имя, адрес, ключ, «локальный» и флаги совместимости.
 * Ключ профиля в renderer не приходит: форма только задаёт новый или удаляет сохранённый.
 */

export interface ProfileDraft {
  isNew: boolean;
  profile: LlmProfile;
  apiKey: string;
  removeKey: boolean;
  hasApiKey: boolean;
}

function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function draftFromPreset(preset: LlmProviderPreset): ProfileDraft {
  return {
    isNew: true,
    profile: {
      id: newProfileId(),
      name: preset.name,
      presetId: preset.id,
      baseUrl: preset.baseUrl,
      local: preset.local,
      compat: { ...preset.compat },
      ...(preset.headers ? { headers: { ...preset.headers } } : {})
    },
    apiKey: '',
    removeKey: false,
    hasApiKey: false
  };
}

export function draftFromProfile(view: LlmProfileView): ProfileDraft {
  const { hasApiKey, ...profile } = view;
  return { isNew: false, profile: { ...profile, compat: { ...profile.compat } }, apiKey: '', removeKey: false, hasApiKey };
}

const inputClass =
  'w-full bg-ph-hover border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-500 font-mono focus:outline-none focus:border-indigo-500';
const labelClass = 'font-medium text-slate-200 text-[11px] block mb-1.5';

interface LlmProfileEditorProps {
  initial: ProfileDraft;
  preset?: LlmProviderPreset;
  onSaved: (profile: LlmProfile) => void;
  onCancel: () => void;
}

export const LlmProfileEditor: React.FC<LlmProfileEditorProps> = ({ initial, preset, onSaved, onCancel }) => {
  const { t } = useTranslation();
  const l = t.llmProfiles;
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setProfile = (patch: Partial<LlmProfile>) => setDraft((d) => ({ ...d, profile: { ...d.profile, ...patch } }));
  const setCompat = <K extends keyof LlmCompatFlags>(key: K, value: LlmCompatFlags[K]) =>
    setDraft((d) => ({ ...d, profile: { ...d.profile, compat: { ...d.profile.compat, [key]: value } } }));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const apiKey = draft.removeKey ? '' : draft.apiKey.trim() ? draft.apiKey.trim() : undefined;
      onSaved(await window.api.saveLlmProfile(draft.profile, apiKey));
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 p-3 mt-2 rounded-lg border border-indigo-500/30 bg-ph-raised" data-testid="llm-profile-editor">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>{l.name}</label>
          <input type="text" value={draft.profile.name} onChange={(e) => setProfile({ name: e.target.value })} className={`${inputClass} font-sans`} />
        </div>
        <div>
          <label className={labelClass}>{l.baseUrl}</label>
          <input
            type="text"
            value={draft.profile.baseUrl}
            onChange={(e) => setProfile({ baseUrl: e.target.value })}
            placeholder="http://192.168.1.10:11434/v1"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className={`${labelClass} flex items-center gap-1.5`}>
          <Key className="w-3.5 h-3.5 text-indigo-400" />
          {l.apiKey}
        </label>
        <input
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value, removeKey: false })}
          placeholder={draft.hasApiKey ? l.apiKeyStored : preset?.requiresApiKey ? 'sk-...' : l.apiKeyOptional}
          className={inputClass}
          autoComplete="off"
        />
        {draft.hasApiKey && (
          <label className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
            <input type="checkbox" checked={draft.removeKey} onChange={(e) => setDraft({ ...draft, removeKey: e.target.checked, apiKey: '' })} />
            {l.removeKey}
          </label>
        )}
      </div>

      <label className="flex items-center gap-2 text-[11px] text-slate-300">
        <input type="checkbox" checked={draft.profile.local} onChange={(e) => setProfile({ local: e.target.checked })} />
        {l.local}
      </label>

      {/* Флаги совместимости нужны редко: пресет задаёт их сам */}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none">{l.compat}</summary>
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-1 gap-1.5 text-slate-300">
            {(
              [
                ['tools', l.compatTools],
                ['vision', l.compatVision],
                ['streamUsage', l.compatStreamUsage],
                ['openRouterUsage', l.compatOpenRouterUsage],
                ['responseFormat', l.compatResponseFormat]
              ] as const
            ).map(([key, text]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={draft.profile.compat[key]} onChange={(e) => setCompat(key, e.target.checked)} />
                {text}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-400 block mb-1">{l.compatMaxTokensField}</label>
              <select
                value={draft.profile.compat.maxTokensField}
                onChange={(e) => setCompat('maxTokensField', e.target.value as LlmCompatFlags['maxTokensField'])}
                className={inputClass}
              >
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </div>
            <div>
              <label className="text-slate-400 block mb-1">{l.compatReasoning}</label>
              <select
                value={draft.profile.compat.reasoning}
                onChange={(e) => setCompat('reasoning', e.target.value as LlmCompatFlags['reasoning'])}
                className={inputClass}
              >
                <option value="none">{l.reasoningNone}</option>
                <option value="reasoning_effort">reasoning_effort</option>
                <option value="reasoning_object">reasoning: {'{ effort }'}</option>
                <option value="ollama_think">Ollama /v1 (reasoning_effort, none…max)</option>
              </select>
            </div>
          </div>
        </div>
      </details>

      {error && <p className="text-[11px] text-rose-400 break-words">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" className="ph-btn ph-btn-secondary" onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button type="button" className="ph-btn ph-btn-primary" onClick={() => void save()} disabled={saving || !draft.profile.baseUrl.trim()}>
          {l.saveProfile}
        </button>
      </div>
    </div>
  );
};
