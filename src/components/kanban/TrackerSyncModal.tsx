import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Unplug } from '../common/icons';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { useConnectionsStore } from '../../store/useConnectionsStore';
import type {
  RemoteStatus,
  TrackerJournalKind,
  TrackerRunSummary,
  TrackerSyncConfig,
  TrackerSyncStatusView,
  TrackerTargetGroup
} from '../../types/electron';

/**
 * Окно «Синхронизация с трекером» (TASK-128, decision-103): подключение, список трекера, соответствие статусов,
 * политика конфликтов, предпросмотр плана, запуск и журнал последнего запуска.
 */

interface Props {
  projectPath: string;
  isOpen: boolean;
  onClose: () => void;
}

const inputClass =
  'bg-ph-panel border border-ph-line rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500';

const errorMessage = ipcErrorText;

export const TrackerSyncModal: React.FC<Props> = ({ projectPath, isOpen, onClose }) => {
  const { t } = useTranslation();
  const ts = t.trackerSync;
  const connections = useConnectionsStore((s) => s.connections);
  const refreshConnections = useConnectionsStore((s) => s.refresh);
  const openConnections = useConnectionsStore((s) => s.open);

  const [status, setStatus] = useState<TrackerSyncStatusView | null>(null);
  const [draft, setDraft] = useState<TrackerSyncConfig | null>(null);
  const [connectionId, setConnectionId] = useState<string>('');
  const [interval, setIntervalMinutes] = useState(0);
  const [groups, setGroups] = useState<TrackerTargetGroup[] | null>(null);
  const [statuses, setStatuses] = useState<{ localStatuses: string[]; remoteStatuses: RemoteStatus[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TrackerRunSummary | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const s = await window.api.trackerSync.status(projectPath);
    setStatus(s);
    setDraft(s.config);
    setConnectionId(s.connectionId ?? '');
    setIntervalMinutes(s.intervalMinutes);
    setResult(s.lastRun);
  }, [projectPath]);

  // Родитель передаёт новый onClose на каждый рендер — эффект открытия не должен перезапускаться от этого.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setGroups(null);
    setStatuses(null);
    void load().catch((err) => setError(errorMessage(err)));
    void refreshConnections().catch(() => undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useConnectionsStore.getState().isOpen) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, load, refreshConnections]);

  const adapter = status?.adapters.find((a) => a.id === draft?.adapter);
  const usable = useMemo(() => connections.filter((c) => c.serviceId === adapter?.serviceId), [connections, adapter?.serviceId]);

  if (!isOpen) return null;

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveAll = (extra?: Partial<TrackerSyncConfig>) =>
    act('save', async () => {
      if (!draft) return;
      const next = await window.api.trackerSync.save(projectPath, {
        config: { ...draft, ...extra },
        connectionId: connectionId || null,
        intervalMinutes: interval
      });
      setStatus(next);
      setDraft(next.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  // Списки и статусы читаются через сохранённые трекер и подключение: сначала сохраняем выбор.
  const loadTargets = () =>
    act('targets', async () => {
      await window.api.trackerSync.save(projectPath, { ...(draft ? { config: draft } : {}), connectionId: connectionId || null });
      setGroups(await window.api.trackerSync.targets(projectPath));
    });

  const loadStatuses = () =>
    act('statuses', async () => {
      if (!draft) return;
      await window.api.trackerSync.save(projectPath, { config: draft, connectionId: connectionId || null });
      const described = await window.api.trackerSync.describeTarget(projectPath);
      setStatuses(described);
      setDraft((d) => (d ? { ...d, statusMap: { ...described.suggested, ...d.statusMap } } : d));
    });

  const preview = () => act('preview', async () => setResult(await window.api.trackerSync.preview(projectPath)));
  const run = () =>
    act('run', async () => {
      setResult(await window.api.trackerSync.run(projectPath));
      await load();
    });

  const allTargets = groups?.flatMap((g) => g.targets.map((tg) => ({ ...tg, group: g.name }))) ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl bg-ph-elevated border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        data-testid="tracker-sync-modal"
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-indigo-300" />
            {ts.title}
            {adapter ? <span className="text-slate-400 font-normal">· {adapter.label}</span> : null}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition" title={ts.close}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {!draft ? (
          <div className="p-6 text-xs text-slate-400">{error ?? t.common.loading}</div>
        ) : (
          <div className="p-4 overflow-y-auto space-y-4 text-xs">
            <p className="text-slate-400">{ts.intro}</p>

            <section className="space-y-1.5">
              <label className="block text-slate-300 font-medium">{ts.tracker}</label>
              <select
                className={inputClass}
                value={draft.adapter}
                onChange={(e) => {
                  // Другой трекер — другие подключение, цель и статусы (decision-106).
                  setDraft({ ...draft, adapter: e.target.value, target: null, statusMap: {} });
                  setConnectionId('');
                  setGroups(null);
                  setStatuses(null);
                }}
                data-testid="tracker-adapter"
              >
                {(status?.adapters ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="space-y-1.5">
              <label className="block text-slate-300 font-medium">{ts.connection}</label>
              <div className="flex items-center gap-2">
                <select
                  className={`${inputClass} flex-1`}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  data-testid="tracker-connection"
                >
                  <option value="">{ts.connectionNone}</option>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={openConnections} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ph-line text-slate-300 hover:text-white">
                  <Unplug className="w-3.5 h-3.5" />
                  {ts.manageConnections}
                </button>
              </div>
              {usable.length === 0 && <p className="text-slate-500">{ts.noConnections}</p>}
            </section>

            <section className="space-y-1.5">
              <label className="block text-slate-300 font-medium">{ts.target}</label>
              <div className="flex items-center gap-2">
                {groups ? (
                  <select
                    className={`${inputClass} flex-1`}
                    value={draft.target?.id ?? ''}
                    onChange={(e) => {
                      const picked = allTargets.find((tg) => tg.id === e.target.value);
                      setDraft({ ...draft, target: picked ? { id: picked.id, name: picked.name, path: `${picked.group} / ${picked.path ?? ''}` } : null, statusMap: {} });
                      setStatuses(null);
                    }}
                    data-testid="tracker-target"
                  >
                    <option value="">—</option>
                    {groups.map((g) => (
                      <optgroup key={g.id} label={g.name}>
                        {g.targets.map((tg) => (
                          <option key={tg.id} value={tg.id}>
                            {tg.path ? `${tg.path} / ${tg.name}` : tg.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                ) : (
                  <span className="flex-1 text-slate-200" data-testid="tracker-target-current">
                    {draft.target ? `${draft.target.path ? `${draft.target.path} / ` : ''}${draft.target.name}` : ts.targetNone}
                  </span>
                )}
                <button
                  type="button"
                  onClick={loadTargets}
                  disabled={!connectionId || busy !== null}
                  data-testid="tracker-load-targets"
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-ph-line text-slate-300 hover:text-white disabled:opacity-40"
                >
                  {busy === 'targets' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {ts.loadTargets}
                </button>
              </div>
            </section>

            <section className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-slate-300 font-medium">{ts.statusMap}</label>
                <button
                  type="button"
                  onClick={loadStatuses}
                  disabled={!connectionId || !draft.target || busy !== null}
                  data-testid="tracker-load-statuses"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-ph-line text-slate-300 hover:text-white disabled:opacity-40"
                >
                  {busy === 'statuses' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {ts.loadStatuses}
                </button>
              </div>
              {statuses ? (
                <table className="w-full">
                  <tbody>
                    {statuses.localStatuses.map((local) => (
                      <tr key={local}>
                        <td className="py-1 pr-3 text-slate-300 w-1/3">{local}</td>
                        <td className="py-1">
                          <select
                            className={`${inputClass} w-full`}
                            value={draft.statusMap[local] ?? ''}
                            onChange={(e) => {
                              const map = { ...draft.statusMap };
                              if (e.target.value) map[local] = e.target.value;
                              else delete map[local];
                              setDraft({ ...draft, statusMap: map });
                            }}
                            data-testid={`tracker-status-${local}`}
                          >
                            <option value="">{ts.statusSkip}</option>
                            {statuses.remoteStatuses.map((r) => (
                              <option key={r.name} value={r.name}>
                                {r.name} ({r.type})
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : Object.keys(draft.statusMap).length > 0 ? (
                <p className="text-slate-400">
                  {Object.entries(draft.statusMap)
                    .map(([l, r]) => `${l} → ${r}`)
                    .join(' · ')}
                </p>
              ) : (
                <p className="text-slate-500">{ts.statusMapEmpty}</p>
              )}
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-slate-300 font-medium">{ts.conflictPolicy}</label>
                {(['backlog', 'remote'] as const).map((p) => (
                  <label key={p} className="flex items-center gap-2 text-slate-300">
                    <input type="radio" checked={draft.conflictPolicy === p} onChange={() => setDraft({ ...draft, conflictPolicy: p })} />
                    {p === 'backlog' ? ts.policyBacklog : fill(ts.policyRemote, adapter?.label ?? '')}
                  </label>
                ))}
              </div>
              <div className="space-y-2">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">{ts.exportLabel}</label>
                  <input
                    className={`${inputClass} w-full`}
                    value={draft.exportLabel}
                    onChange={(e) => setDraft({ ...draft, exportLabel: e.target.value })}
                    placeholder={ts.exportLabelPlaceholder}
                  />
                </div>
                <label className="flex items-center gap-2 text-slate-300">
                  <input type="checkbox" checked={draft.importClosed} onChange={(e) => setDraft({ ...draft, importClosed: e.target.checked })} />
                  {ts.importClosed}
                </label>
                <label className="flex items-center gap-2 text-slate-300">
                  {ts.interval}
                  <select className={inputClass} value={interval} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
                    {[0, 15, 30, 60, 240].map((m) => (
                      <option key={m} value={m}>
                        {m === 0 ? ts.intervalOff : fill(ts.intervalMinutes, String(m))}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <label className="flex items-center gap-2 text-slate-200 font-medium">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-testid="tracker-enabled" />
              {ts.enabled}
            </label>

            {error && (
              <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-200 flex items-start gap-2" data-testid="tracker-error">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => void saveAll()}
                disabled={busy !== null}
                data-testid="tracker-save"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white"
              >
                {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                {ts.save}
              </button>
              <button
                type="button"
                onClick={preview}
                disabled={busy !== null || !status?.connectionId || !status?.config.target}
                data-testid="tracker-preview"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ph-line text-slate-200 hover:text-white disabled:opacity-40"
              >
                {busy === 'preview' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {ts.preview}
              </button>
              <button
                type="button"
                onClick={run}
                disabled={busy !== null || !status?.config.enabled || !status?.connectionId || !status?.config.target}
                data-testid="tracker-run"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white"
              >
                {busy === 'run' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {ts.run}
              </button>
              {status && <span className="text-slate-500">{fill(ts.linked, String(status.linkedTasks))}</span>}
            </div>
            <p className="text-slate-500">{ts.saveHint}</p>

            {result && <RunJournal summary={result} />}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

function fill(template: string, value: string): string {
  return template.replace(/\{\w+\}/, value);
}

const KIND_CLASS: Partial<Record<TrackerJournalKind, string>> = {
  conflict: 'text-amber-300',
  error: 'text-rose-300',
  missingRemote: 'text-amber-200/80',
  missingLocal: 'text-amber-200/80',
  unmappedStatus: 'text-amber-200/80'
};

const RunJournal: React.FC<{ summary: TrackerRunSummary }> = ({ summary }) => {
  const { t } = useTranslation();
  const ts = t.trackerSync;
  const counts = Object.entries(summary.counts) as Array<[TrackerJournalKind, number]>;
  return (
    <section className="space-y-1.5 border-t border-slate-800 pt-3" data-testid="tracker-journal">
      <div className="flex items-center gap-2 text-slate-200 font-medium">
        {summary.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
        {summary.dryRun ? ts.journalPreview : ts.journalRun}
        <span className="text-slate-500 font-normal">{new Date(summary.at).toLocaleString()}</span>
      </div>
      {summary.error && <p className="text-rose-300 break-words">{summary.error}</p>}
      <p className="text-slate-400">{counts.length > 0 ? counts.map(([k, v]) => `${ts.kinds[k]}: ${v}`).join(' · ') : ts.noChanges}</p>
      {summary.entries.length > 0 && (
        <ul className="max-h-56 overflow-y-auto space-y-0.5 font-mono text-[11px]">
          {summary.entries.map((e, i) => (
            <li key={i} className={KIND_CLASS[e.kind] ?? 'text-slate-300'}>
              {ts.kinds[e.kind]}: {e.taskId ?? ''}
              {e.externalId ? ` #${e.externalId}` : ''}
              {e.title ? ` «${e.title}»` : ''}
              {e.fields?.length ? ` [${e.fields.map((f) => ts.fields[f]).join(', ')}]` : ''}
              {e.detail ? ` — ${e.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
