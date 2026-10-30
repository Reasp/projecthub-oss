import type { ProjectInfo, RemoteProjectRef } from '../types/electron';
import { toRemotePath } from '../lib/remoteProjectPath';

/**
 * Проекты других ПК, открытые в окне как локальные (TASK-280): живут в общем списке проектов с полем `remote`, чтобы
 * вкладки, переключение по номеру и восстановление выбранного проекта работали без отдельных веток. Чистый модуль.
 */

export const REMOTE_PROJECTS_STORAGE_KEY = 'projecthub_remote_projects';

interface StoredRemoteProject extends RemoteProjectRef {
  name: string;
}

export function remoteProjectInfo(ref: RemoteProjectRef, name: string): ProjectInfo {
  return {
    name,
    path: toRemotePath(ref.hostId, ref.hostPath),
    // Признаки уточнит `projects:getDetails` хоста; до ответа вкладка выглядит как проект с git и задачами.
    hasBacklog: true,
    hasInfraConfig: false,
    hasGit: true,
    remote: { hostId: ref.hostId, hostPath: ref.hostPath, machineName: ref.machineName }
  };
}

export function serializeRemoteProjects(projects: readonly ProjectInfo[]): string {
  const stored: StoredRemoteProject[] = projects
    .filter((p): p is ProjectInfo & { remote: RemoteProjectRef } => Boolean(p.remote))
    .map((p) => ({ hostId: p.remote.hostId, hostPath: p.remote.hostPath, machineName: p.remote.machineName, name: p.name }));
  return JSON.stringify(stored);
}

export function parseRemoteProjects(raw: string | null): ProjectInfo[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ProjectInfo[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      const hostId = str(r.hostId);
      const hostPath = str(r.hostPath);
      if (!hostId || !hostPath || /[/\\]/.test(hostId)) continue;
      const machineName = str(r.machineName) ?? hostId;
      out.push(remoteProjectInfo({ hostId, hostPath, machineName }, str(r.name) ?? hostPath.split(/[/\\]/).filter(Boolean).pop() ?? hostPath));
    }
    return out;
  } catch {
    return [];
  }
}

/** Свежий список проектов этого ПК плюс открытые проекты других ПК из текущего списка. */
export function withRemoteProjects(local: readonly ProjectInfo[], current: readonly ProjectInfo[]): ProjectInfo[] {
  return [...local.filter((p) => !p.remote), ...current.filter((p) => p.remote)];
}

/**
 * Ответ хоста о проекте (`projects:refresh`, `projects:getDetails`) поверх записи окна: путь `phr://` и ссылка на хост
 * остаются окна, остальное — свежее с хоста.
 */
export function mergeRemoteDetails(existing: ProjectInfo, fresh: ProjectInfo): ProjectInfo {
  return existing.remote ? { ...fresh, path: existing.path, remote: existing.remote } : fresh;
}
