import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Brain, Check, FileText, FolderOpen, Loader2, RefreshCw, Save, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { studioCliText } from '../../i18n/studioCliText';
import { useDialog } from '../../hooks/useDialog';
import { memoryModifiedLabel, memoryPathLabel, sameMemoryPath } from '../../lib/studioMemory';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useProjectStore } from '../../store/useProjectStore';
import type { CliMemoryDialog } from '../../types/electron';

type Loaded = { status: 'loading' } | { status: 'error'; reason: 'start' | 'timeout' | 'cli' } | { status: 'ok'; dialog: CliMemoryDialog };
type OpenFile = { path: string; exists: boolean; content: string; original: string } | { path: string; error: 'denied' | 'tooLarge' | 'io' };

/**
 * `/memory` во вкладке Claude Code (TASK-286, decision-207): строки терминального диалога CLI — файлы инструкций, папки и
 * записи автопамяти этой вкладки — и встроенный редактор выбранного файла. Список даёт сам CLI (`get_memory_dialog`),
 * поэтому он учитывает аккаунт вкладки, её каталог и `/add-dir`. Портал в `document.body`, `z-[9999]` (правило 19).
 */
export function CliMemoryModal() {
  const { language } = useTranslation();
  const c = studioCliText(language);
  const dialogApi = useDialog();
  const command = useAIStudioStore((s) => s.cliCommand);
  const clear = useAIStudioStore((s) => s.clearCliCommand);
  const selectedPath = useProjectStore((s) => s.selectedProject?.path);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [file, setFile] = useState<OpenFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'failed' | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const memory = command?.kind === 'memory' ? command : null;
  const scope = memory
    ? {
        projectPath: memory.projectPath,
        cwd: memory.workspaceRoot,
        ...(memory.claudeAccountId ? { claudeAccountId: memory.claudeAccountId } : {})
      }
    : null;
  const scopeKey = scope ? `${scope.projectPath}\n${scope.cwd}\n${scope.claudeAccountId ?? ''}` : '';

  useEffect(() => {
    if (!memory) return;
    let alive = true;
    setLoaded({ status: 'loading' });
    window.api
      .cliMemoryDialog({ projectPath: memory.projectPath, cwd: memory.workspaceRoot, ...(memory.claudeAccountId ? { claudeAccountId: memory.claudeAccountId } : {}), ...(memory.addDirs?.length ? { addDirs: memory.addDirs } : {}) })
      .then((result) => alive && setLoaded(result.ok ? { status: 'ok', dialog: result.dialog } : { status: 'error', reason: result.reason }))
      .catch(() => alive && setLoaded({ status: 'error', reason: 'start' }));
    return () => {
      alive = false;
    };
    // Список перечитывается при новом `/memory` и по «Обновить»; объект команды меняется только с командой.
  }, [memory, reloadKey]);

  useEffect(() => {
    if (!memory) {
      setFile(null);
      setSaveState(null);
    }
  }, [memory]);

  const dirty = !!file && 'content' in file && file.content !== file.original;

  const confirmDiscard = useCallback(async () => (dirty ? dialogApi.confirm(c.memoryUnsaved) : true), [dirty, dialogApi, c.memoryUnsaved]);

  const close = useCallback(async () => {
    if (await confirmDiscard()) clear();
  }, [confirmDiscard, clear]);

  useEffect(() => {
    if (!memory || memory.projectPath !== selectedPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [memory, selectedPath, close]);

  const openFile = async (path: string) => {
    if (!scope || (file && sameMemoryPath(file.path, path))) return;
    if (!(await confirmDiscard())) return;
    setSaveState(null);
    const result = await window.api.readCliMemoryFile({ ...scope, file: path }).catch(() => ({ ok: false as const, reason: 'io' as const }));
    setFile(result.ok ? { path, exists: result.exists, content: result.content, original: result.content } : { path, error: result.reason });
  };

  const save = async () => {
    if (!scope || !file || !('content' in file) || saving) return;
    setSaving(true);
    const result = await window.api.saveCliMemoryFile({ ...scope, file: file.path, content: file.content }).catch(() => ({ ok: false }));
    setSaving(false);
    setSaveState(result.ok ? 'saved' : 'failed');
    if (result.ok) {
      setFile({ ...file, exists: true, original: file.content });
      // Новый CLAUDE.md меняет строку списка «не создан» — перечитать список у CLI.
      if (!file.exists) setReloadKey((k) => k + 1);
    }
  };

  // Окно принадлежит вкладке своего проекта: в Studio другого проекта оно не висит поверх.
  if (!memory || !scope || memory.projectPath !== selectedPath) return null;

  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  const now = Date.now();
  const rowClass = (path: string) =>
    `w-full text-left px-2 py-1.5 rounded ${file && sameMemoryPath(file.path, path) ? 'bg-primary/15 text-foreground' : 'hover:bg-secondary/50'}`;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="studio-memory-modal" data-scope={scopeKey}>
      <div className="w-full max-w-5xl h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Brain className="w-4 h-4 text-indigo-300 shrink-0" />
          <h2 className="text-base font-semibold">{c.memoryTitle}</h2>
          {loaded.status === 'ok' && loaded.dialog.autoMemory && (
            <span className="text-[11px] text-muted-foreground" data-testid="studio-memory-auto">
              {c.memoryAuto(loaded.dialog.autoMemory.enabled)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
            title={c.memoryRefresh}
            aria-label={c.memoryRefresh}
            data-testid="studio-memory-refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void close()}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label={c.close}
            data-testid="studio-memory-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 flex min-h-0">
          <div className="w-80 shrink-0 border-r border-border overflow-y-auto p-3 space-y-3 text-sm" data-testid="studio-memory-list">
            <p className="text-[11px] text-muted-foreground">{c.memoryHint}</p>
            {loaded.status === 'loading' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {c.memoryLoading}
              </p>
            )}
            {loaded.status === 'error' && (
              <p className="text-xs text-destructive" data-testid="studio-memory-error">
                {c.memoryFailed(loaded.reason)}
              </p>
            )}
            {loaded.status === 'ok' && (
              <>
                <section>
                  <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.memoryFiles}</h3>
                  <ul>
                    {loaded.dialog.files.map((f) => (
                      <li key={f.path}>
                        <button type="button" onClick={() => void openFile(f.path)} className={rowClass(f.path)} title={f.path} data-testid="studio-memory-file" data-kind={f.kind} data-path={f.path}>
                          <div className="flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                            <span className="truncate">{c.memoryFileKind[f.kind] || f.label}</span>
                            {!f.exists && <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{c.memoryNotCreated}</span>}
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">{memoryPathLabel(f.path, memory.workspaceRoot)}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                {loaded.dialog.folders.length > 0 && (
                  <section>
                    <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.memorySaved}</h3>
                    {loaded.dialog.memories.length === 0 && <p className="text-xs text-muted-foreground px-2">{c.memoryNoSaved}</p>}
                    <ul>
                      {loaded.dialog.memories.map((m) => (
                        <li key={m.path}>
                          <button type="button" onClick={() => void openFile(m.path)} className={rowClass(m.path)} title={m.path} data-testid="studio-memory-entry" data-path={m.path}>
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-mono text-xs">{m.name}</span>
                              {m.type && <span className="text-[10px] px-1 rounded bg-secondary text-muted-foreground shrink-0">{c.memoryType[m.type]}</span>}
                              <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{memoryModifiedLabel(m.modifiedMs, now, locale)}</span>
                            </div>
                            {(m.name === 'MEMORY.md' || m.description) && (
                              <div className="text-[11px] text-muted-foreground line-clamp-2">{m.name === 'MEMORY.md' ? c.memoryIndex : m.description}</div>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {loaded.dialog.folders.length > 0 && (
                  <section>
                    <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.memoryFolders}</h3>
                    <ul>
                      {loaded.dialog.folders.map((f) => (
                        <li key={f.path}>
                          <button
                            type="button"
                            onClick={() => void window.api.openCliMemoryFolder({ ...scope, dir: f.path })}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-secondary/50"
                            title={`${c.memoryOpenFolder}: ${f.path}`}
                            data-testid="studio-memory-folder"
                            data-kind={f.kind}
                          >
                            <div className="flex items-center gap-1.5">
                              <FolderOpen className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                              <span className="truncate">{c.memoryFolderKind[f.kind] || f.label}</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground font-mono truncate">{f.path}</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            {!file ? (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-6 text-center">{c.memorySelect}</div>
            ) : 'error' in file ? (
              <div className="flex-1 flex items-center justify-center gap-2 text-xs text-destructive p-6" data-testid="studio-memory-read-error">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {c.memoryReadFailed(file.error)}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border text-xs">
                  <span className="font-mono truncate" title={file.path} data-testid="studio-memory-path">
                    {file.path}
                  </span>
                  {dirty && <span className="text-amber-300 shrink-0">●</span>}
                  {!file.exists && <span className="text-muted-foreground shrink-0">{c.memoryCreateHint}</span>}
                  {saveState === 'saved' && !dirty && (
                    <span className="flex items-center gap-1 text-emerald-400 shrink-0" data-testid="studio-memory-saved">
                      <Check className="w-3.5 h-3.5" />
                      {c.memorySavedOk}
                    </span>
                  )}
                  {saveState === 'failed' && <span className="text-destructive shrink-0">{c.memorySaveFailed}</span>}
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving || (!dirty && file.exists)}
                    className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    data-testid="studio-memory-save"
                  >
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    {c.memorySave}
                  </button>
                </div>
                <div className="flex-1 flex min-h-0 font-mono text-[12px] bg-ph-base">
                  <div className="w-12 py-3 text-slate-600 text-right pr-3 select-none border-r border-slate-800/80 overflow-hidden shrink-0">
                    {file.content.split('\n').map((_, idx) => (
                      <div key={idx} className="leading-5">
                        {idx + 1}
                      </div>
                    ))}
                  </div>
                  <textarea
                    value={file.content}
                    onChange={(e) => {
                      setSaveState(null);
                      setFile({ ...file, content: e.target.value });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void save();
                      }
                    }}
                    className="flex-1 p-3 bg-transparent text-slate-200 outline-none resize-none leading-5 font-mono overflow-auto whitespace-pre"
                    spellCheck={false}
                    data-testid="studio-memory-editor"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
