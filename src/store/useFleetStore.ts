import { create } from 'zustand';
import type { FederationPeerState } from '../types/remote';
import { compareHosts, type FleetHostEntry, type OverviewSession, type RemoteOverview } from '../utils/fleetOverview';
import { useFederationStore } from './useFederationStore';
import { useHitlStore } from './useHitlStore';
import { useProjectStore } from './useProjectStore';
import { ipcErrorText } from '../i18n/useTranslation';

/**
 * Дерево «Компьютеры» в сайдбаре (TASK-174, decision-129 п. 10): сводка этого ПК и удалённых хостов hub-режима,
 * время последней связи и открытая удалённая сессия. Данные удалённых ПК — только здесь и в `useFederationStore`,
 * с локальными сторами не смешиваются.
 */

const LAST_SEEN_KEY = 'ph.fleet.lastSeen';
const UI_KEY = 'ph.fleet.ui';
/** Перечитать снимок после события не чаще, чем раз в это время. */
const REFETCH_DEBOUNCE_MS = 500;

export interface RemoteHostOverviewState {
  overview?: RemoteOverview;
  error?: string;
  /** Хост старой версии без `get_overview`. */
  unsupported?: boolean;
  loading?: boolean;
}

/** Удалённая сессия, открытая в основной области: чат Studio или вывод агента. */
export interface OpenRemoteSession {
  hostId: string;
  machineName: string;
  projectPath: string;
  projectName: string;
  session: OverviewSession;
}

export type RemoteProjectTab = 'tasks' | 'agents' | 'docs';

/** Проект удалённого ПК в основной области (TASK-229): задачи, сессии агентов и документация через RPC его хоста. */
export interface OpenRemoteProject {
  hostId: string;
  machineName: string;
  projectPath: string;
  projectName: string;
  tab: RemoteProjectTab;
}

interface FleetUi {
  collapsed: boolean;
  /** Свёрнутые компьютеры и раскрытые «ещё N» по hostId. */
  collapsedHosts: Record<string, boolean>;
  showQuiet: Record<string, boolean>;
  /** Раскрытые проекты: `${hostId}|${path}`. */
  openProjects: Record<string, boolean>;
}

interface FleetState extends FleetUi {
  local: RemoteHostOverviewState;
  remote: Record<string, RemoteHostOverviewState>;
  lastSeen: Record<string, number>;
  remoteSession: OpenRemoteSession | null;
  remoteProject: OpenRemoteProject | null;

  init: () => void;
  refreshLocal: () => Promise<void>;
  refreshRemote: (hostId: string) => Promise<void>;
  toggleSection: () => void;
  toggleHost: (hostId: string) => void;
  toggleQuiet: (hostId: string) => void;
  toggleProject: (hostId: string, projectPath: string) => void;
  openRemoteSession: (s: OpenRemoteSession) => void;
  closeRemoteSession: () => void;
  /** Открыть проект удалённого ПК; без `tab` — та же вкладка, если проект уже открыт, иначе задачи. */
  openRemoteProject: (p: Omit<OpenRemoteProject, 'tab'> & { tab?: RemoteProjectTab }) => void;
  setRemoteProjectTab: (tab: RemoteProjectTab) => void;
  closeRemoteProject: () => void;
  /** Решение HITL из строки: свой ПК — как в окне, удалённый — RPC на его хост. */
  decide: (hostId: string | null, requestId: string, approved: boolean) => Promise<{ ok: boolean; error?: string }>;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // хранилище недоступно — состояние раздела просто не запомнится
  }
}

const defaultUi: FleetUi = { collapsed: false, collapsedHosts: {}, showQuiet: {}, openProjects: {} };

let cleanups: Array<() => void> = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function debounced(key: string, fn: () => void): void {
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, REFETCH_DEBOUNCE_MS)
  );
}

/** События хоста, после которых снимок старых хостов без `overview:changed` тоже устаревает. */
function isOverviewEvent(event: string): boolean {
  return event === 'overview:changed' || event.startsWith('ai:hitl') || event.startsWith('agent:') || event === 'backlog:changed' || event === 'studio:complete' || event === 'studio:started';
}

export const useFleetStore = create<FleetState>((set, get) => {
  const saveUi = () => {
    const { collapsed, collapsedHosts, showQuiet, openProjects } = get();
    writeJson(UI_KEY, { collapsed, collapsedHosts, showQuiet, openProjects });
  };
  const seen = (hostId: string) => {
    const lastSeen = { ...get().lastSeen, [hostId]: Date.now() };
    set({ lastSeen });
    writeJson(LAST_SEEN_KEY, lastSeen);
  };

  return {
    ...readJson<FleetUi>(UI_KEY, defaultUi),
    local: {},
    remote: {},
    lastSeen: readJson<Record<string, number>>(LAST_SEEN_KEY, {}),
    remoteSession: null,
    remoteProject: null,

    init: () => {
      if (!window.api?.getLocalOverview) return;
      for (const c of cleanups) c();
      cleanups = [];
      cleanups.push(window.api.onLocalOverviewChanged(() => debounced('local', () => void get().refreshLocal())));
      // Решения из окна и центра HITL меняют «ждёт» сразу, не дожидаясь события хоста.
      cleanups.push(useHitlStore.subscribe((s, prev) => s.pending !== prev.pending && debounced('local', () => void get().refreshLocal())));
      cleanups.push(
        window.api.onFederationEvent((payload) => {
          seen(payload.hostId);
          if (isOverviewEvent(payload.event)) debounced(payload.hostId, () => void get().refreshRemote(payload.hostId));
        })
      );
      // Человек ушёл в свой проект или вкладку — удалённая сессия и проект перестают закрывать рабочую область.
      cleanups.push(
        useProjectStore.subscribe((s, prev) => {
          if (s.selectedProject?.path !== prev.selectedProject?.path || s.activeTab !== prev.activeTab) {
            get().closeRemoteSession();
            get().closeRemoteProject();
          }
        })
      );
      // Хост стал доступен — его снимок читается сразу.
      let prevPeers: FederationPeerState[] = useFederationStore.getState().peers;
      cleanups.push(
        useFederationStore.subscribe((s) => {
          if (s.peers === prevPeers) return;
          for (const peer of s.peers) {
            const before = prevPeers.find((p) => p.hostId === peer.hostId);
            if (peer.status === 'connected' && before?.status !== 'connected') void get().refreshRemote(peer.hostId);
            if (peer.status !== 'connected' && before?.status === 'connected') seen(peer.hostId);
          }
          prevPeers = s.peers;
        })
      );
      void get().refreshLocal();
      void useFederationStore
        .getState()
        .refreshPeers()
        .then(() => {
          for (const peer of useFederationStore.getState().peers) if (peer.status === 'connected') void get().refreshRemote(peer.hostId);
        });
    },

    refreshLocal: async () => {
      if (!window.api?.getLocalOverview) return;
      try {
        set({ local: { overview: await window.api.getLocalOverview() } });
      } catch (err) {
        set((s) => ({ local: { ...s.local, error: ipcErrorText(err) } }));
      }
    },

    refreshRemote: async (hostId) => {
      if (!window.api?.federationCall) return;
      set((s) => ({ remote: { ...s.remote, [hostId]: { ...s.remote[hostId], loading: true } } }));
      try {
        const overview = await window.api.federationCall<RemoteOverview>(hostId, 'get_overview');
        seen(hostId);
        set((s) => ({ remote: { ...s.remote, [hostId]: { overview } } }));
      } catch (err) {
        const message = ipcErrorText(err);
        set((s) => ({
          remote: {
            ...s.remote,
            [hostId]: { ...s.remote[hostId], loading: false, error: message, unsupported: /Unknown RPC method/i.test(message) }
          }
        }));
      }
    },

    toggleSection: () => {
      set((s) => ({ collapsed: !s.collapsed }));
      saveUi();
    },
    toggleHost: (hostId) => {
      set((s) => ({ collapsedHosts: { ...s.collapsedHosts, [hostId]: !s.collapsedHosts[hostId] } }));
      saveUi();
    },
    toggleQuiet: (hostId) => {
      set((s) => ({ showQuiet: { ...s.showQuiet, [hostId]: !s.showQuiet[hostId] } }));
      saveUi();
    },
    toggleProject: (hostId, projectPath) => {
      const key = `${hostId}|${projectPath}`;
      set((s) => ({ openProjects: { ...s.openProjects, [key]: !s.openProjects[key] } }));
      saveUi();
    },

    // Сессия другого проекта закрывает открытый удалённый проект: «Закрыть» сессии не должно вести в чужой проект.
    openRemoteSession: (remoteSession) =>
      set((s) => ({
        remoteSession,
        remoteProject:
          s.remoteProject?.hostId === remoteSession.hostId && s.remoteProject.projectPath === remoteSession.projectPath ? s.remoteProject : null
      })),
    closeRemoteSession: () => set({ remoteSession: null }),

    openRemoteProject: ({ tab, ...p }) =>
      set((s) => {
        const same = s.remoteProject?.hostId === p.hostId && s.remoteProject.projectPath === p.projectPath;
        return { remoteSession: null, remoteProject: { ...p, tab: tab ?? (same ? s.remoteProject!.tab : 'tasks') } };
      }),
    setRemoteProjectTab: (tab) => set((s) => (s.remoteProject ? { remoteProject: { ...s.remoteProject, tab } } : {})),
    closeRemoteProject: () => set({ remoteProject: null }),

    decide: async (hostId, requestId, approved) => {
      try {
        if (!hostId) {
          await useHitlStore.getState().decide(requestId, approved);
          void get().refreshLocal();
          return { ok: true };
        }
        const res = await window.api.federationCall<{ ok: boolean; reason?: string }>(hostId, 'hitl_decision', { requestId, decision: approved ? 'allow' : 'deny' });
        void get().refreshRemote(hostId);
        return res.ok ? { ok: true } : { ok: false, error: res.reason };
      } catch (err) {
        return { ok: false, error: ipcErrorText(err) };
      }
    }
  };
});

/** Компьютеры дерева: свой ПК первым, удалённые из hub-режима; офлайн — со временем последней связи. */
export function fleetHosts(
  localHostId: string,
  local: RemoteHostOverviewState,
  peers: FederationPeerState[],
  remote: Record<string, RemoteHostOverviewState>,
  lastSeen: Record<string, number>
): Array<FleetHostEntry & { state?: RemoteHostOverviewState; peer?: FederationPeerState }> {
  const self = {
    hostId: local.overview?.hostId || localHostId || 'local',
    machineName: local.overview?.machineName || '',
    self: true,
    online: true,
    ...(local.overview ? { overview: local.overview } : {}),
    state: local
  };
  const others = peers.map((peer) => {
    const state = remote[peer.hostId];
    const online = peer.status === 'connected';
    const seenAt = Math.max(lastSeen[peer.hostId] ?? 0, peer.connectedAt ?? 0);
    return {
      hostId: peer.hostId,
      machineName: state?.overview?.machineName || peer.machineName || peer.hostId,
      online,
      ...(seenAt ? { lastSeenAt: seenAt } : {}),
      ...(online && state?.overview ? { overview: state.overview } : {}),
      ...(peer.error ? { error: peer.error } : {}),
      state,
      peer
    };
  });
  return [self, ...others].sort(compareHosts);
}
