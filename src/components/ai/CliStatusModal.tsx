import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Info, Loader2, RefreshCw, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { studioCliText } from '../../i18n/studioCliText';
import { sessionRequestConfig } from '../../lib/studioSessionAgent';
import { sessionMode } from '../../lib/studioSessionMode';
import { goesToClaudeCli } from '../../lib/studioCliCommands';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';
import { useProjectStore } from '../../store/useProjectStore';
import type { CliStatus } from '../../types/electron';

type Loaded = { status: 'loading' } | { status: 'error'; reason: 'start' | 'timeout' | 'cli' } | { status: 'ok'; data: CliStatus };

/**
 * `/status` во вкладке Claude Code (TASK-287, decision-208): сведения Studio о вкладке (заголовок, сессия CLI с
 * копированием id, папка, аккаунт, модель, усилие, режим) и экран `/status` самого CLI для её сессии — запрос
 * `get_status` без хода модели. Портал в `document.body`, `z-[9999]` (правило 19).
 */
export function CliStatusModal() {
  const { t, language } = useTranslation();
  const c = studioCliText(language);
  const command = useAIStudioStore((s) => s.cliCommand);
  const clear = useAIStudioStore((s) => s.clearCliCommand);
  const sessions = useAIStudioStore((s) => s.sessions);
  const config = useAIStudioStore((s) => s.config);
  const overview = useClaudeAccountsStore((s) => s.overview);
  const projectAccounts = useClaudeAccountsStore((s) => s.projectAccounts);
  const selectedPath = useProjectStore((s) => s.selectedProject?.path);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const status = command?.kind === 'status' ? command : null;

  useEffect(() => {
    if (!status) return;
    let alive = true;
    setLoaded({ status: 'loading' });
    setCopied(false);
    window.api
      .cliStatus({
        projectPath: status.projectPath,
        cwd: status.workspaceRoot,
        ...(status.claudeAccountId ? { claudeAccountId: status.claudeAccountId } : {}),
        ...(status.addDirs?.length ? { addDirs: status.addDirs } : {}),
        ...(status.cliSessionId ? { cliSessionId: status.cliSessionId } : {})
      })
      .then((result) => alive && setLoaded(result.ok ? { status: 'ok', data: result.status } : { status: 'error', reason: result.reason }))
      .catch(() => alive && setLoaded({ status: 'error', reason: 'start' }));
    return () => {
      alive = false;
    };
    // Экран перечитывается при новом `/status` и по «Обновить»; объект команды меняется только с командой.
  }, [status, reloadKey]);

  useEffect(() => {
    if (!status || status.projectPath !== selectedPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, selectedPath, clear]);

  // Окно принадлежит вкладке своего проекта: в Studio другого проекта оно не висит поверх.
  if (!status || status.projectPath !== selectedPath) return null;

  const session = (sessions[status.projectPath] || []).find((s) => s.id === status.sessionId);
  const requestConfig = sessionRequestConfig(config, session?.agent);
  const effort = requestConfig.reasoningEffort;
  // Режим вкладки команды (TASK-291), а не соседней.
  const mode = sessionMode(session);
  const modeText = mode === 'agent' ? t.aiStudio.input.agentMode : mode === 'chat' ? t.aiStudio.input.chatMode : goesToClaudeCli(requestConfig) ? t.aiStudio.input.planMode : t.aiStudio.input.adrMode;
  const accountName = status.claudeAccountId
    ? overview?.accounts.find((a) => a.id === status.claudeAccountId)?.name
    : projectAccounts[status.projectPath]?.account.name;
  const cliSessionId = session?.engineSessionId ?? status.cliSessionId;

  const copyId = async () => {
    if (!cliSessionId) return;
    try {
      await navigator.clipboard.writeText(cliSessionId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const studioRows: Array<{ label: string; value: React.ReactNode; testId: string }> = [
    { label: c.statusTabTitle, value: session?.title ?? '—', testId: 'title' },
    {
      label: c.statusSession,
      testId: 'session',
      value: cliSessionId ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono" data-testid="studio-status-session-id">
            {cliSessionId}
          </span>
          <button
            type="button"
            onClick={() => void copyId()}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
            title={copied ? c.statusCopied : c.statusCopy}
            aria-label={c.statusCopy}
            data-testid="studio-status-copy"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </span>
      ) : (
        <span className="text-muted-foreground">{c.statusNoSession}</span>
      )
    },
    { label: c.statusFolder, value: <span className="font-mono break-all">{status.workspaceRoot}</span>, testId: 'folder' },
    ...(status.addDirs?.length
      ? [{ label: c.statusAddDirs, value: <span className="font-mono break-all">{status.addDirs.join('\n')}</span>, testId: 'add-dirs' }]
      : []),
    { label: c.statusAccount, value: accountName || c.statusAccountDefault, testId: 'account' },
    { label: c.statusModel, value: requestConfig.model && requestConfig.model !== 'default' ? requestConfig.model : c.statusModelDefault, testId: 'model' },
    { label: c.statusEffort, value: effort ? t.reasoningEffort[effort] : t.reasoningEffort.modelDefault, testId: 'effort' },
    { label: c.statusMode, value: modeText, testId: 'mode' }
  ];

  const rowsGrid = 'grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="studio-status-modal">
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Info className="w-4 h-4 text-indigo-300 shrink-0" />
          <h2 className="text-base font-semibold">{c.statusTitle}</h2>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
            title={c.memoryRefresh}
            aria-label={c.memoryRefresh}
            data-testid="studio-status-refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={clear}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label={c.close}
            data-testid="studio-status-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <p className="text-[11px] text-muted-foreground">{c.statusHint}</p>
          <section data-testid="studio-status-tab">
            <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{c.statusTab}</h3>
            <dl className={rowsGrid}>
              {studioRows.map((row) => (
                <React.Fragment key={row.testId}>
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words" data-testid={`studio-status-row-${row.testId}`}>
                    {row.value}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
          {loaded.status === 'loading' && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {c.statusLoading}
            </p>
          )}
          {loaded.status === 'error' && (
            <p className="text-xs text-destructive" data-testid="studio-status-error">
              {c.statusFailed(loaded.reason)}
            </p>
          )}
          {loaded.status === 'ok' && (
            <>
              {cliSessionId && !loaded.data.tabSession && (
                <p className="text-xs text-amber-300" data-testid="studio-status-new-session">
                  {c.statusNewSession}
                </p>
              )}
              {loaded.data.sections.map((section, i) => (
                <section key={`${section.title}-${i}`} data-testid="studio-status-cli-section">
                  <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{c.statusCliSection(section.title)}</h3>
                  <dl className={rowsGrid}>
                    {section.rows.map((row, j) =>
                      row.label ? (
                        <React.Fragment key={j}>
                          <dt className="text-muted-foreground">{row.label}</dt>
                          <dd className="min-w-0 break-words" data-testid="studio-status-cli-row" data-label={row.label}>
                            {row.value}
                          </dd>
                        </React.Fragment>
                      ) : (
                        <dd key={j} className="col-span-2 break-words" data-testid="studio-status-cli-row">
                          {row.value}
                        </dd>
                      )
                    )}
                  </dl>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
