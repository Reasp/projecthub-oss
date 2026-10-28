import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, TriangleAlert, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { profileTransferText } from '../../i18n/profileTransferText';
import { appErrorText } from '../../lib/appErrorText';
import { PROFILE_PASSWORD_MIN, PROFILE_SECTIONS, type ProfileSectionId } from '../../lib/profileSections';
import type { ProfilePreview } from '../../../electron/services/profileService';
import type { FederationPeerState } from '../../types/remote';

/** Откуда предпросмотр: файл, профиль домашнего хоста здесь или профиль этого ПК на хосте (TASK-225). */
type PreviewSource = { kind: 'file' } | { kind: 'fromHost' | 'toHost'; hostId: string; name: string };

const HOME_HOST_KEY = 'projecthub.profile.homeHost';

function readHomeHost(): string {
  try {
    return localStorage.getItem(HOME_HOST_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveHomeHost(hostId: string): void {
  try {
    localStorage.setItem(HOME_HOST_KEY, hostId);
  } catch {
    // Нет хранилища — выбор живёт до закрытия окна.
  }
}

/**
 * Перенос профиля ProjectHub (TASK-224, decision-175): экспорт настроек в файл с паролем и импорт с предпросмотром
 * по разделам, а также обмен профилем с домашним хостом федерации (TASK-225). Рендерится порталом в `document.body`,
 * `z-[9999]` (правило 19, decision-17).
 */
export function ProfileTransferModal({ onClose }: { onClose: () => void }) {
  const { t, language } = useTranslation();
  const p = profileTransferText(language);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exportPassword, setExportPassword] = useState('');
  const [exportRepeat, setExportRepeat] = useState('');
  const [exportSections, setExportSections] = useState<ProfileSectionId[]>([...PROFILE_SECTIONS]);
  const [exported, setExported] = useState<string | null>(null);

  const [file, setFile] = useState<string | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [chosen, setChosen] = useState<ProfileSectionId[]>([]);
  const [applied, setApplied] = useState<number | null>(null);
  const [cloned, setCloned] = useState<Record<string, string>>({});

  const [source, setSource] = useState<PreviewSource>({ kind: 'file' });
  const [peers, setPeers] = useState<FederationPeerState[]>([]);
  const [homeHost, setHomeHost] = useState(readHomeHost);
  const [appliedOnHost, setAppliedOnHost] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    window.api
      .listFederationPeers()
      .then((list) => {
        if (alive) setPeers(list.filter((peer) => peer.paired));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const host = peers.find((peer) => peer.hostId === homeHost) ?? peers[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    // Итог прошлой попытки не остаётся рядом с новой ошибкой.
    setApplied(null);
    setAppliedOnHost(null);
    try {
      await action();
    } catch (err) {
      setError(appErrorText(err, t.appErrors));
    } finally {
      setBusy(false);
    }
  };

  const exportProblem =
    exportPassword.length < PROFILE_PASSWORD_MIN ? p.passwordShort(PROFILE_PASSWORD_MIN) : exportPassword !== exportRepeat ? p.passwordMismatch : exportSections.length === 0 ? p.nothingSelected : null;

  const doExport = () =>
    run(async () => {
      const res = await window.api.profileExport(exportPassword, exportSections);
      if (!res.canceled && res.filePath) {
        setExported(p.exported(res.filePath, res.sections?.length ?? 0));
        setExportPassword('');
        setExportRepeat('');
      }
    });

  const chooseFile = () =>
    run(async () => {
      const chosenFile = await window.api.profileChooseFile();
      if (chosenFile) {
        setFile(chosenFile);
        setPreview(null);
        setApplied(null);
      }
    });

  const doPreview = () =>
    run(async () => {
      if (!file) return;
      showPreview(await window.api.profilePreview(file, importPassword), { kind: 'file' });
    });

  const showPreview = (res: ProfilePreview | null, from: PreviewSource) => {
    if (!res) return;
    setSource(from);
    setPreview(res);
    setChosen(res.sections.filter((s) => s.change !== 'same').map((s) => s.id));
    setApplied(null);
    setAppliedOnHost(null);
  };

  const doPull = () =>
    run(async () => {
      if (!host) return;
      showPreview(await window.api.profilePreviewFromHost(host.hostId, [...PROFILE_SECTIONS]), { kind: 'fromHost', hostId: host.hostId, name: host.machineName });
    });

  const doPush = () =>
    run(async () => {
      if (!host) return;
      const sections = PROFILE_SECTIONS.filter((id) => id !== 'projects');
      showPreview(await window.api.profilePreviewOnHost(host.hostId, sections), { kind: 'toHost', hostId: host.hostId, name: host.machineName });
    });

  const doApply = () =>
    run(async () => {
      if (!preview) return;
      if (source.kind === 'toHost') {
        const res = await window.api.profileApplyOnHost(source.hostId, preview.token, chosen);
        setAppliedOnHost(res.applied.length);
      } else {
        const res = await window.api.profileApply(preview.token, chosen);
        setApplied(res.applied.length);
      }
      setPreview(null);
      setImportPassword('');
    });

  const newerLabel = (incomingNewer: boolean) =>
    source.kind === 'file' ? (incomingNewer ? p.newer : p.older) : incomingNewer === (source.kind === 'fromHost') ? p.hostNewer : p.localNewer;

  const clone = (remote: string, name: string) =>
    run(async () => {
      const target = await window.api.profileCloneProject(remote, name);
      if (target) setCloned((prev) => ({ ...prev, [remote]: target }));
    });

  const toggle = (list: ProfileSectionId[], id: ProfileSectionId) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const input = 'w-full px-2.5 py-1.5 rounded-md bg-background border border-border text-sm focus:outline-none focus:border-primary';
  const button = 'px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40';
  const secondary = 'px-3 py-1.5 rounded-md text-sm border border-border hover:bg-secondary disabled:opacity-40';

  const results = (
    <>
      {preview && (
        <div className="space-y-3" data-testid="profile-preview">
          <div className="text-xs text-muted-foreground">
            {source.kind === 'file'
              ? p.madeAt(new Date(preview.exportedAt).toLocaleString(language), preview.appVersion)
              : source.kind === 'fromHost'
                ? p.fromHost(source.name)
                : p.toHost(source.name)}
          </div>
          <div className="space-y-1">
            {preview.sections.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" disabled={s.change === 'same'} checked={chosen.includes(s.id)} onChange={() => setChosen((c) => toggle(c, s.id))} />
                <span className="min-w-[180px]">{p.sections[s.id]}</span>
                <span className={s.change === 'same' ? 'text-muted-foreground' : 'text-amber-300'}>{p.change[s.change]}</span>
                {s.change === 'changed' && <span className="text-muted-foreground">· {newerLabel(s.incomingNewer)}</span>}
              </label>
            ))}
          </div>
          <button className={button} disabled={busy || chosen.length === 0} onClick={doApply} data-testid="profile-apply">
            {source.kind === 'toHost' ? p.applyOnHost : p.apply}
          </button>

          {preview.missingProjects.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="font-medium text-xs">{p.projectsTitle}</div>
              <p className="text-xs text-muted-foreground">{p.projectsHint}</p>
              {preview.missingProjects.map((proj) => (
                <div key={proj.remote} className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{proj.name}</span>
                  <span className="font-mono text-muted-foreground truncate flex-1" title={proj.remote}>{proj.remote}</span>
                  {cloned[proj.remote] ? (
                    <span className="text-emerald-400">{p.cloned(cloned[proj.remote])}</span>
                  ) : (
                    <button className={secondary} disabled={busy} onClick={() => clone(proj.remote, proj.name)}>
                      {p.clone}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {applied !== null && (
        <div className="flex items-center gap-3 text-xs" data-testid="profile-applied">
          <span className="text-emerald-400">{p.applied(applied)}</span>
          {applied > 0 && (
            <>
              <span className="text-muted-foreground">{p.restartHint}</span>
              <button className={secondary} onClick={() => void window.api.profileRelaunch()}>
                {p.restart}
              </button>
            </>
          )}
        </div>
      )}

      {appliedOnHost !== null && (
        <div className="flex items-center gap-3 text-xs" data-testid="profile-applied-host">
          <span className="text-emerald-400">{p.appliedOnHost(appliedOnHost)}</span>
          {appliedOnHost > 0 && <span className="text-muted-foreground">{p.hostRestartHint}</span>}
        </div>
      )}
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" data-testid="profile-transfer-modal">
      <div className="relative w-full max-w-3xl max-h-[88vh] rounded-xl border border-slate-700 bg-ph-elevated shadow-2xl text-card-foreground flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/20">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{p.title}</h2>
              <p className="text-[11px] text-muted-foreground">{p.subtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary" aria-label={p.close}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-sm">
          <p className="text-xs text-muted-foreground">{p.never}</p>
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/40 text-xs text-destructive" data-testid="profile-error">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <section className="space-y-3">
            <h3 className="font-semibold">{p.exportTitle}</h3>
            <p className="text-xs text-muted-foreground">{p.exportHint}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {PROFILE_SECTIONS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={exportSections.includes(id)} onChange={() => setExportSections((s) => toggle(s, id))} />
                  {p.sections[id]}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input type="password" className={input} placeholder={p.password} value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} autoComplete="new-password" />
              <input type="password" className={input} placeholder={p.passwordRepeat} value={exportRepeat} onChange={(e) => setExportRepeat(e.target.value)} autoComplete="new-password" />
            </div>
            <div className="flex items-center gap-3">
              <button className={button} disabled={busy || Boolean(exportProblem)} onClick={doExport} data-testid="profile-export">
                {busy ? p.working : p.exportButton}
              </button>
              {exportProblem && (exportPassword || exportRepeat) && <span className="text-xs text-amber-400">{exportProblem}</span>}
              {exported && <span className="text-xs text-emerald-400">{exported}</span>}
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="font-semibold">{p.importTitle}</h3>
            <p className="text-xs text-muted-foreground">{p.importHint}</p>
            <div className="flex items-center gap-3">
              <button className={secondary} disabled={busy} onClick={chooseFile}>
                {p.chooseFile}
              </button>
              {file && <span className="text-xs text-muted-foreground truncate" title={file}>{p.fileChosen(file)}</span>}
            </div>
            {file && (
              <div className="flex items-center gap-3">
                <input type="password" className={input} placeholder={p.password} value={importPassword} onChange={(e) => setImportPassword(e.target.value)} autoComplete="current-password" />
                <button className={button} disabled={busy || !importPassword} onClick={doPreview}>
                  {p.preview}
                </button>
              </div>
            )}

            {source.kind === 'file' && results}
          </section>

          <section className="space-y-3 border-t border-border pt-5" data-testid="profile-home-host">
            <h3 className="font-semibold">{p.homeTitle}</h3>
            <p className="text-xs text-muted-foreground">{p.homeHint}</p>
            {peers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{p.noPeers}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  {p.homeHost}
                  <select
                    className="px-2 py-1.5 rounded-md bg-background border border-border text-sm"
                    value={host?.hostId ?? ''}
                    onChange={(e) => {
                      setHomeHost(e.target.value);
                      saveHomeHost(e.target.value);
                    }}
                    data-testid="profile-home-select"
                  >
                    {peers.map((peer) => (
                      <option key={peer.hostId} value={peer.hostId}>
                        {peer.machineName}
                        {peer.status === 'connected' ? '' : ` (${p.peerOffline})`}
                      </option>
                    ))}
                  </select>
                </label>
                <button className={secondary} disabled={busy || !host} onClick={doPull} data-testid="profile-pull">
                  {p.pull}
                </button>
                <button className={secondary} disabled={busy || !host} onClick={doPush} data-testid="profile-push">
                  {p.push}
                </button>
              </div>
            )}
            {source.kind !== 'file' && results}
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
}
