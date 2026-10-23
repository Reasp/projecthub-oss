import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderLock, X } from '../common/icons';
import { useTranslation } from '../../i18n';
import { ipcErrorText } from '../../i18n/useTranslation';
import { useProjectStore } from '../../store/useProjectStore';
import type { DeviceRights, PairedDevice, RemoteControlStatus } from '../../types/electron';
import {
  PROJECT_ACCESS_LEVELS,
  hasProjectRestrictions,
  minAccess,
  projectAccessKey,
  type DeviceProjectRights,
  type ProjectAccess
} from '../../utils/projectAccess';

/** «Как у устройства» в выборе права: поле не задаётся, действует право по умолчанию или права устройства. */
const INHERIT = 'inherit';
type Choice = ProjectAccess | typeof INHERIT;

/**
 * Права устройства на отдельные проекты этого ПК (TASK-180, decision-144): матрица «проект → права» и право для
 * остальных и новых проектов. Открывается поверх окна Remote Control — поэтому z-[10001] (правило 19 infra-dev).
 */
export const DeviceProjectsModal: React.FC<{
  device: Pick<PairedDevice, 'deviceId' | 'name' | 'rights' | 'projectRights'>;
  onClose: () => void;
  onSaved: (status: RemoteControlStatus) => void;
}> = ({ device, onClose, onSaved }) => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const initial = device.projectRights;
  const [restricted, setRestricted] = useState(hasProjectRestrictions(initial));
  const [other, setOther] = useState<Choice>(initial?.defaultAccess ?? INHERIT);
  const [perProject, setPerProject] = useState<Record<string, Choice>>(() => ({ ...(initial?.projects ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = (a: ProjectAccess) =>
    a === 'none' ? t.remote.projectAccessNone : a === 'readOnly' ? t.remote.rightsReadOnly : a === 'hitl' ? t.remote.rightsHitl : t.remote.rightsFull;
  // Право проекта не шире прав устройства: выше — недоступно в списке.
  const allowed = (a: ProjectAccess) => minAccess(a, device.rights as DeviceRights) === a;
  const sorted = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  const save = async () => {
    if (!window.api?.setRemoteDeviceProjectRights) return;
    setBusy(true);
    setError(null);
    try {
      let next: DeviceProjectRights | null = null;
      if (restricted) {
        const overrides: Record<string, ProjectAccess> = {};
        for (const p of projects) {
          const choice = perProject[projectAccessKey(p.path)];
          if (choice && choice !== INHERIT) overrides[projectAccessKey(p.path)] = choice;
        }
        next = { ...(Object.keys(overrides).length > 0 ? { projects: overrides } : {}), ...(other !== INHERIT ? { defaultAccess: other } : {}) };
      }
      onSaved(await window.api.setRemoteDeviceProjectRights(device.deviceId, next));
      onClose();
    } catch (e) {
      console.error('Failed to set device project rights:', e);
      setError(t.remote.deviceProjectsSaveFailed.replace('{error}', ipcErrorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const select = (value: Choice, onChange: (v: Choice) => void, testId: string) => (
    <select
      value={value}
      disabled={!restricted}
      onChange={(e) => onChange(e.target.value as Choice)}
      className="bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-slate-200 disabled:opacity-50"
      data-testid={testId}
    >
      <option value={INHERIT}>{t.remote.deviceProjectsUseDevice}</option>
      {PROJECT_ACCESS_LEVELS.map((a) => (
        <option key={a} value={a} disabled={!allowed(a)}>
          {label(a)}
        </option>
      ))}
    </select>
  );

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[520px] max-w-[95vw] max-h-[85vh] flex flex-col rounded-xl border border-ph-line bg-ph-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="device-projects"
      >
        <div className="flex items-center justify-between border-b border-ph-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <FolderLock className="h-4 w-4 text-indigo-300" />
            {t.remote.deviceProjectsTitle.replace('{name}', device.name)}
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 py-3 text-xs text-slate-300">
          <div className="text-[11px] text-slate-400">{t.remote.deviceProjectsHint}</div>
          <div className="text-[11px] text-slate-500">{t.remote.deviceProjectsCeiling.replace('{rights}', label(device.rights as DeviceRights))}</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!restricted} onChange={(e) => setRestricted(!e.target.checked)} data-testid="device-projects-all" />
            {t.remote.deviceProjectsAll}
          </label>
          <div className="space-y-1.5">
            {sorted.map((p) => {
              const key = projectAccessKey(p.path);
              return (
                <div key={p.path} className="flex items-center justify-between gap-2 rounded-md bg-ph-raised px-2 py-1.5" data-testid="device-project-row">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-200">{p.name}</div>
                    <div className="truncate text-[11px] text-slate-500">{p.path}</div>
                  </div>
                  {select(perProject[key] ?? INHERIT, (v) => setPerProject({ ...perProject, [key]: v }), 'device-project-access')}
                </div>
              );
            })}
            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-ph-line px-2 py-1.5">
              <div className="font-medium text-slate-300">{t.remote.deviceProjectsOther}</div>
              {select(other, setOther, 'device-projects-other')}
            </div>
          </div>
        </div>
        {error && (
          <div className="border-t border-ph-line px-4 py-2 text-[11px] text-rose-300" data-testid="device-projects-error">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-ph-line px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            {t.remote.deviceProjectsCancel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            data-testid="device-projects-save"
          >
            {t.remote.deviceProjectsSave}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
