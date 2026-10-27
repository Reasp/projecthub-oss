import { ipcMain } from 'electron';
import { assertRegisteredProject } from '../services/projectPathGuard';
import { knowledgeBaseIndex, readKnowledgeBaseDoc } from '../services/knowledgeBaseService';

/**
 * IPC базы знаний компании (TASK-223, decision-182): список документов подключённой базы знаний для ссылок
 * `[[kb:doc-N]]` и чтение документа. Проект — только из реестра; документ — только из списка базы знаний.
 */
export function registerKnowledgeBaseIpc() {
  ipcMain.handle('kb:index', async (_event, projectPath: unknown) => {
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    const index = await knowledgeBaseIndex(root);
    return index ? { name: index.name, docs: index.docs.map((d) => ({ id: d.id, title: d.title, category: d.category })) } : null;
  });
  ipcMain.handle('kb:read', async (_event, projectPath: unknown, id: unknown) => {
    const root = await assertRegisteredProject(String(projectPath ?? ''));
    return typeof id === 'string' ? readKnowledgeBaseDoc(root, id) : null;
  });
}
