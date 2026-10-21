import { useCallback, useMemo } from 'react';
import { phoneFleetHosts, type PhoneFleetHost } from '../protocol/fleet';
import { activeProfile } from '../protocol/profiles';
import type { Scope } from '../protocol/scope';
import type { OverviewSessionKind } from '../../../src/utils/fleetOverview';
import { useAppState, useHostSummaries, useLastSeen, usePoolOverviews, useServices } from './context';

/**
 * Дерево «Обзора» (TASK-174, TASK-181): открытый ПК — по соединению и сводке стора, остальные — по снимкам пула.
 * Общее для главного экрана и вкладок вне проекта.
 */
export function useFleet(): PhoneFleetHost[] {
  const { profiles } = useServices();
  const conn = useAppState((s) => s.conn);
  const status = useAppState((s) => s.status);
  const overview = useAppState((s) => s.overview);
  const overviewUnsupported = useAppState((s) => s.overviewUnsupported);
  const projects = useAppState((s) => s.projects);
  const summaries = useHostSummaries();
  const overviews = usePoolOverviews();
  const lastSeen = useLastSeen();
  const active = activeProfile(profiles);
  return useMemo(
    () =>
      phoneFleetHosts({
        profiles: profiles.profiles,
        activeId: active?.id ?? null,
        active: { overview, unsupported: overviewUnsupported, connection: conn.state, route: conn.route, machineName: status?.machineName, projects },
        summaries,
        overviews,
        lastSeen
      }),
    [profiles.profiles, active?.id, overview, overviewUnsupported, conn.state, conn.route, status?.machineName, projects, summaries, overviews, lastSeen]
  );
}

export interface ScopeActions {
  /** Выбрать узел дерева. Проект другого ПК открывает этот ПК: экраны проекта работают через соединение стора. */
  select(scope: Scope, host?: PhoneFleetHost): void;
  /** Открыть сессию или задачу в её проекте: область становится этим проектом. */
  open(host: PhoneFleetHost, projectPath: string, kind: OverviewSessionKind | 'task', id: string, agentId?: string): void;
}

export function useScopeActions(): ScopeActions {
  const { store, switchHost, profiles } = useServices();
  const activeId = profiles.activeId;
  const select = useCallback<ScopeActions['select']>(
    (scope, host) => {
      store.setScope(scope);
      if (scope.kind !== 'project') return;
      if (scope.profileId === activeId) void store.selectProject(scope.projectPath);
      else if (host) {
        // Новый ПК загрузится с этим проектом: он запоминается до переключения.
        void store.requestNav({ hostId: host.hostId, projectPath: scope.projectPath, kind: 'project', sessionId: '' });
        switchHost(scope.profileId);
      }
    },
    [store, switchHost, activeId]
  );
  const open = useCallback<ScopeActions['open']>(
    (host, projectPath, kind, id, agentId) => {
      store.setScope({ kind: 'project', profileId: host.profileId, projectPath });
      void store.requestNav({ hostId: host.hostId, projectPath, kind, sessionId: id, ...(agentId ? { agentId } : {}) });
      if (!host.active) switchHost(host.profileId);
    },
    [store, switchHost]
  );
  return useMemo(() => ({ select, open }), [select, open]);
}
