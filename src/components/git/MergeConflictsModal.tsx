import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle, FileText, GitMerge, RefreshCw, RotateCcw, Sparkles, X } from '../common/icons';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { applyConflictChoices, countConflicts, frontmatterLoss, hasConflictMarkers } from '../../../electron/services/conflictMarkers';
import type { ConflictChoice, ConflictFileContent, ConflictFileKind, ConflictResolution, MergeState } from '../../types/electron';
import { describeMergeFailure } from '../../lib/gitFailureText';

/**
 * Окно конфликтов слияния (TASK-139.3, decision-157): незавершённое слияние в рабочем дереве — выбор «моё / их / оба»
 * по блокам, правка итога с предпросмотром Markdown, «Решить агентом» (сессия Agents Studio под HITL) и завершение:
 * пересборка индексов и коммит слияния в main.
 */

interface MergeConflictsModalProps {
  /** Рабочее дерево, где идёт слияние (корень проекта или активный worktree). */
  root: string;
  /** Проект — для сессии Agents Studio. */
  projectPath: string;
  onClose: () => void;
}

type View = 'blocks' | 'result' | 'preview';
type Notice = { kind: 'ok' | 'error' | 'info'; text: string };

const CHOICES: ConflictChoice[] = ['ours', 'theirs', 'both'];
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const MergeConflictsModal: React.FC<MergeConflictsModalProps> = ({ root, projectPath, onClose }) => {
  const { t } = useTranslation();
  const tm = t.mergeConflicts;
  const dialog = useDialog();
  const [state, setState] = useState<MergeState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ConflictFileContent | null>(null);
  const [choices, setChoices] = useState<Array<ConflictChoice | null>>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<View>('blocks');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async () => {
    const next = await window.api.getMergeState(root);
    // После коммита MERGE_MSG уже нет — заголовок остаётся прежним.
    setState((prev) => (next.title || !prev ? next : { ...next, title: prev.title }));
    setSelected((cur) => (cur && next.files.some((f) => f.path === cur) ? cur : next.files[0]?.path ?? null));
  }, [root]);

  useEffect(() => {
    void reload().catch((err) => setNotice({ kind: 'error', text: tm.error.replace('{error}', errorText(err)) }));
  }, [reload, tm]);

  const loadFile = useCallback(async (path: string) => {
    setFile(null);
    try {
      const content = await window.api.getConflictFile(root, path);
      const blocks = countConflicts(content.segments);
      setFile(content);
      setChoices(Array.from({ length: blocks }, () => null));
      setDraft(null);
      setView(blocks > 0 ? 'blocks' : 'result');
    } catch (err) {
      setNotice({ kind: 'error', text: tm.error.replace('{error}', errorText(err)) });
    }
  }, [root, tm]);

  useEffect(() => {
    if (selected) void loadFile(selected);
    else setFile(null);
  }, [selected, loadFile]);

  const blocks = file ? countConflicts(file.segments) : 0;
  // Итог: правка вручную важнее выбора по блокам; выбор блока сбрасывает правку.
  const result = useMemo(() => {
    if (!file) return '';
    if (draft !== null) return draft;
    return blocks > 0 ? applyConflictChoices(file.segments, choices) : file.working ?? '';
  }, [file, draft, blocks, choices]);
  const resultHasMarkers = hasConflictMarkers(result);
  // Итог без полей frontmatter, которые есть у обеих сторон, ломает задачу или документ после коммита (TASK-203).
  const loss = useMemo(() => (file && file.state === 'content' ? frontmatterLoss(result, file.ours, file.theirs) : null), [file, result]);
  const lossText = loss ? (loss.broken ? tm.frontmatterBroken : tm.frontmatterLost.replace('{keys}', loss.lostKeys.join(', '))) : null;
  const isMarkdown = file ? file.path.toLowerCase().endsWith('.md') : false;

  const choose = (index: number, choice: ConflictChoice) => {
    setDraft(null);
    setChoices((cur) => cur.map((c, i) => (i === index ? choice : c)));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setNotice({ kind: 'error', text: tm.error.replace('{error}', errorText(err)) });
    } finally {
      setBusy(false);
    }
  };

  const resolve = (resolution: ConflictResolution) =>
    run(async () => {
      if (!file) return;
      const res = await window.api.resolveConflict(root, file.path, resolution);
      if (!res.success) throw new Error(describeMergeFailure(res.failure, tm.failures));
      setNotice({ kind: 'ok', text: tm.resolved.replace('{file}', file.path) });
      await reload();
    });

  const saveResult = async () => {
    if (lossText && !(await dialog.confirm({ message: `${lossText} ${tm.frontmatterConfirm}` }))) return;
    await resolve({ kind: 'content', content: result });
  };

  const finish = () =>
    run(async () => {
      setNotice({ kind: 'info', text: tm.finishing });
      const res = await window.api.finishMerge(root);
      if (!res.ok) throw new Error(describeMergeFailure(res.failure, tm.failures));
      const details = [
        res.memoryRebuilt ? tm.memoryRebuilt : null,
        res.index === 'fresh' ? tm.indexFresh : res.index === 'rebuilt' ? tm.indexRebuilt : res.index === 'failed' ? tm.indexFailed : null
      ].filter(Boolean);
      setNotice({ kind: res.index === 'failed' ? 'error' : 'ok', text: [tm.finished.replace('{sha}', (res.sha ?? '').slice(0, 8)), ...details].join(' · ') });
      await reload();
    });

  const abort = async () => {
    if (!(await dialog.confirm({ message: tm.abortConfirm }))) return;
    await run(async () => {
      const res = await window.api.abortMerge(root);
      if (!res.success) throw new Error(describeMergeFailure(res.failure, tm.failures));
      onClose();
    });
  };

  const askAgent = () =>
    run(async () => {
      if (!state || state.files.length === 0) return;
      const studio = useAIStudioStore.getState();
      const sessionId = studio.createSession(projectPath, tm.agentSessionTitle, { activate: false });
      const prompt = tm.agentPrompt
        .replace('{root}', root)
        .replace('{title}', state.title || 'merge')
        .replace('{branch}', state.branch)
        .replace('{files}', state.files.map((f) => `- ${f.path}`).join('\n'));
      void studio.sendMessage(projectPath, prompt, { sessionId, mode: 'agent' });
      setNotice({ kind: 'info', text: tm.agentStarted });
    });

  const kindLabel = (kind: ConflictFileKind) =>
    ({ task: tm.kindTask, decision: tm.kindDecision, doc: tm.kindDoc, memory: tm.kindMemory, other: tm.kindOther })[kind];

  const filesLeft = state?.files.length ?? 0;
  const done = state !== null && !state.inMerge;

  const renderBlocks = () => {
    if (!file) return null;
    let n = 0;
    return (
      <div className="space-y-3">
        {file.segments.map((segment, i) => {
          if (segment.kind === 'text') {
            const lines = segment.text.replace(/\r?\n$/, '').split(/\r?\n/);
            const shown = lines.length > 6 ? [...lines.slice(0, 2), '…', ...lines.slice(-2)] : lines;
            return (
              <pre key={i} className="text-[11px] text-slate-500 font-mono whitespace-pre-wrap px-3">
                {shown.join('\n')}
              </pre>
            );
          }
          const index = n++;
          const choice = choices[index];
          return (
            <div key={i} data-testid="conflict-block" className="rounded-lg border border-amber-700/50 bg-amber-950/10 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-amber-950/30 border-b border-amber-800/40">
                <span className="text-[11px] font-medium text-amber-200">
                  {tm.blockOf.replace('{n}', String(index + 1)).replace('{total}', String(blocks))}
                </span>
                <div className="flex gap-1">
                  {CHOICES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => choose(index, c)}
                      className={`px-2 py-0.5 rounded text-[11px] border transition ${
                        choice === c
                          ? 'bg-indigo-600 border-indigo-500 text-white'
                          : 'bg-ph-elevated border-slate-700 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {c === 'ours' ? tm.takeOurs : c === 'theirs' ? tm.takeTheirs : tm.takeBoth}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 divide-x divide-slate-800">
                {(['ours', 'theirs'] as const).map((side) => (
                  <div key={side} className={choice && choice !== 'both' && choice !== side ? 'opacity-40' : ''}>
                    <div className={`px-3 py-1 text-[10px] uppercase tracking-wide ${side === 'ours' ? 'text-emerald-400' : 'text-sky-400'}`}>
                      {(side === 'ours' ? tm.ours : tm.theirs).replace('{label}', side === 'ours' ? segment.oursLabel : segment.theirsLabel)}
                    </div>
                    <pre className="px-3 pb-2 text-[11px] text-slate-200 font-mono whitespace-pre-wrap break-words">{segment[side] || ' '}</pre>
                  </div>
                ))}
              </div>
              {segment.base !== null && (
                <details className="border-t border-slate-800 px-3 py-1">
                  <summary className="text-[10px] text-slate-500 cursor-pointer">{tm.base}</summary>
                  <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap">{segment.base}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderFile = () => {
    if (done) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center p-8">
          <CheckCircle className="w-10 h-10 text-emerald-400" />
          <p className="text-sm font-medium text-slate-200">{tm.doneTitle}</p>
        </div>
      );
    }
    if (!selected) {
      return <div className="flex-1 flex items-center justify-center text-xs text-slate-500">{filesLeft === 0 ? tm.noneLeft : tm.selectFile}</div>;
    }
    if (!file) {
      return (
        <div className="flex-1 flex items-center justify-center gap-2 text-xs text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin" /> {tm.loading}
        </div>
      );
    }
    if (file.state !== 'content') {
      const remaining = file.state === 'ours-deleted' ? file.theirs : file.ours;
      return (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-3 text-xs text-amber-200 bg-amber-950/30 border-b border-amber-800/40">
            {file.state === 'ours-deleted' ? tm.oursDeletedDesc : tm.theirsDeletedDesc}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {isMarkdown ? <MarkdownViewer content={remaining ?? ''} /> : <pre className="text-[11px] font-mono text-slate-200 whitespace-pre-wrap">{remaining}</pre>}
          </div>
          <div className="px-4 py-2.5 border-t border-slate-800 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => resolve({ kind: file.state === 'ours-deleted' ? 'theirs' : 'ours' })}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white disabled:opacity-50"
            >
              {tm.keepFile}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => resolve({ kind: file.state === 'ours-deleted' ? 'ours' : 'theirs' })}
              className="px-3 py-1.5 rounded-lg border border-rose-700/60 text-rose-300 hover:bg-rose-950/40 text-xs disabled:opacity-50"
            >
              {tm.deleteFile}
            </button>
          </div>
        </div>
      );
    }
    const tabs: View[] = blocks > 0 ? ['blocks', 'result', 'preview'] : ['result', 'preview'];
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-1">
          {tabs.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded text-xs transition ${view === v ? 'bg-ph-raised text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {v === 'blocks' ? tm.blocksTab : v === 'result' ? tm.resultTab : tm.previewTab}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-slate-500 font-mono truncate" title={file.path}>{file.path}</span>
        </div>
        {blocks === 0 && <div className="px-4 py-2 text-xs text-sky-200 bg-sky-950/30 border-b border-sky-800/40">{tm.noMarkers}</div>}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {view === 'blocks' && renderBlocks()}
          {view === 'result' && (
            <textarea
              value={result}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="w-full h-full min-h-[300px] bg-ph-panel border border-slate-800 rounded-lg p-3 text-[12px] font-mono text-slate-200 focus:outline-none focus:border-indigo-600"
            />
          )}
          {view === 'preview' &&
            (isMarkdown ? <MarkdownViewer content={result} /> : <pre className="text-[11px] font-mono text-slate-200 whitespace-pre-wrap">{result}</pre>)}
        </div>
        <div className="px-4 py-2.5 border-t border-slate-800 flex items-center gap-2">
          {resultHasMarkers ? (
            <span className="text-[11px] text-amber-300 flex items-center gap-1.5 mr-auto">
              <AlertTriangle className="w-3.5 h-3.5" /> {tm.markersLeft}
            </span>
          ) : (
            lossText && (
              <span data-testid="frontmatter-loss" className="text-[11px] text-amber-300 flex items-center gap-1.5 mr-auto min-w-0">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {lossText}
              </span>
            )
          )}
          <div className="ml-auto flex gap-2 shrink-0">
            {file.ours !== null && (
              <button type="button" disabled={busy} onClick={() => resolve({ kind: 'ours' })} className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap">
                {tm.wholeOurs}
              </button>
            )}
            {file.theirs !== null && (
              <button type="button" disabled={busy} onClick={() => resolve({ kind: 'theirs' })} className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap">
                {tm.wholeTheirs}
              </button>
            )}
            <button
              type="button"
              disabled={busy || resultHasMarkers}
              onClick={() => void saveResult()}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white disabled:opacity-50 whitespace-nowrap"
            >
              {blocks === 0 ? tm.acceptAsIs : tm.saveResolution}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-ph-elevated border border-slate-700 rounded-xl w-full max-w-6xl h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-1.5 rounded-lg bg-ph-raised text-amber-400">
              <GitMerge className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-white">{tm.title}</h3>
              {state && (
                <p className="text-xs text-slate-400 truncate">{tm.subtitle.replace('{title}', state.title || '—').replace('{branch}', state.branch)}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => void reload().then(() => (selected ? loadFile(selected) : undefined))} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" title={t.common.refresh}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-72 shrink-0 border-r border-slate-800 flex flex-col min-h-0">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500">
              {tm.filesHeading} ({filesLeft})
            </div>
            <div className="flex-1 overflow-y-auto px-2 space-y-1">
              {state?.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setSelected(f.path)}
                  className={`w-full text-left px-2 py-1.5 rounded-lg border transition ${
                    selected === f.path ? 'bg-ph-raised border-indigo-600/60' : 'border-transparent hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-xs text-slate-200 truncate" title={f.path}>{f.path.split('/').pop()}</span>
                  </div>
                  <div className="mt-0.5 flex gap-1.5 text-[10px] text-slate-500">
                    <span>{kindLabel(f.kind)}</span>
                    {f.state !== 'content' && <span className="text-rose-400">{f.state === 'ours-deleted' ? tm.stateOursDeleted : tm.stateTheirsDeleted}</span>}
                  </div>
                </button>
              ))}
              {state && filesLeft === 0 && !done && (
                <div className="px-2 py-3 text-xs text-emerald-300 flex items-start gap-1.5">
                  <CheckCircle className="w-4 h-4 shrink-0" /> {tm.noneLeft}
                </div>
              )}
            </div>
            {state && (state.generated.length > 0 || filesLeft > 0) && (
              <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-800">{tm.generatedNote}</div>
            )}
          </div>
          {renderFile()}
        </div>

        {notice && (
          <div
            className={`px-6 py-2 text-xs border-t shrink-0 ${
              notice.kind === 'error'
                ? 'bg-rose-950/60 border-rose-800/60 text-rose-300'
                : notice.kind === 'ok'
                  ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                  : 'bg-sky-950/50 border-sky-800/60 text-sky-200'
            }`}
          >
            {notice.text}
          </div>
        )}

        {done ? (
          <div className="px-6 py-3.5 border-t border-slate-800 flex justify-end shrink-0">
            <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-lg bg-ph-raised hover:bg-slate-700 text-xs text-white">
              {t.common.close}
            </button>
          </div>
        ) : (
        <div className="px-6 py-3.5 border-t border-slate-800 flex items-center justify-between shrink-0">
          <button
            type="button"
            disabled={busy || done}
            onClick={() => void abort()}
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 flex items-center gap-1.5 disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" /> {tm.abort}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || filesLeft === 0}
              onClick={() => void askAgent()}
              className="px-3 py-1.5 rounded-lg border border-indigo-600/60 text-xs text-indigo-200 hover:bg-indigo-950/40 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" /> {tm.askAgent}
            </button>
            <button
              type="button"
              disabled={busy || filesLeft > 0 || done}
              onClick={() => void finish()}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />} {tm.finish}
            </button>
          </div>
        </div>
        )}
      </div>
    </div>,
    document.body
  );
};
