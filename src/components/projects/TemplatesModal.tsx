import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Package,
  FolderOpen,
  GitBranch,
  FileArchive,
  Copy,
  Trash2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Save,
  AlertCircle,
  CheckCircle2,
  Loader2
} from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import type { SaveTemplatePreview, TemplateEntry, TemplateOrigin } from '../../types/projectInit';

interface TemplatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Проект, который можно сохранить шаблоном. */
  projectPath?: string;
}

export const TemplatesModal: React.FC<TemplatesModalProps> = ({ isOpen, onClose, projectPath }) => {
  const { t, language } = useTranslation();
  const tt = t.templates;
  const dialog = useDialog();

  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [savePreview, setSavePreview] = useState<SaveTemplatePreview | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);

  const reload = async () => {
    const res = await window.api.templatesList(language);
    if (res.ok) setTemplates(res.value);
    else setError(res.error);
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setNotice(null);
    setSavePreview(null);
    setExcluded([]);
    setSaveName('');
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- загрузка только при открытии
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !projectPath) return;
    const timer = setTimeout(async () => {
      const res = await window.api.templatesPreviewSaveProject(projectPath, { name: saveName || 'template', exclude: excluded });
      if (res.ok) setSavePreview(res.value);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen, projectPath, saveName, excluded]);

  if (!isOpen) return null;

  const run = async <T,>(fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>, after?: (value: T) => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (res.ok) {
        after?.(res.value);
        await reload();
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const originLabel: Record<TemplateOrigin, string> = {
    builtin: tt.originBuiltin,
    override: tt.originOverride,
    folder: tt.originFolder,
    git: tt.originGit,
    zip: tt.originZip,
    copy: tt.originCopy,
    project: tt.originProject
  };

  const handleAddGit = async () => {
    const url = await dialog.prompt({ title: tt.addGit, message: tt.gitUrlPrompt, placeholder: 'https://github.com/org/template.git' });
    if (url && url.trim()) await run(() => window.api.templatesAddGit(url.trim()));
  };

  const handleRemove = async (entry: TemplateEntry) => {
    if (await dialog.confirm({ message: tt.confirmRemove.replace('{name}', entry.name), danger: true })) {
      await run(() => window.api.templatesRemove(entry.id));
    }
  };

  const handleSave = async () => {
    if (!projectPath || !saveName.trim()) return;
    await run(
      () => window.api.templatesSaveProject(projectPath, { name: saveName.trim(), exclude: excluded }),
      (entry) => setNotice(tt.saved.replace('{name}', entry.name))
    );
  };

  const iconButton = 'p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition disabled:opacity-40';

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 animate-in fade-in duration-150">
      <div className="bg-ph-elevated border border-slate-700 rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-ph-raised flex items-center justify-center text-indigo-400">
              <Package className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">{tt.title}</h2>
              <p className="text-xs text-slate-400">{tt.subtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" aria-label={t.common.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs">
          {error && (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/50 flex items-start gap-2 text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}
          {notice && (
            <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/50 flex items-center gap-2 text-emerald-300">
              <CheckCircle2 className="w-4 h-4" />
              {notice}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => window.api.templatesAddFolder())} className="ph-btn ph-btn-secondary">
              <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
              {tt.addFolder}
            </button>
            <button type="button" disabled={busy} onClick={handleAddGit} className="ph-btn ph-btn-secondary">
              <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
              {tt.addGit}
            </button>
            <button type="button" disabled={busy} onClick={() => run(() => window.api.templatesAddZip())} className="ph-btn ph-btn-secondary">
              <FileArchive className="w-3.5 h-3.5 text-indigo-400" />
              {tt.addZip}
            </button>
            {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400 self-center" />}
          </div>

          <div className="rounded-xl border border-slate-800 divide-y divide-slate-800/80 overflow-hidden">
            {templates.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3 px-3 py-2.5 bg-ph-hover/40">
                <div className="min-w-0 flex-1">
                  <div className="text-slate-200 font-medium truncate">
                    {entry.name} <span className="text-slate-500 font-normal">{entry.version && tt.version.replace('{version}', entry.version)}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2">
                    <span>{originLabel[entry.origin]}</span>
                    {entry.originRef && <span className="font-mono truncate max-w-[260px]" title={entry.originRef}>{entry.originRef}</span>}
                    <span className={entry.trusted ? 'text-emerald-400' : 'text-amber-300'}>{entry.trusted ? tt.trusted : tt.untrusted}</span>
                  </div>
                  {entry.issues.length > 0 && (
                    <div className="text-[11px] text-rose-300 mt-1">
                      {entry.issues.map((issue) => `${issue.path || '·'}: ${issue.message}`).join('; ')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {entry.origin === 'git' && (
                    <button type="button" disabled={busy} onClick={() => run(() => window.api.templatesUpdate(entry.id))} className={iconButton} title={tt.update}>
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {!entry.builtin && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => window.api.templatesSetTrusted(entry.id, !entry.trusted))}
                      className={iconButton}
                      title={entry.trusted ? tt.untrust : tt.trust}
                    >
                      {entry.trusted ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => run(() => window.api.templatesDuplicate(entry.id))} className={iconButton} title={tt.duplicate}>
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => run(() => window.api.templatesOpenFolder(entry.id))} className={iconButton} title={tt.openFolder}>
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                  {!entry.builtin && (
                    <button type="button" disabled={busy} onClick={() => handleRemove(entry)} className={`${iconButton} hover:text-rose-400`} title={tt.remove}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {templates.filter((entry) => !entry.builtin).length === 0 && (
              <div className="px-3 py-3 text-center text-slate-500">{tt.empty}</div>
            )}
          </div>

          {projectPath && (
            <section className="space-y-2">
              <h3 className="font-medium text-slate-200 text-[11px]">{tt.saveProject}</h3>
              <p className="text-[11px] text-slate-400">{tt.saveExcludedNote}</p>
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={tt.saveName}
                aria-label={tt.saveName}
                className="w-full bg-ph-hover border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
              />
              {savePreview && (
                <div className="rounded-xl border border-slate-800 max-h-56 overflow-auto">
                  {savePreview.files.length === 0 && excluded.length === 0 && <div className="px-3 py-2.5 text-slate-500">{tt.saveNoFiles}</div>}
                  {[...savePreview.files.map((f) => f.projectPath), ...excluded].sort().map((file) => {
                    const info = savePreview.files.find((f) => f.projectPath === file);
                    const included = !excluded.includes(file);
                    return (
                      <label key={file} className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800/60 last:border-b-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => setExcluded((prev) => (included ? [...prev, file] : prev.filter((x) => x !== file)))}
                          className="w-3.5 h-3.5"
                        />
                        <span className={`font-mono truncate ${included ? 'text-slate-200' : 'text-slate-500 line-through'}`}>{file}</span>
                        {info && info.secrets.length > 0 && (
                          <span className="ml-auto text-[10px] text-rose-300 shrink-0">{tt.saveSecrets.replace('{kinds}', info.secrets.join(', '))}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy || !saveName.trim() || !savePreview || savePreview.files.length === 0 || savePreview.secretsFound}
                  onClick={handleSave}
                  className="ph-btn ph-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="w-3.5 h-3.5" />
                  {tt.saveButton}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
