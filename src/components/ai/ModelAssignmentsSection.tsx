import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Network } from '../common/icons';
import type {
  AIProviderConfig,
  ModelAssignmentState,
  ModelAssignments,
  ModelPurpose,
  ModelRouteView,
  ModelTargetSpec,
  TierEngine
} from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { ModelTierSelect } from './ModelTierSelect';
import { ProviderProfileSelect, useLlmProfiles } from './ProviderProfileSelect';
import { ReasoningEffortSelect } from './ReasoningEffortSelect';
import { describeModelRoute } from '../../lib/modelRouteText';
import { effortTargetKind } from '../../lib/reasoningEffort';
import {
  ASSIGNMENT_MODES,
  PURPOSE_ROWS,
  assignmentDraftProblems,
  assignmentModeOf,
  catalogAssignment,
  isFixedPurpose,
  purposeEngineOptions,
  withAssignmentMode,
  withTargetPatch,
  withTier,
  type AssignmentMode
} from '../../lib/modelAssignmentEditor';

const inputClass =
  'w-full bg-ph-panel border border-slate-800 rounded-md px-2 py-1 text-[11px] text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500';

/** Пауза перед пересчётом «Сейчас» после правки: не дёргать main на каждый символ модели. */
const PREVIEW_DEBOUNCE_MS = 250;

function stopEnter(e: React.KeyboardEvent) {
  if (e.key === 'Enter') e.preventDefault();
}

interface ModelAssignmentsSectionProps {
  /** Основная модель из вкладки «Основные» до «Сохранить»: «Сейчас» считается по ней. */
  mainDraft: AIProviderConfig;
  /** Назначение, строку которого показать (переход из сообщения об ошибке выбора модели). */
  focusPurpose?: string;
}

/**
 * Вкладка «Назначения» (TASK-134.3, decision-96): для каждого назначения каталога — по умолчанию, как основная,
 * тир или своя цель; «Сейчас» показывает, чем пойдёт вызов на черновике, и предупреждает о нерабочей цели.
 * Сохраняется своей кнопкой отдельно от основных настроек, как тиры.
 */
export const ModelAssignmentsSection: React.FC<ModelAssignmentsSectionProps> = ({ mainDraft, focusPurpose }) => {
  const { t } = useTranslation();
  const l = t.modelAssignments;
  const profiles = useLlmProfiles();
  const [state, setState] = useState<ModelAssignmentState | null>(null);
  const [draft, setDraft] = useState<ModelAssignments | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<ModelPurpose, ModelRouteView> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const rowRefs = useRef<Partial<Record<ModelPurpose, HTMLDivElement | null>>>({});

  useEffect(() => {
    let cancelled = false;
    window.api
      .getModelAssignments()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setDraft(s.settings);
      })
      .catch((err: unknown) => !cancelled && setError(String((err as Error)?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // «Сейчас» по черновику назначений и основной модели — до сохранения (AC #4).
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.api
        .previewModelAssignments({ assignments: draft, main: mainDraft })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err: unknown) => !cancelled && setPreviewError(String((err as Error)?.message ?? err)));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, mainDraft]);

  // Переход к строке из сообщения об ошибке: прокрутить, когда строки отрисованы.
  useEffect(() => {
    if (!draft || !focusPurpose) return;
    rowRefs.current[focusPurpose as ModelPurpose]?.scrollIntoView({ block: 'center' });
  }, [draft, focusPurpose]);

  const change = useCallback((next: ModelAssignments) => {
    setDraft(next);
    setDirty(true);
    setNotice(null);
  }, []);

  if (!state || !draft) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-xs py-6 justify-center">
        {error ? <span className="text-rose-300">{error}</span> : <Loader2 className="w-4 h-4 animate-spin" />}
      </div>
    );
  }

  const problems = assignmentDraftProblems(draft);
  const canSave = dirty && !busy && Object.keys(problems).length === 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await window.api.saveModelAssignments(draft);
      setState(saved);
      setDraft(saved.settings);
      setDirty(false);
      setNotice(l.saved);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const catalogText = (purpose: ModelPurpose) => {
    const c = catalogAssignment(purpose);
    return c.mode === 'tier' ? l.catalogTier.replace('{tier}', c.tier) : l.catalogMain;
  };

  const modeLabel = (purpose: ModelPurpose, mode: AssignmentMode) =>
    mode === 'default' ? l.defaultOf.replace('{value}', catalogText(purpose)) : l.mode[mode];

  const renderCustom = (purpose: ModelPurpose, target: ModelTargetSpec) => {
    const engines = purposeEngineOptions(purpose);
    const engine = target.engine;
    return (
      <div className="flex flex-wrap gap-2 items-center">
        <div className="w-24 shrink-0">
          <select
            value={engine ?? ''}
            onChange={(e) => change(withTargetPatch(draft, purpose, { engine: (e.target.value || undefined) as TierEngine | undefined }))}
            aria-label={l.engine}
            title={l.engine}
            className={inputClass}
          >
            <option value="">{l.engine}: —</option>
            {engines.map((en) => (
              <option key={en} value={en}>
                {en}
              </option>
            ))}
          </select>
        </div>
        <div className="w-40 shrink-0">
          {engine === undefined || engine === 'api' ? (
            <ProviderProfileSelect
              value={{ provider: target.provider, profile: target.profile }}
              onChange={(choice) => change(withTargetPatch(draft, purpose, { provider: choice.provider, profile: choice.profile }))}
              profiles={profiles}
              storeProfileAs="name"
              className={inputClass}
            />
          ) : (
            <span className="text-[11px] text-slate-500 truncate">{engine}</span>
          )}
        </div>
        {/* Модель — шире остальных полей: идентификаторы API длинные. */}
        <div className="flex-1 min-w-[12rem]">
          <input
            type="text"
            value={target.model ?? ''}
            onChange={(e) => change(withTargetPatch(draft, purpose, { model: e.target.value }))}
            onKeyDown={stopEnter}
            placeholder={l.modelPlaceholder}
            aria-label={l.model}
            className={inputClass}
          />
        </div>
        <div className="w-32 shrink-0">
          <ModelTierSelect
            value={target.modelTier}
            onChange={(modelTier) => change(withTargetPatch(draft, purpose, { modelTier }))}
            className={inputClass}
          />
        </div>
        <div className="w-36 shrink-0">
          <ReasoningEffortSelect
            value={target.reasoningEffort}
            onChange={(reasoningEffort) => change(withTargetPatch(draft, purpose, { reasoningEffort }))}
            target={effortTargetKind({ engine, provider: target.provider ?? (target.profile ? 'openai-compatible' : undefined) })}
            className={inputClass}
            compact
          />
        </div>
      </div>
    );
  };

  const renderNow = (purpose: ModelPurpose) => {
    const view = preview?.[purpose];
    if (!view) return <span className="text-slate-500">{l.nowLoading}</span>;
    const text = describeModelRoute(view, t.modelRouting);
    return (
      <div className="flex flex-wrap items-baseline gap-x-1.5" title={text.details} data-testid={`assignment-now-${purpose}`}>
        <span className="text-slate-500">{l.columnNow}:</span>
        <span className={view.problem ? 'text-amber-300' : 'text-slate-100'}>{text.target}</span>
        <span className="text-slate-500">({text.origin})</span>
        {text.problem && (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <AlertTriangle className="w-3 h-3" />
            {l.willFail.replace('{reason}', text.problem)}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="model-assignments-section">
      <div>
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Network className="w-4 h-4 text-sky-400" />
          {l.title}
        </h3>
        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{l.subtitle}</p>
      </div>

      {state.loadError && (
        <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800/50 text-rose-200 text-[11px]">
          {l.loadError.replace('{error}', state.loadError)}
        </div>
      )}
      {state.problems.length > 0 && (
        <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/50 text-amber-200 text-[11px]">
          {l.problems.replace('{list}', state.problems.join('; '))}
        </div>
      )}
      {previewError && (
        <div className="p-2 rounded-lg bg-amber-950/20 border border-amber-800/40 text-amber-200 text-[11px]">
          {l.previewError.replace('{error}', previewError)}
        </div>
      )}

      <div className="space-y-2">
        {PURPOSE_ROWS.map((purpose) => {
          const fixed = isFixedPurpose(purpose);
          const mode = assignmentModeOf(draft, purpose);
          const entry = draft.assignments[purpose];
          const focused = focusPurpose === purpose;
          const failing = Boolean(preview?.[purpose]?.problem) || Boolean(problems[purpose]);
          return (
            <div
              key={purpose}
              ref={(el) => {
                rowRefs.current[purpose] = el;
              }}
              data-testid={`assignment-row-${purpose}`}
              className={`rounded-lg border px-3 py-2 space-y-1.5 ${
                focused ? 'ring-1 ring-sky-400/70 border-sky-500/50 bg-sky-500/5' : failing ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-ph-panel/60'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-100">{l.purposes[purpose]}</div>
                  <div className="text-[11px] text-slate-500 font-mono">{purpose}</div>
                </div>
                {fixed ? (
                  <span className="text-[11px] text-slate-400 max-w-[16rem] text-right">{l.fixed}</span>
                ) : (
                  <select
                    value={mode}
                    onChange={(e) => change(withAssignmentMode(draft, purpose, e.target.value as AssignmentMode))}
                    aria-label={l.columnMode}
                    data-testid={`assignment-mode-${purpose}`}
                    className="bg-ph-panel border border-slate-800 rounded-md px-2 py-1 text-[11px] text-white max-w-[15rem]"
                  >
                    {ASSIGNMENT_MODES.map((m) => (
                      <option key={m} value={m}>
                        {modeLabel(purpose, m)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {entry?.mode === 'tier' && (
                <div className="max-w-[12rem]">
                  <ModelTierSelect
                    value={entry.tier}
                    onChange={(tier) => change(tier ? withTier(draft, purpose, tier) : withAssignmentMode(draft, purpose, 'main'))}
                    className={inputClass}
                  />
                </div>
              )}
              {entry?.mode === 'custom' && renderCustom(purpose, entry.target)}
              {problems[purpose] === 'empty_target' && <div className="text-[11px] text-amber-300">{l.emptyTarget}</div>}
              <div className="text-[11px]">{renderNow(purpose)}</div>
            </div>
          );
        })}
      </div>

      {error && <div className="text-[11px] text-rose-300">{error}</div>}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11px] text-slate-500 font-mono truncate" title={state.filePath}>
          {l.filePath}: {state.filePath}
        </span>
        <div className="flex items-center gap-2">
          {notice && (
            <span className="text-[11px] text-emerald-300 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {notice}
            </span>
          )}
          {dirty && !notice && <span className="text-[11px] text-amber-300">{l.unsaved}</span>}
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            data-testid="model-assignments-save"
            className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-medium disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            {busy ? l.saving : l.save}
          </button>
        </div>
      </div>
    </div>
  );
};
