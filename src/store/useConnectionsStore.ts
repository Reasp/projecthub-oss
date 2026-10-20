import { create } from 'zustand';
import type { ConnectionFlowView, ConnectionServiceInfo, ConnectionView } from '../types/electron';

/**
 * Окно «Подключения» (TASK-138.1, decision-102): список подключений без секретов, каталог сервисов
 * и текущий ход входа через OAuth. Обновления приходят событиями `connections:changed` и `connections:flowChanged`.
 */
interface ConnectionsState {
  isOpen: boolean;
  services: ConnectionServiceInfo[];
  connections: ConnectionView[];
  /** Ходы входа по id: окно показывает тот, который запустило. */
  flows: Record<string, ConnectionFlowView>;
  loading: boolean;
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  setConnections: (list: ConnectionView[]) => void;
  setFlow: (flow: ConnectionFlowView) => void;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  isOpen: false,
  services: [],
  connections: [],
  flows: {},
  loading: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  refresh: async () => {
    if (!window.api?.connections) return;
    set({ loading: true });
    try {
      const [services, connections] = await Promise.all([window.api.connections.services(), window.api.connections.list()]);
      set({ services, connections });
    } finally {
      set({ loading: false });
    }
  },
  setConnections: (connections) => set({ connections }),
  setFlow: (flow) => set((s) => ({ flows: { ...s.flows, [flow.flowId]: flow } }))
}));
