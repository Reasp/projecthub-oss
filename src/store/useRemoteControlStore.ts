import { create } from 'zustand';

/** Вкладки модалки Remote Control. */
export type RemoteControlTab = 'connect' | 'devices' | 'settings' | 'telegram';

/**
 * Открытие модалки Remote Control (TASK-173). Состояние вынесено из `RemoteControlBadge`, чтобы
 * клик по уведомлению «Устройство ждёт подтверждения» открывал её сразу на вкладке устройств.
 */
interface RemoteControlState {
  isOpen: boolean;
  activeTab: RemoteControlTab;
  open: (tab?: RemoteControlTab) => void;
  close: () => void;
  setActiveTab: (tab: RemoteControlTab) => void;
}

export const useRemoteControlStore = create<RemoteControlState>((set) => ({
  isOpen: false,
  activeTab: 'connect',
  open: (tab) => set((s) => ({ isOpen: true, activeTab: tab ?? s.activeTab })),
  close: () => set({ isOpen: false }),
  setActiveTab: (activeTab) => set({ activeTab })
}));
