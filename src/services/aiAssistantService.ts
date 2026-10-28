/**
 * Шаблоны коммита и PR без модели (TASK-134.4: кнопки «AI» для них остаются шаблонами).
 * Черновик задачи моделью — `window.api.generateTaskDraft` (назначение «Черновик описания задачи»).
 * Текст уходит в репозиторий человека — на языке окна (decision-165 п. 14).
 */
import { rendererServiceText } from '../i18n/rendererServiceText';

export async function generateCommitMessage(
  taskId?: string,
  taskTitle?: string,
  changedFiles?: string[]
): Promise<string> {
  if (taskId && taskTitle) {
    return `feat(${taskId}): ${taskTitle.toLowerCase()}`;
  }

  const tx = rendererServiceText().commitDraft;
  if (changedFiles && changedFiles.length > 0) {
    const firstFile = changedFiles[0];
    if (firstFile.includes('docs/') || firstFile.includes('decisions/')) {
      return tx.docs;
    }
    if (firstFile.includes('test') || firstFile.includes('spec')) {
      return tx.tests;
    }
    return tx.modules(changedFiles.slice(0, 2).join(', '));
  }

  return tx.planned;
}

export async function generatePRDraft(
  taskId?: string,
  taskTitle?: string,
  taskDescription?: string,
  branchName?: string
): Promise<{ title: string; description: string }> {
  const tx = rendererServiceText().commitDraft;
  const prTitle = taskId && taskTitle ? `${taskId}: ${taskTitle}` : `feat: ${branchName || tx.fallbackTitle}`;

  const prDesc = `## 📋 ${tx.prSummary}
${taskDescription || tx.prDefaultDescription(String(taskId || branchName))}

## 🔍 ${tx.prDone}
${tx.prDoneItems.map((item) => `- [x] ${item}`).join('\n')}

## 🔗 ${tx.prRelated}
- Backlog: ${taskId ? `\`${taskId}\`` : '—'}
`;

  return {
    title: prTitle,
    description: prDesc
  };
}
