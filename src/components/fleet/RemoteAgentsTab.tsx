import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, History, Loader2, MessageSquare, Send, Terminal } from '../common/icons';
import { useFleetStore, type OpenRemoteProject } from '../../store/useFleetStore';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { hostLabelText } from '../../i18n/hostLabels';
import { overviewSessionDetail, type OverviewProject, type OverviewSession } from '../../utils/fleetOverview';
import { pendingSessionTitle, splitStudioSessions, studioSessionRow } from '../../utils/remoteProject';
import type { RemoteStudioOptions, RemoteStudioSessionSummary } from '../../types/remote';
import type { RemoteCall } from './RemoteProjectView';

/**
 * Вкладка «Агенты» проекта удалённого ПК (TASK-229): сессии Agents Studio хоста с историей, новая сессия с промптом,
 * рои и терминальные сессии из сводки. Чат открывается `RemoteSessionView` поверх проекта.
 */

function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** События хоста, после которых список сессий устарел. */
const STUDIO_EVENTS = new Set(['studio:started', 'studio:complete', 'studio:error']);

interface Props {
  open: OpenRemoteProject;
  project: OverviewProject | undefined;
  canWrite: boolean;
  call: RemoteCall;
  reloadTick: number;
}

export const RemoteAgentsTab: React.FC<Props> = ({ open, project, canWrite, call, reloadTick }) => {
  const { t, language } = useTranslation();
  const ta = t.fleet.project.agents;
  const openRemoteSession = useFleetStore((s) => s.openRemoteSession);
  const [sessions, setSessions] = useState<RemoteStudioSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { hostId } = open;

  const load = useCallback(async () => {
    try {
      const list = await call<RemoteStudioSessionSummary[]>('studio_list_sessions');
      setSessions(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setError(ipcErrorText(err));
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  // Модель новой сессии — текущий выбор Agents Studio на том ПК.
  useEffect(() => {
    call<RemoteStudioOptions>('studio_get_options')
      .then((opts) => setModelLabel(opts?.currentLabel || ''))
      .catch(() => setModelLabel(''));
  }, [call]);

  useEffect(() => {
    const off = window.api.onFederationEvent((payload) => {
      if (payload.hostId !== hostId || !STUDIO_EVENTS.has(payload.event)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 400);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hostId, load]);

  const openSession = (session: OverviewSession) =>
    openRemoteSession({ hostId, machineName: open.machineName, projectPath: open.projectPath, projectName: open.projectName, session });

  const start = async () => {
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const res = await call<{ sessionId: string }>('studio_send', { prompt: text });
      setPrompt('');
      void load();
      openSession({ kind: 'studio', id: res.sessionId, title: pendingSessionTitle(text), state: 'running', updatedAt: Date.now() });
    } catch (err) {
      setError(ipcErrorText(err));
    } finally {
      setSending(false);
    }
  };

  const { open: openTabs, history } = splitStudioSessions(sessions ?? []);
  const others = (project?.sessions ?? []).filter((s) => s.kind !== 'studio');

  const renderStudio = (s: RemoteStudioSessionSummary) => (
    <button
      key={s.id}
      type="button"
      onClick={() => openSession(studioSessionRow(s))}
      className="w-full text-left px-3 py-2 rounded-md hover:bg-ph-hover"
      data-testid={`remote-studio-${s.id}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${s.running ? 'text-emerald-300' : 'text-slate-500'}`} />
        <span className="truncate text-sm text-slate-100 flex-1">{s.title}</span>
        {s.running && <span className="shrink-0 text-[10px] text-emerald-300">{ta.answering}</span>}
        <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">{fmt(ta.messages, { n: s.messageCount })}</span>
      </div>
      <div className="pl-[22px] flex items-center gap-2 text-[11px] text-slate-500 min-w-0">
        {s.modelLabel && <span className="shrink-0">{s.modelLabel}</span>}
        {/* Хост помечает `phone` любую сессию с удалённого устройства, в том числе с другого ПК. */}
        {s.origin === 'phone' && s.originDevice && <span className="shrink-0">{fmt(ta.fromDevice, { device: s.originDevice })}</span>}
        {s.preview && <span className="truncate">{s.preview}</span>}
        <span className="ml-auto shrink-0">{new Date(s.updatedAt).toLocaleString(language === 'en' ? 'en' : 'ru')}</span>
      </div>
    </button>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {canWrite && (
          <div className="rounded-md border border-ph-line bg-ph-raised/40 p-2 space-y-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void start();
                }
              }}
              rows={3}
              placeholder={fmt(ta.newPlaceholder, { host: open.machineName })}
              className="w-full resize-y bg-ph-panel rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
              data-testid="remote-studio-prompt"
            />
            <div className="flex items-center gap-2">
              {modelLabel && <span className="text-[11px] text-slate-500 truncate">{fmt(ta.model, { model: modelLabel })}</span>}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void start()}
                disabled={sending || !prompt.trim()}
                className="h-7 px-3 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs text-white flex items-center gap-1"
                data-testid="remote-studio-start"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} {ta.newSession}
              </button>
            </div>
          </div>
        )}

        {error && <div className="text-xs text-rose-300">{fmt(t.fleet.project.loadError, { error })}</div>}

        <section>
          <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{ta.studio}</div>
          {!sessions && !error && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
          {sessions && openTabs.length === 0 && history.length === 0 && <div className="text-xs text-slate-500">{ta.empty}</div>}
          {openTabs.map(renderStudio)}
          {history.length > 0 && (
            <>
              <button type="button" onClick={() => setShowHistory((v) => !v)} className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
                {showHistory ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <History className="w-3 h-3" /> {ta.history} · {history.length}
              </button>
              {showHistory && history.map(renderStudio)}
            </>
          )}
        </section>

        {others.length > 0 && (
          <section>
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{ta.others}</div>
            {others.map((s) => {
              const Icon = s.kind === 'terminal' ? Terminal : Bot;
              const detail = overviewSessionDetail(s, t.hitl.requestText, t.appErrors);
              return (
                <button
                  key={`${s.kind}:${s.id}`}
                  type="button"
                  onClick={() => openSession(s)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-ph-hover"
                  data-testid={`remote-session-${s.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                    <span className="truncate text-sm text-slate-100 flex-1">{hostLabelText(s.title, language)}</span>
                    <span className="shrink-0 text-[10px] text-slate-400">{t.fleet.states[s.state]}</span>
                  </div>
                  {detail && <div className="pl-[22px] truncate text-[11px] text-slate-500">{detail}</div>}
                </button>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
};
