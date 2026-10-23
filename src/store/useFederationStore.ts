import { create } from 'zustand';
import type { FederationHost, FederationPeerState, FederationTransport, RemoteQueueView, RemoteTeam } from '../types/remote';
import type { PeerPairingFields } from '../utils/remotePairingLink';
import { getDictionary } from '../i18n';
import { ipcErrorText, ipcFailureText } from '../i18n/useTranslation';
import { useProjectStore } from './useProjectStore';

/**
 * Стор федерации компьютеров (TASK-66, decision-11 п.4): каталог хостов, сопряжённые пиры и
 * данные удалённого хоста в hub-режиме.
 *
 * Данные удалённого хоста НЕ смешиваются с локальными сторами (проекты, задачи, HITL): всё, что
 * пришло с другой машины, живёт здесь и показывается с явной пометкой хоста — иначе очереди двух
 * машин слились бы в одну и было бы непонятно, где на самом деле выполняется действие.
 */

export interface RemoteProjectInfo {
  id?: string;
  name?: string;
  path: string;
}

export interface RemoteTaskInfo {
  id: string;
  title: string;
  status: string;
  assignee?: string[];
  filePath?: string;
  priority?: string;
}

export interface RemoteProcessInfo {
  id: string;
  name: string;
  status: string;
  command?: string;
  port?: number;
}

export interface RemoteApprovalInfo {
  requestId: string;
  sessionId: string;
  projectPath: string;
  tool?: string;
  type?: string;
  title?: string;
  details?: string;
  command?: string;
  filePath?: string;
  createdAt?: number;
  agentName?: string;
  role?: string;
}

export interface RemoteSwarmInfo {
  id: string;
  mode: string;
  status: string;
  taskId?: string;
  taskTitle?: string;
  origin?: string;
  agents: Array<{ id: string; name: string; roleSlug?: string; engine?: string; status: string; error?: string }>;
}

export interface RemoteHostData {
  projects: RemoteProjectInfo[];
  activeProjectPath: string | null;
  tasks: RemoteTaskInfo[];
  processes: RemoteProcessInfo[];
  approvals: RemoteApprovalInfo[];
  swarms: RemoteSwarmInfo[];
  roles: Array<{ slug: string; name: string }>;
  /** Общий хост команды (TASK-142.5): кто я на нём и кто что ведёт; `null` — хост без модуля Team. */
  team: RemoteTeam | null;
  /** Очередь слияния выбранного проекта хоста; `null` — хост без очереди. */
  queue: RemoteQueueView | null;
  isLoading: boolean;
  error: string | null;
}

export type RemoteHostTab = 'overview' | 'tasks' | 'processes' | 'agents' | 'hitl' | 'queue';

/** Заполненная форма нового хоста: из ссылки `projecthub://` или найденного в каталоге ПК (decision-143). */
export type AddPeerDraft = Partial<PeerPairingFields> & { machineName?: string };

/** Черновик формы для ПК из каталога релея или LAN: адрес есть, ключа нет — нужен PIN или ссылка. */
export function catalogDraft(host: FederationHost): AddPeerDraft {
  const ip = host.localIps?.[0];
  return {
    hostId: host.hostId,
    machineName: host.machineName,
    transport: ip ? 'lan' : 'relay',
    address: ip ? `${ip}:${host.port || 42050}` : ''
  };
}

/** ПК каталога, с которыми этот ПК ещё не сопряжён. */
export function discoveredHosts(catalog: FederationHost[], peers: FederationPeerState[], selfHostId?: string): FederationHost[] {
  return catalog.filter((h) => h.source !== 'self' && h.hostId !== selfHostId && !peers.some((p) => p.hostId === h.hostId));
}

/** Действие участника с задачей на общем хосте: взять, отказаться, поставить в очередь слияния. */
export type RemoteTeamAction = 'take_task' | 'release_task' | 'queue_enqueue';

interface FederationState {
  isOpen: boolean;
  peers: FederationPeerState[];
  catalog: FederationHost[];
  selectedHostId: string | null;
  activeTab: RemoteHostTab;
  data: Record<string, RemoteHostData>;
  lastEvent: { hostId: string; machineName: string; event: string; at: number } | null;

  /** Черновик формы добавления: окно забирает его при показе (`takeAddDraft`). */
  addDraft: AddPeerDraft | null;

  init: () => void;
  open: (hostId?: string) => void;
  /** Открыть окно сразу на форме добавления хоста, заполнив её. */
  openAdd: (draft: AddPeerDraft) => void;
  takeAddDraft: () => AddPeerDraft | null;
  close: () => void;
  setActiveTab: (tab: RemoteHostTab) => void;
  refreshPeers: () => Promise<void>;
  refreshCatalog: () => Promise<void>;
  addPeer: (options: {
    hostId: string;
    machineName?: string;
    transport: FederationTransport;
    address: string;
    secretKey?: string;
    hostKey?: string;
    pin?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  removePeer: (hostId: string) => Promise<void>;
  connectPeer: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
  disconnectPeer: (hostId: string) => Promise<void>;
  selectHost: (hostId: string | null) => void;
  loadHostData: (hostId: string) => Promise<void>;
  selectRemoteProject: (hostId: string, projectPath: string) => Promise<void>;
  decideRemoteApproval: (hostId: string, requestId: string, approved: boolean) => Promise<{ ok: boolean; error?: string }>;
  runRemoteAssignedAgent: (
    hostId: string,
    options: { projectPath: string; taskId: string; taskTitle?: string; roleSlug: string }
  ) => Promise<{ ok: boolean; error?: string }>;
  updateRemoteTaskStatus: (hostId: string, filePath: string, newStatus: string) => Promise<{ ok: boolean; error?: string }>;
  remoteProcessAction: (hostId: string, action: 'stop' | 'restart', processId: string) => Promise<{ ok: boolean; error?: string }>;
  remoteTeamAction: (hostId: string, action: RemoteTeamAction, taskId: string) => Promise<{ ok: boolean; error?: string }>;
  remoteQueueReview: (hostId: string, itemId: string, approved: boolean, comment?: string) => Promise<{ ok: boolean; error?: string }>;
  remoteQueueCancel: (hostId: string, itemId: string) => Promise<{ ok: boolean; error?: string }>;
}

const emptyData: RemoteHostData = {
  projects: [],
  activeProjectPath: null,
  tasks: [],
  processes: [],
  approvals: [],
  swarms: [],
  roles: [],
  team: null,
  queue: null,
  isLoading: false,
  error: null
};

let cleanupPeers: (() => void) | null = null;
let cleanupEvents: (() => void) | null = null;

const federationText = () => getDictionary(useProjectStore.getState().language).federation;

/** Причина из состояния пира на языке окна (decision-165); нет причины — `undefined`. */
function peerErrorText(peer: FederationPeerState | undefined): string | undefined {
  return peer?.error ? ipcFailureText(peer) : undefined;
}

export const useFederationStore = create<FederationState>((set, get) => ({
  isOpen: false,
  peers: [],
  catalog: [],
  selectedHostId: null,
  activeTab: 'overview',
  data: {},
  lastEvent: null,
  addDraft: null,

  init: () => {
    if (!window.api) return;
    cleanupPeers?.();
    cleanupEvents?.();

    cleanupPeers = window.api.onFederationPeersChanged?.((peers) => set({ peers })) || null;
    cleanupEvents =
      window.api.onFederationEvent?.((payload) => {
        set({ lastEvent: { hostId: payload.hostId, machineName: payload.machineName, event: payload.event, at: Date.now() } });

        // Очередь HITL и статусы агентов удалённого хоста должны обновляться сами: человек не
        // должен жать «обновить», чтобы увидеть запрос, который ждёт его решения.
        const { selectedHostId } = get();
        if (payload.hostId !== selectedHostId) return;
        if (payload.event.startsWith('ai:hitl') || payload.event.startsWith('agent:') || payload.event === 'backlog:changed' || payload.event.startsWith('queue:')) {
          void get().loadHostData(payload.hostId);
        }
      }) || null;

    void get().refreshPeers();
    void get().refreshCatalog();
  },

  open: (hostId) => {
    set({ isOpen: true, ...(hostId ? { selectedHostId: hostId } : {}) });
    void get().refreshPeers();
    void get().refreshCatalog();
    const target = hostId || get().selectedHostId;
    if (target) void get().loadHostData(target);
  },

  openAdd: (draft) => {
    set({ isOpen: true, addDraft: draft });
    void get().refreshPeers();
    void get().refreshCatalog();
  },

  takeAddDraft: () => {
    const draft = get().addDraft;
    if (draft) set({ addDraft: null });
    return draft;
  },

  close: () => set({ isOpen: false }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  refreshPeers: async () => {
    if (!window.api?.listFederationPeers) return;
    try {
      set({ peers: await window.api.listFederationPeers() });
    } catch {
      // main ещё не поднял сервис — список останется прежним
    }
  },

  refreshCatalog: async () => {
    if (!window.api?.getFederationHosts) return;
    try {
      set({ catalog: await window.api.getFederationHosts() });
    } catch {
      // каталог недоступен — не ошибка интерфейса
    }
  },

  addPeer: async (options) => {
    if (!window.api?.addFederationPeer) return { ok: false, error: federationText().apiUnavailable };
    try {
      const peer = await window.api.addFederationPeer(options);
      await get().refreshPeers();
      set({ selectedHostId: peer.hostId });
      await get().loadHostData(peer.hostId);
      return { ok: peer.status === 'connected', error: peerErrorText(peer) };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  removePeer: async (hostId) => {
    if (!window.api?.removeFederationPeer) return;
    const peers = await window.api.removeFederationPeer(hostId);
    const { selectedHostId, data } = get();
    const rest = { ...data };
    delete rest[hostId];
    set({ peers, data: rest, selectedHostId: selectedHostId === hostId ? null : selectedHostId });
  },

  connectPeer: async (hostId) => {
    if (!window.api?.connectFederationPeer) return { ok: false, error: federationText().apiUnavailable };
    try {
      const peer = await window.api.connectFederationPeer(hostId);
      await get().refreshPeers();
      if (peer.status === 'connected') await get().loadHostData(hostId);
      return { ok: peer.status === 'connected', error: peerErrorText(peer) };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  disconnectPeer: async (hostId) => {
    if (!window.api?.disconnectFederationPeer) return;
    await window.api.disconnectFederationPeer(hostId);
    await get().refreshPeers();
  },

  selectHost: (hostId) => {
    set({ selectedHostId: hostId });
    if (hostId) void get().loadHostData(hostId);
  },

  loadHostData: async (hostId) => {
    if (!window.api?.federationCall) return;
    const peer = get().peers.find((p) => p.hostId === hostId);
    if (!peer || peer.status !== 'connected') {
      set((s) => ({
        data: {
          ...s.data,
          [hostId]: { ...(s.data[hostId] || emptyData), isLoading: false, error: peerErrorText(peer) || federationText().notConnected }
        }
      }));
      return;
    }

    set((s) => ({ data: { ...s.data, [hostId]: { ...(s.data[hostId] || emptyData), isLoading: true, error: null } } }));

    try {
      const call = window.api.federationCall;
      const [status, projects, tasks, processes, approvals, swarms, roles, team, queue] = await Promise.all([
        call<{ activeProjectPath?: string }>(hostId, 'get_status').catch(() => ({}) as { activeProjectPath?: string }),
        call<RemoteProjectInfo[]>(hostId, 'get_projects').catch(() => []),
        call<RemoteTaskInfo[]>(hostId, 'get_tasks').catch(() => []),
        call<RemoteProcessInfo[]>(hostId, 'get_processes').catch(() => []),
        call<RemoteApprovalInfo[]>(hostId, 'get_pending_approvals').catch(() => []),
        call<RemoteSwarmInfo[]>(hostId, 'get_swarms').catch(() => []),
        call<Array<{ slug: string; name: string }>>(hostId, 'get_roles').catch(() => []),
        // Хост без модуля Team отвечает «Unknown RPC method» — команды и очереди у него нет.
        call<RemoteTeam>(hostId, 'get_team').catch(() => null),
        call<RemoteQueueView>(hostId, 'queue_list').catch(() => null)
      ]);

      set((s) => ({
        data: {
          ...s.data,
          [hostId]: {
            projects: Array.isArray(projects) ? projects : [],
            activeProjectPath: status?.activeProjectPath || null,
            tasks: Array.isArray(tasks) ? tasks : [],
            processes: Array.isArray(processes) ? processes : [],
            approvals: Array.isArray(approvals) ? approvals : [],
            swarms: Array.isArray(swarms) ? swarms : [],
            roles: Array.isArray(roles) ? roles : [],
            team: team && typeof team === 'object' && 'me' in team ? team : null,
            queue: queue && typeof queue === 'object' && Array.isArray((queue as RemoteQueueView).active) ? queue : null,
            isLoading: false,
            error: null
          }
        }
      }));
    } catch (err) {
      set((s) => ({
        data: { ...s.data, [hostId]: { ...(s.data[hostId] || emptyData), isLoading: false, error: ipcErrorText(err) } }
      }));
    }
  },

  selectRemoteProject: async (hostId, projectPath) => {
    if (!window.api?.federationCall) return;
    try {
      await window.api.federationCall(hostId, 'select_project', { projectPath });
      await get().loadHostData(hostId);
    } catch (err) {
      set((s) => ({ data: { ...s.data, [hostId]: { ...(s.data[hostId] || emptyData), error: ipcErrorText(err) } } }));
    }
  },

  decideRemoteApproval: async (hostId, requestId, approved) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      // Решение всегда адресуется по requestId (TASK-57): хост применит его один раз, откуда бы
      // оно ни пришло — с телефона, из своего окна или отсюда.
      const res = await window.api.federationCall<{ ok?: boolean; reason?: string }>(hostId, 'hitl_decision', {
        requestId,
        decision: approved ? 'allow' : 'deny'
      });
      await get().loadHostData(hostId);
      return { ok: Boolean(res?.ok), error: res?.reason };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  runRemoteAssignedAgent: async (hostId, options) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      await window.api.federationCall(hostId, 'start_assigned_agent', {
        projectPath: options.projectPath,
        taskId: options.taskId,
        taskTitle: options.taskTitle,
        roleSlug: options.roleSlug,
        hostId
      });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  updateRemoteTaskStatus: async (hostId, filePath, newStatus) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      await window.api.federationCall(hostId, 'update_task_status', { filePath, newStatus });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  remoteTeamAction: async (hostId, action, taskId) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      // Участник — по устройству этого ПК на хосте: роль и права проверяет хост (decision-126 п. 3).
      await window.api.federationCall(hostId, action, { taskId });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  remoteQueueReview: async (hostId, itemId, approved, comment) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      await window.api.federationCall(hostId, 'queue_review', { itemId, approved, ...(comment?.trim() ? { comment: comment.trim() } : {}) });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  remoteQueueCancel: async (hostId, itemId) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      await window.api.federationCall(hostId, 'queue_cancel', { itemId });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  },

  remoteProcessAction: async (hostId, action, processId) => {
    if (!window.api?.federationCall) return { ok: false, error: federationText().apiUnavailable };
    try {
      await window.api.federationCall(hostId, action === 'stop' ? 'stop_process' : 'restart_process', { processId });
      await get().loadHostData(hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ipcErrorText(err) };
    }
  }
}));
