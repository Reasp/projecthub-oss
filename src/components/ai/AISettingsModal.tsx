import React, { useState, useEffect } from 'react';
import {
  X,
  Cpu,
  Sliders,
  Sparkles,
  CheckCircle2,
  EyeOff,
  ShieldCheck,
  FileCode,
  Terminal,
  BookOpen,
  GitFork,
  Plus,
  SlidersHorizontal,
  Lock,
  Clock,
  History,
  DollarSign,
  Layers,
  Network,
} from '../common/icons';
import { useAIStudioStore, DEFAULT_AUTO_APPROVE_RULES } from '../../store/useAIStudioStore';
import { useHitlStore } from '../../store/useHitlStore';
import type { AIProviderConfig, AutoApproveRules } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { useTimers } from '../../hooks/useTimeoutState';
import { PricingEditorSection } from './PricingEditorSection';
import { ModelTiersSection } from './ModelTiersSection';
import { useLlmProfiles } from './ProviderProfileSelect';
import { ReasoningEffortSelect } from './ReasoningEffortSelect';
import { ConnectionsPanel } from './ConnectionsPanel';
import { ModelSelectorDropdown } from './ModelSelectorDropdown';
import { effortTargetKind } from '../../lib/reasoningEffort';
import { mainEngineOfForm } from '../../lib/modelAssignmentEditor';
import { claudeEngineOf, defaultModelPatch, hasAnthropicKey, legacyProviderOf } from '../../lib/connections';
import { ModelAssignmentsSection } from './ModelAssignmentsSection';

export type AISettingsTab = 'general' | 'autoApprove' | 'pricing' | 'tiers' | 'assignments';

interface AISettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Вкладка при открытии; переход из ошибки выбора модели открывает «Назначения» (TASK-134.3). */
  initialTab?: AISettingsTab;
  /** Назначение, строку которого показать на вкладке «Назначения». */
  focusPurpose?: string;
}

// Подсказки поля модели для API-пути Anthropic: ему нужен полный идентификатор, алиасы Claude CLI не подходят.
// Справка, а не рекомендация: модель выбирает пользователь (decision-26 п. 0).
const ANTHROPIC_API_MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

export const AISettingsModal: React.FC<AISettingsModalProps> = ({ isOpen, onClose, initialTab, focusPurpose }) => {
  const { t } = useTranslation();
  const { config, saveConfig } = useAIStudioStore();
  const openHitlCenter = useHitlStore((s) => s.openCenter);

  const [activeTab, setActiveTab] = useState<AISettingsTab>(initialTab ?? 'general');
  const [form, setForm] = useState<AIProviderConfig>({
    ...config,
    autoApproveRules: config.autoApproveRules || { ...DEFAULT_AUTO_APPROVE_RULES }
  });
  const [savedSuccess, setSavedSuccess] = useState(false);
  // Отложенное закрытие после сохранения: таймер снимается при размонтировании (TASK-50)
  const { setTimer } = useTimers();

  // Exclusion list inputs state
  const [newWritePattern, setNewWritePattern] = useState('');
  const [newReadPattern, setNewReadPattern] = useState('');
  const [newCommandPattern, setNewCommandPattern] = useState('');
  // Формат усилия профиля — для подсказки под выбором усилия рассуждений.
  const llmProfiles = useLlmProfiles(isOpen);

  useEffect(() => {
    if (isOpen) {
      setForm({
        ...config,
        autoApproveRules: config.autoApproveRules || { ...DEFAULT_AUTO_APPROVE_RULES }
      });
      setSavedSuccess(false);
    }
  }, [isOpen, config]);

  useEffect(() => {
    if (isOpen && initialTab) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const rules: AutoApproveRules = form.autoApproveRules || { ...DEFAULT_AUTO_APPROVE_RULES };

  const updateRules = (updated: Partial<AutoApproveRules>) => {
    setForm((prev) => ({
      ...prev,
      autoApproveRules: {
        ...(prev.autoApproveRules || DEFAULT_AUTO_APPROVE_RULES),
        ...updated
      }
    }));
  };

  const handleAddWritePattern = () => {
    const p = newWritePattern.trim();
    if (!p) return;
    const current = rules.writeExcludePatterns || [];
    if (!current.includes(p)) {
      updateRules({ writeExcludePatterns: [...current, p] });
    }
    setNewWritePattern('');
  };

  const handleRemoveWritePattern = (pat: string) => {
    const current = rules.writeExcludePatterns || [];
    updateRules({ writeExcludePatterns: current.filter((p) => p !== pat) });
  };

  const handleAddReadPattern = () => {
    const p = newReadPattern.trim();
    if (!p) return;
    const current = rules.readExcludePatterns || [];
    if (!current.includes(p)) {
      updateRules({ readExcludePatterns: [...current, p] });
    }
    setNewReadPattern('');
  };

  const handleRemoveReadPattern = (pat: string) => {
    const current = rules.readExcludePatterns || [];
    updateRules({ readExcludePatterns: current.filter((p) => p !== pat) });
  };

  const handleAddCommandPattern = () => {
    const p = newCommandPattern.trim();
    if (!p) return;
    const current = rules.commandDenyList || [];
    if (!current.includes(p)) {
      updateRules({ commandDenyList: [...current, p] });
    }
    setNewCommandPattern('');
  };

  const handleRemoveCommandPattern = (pat: string) => {
    const current = rules.commandDenyList || [];
    updateRules({ commandDenyList: current.filter((p) => p !== pat) });
  };

  // Подключения и модель по умолчанию (TASK-172): правка формы, сохраняется кнопкой «Сохранить».
  const patchForm = (patch: Partial<AIProviderConfig>) =>
    setForm((prev) => {
      const next = { ...prev, ...patch };
      for (const key of Object.keys(patch) as (keyof AIProviderConfig)[]) if (patch[key] === undefined) delete next[key];
      return next;
    });
  const legacy = legacyProviderOf(form);
  const claudeEngine = claudeEngineOf(form);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveConfig(form);
    setSavedSuccess(true);
    setTimer(() => {
      onClose();
    }, 400);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150 select-none">
      <div className="bg-ph-elevated border border-slate-700 rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-ph-raised flex items-center justify-center text-indigo-400">
              <Sparkles className="w-4 h-4 text-amber-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">{t.aiStudio.settingsModal.title}</h2>
              <p className="text-xs text-slate-400">{t.aiStudio.settingsModal.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="px-6 pt-3 bg-ph-hover/60 border-b border-slate-800 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('general')}
            className={`pb-2.5 px-3 border-b-2 text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'general'
                ? 'border-indigo-500 text-indigo-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>{t.aiStudio.settingsModal.tabGeneral}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('autoApprove')}
            className={`pb-2.5 px-3 border-b-2 text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'autoApprove'
                ? 'border-emerald-500 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t.aiStudio.settingsModal.tabAutoApprove}</span>
            {form.autoApprove && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('pricing')}
            data-testid="ai-settings-tab-pricing"
            className={`pb-2.5 px-3 border-b-2 text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'pricing'
                ? 'border-amber-500 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <DollarSign className="w-3.5 h-3.5 text-amber-400" />
            <span>{t.pricing.tabLabel}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tiers')}
            data-testid="ai-settings-tab-tiers"
            className={`pb-2.5 px-3 border-b-2 text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'tiers'
                ? 'border-violet-500 text-violet-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-violet-400" />
            <span>{t.modelTiers.tabLabel}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('assignments')}
            data-testid="ai-settings-tab-assignments"
            className={`pb-2.5 px-3 border-b-2 text-xs font-semibold flex items-center gap-2 transition ${
              activeTab === 'assignments'
                ? 'border-sky-500 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Network className="w-3.5 h-3.5 text-sky-400" />
            <span>{t.modelAssignments.tabLabel}</span>
          </button>
        </div>

        {/* Body Form */}
        <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-5 flex-1 text-xs">
          {savedSuccess && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/50 flex items-center gap-2 text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{t.aiStudio.settingsModal.saved}</span>
            </div>
          )}

          {/* TAB 1: GENERAL (LLM PROVIDERS & MODELS) */}
          {activeTab === 'general' && (
            <div className="space-y-5">
              {/* Аккаунты, ключи и серверы моделей одним списком (TASK-172) */}
              <ConnectionsPanel form={form} onFormChange={patchForm} />

              {/* Модель по умолчанию: тот же список, что в поле ввода вкладки (TASK-170, TASK-172) */}
              <section className="space-y-2 pt-4 border-t border-ph-line" data-testid="default-model">
                <div>
                  <h3 className="text-xs font-medium text-slate-100">{t.aiConnections.defaultModel}</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.aiConnections.defaultModelHint}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ModelSelectorDropdown config={form} placement="auto" onSelect={(selection) => patchForm(defaultModelPatch(form, selection))} />
                  {form.provider === 'anthropic' && hasAnthropicKey(form) && (
                    <div className="flex items-center p-0.5 rounded-md bg-ph-raised" role="radiogroup" aria-label={t.aiConnections.engineTitle} title={t.aiConnections.engineTitle}>
                      {(['claude-cli', 'api'] as const).map((engine) => (
                        <button
                          key={engine}
                          type="button"
                          role="radio"
                          aria-checked={claudeEngine === engine}
                          onClick={() => patchForm({ engine })}
                          data-testid={`default-engine-${engine}`}
                          className={`h-6 px-2 rounded text-xs transition ${
                            claudeEngine === engine ? 'bg-ph-hover text-slate-100' : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {engine === 'claude-cli' ? t.aiConnections.engineSubscription : t.aiConnections.engineApiKey}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* API-пути Anthropic нужен полный идентификатор модели, алиасы Claude CLI ему не подходят */}
                {form.provider === 'anthropic' && claudeEngine === 'api' && (
                  <div>
                    <label className="font-medium text-slate-200 text-[11px] block mb-1.5 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                      {t.aiStudio.settingsModal.model}
                    </label>
                    <input
                      type="text"
                      list="anthropic-api-models"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                      className="w-full bg-ph-hover border border-slate-800 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                      placeholder="claude-..."
                    />
                    <datalist id="anthropic-api-models">
                      {ANTHROPIC_API_MODELS.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                )}
                {legacy && (
                  <p className="text-[11px] text-amber-300/90">
                    {t.aiConnections.legacyActive.replace('{name}', legacy)}
                  </p>
                )}
              </section>

              {/* Sliders: Temperature & Thinking */}
              <div className="p-4 rounded-xl bg-ph-hover/60 border border-slate-800 space-y-4">
                {/* Усилие рассуждений (TASK-70.3, decision-41): без значения ничего не отправляется */}
                <div>
                  <span className="font-medium text-slate-300 flex items-center gap-1.5 mb-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    {t.reasoningEffort.label}
                  </span>
                  <ReasoningEffortSelect
                    value={form.reasoningEffort}
                    onChange={(reasoningEffort) => setForm({ ...form, reasoningEffort })}
                    target={effortTargetKind({
                      engine: mainEngineOfForm(form),
                      provider: form.provider,
                      profileReasoning: llmProfiles.find((p) => p.id === form.profileId)?.compat.reasoning
                    })}
                    className="w-full bg-ph-hover border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium text-slate-300 flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                      {t.aiStudio.settingsModal.temperature}
                    </span>
                    <span className="flex items-center gap-2">
                      {form.temperature !== undefined && (
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, temperature: undefined })}
                          className="text-[11px] text-slate-400 hover:text-slate-200 underline"
                        >
                          {t.aiStudio.settingsModal.resetToModelDefault}
                        </button>
                      )}
                      <span className="font-mono text-indigo-400 font-semibold">
                        {form.temperature ?? t.aiStudio.settingsModal.modelDefault}
                      </span>
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={form.temperature ?? 1}
                    onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
                    className="w-full accent-indigo-500"
                  />
                  {form.provider === 'anthropic' && (
                    <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">{t.aiStudio.settingsModal.temperatureHint}</p>
                  )}
                </div>

                {form.provider === 'anthropic' && form.reasoningEffort && (
                  <p className="text-[11px] text-slate-400 leading-relaxed">{t.reasoningEffort.budgetOverridden}</p>
                )}

                {form.provider === 'anthropic' && !form.reasoningEffort && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-medium text-slate-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        {t.aiStudio.settingsModal.thinkingBudget}
                      </span>
                      <span className="font-mono text-amber-400 font-semibold">{form.thinkingBudget || 0} tokens</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="8192"
                      step="512"
                      value={form.thinkingBudget ?? 0}
                      onChange={(e) => setForm({ ...form, thinkingBudget: parseInt(e.target.value) })}
                      className="w-full accent-amber-500"
                    />
                    <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">{t.aiStudio.settingsModal.thinkingBudgetHint}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: AUTO-APPROVE GRANULAR RULES & EXCLUSIONS */}
          {activeTab === 'autoApprove' && (
            <div className="space-y-5">
              {/* Master Toggle Card */}
              <div className="p-4 rounded-2xl bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="font-bold text-white flex items-center gap-2 text-xs">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    <span>{t.aiStudio.settingsModal.autoApproveLabel}</span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    {t.aiStudio.settingsModal.autoApproveSub}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={form.autoApprove || false}
                    onChange={(e) => setForm({ ...form, autoApprove: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                </label>
              </div>

              {/* Единый HITL-контур: таймаут ожидания решения и история решений (TASK-57) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <div className="p-3 rounded-xl bg-ph-hover border border-slate-800 space-y-1.5">
                  <label className="font-semibold text-slate-200 text-xs flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    {t.hitl.timeoutMinLabel}
                  </label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={rules.approvalTimeoutMin ?? ''}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      updateRules({ approvalTimeoutMin: Number.isFinite(v) && v > 0 ? v : undefined });
                    }}
                    placeholder="1440"
                    className="w-full bg-ph-panel border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-600 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[11px] text-slate-400">{t.hitl.timeoutMinDesc}</p>
                </div>
                <div className="p-3 rounded-xl bg-ph-hover border border-slate-800 flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-200 text-xs flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5 text-indigo-400" />
                      {t.hitl.openHistory}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{t.hitl.openHistoryDesc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openHitlCenter('history')}
                    className="self-start px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 border border-indigo-500/40 text-xs font-medium transition flex items-center gap-1.5"
                  >
                    <History className="w-3.5 h-3.5" />
                    {t.hitl.openHistory}
                  </button>
                </div>
              </div>

              {/* Action Types Permissions */}
              <div className="space-y-2">
                <label className="font-medium text-slate-200 text-[11px] block">
                  {t.aiStudio.settingsModal.allowedCategoriesLabel}
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="p-3 rounded-xl bg-ph-hover border border-slate-800 flex items-start gap-3 cursor-pointer hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      checked={rules.allowFileWrite}
                      onChange={(e) => updateRules({ allowFileWrite: e.target.checked })}
                      className="mt-0.5 rounded border-slate-700 text-emerald-500 focus:ring-0"
                    />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-xs text-slate-200 flex items-center gap-1.5">
                        <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                        <span>{t.aiStudio.settingsModal.autoApproveWrite}</span>
                      </div>
                      <p className="text-[11px] text-slate-400">{t.aiStudio.settingsModal.autoApproveWriteDesc}</p>
                    </div>
                  </label>

                  <label className="p-3 rounded-xl bg-ph-hover border border-slate-800 flex items-start gap-3 cursor-pointer hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      checked={rules.allowCommands}
                      onChange={(e) => updateRules({ allowCommands: e.target.checked })}
                      className="mt-0.5 rounded border-slate-700 text-emerald-500 focus:ring-0"
                    />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-xs text-slate-200 flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{t.aiStudio.settingsModal.autoApproveCommands}</span>
                      </div>
                      <p className="text-[11px] text-slate-400">{t.aiStudio.settingsModal.autoApproveCommandsDesc}</p>
                    </div>
                  </label>

                  <label className="p-3 rounded-xl bg-ph-hover border border-slate-800 flex items-start gap-3 cursor-pointer hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      checked={rules.allowFileRead}
                      onChange={(e) => updateRules({ allowFileRead: e.target.checked })}
                      className="mt-0.5 rounded border-slate-700 text-emerald-500 focus:ring-0"
                    />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-xs text-slate-200 flex items-center gap-1.5">
                        <BookOpen className="w-3.5 h-3.5 text-purple-400" />
                        <span>{t.aiStudio.settingsModal.autoApproveRead}</span>
                      </div>
                      <p className="text-[11px] text-slate-400">{t.aiStudio.settingsModal.autoApproveReadDesc}</p>
                    </div>
                  </label>

                  <label className="p-3 rounded-xl bg-ph-hover border border-slate-800 flex items-start gap-3 cursor-pointer hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      checked={rules.allowSubagents}
                      onChange={(e) => updateRules({ allowSubagents: e.target.checked })}
                      className="mt-0.5 rounded border-slate-700 text-emerald-500 focus:ring-0"
                    />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-xs text-slate-200 flex items-center gap-1.5">
                        <GitFork className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t.aiStudio.settingsModal.autoApproveSubagents}</span>
                      </div>
                      <p className="text-[11px] text-slate-400">{t.aiStudio.settingsModal.autoApproveSubagentsDesc}</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Exclusion Lists: 1. File Write Exclusions */}
              <div className="p-4 rounded-xl bg-ph-hover border border-slate-800 space-y-3">
                <div>
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5 text-xs">
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                    <span>{t.aiStudio.settingsModal.writeExclusionsTitle}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t.aiStudio.settingsModal.writeExclusionsDesc}
                  </p>
                </div>

                {/* Pattern Badges */}
                <div className="flex flex-wrap gap-1.5">
                  {(rules.writeExcludePatterns || []).map((pat) => (
                    <span
                      key={pat}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-mono text-amber-300 shadow-sm"
                    >
                      <span>{pat}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveWritePattern(pat)}
                        className="hover:text-rose-400 text-slate-400 p-0.5 rounded transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Input */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={newWritePattern}
                    onChange={(e) => setNewWritePattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddWritePattern();
                      }
                    }}
                    placeholder={t.aiStudio.settingsModal.addPatternPlaceholder}
                    className="flex-1 bg-ph-panel border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-600 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddWritePattern}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 border border-indigo-500/40 text-xs font-medium transition flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t.aiStudio.settingsModal.addPattern}</span>
                  </button>
                </div>
              </div>

              {/* Exclusion Lists: 2. File Read Exclusions */}
              <div className="p-4 rounded-xl bg-ph-hover border border-slate-800 space-y-3">
                <div>
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5 text-xs">
                    <EyeOff className="w-3.5 h-3.5 text-purple-400" />
                    <span>{t.aiStudio.settingsModal.readExclusionsTitle}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t.aiStudio.settingsModal.readExclusionsDesc}
                  </p>
                </div>

                {/* Pattern Badges */}
                <div className="flex flex-wrap gap-1.5">
                  {(rules.readExcludePatterns || []).map((pat) => (
                    <span
                      key={pat}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-mono text-purple-300 shadow-sm"
                    >
                      <span>{pat}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveReadPattern(pat)}
                        className="hover:text-rose-400 text-slate-400 p-0.5 rounded transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Input */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={newReadPattern}
                    onChange={(e) => setNewReadPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddReadPattern();
                      }
                    }}
                    placeholder={t.aiStudio.settingsModal.readPatternPlaceholder}
                    className="flex-1 bg-ph-panel border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-600 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddReadPattern}
                    className="px-3 py-1.5 rounded-lg bg-purple-600/30 hover:bg-purple-600 text-purple-200 border border-purple-500/40 text-xs font-medium transition flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t.aiStudio.settingsModal.addPattern}</span>
                  </button>
                </div>
              </div>

              {/* Exclusion Lists: 3. Command Deny List */}
              <div className="p-4 rounded-xl bg-ph-hover border border-slate-800 space-y-3">
                <div>
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5 text-xs">
                    <Terminal className="w-3.5 h-3.5 text-rose-400" />
                    <span>{t.aiStudio.settingsModal.commandDenyTitle}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t.aiStudio.settingsModal.commandDenyDesc}
                  </p>
                </div>

                {/* Pattern Badges */}
                <div className="flex flex-wrap gap-1.5">
                  {(rules.commandDenyList || []).map((pat) => (
                    <span
                      key={pat}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-950/40 border border-rose-800/60 text-[11px] font-mono text-rose-300 shadow-sm"
                    >
                      <span>{pat}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveCommandPattern(pat)}
                        className="hover:text-rose-200 text-rose-400 p-0.5 rounded transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Input */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={newCommandPattern}
                    onChange={(e) => setNewCommandPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCommandPattern();
                      }
                    }}
                    placeholder={t.aiStudio.settingsModal.commandPatternPlaceholder}
                    className="flex-1 bg-ph-panel border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-600 font-mono focus:outline-none focus:border-rose-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddCommandPattern}
                    className="px-3 py-1.5 rounded-lg bg-rose-600/30 hover:bg-rose-600 text-rose-200 border border-rose-500/40 text-xs font-medium transition flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t.aiStudio.settingsModal.addPattern}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Цены сохраняются своей кнопкой и сразу применяются (TASK-70.4). */}
          {activeTab === 'pricing' && <PricingEditorSection />}

          {/* Тиры моделей сохраняются своей кнопкой (TASK-79, decision-44). */}
          {activeTab === 'tiers' && <ModelTiersSection />}

          {/* Назначения моделей сохраняются своей кнопкой; «Сейчас» — по черновику основной модели (TASK-134.3). */}
          {activeTab === 'assignments' && <ModelAssignmentsSection mainDraft={form} focusPurpose={focusPurpose} />}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-slate-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="ph-btn ph-btn-secondary"
            >
              {activeTab === 'pricing' || activeTab === 'tiers' || activeTab === 'assignments' ? t.pricing.close : t.common.cancel}
            </button>
            {activeTab !== 'pricing' && activeTab !== 'tiers' && activeTab !== 'assignments' && (
            <button
              type="submit"
              className="ph-btn ph-btn-primary"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t.aiStudio.settingsModal.save}
            </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
