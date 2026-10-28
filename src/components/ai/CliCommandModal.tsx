import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalSquare, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { studioCliText } from '../../i18n/studioCliText';
import { appErrorText } from '../../lib/appErrorText';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useProjectStore } from '../../store/useProjectStore';
import type { CliSessionSummary } from '../../types/electron';

/**
 * Слеш-команды Claude Code, которые Agents Studio выполняет сама (TASK-230): `/resume` — выбор сессии CLI этой папки,
 * интерактивные команды (`/remote-control` и др.) — продолжение разговора в терминале ProjectHub. Портал в
 * `document.body`, `z-[9999]` (правило 19).
 */
export function CliCommandModal() {
  const { t, language } = useTranslation();
  const c = studioCliText(language);
  const command = useAIStudioStore((s) => s.cliCommand);
  const clear = useAIStudioStore((s) => s.clearCliCommand);
  const attach = useAIStudioStore((s) => s.attachCliSession);
  const createPty = useProjectStore((s) => s.createPtySessionAction);
  const [sessions, setSessions] = useState<CliSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (command?.kind !== 'resume') return;
    let alive = true;
    setSessions(null);
    setError(null);
    window.api
      .listCliSessions({ projectPath: command.projectPath, cwd: command.workspaceRoot, ...(command.claudeAccountId ? { claudeAccountId: command.claudeAccountId } : {}) })
      .then((list) => alive && setSessions(list))
      .catch((err) => alive && setError(appErrorText(err, t.appErrors)));
    return () => {
      alive = false;
    };
  }, [command, t.appErrors]);

  useEffect(() => {
    if (!command) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [command, clear]);

  if (!command) return null;

  const openTerminal = async () => {
    await createPty(command.projectPath, 'claude', undefined, command.workspaceRoot, undefined, {
      ...(command.cliSessionId ? { resumeSessionId: command.cliSessionId } : {}),
      ...(command.claudeAccountId ? { claudeAccountId: command.claudeAccountId } : {})
    });
    clear();
  };

  const title = command.kind === 'resume' ? c.resumeTitle : c.terminalTitle(command.command);
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="studio-cli-modal">
      <div className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={clear} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary" aria-label={c.close}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3 text-sm">
          {command.kind === 'resume' ? (
            <>
              <p className="text-xs text-muted-foreground">{c.resumeHint}</p>
              {error && <p className="text-xs text-destructive">{error}</p>}
              {!sessions && !error && <p className="text-xs text-muted-foreground">{c.loading}</p>}
              {sessions?.length === 0 && <p className="text-xs text-muted-foreground">{c.empty}</p>}
              <ul className="divide-y divide-ph-line">
                {sessions?.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => attach(command.projectPath, command.sessionId, s.id)}
                      className="w-full text-left px-2 py-2 rounded hover:bg-secondary/50"
                      data-testid={`studio-cli-session-${s.id}`}
                    >
                      <div className="text-sm truncate">{s.title || c.untitled}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US')} · <span className="font-mono">{s.id.slice(0, 8)}</span>
                        {s.id === command.cliSessionId && <span className="ml-2 text-emerald-400">{c.current}</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {sessions && sessions.length > 0 && <p className="text-[11px] text-muted-foreground">{c.attached}</p>}
            </>
          ) : (
            <>
              <p>{c.terminalHint(command.command)}</p>
              {!command.cliSessionId && <p className="text-xs text-muted-foreground">{c.noSession}</p>}
              {command.command === 'remote-control' && <p className="text-xs text-muted-foreground">{c.remoteHint}</p>}
              <button
                type="button"
                onClick={() => void openTerminal()}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
                data-testid="studio-cli-terminal"
              >
                <TerminalSquare className="w-4 h-4" />
                {c.openTerminal}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
