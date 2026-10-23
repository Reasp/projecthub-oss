import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, GitBranch, GitMerge, XCircle, AlertTriangle, ShieldCheck, FileText } from '../common/icons';
import { ipcErrorText as errorText, useTranslation } from '../../i18n/useTranslation';
import { hostLabelText } from '../../i18n/hostLabels';
import { useDialog } from '../../hooks/useDialog';
import { InitDiffView } from '../projects/InitDiffView';
import type { DocBranchDiff, DocBranchFile, DocBranchesOverview, DocResolution } from '../../types/electron';

interface DocBranchesModalProps {
  projectPath: string;
  initialBranchId?: string;
  initialDocPath?: string;
  onClose: () => void;
  /** Основная документация изменилась (принята ветка) — обновить список документов. */
  onMainChanged: () => void;
}

type Resolutions = Record<string, Record<string, DocResolution>>;


/**
 * Ветки документации (TASK-194, decision-151): список веток, документы ветки, итог принятия в основной построчно,
 * конфликты разделов с выбором стороны, принятие целиком или по документам и отклонение ветки.
 */
export const DocBranchesModal: React.FC<DocBranchesModalProps> = ({ projectPath, initialBranchId, initialDocPath, onClose, onMainChanged }) => {
  const { t, language } = useTranslation();
  const b = t.docs.branches;
  const { confirm } = useDialog();
  const [overview, setOverview] = useState<DocBranchesOverview | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialBranchId);
  const [diff, setDiff] = useState<DocBranchDiff | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | undefined>(initialDocPath);
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const next = await window.api.listDocBranches(projectPath);
      setOverview(next);
      setSelectedId((cur) => (cur && next.branches.some((x) => x.id === cur) ? cur : next.branches[0]?.id));
    } catch (err) {
      setMessage({ kind: 'error', text: b.failed.replace('{error}', errorText(err)) });
    }
  }, [projectPath, b.failed]);

  const loadDiff = useCallback(async (id: string | undefined) => {
    if (!id) {
      setDiff(null);
      return;
    }
    try {
      const next = await window.api.diffDocBranch(projectPath, id);
      setDiff(next);
      setSelectedDoc((cur) => (cur && next.files.some((f) => f.path === cur) ? cur : next.files[0]?.path));
    } catch (err) {
      setDiff(null);
      setMessage({ kind: 'error', text: b.failed.replace('{error}', errorText(err)) });
    }
  }, [projectPath, b.failed]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    setResolutions({});
    void loadDiff(selectedId);
  }, [selectedId, loadDiff]);

  // Агент правит ветку, пока окно открыто: список и дифф обновляются по событию шины.
  useEffect(() => {
    if (!window.api?.onBusEvent) return;
    return window.api.onBusEvent((event: { type?: string; projectPath?: string; branchId?: string }) => {
      if (event?.type !== 'docs:branchChanged' || event.projectPath !== projectPath) return;
      void loadOverview();
      if (event.branchId === selectedId) void loadDiff(selectedId);
    });
  }, [projectPath, selectedId, loadOverview, loadDiff]);

  const file = useMemo(() => diff?.files.find((f) => f.path === selectedDoc) ?? null, [diff, selectedDoc]);
  const unresolved = (files: DocBranchFile[]) =>
    files.reduce((n, f) => n + f.conflicts.filter((c) => !resolutions[f.docId]?.[c.key]).length, 0);

  const accept = async (docs?: string[]) => {
    if (!diff) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.api.mergeDocBranch(projectPath, diff.branch.id, { ...(docs ? { docs } : {}), resolutions });
      const files = [...result.written, ...result.removed].join(', ');
      if (result.status === 'conflict') setMessage({ kind: 'error', text: b.conflictLeft.replace('{count}', String(result.conflicts.length)) });
      else if (result.status === 'nothing') setMessage({ kind: 'ok', text: b.nothing });
      else {
        setMessage({ kind: 'ok', text: (result.status === 'merged' ? b.merged : b.partial).replace('{files}', files || '—') });
        onMainChanged();
      }
      await loadOverview();
      await loadDiff(result.status === 'merged' ? undefined : diff.branch.id);
    } catch (err) {
      setMessage({ kind: 'error', text: b.failed.replace('{error}', errorText(err)) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!diff) return;
    const ok = await confirm(b.rejectConfirm.replace('{id}', diff.branch.id).replace('{title}', diff.branch.title));
    if (!ok) return;
    setBusy(true);
    try {
      await window.api.closeDocBranch(projectPath, diff.branch.id);
      setSelectedId(undefined);
      await loadOverview();
    } catch (err) {
      setMessage({ kind: 'error', text: b.failed.replace('{error}', errorText(err)) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (docId: string, key: string, resolution: DocResolution) =>
    setResolutions((prev) => ({ ...prev, [docId]: { ...(prev[docId] ?? {}), [key]: resolution } }));

  const changeLabel = (change: DocBranchFile['change']) => (change === 'added' ? b.added : change === 'removed' ? b.removed : b.modified);
  const allUnresolved = diff ? unresolved(diff.files) : 0;
  const docUnresolved = file ? unresolved([file]) : 0;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60" data-testid="doc-branches-modal">
      <div className="bg-ph-elevated border border-slate-700 w-full max-w-6xl h-[85vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-indigo-400" /> {b.title}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" title={t.common.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {message && (
          <div className={`px-5 py-2 text-xs border-b border-slate-800 ${message.kind === 'ok' ? 'text-emerald-300 bg-emerald-500/5' : 'text-rose-300 bg-rose-500/5'}`}>
            {message.text}
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          {/* Ветки */}
          <div className="w-72 border-r border-slate-800 overflow-y-auto p-2 space-y-1 shrink-0">
            {overview && !overview.available && <p className="p-3 text-xs text-slate-500">{b.notGit}</p>}
            {overview?.available && overview.branches.length === 0 && <p className="p-3 text-xs text-slate-500">{b.empty}</p>}
            {overview?.branches.map((br) => (
              <button
                key={br.id}
                onClick={() => setSelectedId(br.id)}
                data-testid={`doc-branch-${br.id}`}
                className={`w-full text-left p-2.5 rounded-lg border transition ${
                  br.id === selectedId ? 'bg-indigo-500/10 border-indigo-500/40' : 'border-transparent hover:bg-ph-hover'
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-slate-400">{br.id}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      br.status === 'proposed' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700/50 text-slate-400'
                    }`}
                  >
                    {br.status === 'proposed' ? b.statusProposed : b.statusOpen}
                  </span>
                </div>
                <div className="text-xs text-slate-100 mt-1 line-clamp-2">{br.title}</div>
                <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-2">
                  {br.author && <span>{hostLabelText(br.author, language)}</span>}
                  {br.task && <span>{br.task}</span>}
                  <span>{b.docsCount.replace('{count}', String(br.docs.length))}</span>
                  {br.conflicts > 0 && <span className="text-rose-300">{b.conflictsCount.replace('{count}', String(br.conflicts))}</span>}
                </div>
              </button>
            ))}
          </div>

          {/* Ветка */}
          {!diff ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-500">{b.selectBranch}</div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-slate-100 truncate">
                    <span className="font-mono text-slate-400 mr-2">{diff.branch.id}</span>
                    {diff.branch.title}
                  </div>
                  {diff.branch.proposal && <p className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{diff.branch.proposal}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => void reject()}
                    disabled={busy}
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> {b.reject}
                  </button>
                  <button
                    onClick={() => void accept()}
                    disabled={busy || diff.files.length === 0 || allUnresolved > 0}
                    title={allUnresolved > 0 ? b.conflictLeft.replace('{count}', String(allUnresolved)) : undefined}
                    data-testid="doc-branch-accept-all"
                    className="ph-btn ph-btn-primary disabled:opacity-40"
                  >
                    <GitMerge className="w-3.5 h-3.5" /> {b.acceptAll}
                  </button>
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                {/* Документы ветки */}
                <div className="w-64 border-r border-slate-800 overflow-y-auto p-2 space-y-1 shrink-0">
                  {diff.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setSelectedDoc(f.path)}
                      className={`w-full text-left p-2 rounded-lg text-xs transition ${f.path === selectedDoc ? 'bg-ph-hover' : 'hover:bg-ph-hover/60'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        {f.docId.startsWith('decision-') ? (
                          <ShieldCheck className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        )}
                        <span className="font-mono text-slate-400">{f.docId}</span>
                        <span className="text-[10px] text-slate-500">{changeLabel(f.change)}</span>
                        {f.conflicts.length > 0 && <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
                      </div>
                      <div className="text-slate-200 mt-0.5 line-clamp-2">{f.title}</div>
                    </button>
                  ))}
                  {diff.files.length === 0 && <p className="p-2 text-xs text-slate-500">{b.nothing}</p>}
                </div>

                {/* Документ */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {file && (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-xs text-slate-100">
                            <span className="font-mono text-slate-400 mr-2">{file.docId}</span>
                            {file.title}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 truncate">{file.path}</div>
                          <div className="flex flex-wrap gap-1.5 text-[10px]">
                            <span className="px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-300">{changeLabel(file.change)}</span>
                            {file.mainChanged && <span className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300">{b.mainChanged}</span>}
                            {file.renumberedFrom && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                                {b.renumbered.replace('{from}', file.renumberedFrom).replace('{to}', file.docId)}
                              </span>
                            )}
                          </div>
                          {file.parts.length > 0 && (
                            <p className="text-[11px] text-slate-400">{b.parts.replace('{parts}', file.parts.map((p) => p.label).join('; '))}</p>
                          )}
                        </div>
                        <button
                          onClick={() => void accept([file.docId])}
                          disabled={busy || docUnresolved > 0}
                          data-testid="doc-branch-accept-doc"
                          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 disabled:opacity-40 shrink-0"
                        >
                          <GitMerge className="w-3.5 h-3.5" /> {file.conflicts.length ? b.acceptResolved : b.acceptDoc}
                        </button>
                      </div>

                      {file.conflicts.length > 0 ? (
                        <div className="space-y-3">
                          <p className="text-[11px] text-slate-400">{b.conflictsHint}</p>
                          {file.conflicts.map((c) => {
                            const chosen = resolutions[file.docId]?.[c.key];
                            const pick = (r: 'ours' | 'theirs' | 'both', label: string) => (
                              <button
                                onClick={() => choose(file.docId, c.key, r)}
                                className={`h-6 px-2 rounded text-[11px] border ${
                                  chosen === r ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-slate-700 text-slate-300 hover:bg-ph-hover'
                                }`}
                              >
                                {label}
                              </button>
                            );
                            return (
                              <div key={c.key} className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 space-y-2" data-testid="doc-branch-conflict">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-rose-200">{b.conflictTitle.replace('{label}', c.label)}</span>
                                  <div className="flex gap-1.5">
                                    {pick('ours', b.takeOurs)}
                                    {pick('theirs', b.takeTheirs)}
                                    {c.ours !== null && c.theirs !== null && pick('both', b.takeBoth)}
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  {([['ours', b.ours, c.ours], ['theirs', b.theirs, c.theirs]] as const).map(([key, label, text]) => (
                                    <div key={key}>
                                      <div className="text-[10px] text-slate-500 mb-1">{label}</div>
                                      <pre className="text-[11px] font-mono p-2 rounded bg-ph-base border border-slate-800 max-h-56 overflow-auto whitespace-pre-wrap break-words text-slate-300">
                                        {text ?? b.none}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                                {c.base !== null && (
                                  <details className="text-[11px] text-slate-500">
                                    <summary className="cursor-pointer">{b.base}</summary>
                                    <pre className="font-mono p-2 mt-1 rounded bg-ph-base border border-slate-800 max-h-40 overflow-auto whitespace-pre-wrap break-words">{c.base}</pre>
                                  </details>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : file.merged === null ? (
                        <p className="text-xs text-rose-300">{b.removedDoc}</p>
                      ) : (
                        <InitDiffView
                          title={b.resultTitle}
                          before={file.main ?? ''}
                          after={file.merged}
                          labels={{ tooLarge: b.diffTooLarge, same: b.diffSame, gap: b.diffGap }}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
