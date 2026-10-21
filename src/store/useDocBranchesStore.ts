import { create } from 'zustand';

/**
 * Запрос открыть окно веток документации (TASK-194, decision-151): из уведомления «правки ждут принятия»,
 * плашки «В ветках» в окне документа и кнопки на вкладке документации.
 */
export interface DocBranchesRequest {
  projectPath: string;
  branchId?: string;
  docPath?: string;
}

interface DocBranchesState {
  request: DocBranchesRequest | null;
  open: (request: DocBranchesRequest) => void;
  close: () => void;
}

export const useDocBranchesStore = create<DocBranchesState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null })
}));
