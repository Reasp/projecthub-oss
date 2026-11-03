import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Loader2, Search, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { studioCliText } from '../../i18n/studioCliText';
import { cliOnlyCommands, STUDIO_COMMANDS, terminalCommandNames } from '../../lib/studioCliCommands';
import { commandMatches, commandPrefill } from '../../lib/studioHelp';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useProjectStore } from '../../store/useProjectStore';
import type { CliCommandList } from '../../types/electron';

type Loaded = { status: 'loading' } | { status: 'error'; reason: 'start' | 'timeout' | 'cli' } | { status: 'ok'; list: CliCommandList };
type Row = { name: string; description: string; argumentHint: string };

/**
 * `/help` во вкладке Claude Code (TASK-287, decision-208): слеш-команды по тому, кто их выполняет, — Studio сама, CLI
 * без терминала (список и описания даёт CLI ответом `initialize`, в нём и скиллы аккаунта и проекта), или терминал.
 * Щелчок по команде вставляет её в поле ввода вкладки. Портал в `document.body`, `z-[9999]` (правило 19).
 */
export function CliHelpModal() {
  const { language } = useTranslation();
  const c = studioCliText(language);
  const command = useAIStudioStore((s) => s.cliCommand);
  const clear = useAIStudioStore((s) => s.clearCliCommand);
  const selectedPath = useProjectStore((s) => s.selectedProject?.path);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [query, setQuery] = useState('');

  const help = command?.kind === 'help' ? command : null;

  useEffect(() => {
    if (!help) return;
    let alive = true;
    setLoaded({ status: 'loading' });
    setQuery('');
    window.api
      .cliCommands({
        projectPath: help.projectPath,
        cwd: help.workspaceRoot,
        ...(help.claudeAccountId ? { claudeAccountId: help.claudeAccountId } : {}),
        ...(help.addDirs?.length ? { addDirs: help.addDirs } : {})
      })
      .then((result) => alive && setLoaded(result.ok ? { status: 'ok', list: result.list } : { status: 'error', reason: result.reason }))
      .catch(() => alive && setLoaded({ status: 'error', reason: 'start' }));
    return () => {
      alive = false;
    };
  }, [help]);

  useEffect(() => {
    if (!help || help.projectPath !== selectedPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, selectedPath, clear]);

  if (!help || help.projectPath !== selectedPath) return null;

  const insert = (row: Row) =>
    useAIStudioStore.setState({ cliCommand: null, promptPrefill: { sessionId: help.sessionId, text: commandPrefill(row.name, row.argumentHint), nonce: Date.now() } });

  const studioRows: Row[] = STUDIO_COMMANDS.map((cmd) => ({ name: cmd.name, description: c.helpCommand[cmd.name], argumentHint: cmd.args })).filter((r) => commandMatches(r, query));
  const cliRows: Row[] = loaded.status === 'ok' ? cliOnlyCommands(loaded.list.commands).filter((r) => commandMatches(r, query)) : [];
  const terminalRows: Row[] = terminalCommandNames()
    .map((name) => ({ name, description: '', argumentHint: '' }))
    .filter((r) => commandMatches(r, query));

  const list = (rows: Row[], group: string) => (
    <ul className="space-y-0.5">
      {rows.map((row) => (
        <li key={row.name}>
          <button
            type="button"
            onClick={() => insert(row)}
            className="w-full min-w-0 text-left px-2 py-1 rounded hover:bg-secondary/50 flex items-baseline gap-2 overflow-hidden"
            data-testid="studio-help-command"
            data-group={group}
            data-name={row.name}
          >
            <span className="font-mono text-sm text-foreground shrink-0">/{row.name}</span>
            {row.argumentHint && <span className="font-mono text-[11px] text-muted-foreground shrink-0">{row.argumentHint}</span>}
            {row.description && (
              <span className="min-w-0 flex-1 text-xs text-muted-foreground truncate" title={row.description}>
                {row.description}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );

  const nothing = studioRows.length === 0 && cliRows.length === 0 && terminalRows.length === 0 && loaded.status !== 'loading';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="studio-help-modal">
      <div className="w-full max-w-3xl h-[80vh] flex flex-col rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <HelpCircle className="w-4 h-4 text-indigo-300 shrink-0" />
          <h2 className="text-base font-semibold">{c.helpTitle}</h2>
          {loaded.status === 'ok' && loaded.list.version && (
            <span className="text-[11px] text-muted-foreground" data-testid="studio-help-version">
              {c.helpVersion(loaded.list.version)}
            </span>
          )}
          <button
            type="button"
            onClick={clear}
            className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label={c.close}
            data-testid="studio-help-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pt-3 pb-2 space-y-2 border-b border-border">
          <p className="text-[11px] text-muted-foreground">{c.helpHint}</p>
          <label className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-2 py-1.5">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={c.helpFilter}
              aria-label={c.helpFilter}
              className="flex-1 bg-transparent text-sm outline-none"
              data-testid="studio-help-filter"
            />
          </label>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {studioRows.length > 0 && (
            <section data-testid="studio-help-studio">
              <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.helpStudio}</h3>
              {list(studioRows, 'studio')}
            </section>
          )}
          <section data-testid="studio-help-cli">
            {(cliRows.length > 0 || loaded.status !== 'ok') && <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.helpCli}</h3>}
            {loaded.status === 'loading' && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {c.helpCliLoading}
              </p>
            )}
            {loaded.status === 'error' && (
              <p className="text-xs text-destructive px-2" data-testid="studio-help-error">
                {c.helpCliFailed(loaded.reason)}
              </p>
            )}
            {cliRows.length > 0 && list(cliRows, 'cli')}
          </section>
          {terminalRows.length > 0 && (
            <section data-testid="studio-help-terminal">
              <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{c.helpTerminal}</h3>
              <p className="text-[11px] text-muted-foreground px-2 mb-1">{c.helpTerminalHint}</p>
              {list(terminalRows, 'terminal')}
            </section>
          )}
          {nothing && <p className="text-xs text-muted-foreground">{c.helpNoMatch}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}
