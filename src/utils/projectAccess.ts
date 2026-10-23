import type { DeviceRights } from '../types/remote';

/**
 * Права устройства на отдельные проекты хоста (TASK-180, decision-144). Чистые функции без Electron: их используют
 * хост (`remoteControlService`), окно ПК и тесты.
 *
 * Действующий доступ к проекту = меньшее из прав устройства (после сужения ролью участника, decision-126) и права
 * этого проекта. Право проекта — переопределение для проекта, иначе право «по умолчанию» (оно же для новых
 * проектов), иначе — права устройства: так работают старые сопряжения без настроек по проектам.
 */

export type ProjectAccess = 'none' | DeviceRights;

export const PROJECT_ACCESS_LEVELS: readonly ProjectAccess[] = ['none', 'readOnly', 'hitl', 'full'];

export interface DeviceProjectRights {
  /** Переопределения: ключ — путь проекта (`projectAccessKey`). */
  projects?: Record<string, ProjectAccess>;
  /** Проекты без переопределения и новые проекты. Нет поля — права устройства. */
  defaultAccess?: ProjectAccess;
}

const RANK: Record<ProjectAccess, number> = { none: 0, readOnly: 1, hitl: 2, full: 3 };

export function isProjectAccess(value: unknown): value is ProjectAccess {
  return value === 'none' || value === 'readOnly' || value === 'hitl' || value === 'full';
}

export function minAccess(a: ProjectAccess, b: ProjectAccess): ProjectAccess {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Ключ проекта: разделители `/`, без хвостового `/`; путь Windows — без учёта регистра. */
export function projectAccessKey(projectPath: string): string {
  const p = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
}

/**
 * Проект реестра, которому принадлежит путь: сам проект или путь внутри него (worktree агента в `.worktrees/…`,
 * файл задачи). Из вложенных проектов — самый глубокий.
 */
export function owningProject(targetPath: string, projects: readonly string[]): string | null {
  const t = projectAccessKey(targetPath);
  let best: string | null = null;
  let bestLen = -1;
  for (const p of projects) {
    const k = projectAccessKey(p);
    if ((t === k || t.startsWith(`${k}/`)) && k.length > bestLen) {
      best = p;
      bestLen = k.length;
    }
  }
  return best;
}

/** Права по проектам заданы: устройство видит не все проекты на одних правах. */
export function hasProjectRestrictions(rights: DeviceProjectRights | undefined): boolean {
  return Boolean(rights && (rights.defaultAccess !== undefined || Object.keys(rights.projects ?? {}).length > 0));
}

/** Доступ устройства к проекту: меньшее из прав устройства и права проекта. */
export function projectAccessFor(deviceRights: DeviceRights, rights: DeviceProjectRights | undefined, projectPath: string): ProjectAccess {
  if (!rights) return deviceRights;
  const own = rights.projects?.[projectAccessKey(projectPath)] ?? rights.defaultAccess ?? deviceRights;
  return minAccess(deviceRights, own);
}

/** Чистка входа из IPC и файла: только известные значения, ключи нормализованы, пустое — `undefined`. */
export function sanitizeProjectRights(raw: unknown): DeviceProjectRights | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as { projects?: unknown; defaultAccess?: unknown };
  const projects: Record<string, ProjectAccess> = {};
  if (src.projects && typeof src.projects === 'object') {
    for (const [path, access] of Object.entries(src.projects as Record<string, unknown>)) {
      if (path.trim() && isProjectAccess(access)) projects[projectAccessKey(path)] = access;
    }
  }
  const out: DeviceProjectRights = {
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
    ...(isProjectAccess(src.defaultAccess) ? { defaultAccess: src.defaultAccess } : {})
  };
  return hasProjectRestrictions(out) ? out : undefined;
}

/**
 * Можно ли RPC с таким доступом к проекту: `none` — ничего, `readOnly` — только чтение, `hitl` — чтение и решения
 * человека. Возвращает код причины отказа (`src/i18n/appErrorText.ts`, decision-165) или `null`.
 */
export function projectAccessDenied(
  access: ProjectAccess,
  write: boolean,
  hitlMethod: boolean
): 'remote.projectNoAccess' | 'remote.projectReadOnly' | 'remote.projectHitlOnly' | null {
  if (access === 'none') return 'remote.projectNoAccess';
  if (!write) return null;
  if (access === 'readOnly') return 'remote.projectReadOnly';
  if (access === 'hitl' && !hitlMethod) return 'remote.projectHitlOnly';
  return null;
}

/** Действия, доступные устройству в проекте (кнопки в дереве телефона). */
export function accessActions(access: ProjectAccess, hostReadOnly: boolean): 'none' | 'hitl' | 'full' {
  if (hostReadOnly || access === 'none' || access === 'readOnly') return 'none';
  return access === 'hitl' ? 'hitl' : 'full';
}
