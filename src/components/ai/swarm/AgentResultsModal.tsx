import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, GitBranch, Trash2, RefreshCw } from '../../common/icons';
import { ipcErrorText, useTranslation } from '../../../i18n/useTranslation';
import { useDialog } from '../../../hooks/useDialog';
import { useSwarmStore } from '../../../store/useSwarmStore';
import type { AgentResultEntry, ArenaConfig } from '../../../types/electron';

/**
 * Сохранённые результаты агентов проекта (TASK-238, decision-188): ref `refs/projecthub/results/<сессия>/<агент>`,
 * которые остаются после удаления worktree. Восстановление в ветку, удаление и настройка срока хранения.
 *
 * Модалка рендерится через `createPortal` в `document.body` с `z-[9999]` — правило 19 infra-dev (decision-17).
 */
export const AgentResultsModal: React.FC<{ projectPath: string; onClose: () => void }> = ({ projectPath, onClose }) => {
  const { t } = useTranslation();
  const r = t.agentResults;
  const dialog = useDialog();
  const { saveArenaConfigAction } = useSwarmStore();
  const [results, setResults] = useState<AgentResultEntry[] | null>(null);
  const [retention, setRetention] = useState<ArenaConfig['resultRetention'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await window.api.listAgentResults(projectPath);
      setResults(res.results);
      setRetention((prev) => prev ?? res.retention);
    } catch (err) {
      setResults([]);
      setError(r.loadError.replace('{error}', ipcErrorText(err)));
    }
  }, [projectPath, r.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const restore = (entry: AgentResultEntry) =>
    run(entry.ref, async () => {
      try {
        const res = await window.api.restoreAgentResult(projectPath, entry.ref);
        setNotice(r.restored.replace('{branch}', res.branch));
      } catch (err) {
        setError(r.restoreError.replace('{error}', ipcErrorText(err)));
      }
    });

  const remove = async (entry: AgentResultEntry) => {
    const ok = await dialog.confirm({ title: r.delete, message: r.deleteConfirm.replace('{agent}', entry.agentId), danger: true });
    if (!ok) return;
    await run(entry.ref, async () => {
      try {
        await window.api.deleteAgentResult(projectPath, entry.ref);
        await load();
      } catch (err) {
        setError(r.deleteError.replace('{error}', ipcErrorText(err)));
      }
    });
  };

  const saveRetention = () =>
    run('retention', async () => {
      if (!retention) return;
      const res = await saveArenaConfigAction(projectPath, { arena: { resultRetention: retention } });
      if (res.config) setRetention(res.config.resultRetention);
      if (!res.success) setError(t.judge.settingsSaveError.replace('{error}', '.projecthub.json'));
    });

  const prune = () =>
    run('prune', async () => {
      try {
        // Очистка идёт по настройке из `.projecthub.json`: несохранённые поля сначала сохраняются. Не сохранились — не чистим
        // по старой настройке, которую человек как раз менял.
        if (retention) {
          const saved = await saveArenaConfigAction(projectPath, { arena: { resultRetention: retention } });
          if (!saved.success) {
            setError(t.judge.settingsSaveError.replace('{error}', '.projecthub.json'));
            return;
          }
        }
        const res = await window.api.pruneAgentResults(projectPath);
        setNotice(r.pruned.replace('{count}', String(res.removed)));
        await load();
      } catch (err) {
        setError(r.pruneError.replace('{error}', ipcErrorText(err)));
      }
    });

  const numberField = (label: string, value: number, onChange: (n: number) => void, testId: string) => (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {label}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
        className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-foreground focus:outline-hidden"
        data-testid={testId}
      />
    </label>
  );

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-3xl max-h-[85vh] rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="agent-results-modal"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{r.title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" title={t.common.close}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">{r.hint}</p>
          {notice && <p className="text-xs text-emerald-400">{notice}</p>}
          {error && <p className="text-xs text-rose-400">{error}</p>}
          {results === null ? (
            <p className="text-xs text-muted-foreground">{r.loading}</p>
          ) : results.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="agent-results-empty">{r.empty}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">{r.session}</th>
                  <th className="py-1 pr-3 font-medium">{r.agent}</th>
                  <th className="py-1 pr-3 font-medium">{r.date}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {results.map((e) => (
                  <tr key={e.ref} className="border-t border-border/60 align-top" data-testid="agent-result-row">
                    <td className="py-2 pr-3 font-mono text-[11px] text-foreground">
                      {e.sessionId}
                      {e.live && <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">{r.liveBadge}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-mono text-[11px] text-foreground">{e.agentId}</div>
                      {e.subject && <div className="text-[11px] text-muted-foreground truncate max-w-[16rem]" title={e.subject}>{e.subject}</div>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{e.savedAt ? new Date(e.savedAt).toLocaleString() : '—'}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => void restore(e)}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-foreground hover:bg-secondary border border-border/70 disabled:opacity-50"
                        data-testid="agent-result-restore"
                      >
                        <GitBranch className="w-3.5 h-3.5" /> {r.restore}
                      </button>
                      <button
                        onClick={() => void remove(e)}
                        disabled={busy !== null}
                        title={r.delete}
                        className="ml-1 inline-flex items-center px-2 py-1 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border/70 disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {retention && (
            <section className="space-y-2 border-t border-border pt-3">
              <h4 className="text-xs font-medium text-muted-foreground">{r.retentionTitle}</h4>
              <div className="flex flex-wrap items-center gap-3">
                {numberField(r.maxAgeDays, retention.maxAgeDays, (n) => setRetention({ ...retention, maxAgeDays: n }), 'agent-results-max-age')}
                {numberField(r.maxCount, retention.maxCount, (n) => setRetention({ ...retention, maxCount: n }), 'agent-results-max-count')}
                <button
                  onClick={() => void saveRetention()}
                  disabled={busy !== null}
                  className="px-3 py-1 rounded-lg text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {r.saveRetention}
                </button>
                <button
                  onClick={() => void prune()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] font-medium text-foreground hover:bg-secondary border border-border/70 disabled:opacity-50"
                  data-testid="agent-results-prune"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${busy === 'prune' ? 'animate-spin' : ''}`} /> {r.pruneNow}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">{r.noLimitHint}</p>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
