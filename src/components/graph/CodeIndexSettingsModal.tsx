import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Sliders, X } from '../common/icons';
import { ipcFailureText, useTranslation } from '../../i18n/useTranslation';
import type { CodeIndexSettings, CodeIndexState, IndexDirCount, IndexProfileId, IndexScanResult } from '../../types/codeIndex';

interface CodeIndexSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectPath: string;
  /** Сохранить и сразу переиндексировать: запуск делает вкладка графа, она же ждёт конца процесса. */
  onReindex: () => void;
}

const PREVIEW_DELAY_MS = 600;

/** Группы, доступные при выбранных профилях (как `groupsForProfiles` в main). */
function availableGroups(state: CodeIndexState, profiles: IndexProfileId[]) {
  return state.catalog.groups.filter((group) => group.profile === 'common' || profiles.includes(group.profile));
}

/**
 * Настройка индексации GitNexus (TASK-176, decision-131): профили стека, группы исключений, свои шаблоны и
 * предпросмотр — сколько файлов попадёт в индекс тем же правилом, что у `gitnexus analyze`.
 */
export const CodeIndexSettingsModal: React.FC<CodeIndexSettingsModalProps> = ({ isOpen, onClose, projectPath, onReindex }) => {
  const { t, language } = useTranslation();
  const ci = t.codeIndex;
  const [state, setState] = useState<CodeIndexState | null>(null);
  const [settings, setSettings] = useState<CodeIndexSettings | null>(null);
  const [customText, setCustomText] = useState('');
  const [preview, setPreview] = useState<IndexScanResult | null>(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setState(null);
    setSettings(null);
    setPreview(null);
    setError(null);
    setNotice(null);
    let cancelled = false;
    void window.api.codeIndexState(projectPath).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(ci.loadError.replace('{error}', ipcFailureText(res)));
        return;
      }
      setState(res.value);
      setSettings(res.value.settings);
      setCustomText(res.value.settings.custom.join('\n'));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- загрузка только при открытии окна и смене проекта
  }, [isOpen, projectPath]);

  const draft = useMemo<CodeIndexSettings | null>(
    () => (settings ? { ...settings, custom: customText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } : null),
    [settings, customText]
  );

  // Предпросмотр пересчитывается после паузы в правке: обход большого проекта занимает секунды.
  useEffect(() => {
    if (!isOpen || !draft || state?.broken) return;
    const seq = ++previewSeq.current;
    setCounting(true);
    const timer = setTimeout(async () => {
      const res = await window.api.codeIndexPreview(projectPath, draft, language);
      if (seq !== previewSeq.current) return;
      setCounting(false);
      if (res.ok) setPreview(res.value);
      else setError(ipcFailureText(res));
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isOpen, draft, projectPath, language, state?.broken]);

  if (!isOpen) return null;

  const label = (value: { ru: string; en: string }) => (language === 'ru' ? value.ru : value.en);
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  const number = (n: number) => n.toLocaleString(locale);

  const toggleProfile = (id: IndexProfileId) => {
    if (!state || !settings) return;
    const on = settings.profiles.includes(id);
    const profiles = state.catalog.profiles.map((p) => p.id).filter((p) => (p === id ? !on : settings.profiles.includes(p)));
    const allowed = new Set(availableGroups(state, profiles).map((g) => g.id));
    // Новый профиль приходит со своими группами по умолчанию; группы снятого профиля уходят.
    const added = on ? [] : state.catalog.groups.filter((g) => g.profile === id && g.default).map((g) => g.id);
    const groups = state.catalog.groups.map((g) => g.id).filter((g) => allowed.has(g) && (settings.groups.includes(g) || added.includes(g)));
    setSettings({ ...settings, profiles, groups, headersOnly: settings.headersOnly.filter((g) => groups.includes(g)) });
  };

  const toggleGroup = (id: string) => {
    if (!settings) return;
    const on = settings.groups.includes(id);
    setSettings({
      ...settings,
      groups: on ? settings.groups.filter((g) => g !== id) : [...settings.groups, id],
      headersOnly: on ? settings.headersOnly.filter((g) => g !== id) : settings.headersOnly
    });
  };

  const toggleHeaders = (id: string) => {
    if (!settings) return;
    const on = settings.headersOnly.includes(id);
    setSettings({ ...settings, headersOnly: on ? settings.headersOnly.filter((g) => g !== id) : [...settings.headersOnly, id] });
  };

  const save = async (reindex: boolean) => {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    const res = await window.api.codeIndexSave(projectPath, draft, language);
    setSaving(false);
    if (!res.ok) {
      setError(ipcFailureText(res));
      return;
    }
    if (reindex) {
      onReindex();
      onClose();
      return;
    }
    setNotice(res.value.changed ? ci.saved : ci.unchanged);
  };

  const dirList = (title: string, dirs: IndexDirCount[], tone: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400 mb-1">{title}</div>
      {dirs.length === 0 ? (
        <div className="text-[11px] text-slate-600">—</div>
      ) : (
        <div className="space-y-0.5">
          {dirs.map((d) => (
            <div key={d.dir} className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-slate-300 truncate" title={d.dir}>
                {d.dir === '.' ? ci.rootDir : d.dir}
              </span>
              <span className={`ml-auto tabular-nums shrink-0 ${tone}`}>{number(d.files)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const index = state?.index ?? null;
  const at = index?.indexedAt ? new Date(index.indexedAt) : null;
  const groups = state && settings ? availableGroups(state, settings.profiles) : [];
  const card = 'p-3 rounded-xl bg-ph-hover/60 border border-slate-800';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150" data-testid="code-index-modal">
      <div className="bg-ph-elevated border border-slate-700 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-ph-raised flex items-center justify-center text-indigo-400 shrink-0">
              <Sliders className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white">{ci.title}</h2>
              <p className="text-xs text-slate-400 truncate">{ci.subtitle}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" title={t.common.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {!state || !settings ? (
          <div className="flex-1 flex items-center justify-center gap-2 p-10 text-xs text-slate-400">
            {error ? (
              <>
                <AlertCircle className="w-4 h-4 text-rose-400" />
                {error}
              </>
            ) : (
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-hidden grid md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="overflow-y-auto p-5 space-y-5 text-xs">
              <div className="text-[11px] text-slate-400 space-y-0.5">
                <div>{state.stacks.length > 0 ? ci.stack.replace('{stacks}', state.stacks.map((s) => s.label).join(', ')) : ci.noStack}</div>
                <div>
                  {index && at && !Number.isNaN(at.getTime())
                    ? ci.indexNow.replace('{files}', index.files === null ? '?' : number(index.files)).replace('{at}', at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }))
                    : ci.noIndex}
                </div>
                {index?.rulesChanged && <div className="text-amber-300">{ci.rulesChanged}</div>}
              </div>

              {state.broken && (
                <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-800/50 text-rose-200 text-[11px] flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {ci.broken}
                </div>
              )}

              <section className="space-y-2">
                <h3 className="font-medium text-slate-200 text-[11px]">{ci.profiles}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {state.catalog.profiles.map((profile) => {
                    const on = settings.profiles.includes(profile.id);
                    return (
                      <label
                        key={profile.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border cursor-pointer ${on ? 'border-indigo-500/60 bg-indigo-500/10 text-slate-100' : 'border-slate-800 text-slate-400 hover:border-slate-700'}`}
                      >
                        <input type="checkbox" checked={on} onChange={() => toggleProfile(profile.id)} className="w-3.5 h-3.5" />
                        {label(profile.label)}
                        {state.suggested.includes(profile.id) && <span className="text-[10px] text-emerald-400">{ci.suggested}</span>}
                      </label>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-slate-200 text-[11px]">{ci.groups}</h3>
                {groups.length === 0 && <div className="text-[11px] text-slate-500">{ci.noGroups}</div>}
                <div className="space-y-1.5">
                  {groups.map((group) => {
                    const on = settings.groups.includes(group.id);
                    const profileLabel = group.profile === 'common' ? 'GitNexus' : label(state.catalog.profiles.find((p) => p.id === group.profile)?.label ?? { ru: group.profile, en: group.profile });
                    return (
                      <div key={group.id} className={`${card} ${on ? '' : 'opacity-70'}`}>
                        <label className="flex items-start gap-2 cursor-pointer">
                          <input type="checkbox" checked={on} onChange={() => toggleGroup(group.id)} className="mt-0.5 w-3.5 h-3.5" data-testid={`code-index-group-${group.id}`} />
                          <span className="min-w-0">
                            <span className="block text-slate-200">
                              <span className="text-slate-500">{profileLabel} · </span>
                              {label(group.label)}
                            </span>
                            <span className="block text-[11px] text-slate-500">{label(group.description)}</span>
                            <span className="block text-[10px] text-slate-500 font-mono mt-1 break-words">{group.patterns.join('  ')}</span>
                          </span>
                        </label>
                        {group.id === 'unreal.marketplace' && (
                          <div className="ml-5 mt-1 text-[11px] text-slate-400">
                            {state.context.marketplacePlugins.length > 0 ? ci.foundPlugins.replace('{list}', state.context.marketplacePlugins.join(', ')) : ci.noPlugins}
                          </div>
                        )}
                        {group.headers && on && (
                          <label className="ml-5 mt-1.5 flex items-center gap-1.5 cursor-pointer text-[11px] text-slate-300">
                            <input type="checkbox" checked={settings.headersOnly.includes(group.id)} onChange={() => toggleHeaders(group.id)} className="w-3 h-3" />
                            {ci.headersOnly}
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-medium text-slate-200 text-[11px]">{ci.custom}</h3>
                <p className="text-[11px] text-slate-500">{ci.customHint}</p>
                <textarea
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  placeholder={'Source/Legacy/\n!Plugins/MyPlugin/'}
                  className="w-full bg-ph-hover border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-200 font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                  data-testid="code-index-custom"
                />
                <div className="text-[11px] text-slate-500">
                  {state.userLines.length > 0 ? (
                    <>
                      <div>{ci.userLines.replace('{n}', String(state.userLines.length))}</div>
                      <div className="font-mono text-slate-400 mt-0.5 break-words">{state.userLines.slice(0, 20).join('  ')}</div>
                    </>
                  ) : (
                    ci.noUserLines
                  )}
                </div>
              </section>
            </div>

            <aside className="border-t md:border-t-0 md:border-l border-slate-800 p-5 overflow-y-auto space-y-3 text-xs bg-ph-panel/40" data-testid="code-index-preview">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-slate-200 text-[11px]">{ci.preview}</h3>
                {counting && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />}
              </div>
              {!preview ? (
                <div className="text-[11px] text-slate-500">{ci.counting}</div>
              ) : (
                <div className={`space-y-3 ${counting ? 'opacity-60' : ''}`}>
                  <div className="grid grid-cols-2 gap-2">
                    <div className={card}>
                      <div className="text-[10px] text-slate-500">{ci.included}</div>
                      <div className="text-lg font-semibold text-white tabular-nums" data-testid="code-index-included">{number(preview.included)}</div>
                    </div>
                    <div className={card}>
                      <div className="text-[10px] text-slate-500">{ci.excluded}</div>
                      <div className="text-lg font-semibold text-amber-300 tabular-nums" data-testid="code-index-excluded">{number(preview.excluded)}</div>
                    </div>
                  </div>
                  {preview.skippedLarge > 0 && (
                    <div className="text-[11px] text-slate-400">
                      {ci.skippedLarge}: <span className="tabular-nums">{number(preview.skippedLarge)}</span>
                    </div>
                  )}
                  {preview.truncated && <div className="text-[11px] text-amber-300">{ci.truncated}</div>}
                  {dirList(ci.topIncluded, preview.topIncluded, 'text-slate-300')}
                  {dirList(ci.topExcluded, preview.topExcluded, 'text-amber-300')}
                  <div className="text-[10px] text-slate-600">{ci.elapsed.replace('{s}', (preview.elapsedMs / 1000).toFixed(1))}</div>
                </div>
              )}
            </aside>
          </div>
        )}

        <div className="px-6 py-3.5 border-t border-slate-800 flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[11px] truncate">
            {error && state ? (
              <span className="text-rose-300">{error}</span>
            ) : notice ? (
              <span className="text-emerald-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {notice}
              </span>
            ) : (
              <span className="text-slate-500 font-mono">.gitnexusignore</span>
            )}
          </div>
          <button type="button" onClick={onClose} className="px-3.5 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-medium transition">
            {t.common.close}
          </button>
          <button type="button" onClick={() => void save(false)} disabled={!draft || saving || state?.broken} className="ph-btn ph-btn-secondary disabled:opacity-50">
            {ci.save}
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={!draft || saving || state?.broken}
            className="ph-btn ph-btn-primary disabled:opacity-50"
            data-testid="code-index-save-reindex"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
            {ci.saveReindex}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
