import { create } from 'zustand';

/**
 * Окно восстановления секретов из резервной копии (TASK-154). Открывается из баннера `SecretIssuesNotice`
 * и из кнопки на панели действий, которая видна, пока в копии есть что вернуть: баннер после «Понятно»
 * скрывается, а ключ ОС может вернуться позже.
 */
interface SecretRestoreState {
  isOpen: boolean;
  /** Сколько секретов можно вернуть прямо сейчас (предложенные записи, без отката замены). */
  restorableCount: number;
  open: () => void;
  close: () => void;
  refreshCount: () => Promise<void>;
  setRestorableCount: (count: number) => void;
}

export const useSecretRestoreStore = create<SecretRestoreState>((set) => ({
  isOpen: false,
  restorableCount: 0,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  refreshCount: async () => {
    if (!window.api?.getSecretBackupPreview) return;
    try {
      const preview = await window.api.getSecretBackupPreview();
      set({ restorableCount: preview.items.filter((i) => i.suggested).length });
    } catch {
      // нет копии или main недоступен — кнопки просто нет
    }
  },
  setRestorableCount: (count) => set({ restorableCount: count })
}));
