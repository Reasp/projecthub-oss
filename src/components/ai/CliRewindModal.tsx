import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { studioCliText } from '../../i18n/studioCliText';
import { appErrorText } from '../../lib/appErrorText';
import { matchRewindPoints } from '../../lib/studioRewind';
import { tabCliQuery, useAIStudioStore } from '../../store/useAIStudioStore';
import { useProjectStore } from '../../store/useProjectStore';
import type { CliRewindFile, CliRewindPoint } from '../../types/electron';

/**
 * `/rewind` во вкладке Claude Code (TASK-284, decision-205): выбор реплики и что откатить — разговор, код или оба, как
 * в терминальном CLI. Код откатывается только по явной кнопке, со списком файлов, которые изменятся. Портал в
 * `document.body`, `z-[9999]` (правило 19).
 */
export function CliRewindModal() {
  const { t, language } = useTranslation();
  const c = studioCliText(language);
  const request = useAIStudioStore((s) => s.rewindRequest);
  const close = useAIStudioStore((s) => s.closeRewind);
  const projectSessions = useAIStudioStore((s) => (request ? s.sessions[request.projectPath] : undefined));
  const streaming = useAIStudioStore((s) => (request ? !!s.streamingSessions[request.sessionId] : false));
  const rewindConversation = useAIStudioStore((s) => s.rewindConversation);
  const rewindFiles = useAIStudioStore((s) => s.rewindFiles);
  const selectedPath = useProjectStore((s) => s.selectedProject?.path);
  const session = request ? projectSessions?.find((s) => s.id === request.sessionId) : undefined;
  const tabQuery = request && session ? tabCliQuery(request.projectPath, session) : null;
  // Запрос из примитивов: окно перечитывает точки при смене разговора вкладки, а не на каждое обновление стора.
  const [qProject, qCwd, qSession, qAccount] = [tabQuery?.projectPath, tabQuery?.cwd, tabQuery?.cliSessionId, tabQuery?.claudeAccountId];
  const query = useMemo(
    () => (qProject && qCwd && qSession ? { projectPath: qProject, cwd: qCwd, cliSessionId: qSession, ...(qAccount ? { claudeAccountId: qAccount } : {}) } : null),
    [qProject, qCwd, qSession, qAccount]
  );
  // Откаченная, но ещё не продолженная вкладка: дальше точки отката разговора уже нет.
  const pendingResumeAt = session?.claudeCliForkPending ? session.claudeCliResumeAt : undefined;

  const [points, setPoints] = useState<CliRewindPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<CliRewindFile[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    setPoints(null);
    setError(null);
    setFiles(null);
    window.api
      .cliRewindPoints(query)
      .then((list) => {
        if (!alive) return;
        const cut = pendingResumeAt ? list.findIndex((p) => p.keepUuid === pendingResumeAt) : -1;
        setPoints(cut >= 0 ? list.slice(0, cut) : list);
      })
      .catch((err) => alive && setError(appErrorText(err, t.appErrors)));
    return () => {
      alive = false;
    };
  }, [query, pendingResumeAt, t.appErrors]);

  const matches = useMemo(() => (points && session ? matchRewindPoints(session.messages, points) : new Map<string, string>()), [points, session]);

  // Выбор по умолчанию: реплика, с которой открыли окно, иначе последняя.
  useEffect(() => {
    if (!points) return;
    const fromMessage = request?.messageId ? points.find((p) => matches.get(p.uuid) === request.messageId) : undefined;
    setSelected((fromMessage ?? points[points.length - 1])?.uuid ?? null);
  }, [points, matches, request?.messageId]);

  useEffect(() => {
    if (!query || !selected) return;
    let alive = true;
    setFiles(null);
    window.api
      .cliRewindPreview({ ...query, promptUuid: selected })
      .then((list) => alive && setFiles(list))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [selected, query]);

  useEffect(() => {
    if (!request || request.projectPath !== selectedPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, close, selectedPath, busy]);

  // Окно принадлежит вкладке своего проекта: в Studio другого проекта оно не висит поверх.
  if (!request || request.projectPath !== selectedPath) return null;

  const point = points?.find((p) => p.uuid === selected);
  const run = async (what: 'conversation' | 'both' | 'code') => {
    if (!point || busy) return;
    setBusy(true);
    try {
      const fileCount = files?.length ?? 0;
      const filesOk = what === 'conversation' ? true : await rewindFiles(request.projectPath, request.sessionId, point, fileCount);
      if (filesOk && what !== 'code') {
        await rewindConversation(request.projectPath, request.sessionId, point, matches.get(point.uuid), what === 'both' ? fileCount : undefined);
      }
    } finally {
      setBusy(false);
      close();
    }
  };
  const hasFiles = !!files && files.length > 0;
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="studio-rewind-modal">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <RotateCcw className="w-4 h-4" />
            {c.rewindTitle}
          </h2>
          <button type="button" onClick={close} disabled={busy} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary" aria-label={c.close}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3 text-sm">
          {!query ? (
            <p className="text-xs text-muted-foreground">{c.rewindNoSession}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{c.rewindHint}</p>
              {error && <p className="text-xs text-destructive">{error}</p>}
              {!points && !error && <p className="text-xs text-muted-foreground">{c.loading}</p>}
              {points?.length === 0 && <p className="text-xs text-muted-foreground">{c.rewindEmpty}</p>}
              <ul className="divide-y divide-ph-line" role="radiogroup">
                {points?.map((p, i) => (
                  <li key={p.uuid}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={p.uuid === selected}
                      onClick={() => setSelected(p.uuid)}
                      className={`w-full text-left px-2 py-2 rounded ${p.uuid === selected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-secondary/50'}`}
                      data-testid={`studio-rewind-point-${i + 1}`}
                    >
                      <div className="text-sm line-clamp-2 whitespace-pre-wrap">{p.text}</div>
                      {p.timestamp && <div className="text-[11px] text-muted-foreground">{new Date(p.timestamp).toLocaleString(locale)}</div>}
                    </button>
                  </li>
                ))}
              </ul>
              {point && (
                <div className="rounded-md border border-border p-3 space-y-2" data-testid="studio-rewind-files">
                  {!files ? (
                    <p className="text-xs text-muted-foreground">{c.rewindFilesLoading}</p>
                  ) : !hasFiles ? (
                    <p className="text-xs text-muted-foreground">{c.rewindNoFiles}</p>
                  ) : (
                    <>
                      <p className="text-xs font-medium">{c.rewindFilesTitle(files.length)}</p>
                      <ul className="text-xs font-mono space-y-0.5 max-h-40 overflow-y-auto">
                        {files.map((f) => (
                          <li key={f.path} className="flex gap-2">
                            <span className="truncate" title={f.path}>{f.path}</span>
                            <span className="text-muted-foreground shrink-0 font-sans">— {c.rewindChange[f.change]}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-amber-300">{c.rewindFilesWarning}</p>
                    </>
                  )}
                </div>
              )}
              {streaming && <p className="text-xs text-amber-300">{c.rewindStreaming}</p>}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button type="button" onClick={close} disabled={busy} className="ph-btn ph-btn-ghost h-8 px-3">
            {c.cancel}
          </button>
          <button
            type="button"
            onClick={() => void run('code')}
            disabled={!point || !hasFiles || streaming || busy}
            className="ph-btn ph-btn-ghost h-8 px-3"
            data-testid="studio-rewind-code"
          >
            {c.rewindCodeOnly}
          </button>
          <button
            type="button"
            onClick={() => void run('both')}
            disabled={!point || !hasFiles || streaming || busy}
            className="ph-btn ph-btn-ghost h-8 px-3"
            data-testid="studio-rewind-both"
          >
            {c.rewindBoth}
          </button>
          <button
            type="button"
            onClick={() => void run('conversation')}
            disabled={!point || streaming || busy}
            className="ph-btn ph-btn-primary h-8 px-3"
            data-testid="studio-rewind-conversation"
          >
            {c.rewindConversation}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
