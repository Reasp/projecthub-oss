import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, KeyRound, Loader2, RefreshCw, X } from '../common/icons';
import type { SecretBackupItem, SecretBackupPreview } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { useSecretRestoreStore } from '../../store/useSecretRestoreStore';
import { secretKeyLabel, secretReasonLabel, secretSourceLabel } from './secretLabels';

/**
 * Восстановление секретов из резервной копии (TASK-154, долг decision-88 п. 5).
 * Значения не показываются: только какой секрет, почему он в копии и можно ли вернуть его сейчас.
 * Main сам перепроверяет выбор (`planSecretRestore`), рендерер передаёт только id записей.
 * Модальное окно первого уровня — `z-[9999]` через portal (decision-17).
 */
export const SecretRestoreModal: React.FC = () => {
  const { t, language } = useTranslation();
  const s = t.secretIssues;
  const isOpen = useSecretRestoreStore((st) => st.isOpen);
  const close = useSecretRestoreStore((st) => st.close);
  const setRestorableCount = useSecretRestoreStore((st) => st.setRestorableCount);
  const [preview, setPreview] = useState<SecretBackupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; lines: string[] } | null>(null);

  const apply = useCallback(
    (next: SecretBackupPreview) => {
      setPreview(next);
      setRestorableCount(next.items.filter((i) => i.suggested).length);
      setSelected(new Set(next.items.filter((i) => i.suggested).map((i) => i.id)));
    },
    [setRestorableCount]
  );

  const load = useCallback(async () => {
    try {
      apply(await window.api.getSecretBackupPreview());
    } catch (err) {
      setMessage({ kind: 'error', lines: [s.restoreFailed.replace('{error}', err instanceof Error ? err.message : String(err))] });
    }
  }, [apply, s.restoreFailed]);

  useEffect(() => {
    if (!isOpen) return;
    setMessage(null);
    void load();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, load, close]);

  if (!isOpen) return null;

  const toggle = (item: SecretBackupItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        // На секрет — одна запись: выбор другой снимает прежнюю того же ключа.
        for (const other of preview?.items ?? []) if (other.key === item.key) next.delete(other.id);
        next.add(item.id);
      }
      return next;
    });
  };

  const restore = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.api.restoreSecretsFromBackup([...selected]);
      apply(result.preview);
      const lines: string[] = [];
      if (result.restored.length > 0) {
        lines.push(s.restoreDone.replace('{keys}', result.restored.map((k) => secretKeyLabel(s, k)).join(', ')), s.restoreRestart);
      }
      if (result.skipped.length > 0) lines.push(s.restoreSkipped.replace('{count}', String(result.skipped.length)));
      setMessage({ kind: result.restored.length > 0 ? 'ok' : 'error', lines });
    } catch (err) {
      setMessage({ kind: 'error', lines: [s.restoreFailed.replace('{error}', err instanceof Error ? err.message : String(err))] });
    } finally {
      setBusy(false);
    }
  };

  const formatTime = (at: number) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US');
  const statusLabel = (item: SecretBackupItem) =>
    item.status === 'restorable'
      ? s.statusRestorable
      : item.status === 'current'
        ? s.statusCurrent
        : item.status === 'noValue'
          ? s.statusNoValue
          : s.statusUnreadable;
  const statusClass = (item: SecretBackupItem) =>
    item.status === 'restorable' ? 'text-emerald-400' : item.status === 'current' ? 'text-sky-400' : 'text-muted-foreground';
  const items = preview?.items ?? [];
  const selectedCount = items.filter((i) => selected.has(i.id) && i.status === 'restorable').length;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={s.restoreTitle}
        className="relative w-full max-w-3xl max-h-[86vh] rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-secondary/20">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-semibold">{s.restoreTitle}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="ph-icon-button" title={s.reload} aria-label={s.reload} onClick={() => void load()}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button type="button" className="ph-icon-button" title={s.close} aria-label={s.close} onClick={close}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-3 space-y-3 overflow-y-auto text-xs">
          <p className="text-muted-foreground leading-relaxed">{s.restoreIntro}</p>
          {preview && !preview.encryptionAvailable && (
            <div className="rounded-md border border-amber-500/50 bg-amber-900/20 px-3 py-2 text-amber-100">{s.restoreEncryptionOff}</div>
          )}
          {preview && items.length === 0 && <div className="text-muted-foreground py-6 text-center">{s.restoreEmpty}</div>}
          {!preview && (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {items.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map((item) => {
                const selectable = item.status === 'restorable';
                return (
                  <li key={item.id}>
                    <label className={`flex items-start gap-2.5 px-3 py-2 ${selectable ? 'cursor-pointer hover:bg-ph-hover' : 'opacity-70'}`}>
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        disabled={!selectable || busy}
                        checked={selectable && selected.has(item.id)}
                        onChange={() => toggle(item)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{secretKeyLabel(s, item.key)}</span>
                          <span className={statusClass(item)}>{statusLabel(item)}</span>
                          {item.replacesCurrent && <span className="text-amber-300">· {s.replacesCurrent}</span>}
                        </div>
                        <div className="text-muted-foreground">
                          {secretReasonLabel(s, item.reason)} · {secretSourceLabel(s, item.source)} · {formatTime(item.at)}
                          {item.restoredAt ? ` · ${s.restoredAt.replace('{time}', formatTime(item.restoredAt))}` : ''}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {message && (
            <div
              role="status"
              className={`rounded-md px-3 py-2 space-y-1 ${message.kind === 'ok' ? 'border border-emerald-600/50 bg-emerald-900/20 text-emerald-100' : 'border border-red-600/50 bg-red-900/20 text-red-100'}`}
            >
              {message.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={() => window.api.showSecretBackup()}
            className="px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-ph-hover flex items-center gap-1"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {s.showBackup}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 rounded-md text-xs bg-secondary hover:bg-secondary/80">
              {s.close}
            </button>
            <button
              type="button"
              disabled={busy || selectedCount === 0}
              onClick={() => void restore()}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {s.restoreSelected.replace('{count}', String(selectedCount))}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
