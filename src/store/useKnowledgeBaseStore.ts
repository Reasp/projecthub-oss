import { create } from 'zustand';
import { ipcErrorText } from '../i18n/useTranslation';

/**
 * База знаний компании в окне (TASK-223): список документов подключённой базы знаний для разрешения ссылок
 * `[[kb:doc-N]]` и открытый документ. Список грузится на смену проекта; без базы знаний — пусто.
 */
interface KbDoc {
  id: string;
  title: string;
}

interface KnowledgeBaseState {
  projectPath: string | null;
  name: string | null;
  docs: Record<string, KbDoc>;
  opened: { id: string; title: string; content: string; kbName: string } | null;
  error: string | null;
  load: (projectPath: string | null) => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
}

export const useKnowledgeBaseStore = create<KnowledgeBaseState>((set, get) => ({
  projectPath: null,
  name: null,
  docs: {},
  opened: null,
  error: null,
  load: async (projectPath) => {
    if (projectPath === get().projectPath) return;
    set({ projectPath, name: null, docs: {} });
    if (!projectPath) return;
    try {
      const index = await window.api.knowledgeBaseIndex(projectPath);
      if (get().projectPath !== projectPath) return;
      const docs: Record<string, KbDoc> = {};
      for (const d of index?.docs ?? []) docs[d.id.toLowerCase()] = { id: d.id, title: d.title };
      set({ name: index?.name ?? null, docs });
    } catch {
      // Без базы знаний ссылки [[kb:…]] показываются как ненайденные.
    }
  },
  open: async (id) => {
    const projectPath = get().projectPath;
    if (!projectPath) return;
    try {
      const doc = await window.api.knowledgeBaseRead(projectPath, id);
      set({ opened: doc, error: null });
    } catch (err) {
      set({ error: ipcErrorText(err) });
    }
  },
  close: () => set({ opened: null, error: null })
}));
