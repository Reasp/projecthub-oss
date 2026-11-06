import { create } from 'zustand';
import type { StudioEngineStatus } from '../lib/studioEngines';

/**
 * Найденные движки вкладки Studio (TASK-277, decision-220) по машинам: `local` — эта, иначе хост проекта другого ПК
 * (`phr://<hostId>/…`). Проверку кэширует main; здесь — чтобы выбор модели не спрашивал её на каждом открытии.
 */
interface StudioEnginesState {
  statuses: Record<string, StudioEngineStatus[]>;
  load: (projectPath: string, force?: boolean) => Promise<void>;
}

/** Ключ машины проекта: проекты одного хоста делят результат. */
export function engineHostKey(projectPath: string): string {
  const remote = /^phr:\/\/([^/]+)\//.exec(projectPath);
  return remote ? remote[1] : 'local';
}

const inflight = new Map<string, Promise<void>>();

export const useStudioEnginesStore = create<StudioEnginesState>((set) => ({
  statuses: {},
  load: (projectPath, force = false) => {
    const key = engineHostKey(projectPath);
    const running = inflight.get(key);
    if (running && !force) return running;
    if (!window.api?.studioEngines) return Promise.resolve();
    const task = window.api
      .studioEngines({ projectPath, ...(force ? { force: true } : {}) })
      .then((list) => set((state) => ({ statuses: { ...state.statuses, [key]: Array.isArray(list) ? list : [] } })))
      .catch(() => set((state) => ({ statuses: { ...state.statuses, [key]: [] } })))
      .finally(() => {
        if (inflight.get(key) === task) inflight.delete(key);
      });
    inflight.set(key, task);
    return task;
  }
}));
