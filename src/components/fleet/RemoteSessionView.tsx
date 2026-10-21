import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, MessageSquare, Monitor, Send, Square, Terminal, X } from '../common/icons';
import { useFleetStore } from '../../store/useFleetStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { RemoteAgentOutput, RemoteStudioSession } from '../../types/remote';
import type { OverviewSession } from '../../utils/fleetOverview';

/**
 * Удалённая сессия в основной области (TASK-174, decision-129 п. 10): чат Agents Studio с потоком ответа и отправкой
 * промпта, хвост вывода агента роя или сводка терминала. Всё идёт RPC и событиями hub-соединения с того хоста.
 */

const POLL_MS = 2000;

function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const RemoteSessionView: React.FC = () => {
  const { t } = useTranslation();
  const open = useFleetStore((s) => s.remoteSession);
  const remote = useFleetStore((s) => (open ? s.remote[open.hostId] : undefined));
  const close = useFleetStore((s) => s.closeRemoteSession);
  const [studio, setStudio] = useState<RemoteStudioSession | null>(null);
  const [output, setOutput] = useState<RemoteAgentOutput | null>(null);
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Строка сессии из свежего снимка: состояние и запросы обновляются вместе с деревом.
  const session: OverviewSession | undefined = open
    ? (remote?.overview?.projects.find((p) => p.path === open.projectPath)?.sessions.find((s) => s.kind === open.session.kind && s.id === open.session.id) ?? open.session)
    : undefined;
  // Действия в проекте могут быть уже, чем на хосте (права устройства по проектам, TASK-180).
  const actions = remote?.overview?.projects.find((p) => p.path === open?.projectPath)?.actions ?? remote?.overview?.actions ?? 'none';
  const hostId = open?.hostId;
  const projectPath = open?.projectPath;
  const kind = open?.session.kind;
  const sessionId = open?.session.id;
  const agentId = session?.agentId;
  const active = session?.state === 'running' || session?.state === 'waiting';

  const loadStudio = useCallback(async () => {
    if (!hostId || !projectPath || !sessionId) return;
    try {
      setStudio(await window.api.federationCall<RemoteStudioSession>(hostId, 'studio_get_session', { projectPath, sessionId }));
      setLive('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hostId, projectPath, sessionId]);

  const loadOutput = useCallback(async () => {
    if (!hostId || !sessionId || !agentId) return;
    try {
      setOutput(await window.api.federationCall<RemoteAgentOutput>(hostId, 'get_agent_output', { swarmId: sessionId, agentId }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hostId, sessionId, agentId]);

  useEffect(() => {
    setStudio(null);
    setOutput(null);
    setLive('');
    setError(null);
    if (kind === 'studio') void loadStudio();
    if (kind === 'swarm') void loadOutput();
  }, [kind, loadStudio, loadOutput]);

  // Поток ответа Studio с того хоста: чанки текста, по завершении — сессия целиком.
  useEffect(() => {
    if (kind !== 'studio' || !hostId) return;
    return window.api.onFederationEvent((payload) => {
      if (payload.hostId !== hostId) return;
      const data = (payload.data || {}) as { sessionId?: string; text?: string };
      if (data.sessionId !== sessionId) return;
      if (payload.event === 'studio:chunk' && data.text) setLive((prev) => (prev + data.text).slice(-20_000));
      if (payload.event === 'studio:complete' || payload.event === 'studio:error') void loadStudio();
    });
  }, [kind, hostId, sessionId, loadStudio]);

  // Вывод агента роя — хвост, пока агент работает.
  useEffect(() => {
    if (kind !== 'swarm' || !active) return;
    const timer = setInterval(() => void loadOutput(), POLL_MS);
    return () => clearInterval(timer);
  }, [kind, active, loadOutput]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [studio, live, output]);

  if (!open || !session) return null;

  const send = async () => {
    const text = prompt.trim();
    if (!text || !hostId) return;
    setSending(true);
    try {
      await window.api.federationCall(hostId, 'studio_send', { projectPath, sessionId, prompt: text });
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!hostId) return;
    try {
      if (kind === 'studio') await window.api.federationCall(hostId, 'studio_abort', { projectPath, sessionId });
      else await window.api.federationCall(hostId, 'stop_swarm', { swarmId: sessionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const Icon = kind === 'studio' ? MessageSquare : kind === 'terminal' ? Terminal : Bot;
  const canWrite = actions === 'full';

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-ph-panel" data-testid="fleet-remote-session">
      <div className="h-10 px-3 flex items-center gap-2 border-b border-ph-line shrink-0">
        <Monitor className="w-4 h-4 text-slate-400 shrink-0" />
        <span className="text-xs text-slate-400 truncate">
          {open.machineName} · {open.projectName}
        </span>
        <Icon className="w-4 h-4 text-indigo-300 shrink-0" />
        <span className="text-sm text-slate-100 truncate flex-1">{session.title}</span>
        <span className="text-[11px] text-slate-400">{t.fleet.states[session.state]}</span>
        {canWrite && active && kind !== 'terminal' && (
          <button type="button" onClick={() => void stop()} className="h-6 px-2 rounded bg-ph-raised hover:bg-ph-hover text-xs text-slate-200 flex items-center gap-1">
            <Square className="w-3 h-3" /> {t.fleet.session.stop}
          </button>
        )}
        <button type="button" onClick={close} className="ph-icon-button" title={t.fleet.session.close} aria-label={t.fleet.session.close}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
        {error && <div className="text-rose-300 text-xs">{fmt(t.fleet.session.loadError, { error })}</div>}
        {session.state === 'waiting' && session.detail && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">{session.detail}</div>
        )}

        {kind === 'studio' && (
          <>
            {!studio && !error && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
            {studio && studio.olderOmitted > 0 && <div className="text-[11px] text-slate-500">{fmt(t.fleet.session.olderOmitted, { n: studio.olderOmitted })}</div>}
            {studio && studio.messages.length === 0 && !live && <div className="text-slate-500 text-xs">{t.fleet.session.noMessages}</div>}
            {studio?.messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'ml-12 rounded-lg bg-indigo-600/20 px-3 py-2' : m.role === 'error' ? 'text-rose-300' : 'text-slate-200'}>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {m.tools?.map((tool) => (
                  <div key={tool.id} className="mt-1 text-[11px] text-slate-500 truncate font-mono">
                    {tool.name}
                    {tool.summary ? `: ${tool.summary}` : ''}
                  </div>
                ))}
              </div>
            ))}
            {live && (
              <div className="text-slate-200">
                <div className="text-[11px] text-emerald-300 mb-1">{t.fleet.session.live}</div>
                <div className="whitespace-pre-wrap break-words">{live}</div>
              </div>
            )}
          </>
        )}

        {kind === 'swarm' && (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-300">{output?.text || (output ? t.fleet.session.noOutput : '')}</pre>
        )}

        {kind === 'terminal' && (
          <div className="space-y-2 text-xs text-slate-400">
            <p>{t.fleet.session.terminalNote}</p>
            {session.detail && <p className="font-mono text-slate-300">{session.detail}</p>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {kind === 'studio' && (
        <div className="border-t border-ph-line p-2 flex items-end gap-2 shrink-0">
          {canWrite ? (
            <>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={fmt(t.fleet.session.placeholder, { host: open.machineName })}
                className="flex-1 resize-none bg-ph-raised rounded-md px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || !prompt.trim()}
                className="h-8 px-3 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs text-white flex items-center gap-1"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} {t.fleet.session.send}
              </button>
            </>
          ) : (
            <span className="text-[11px] text-slate-500">{t.fleet.session.readOnly}</span>
          )}
        </div>
      )}
    </div>
  );
};
