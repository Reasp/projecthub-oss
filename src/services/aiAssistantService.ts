/**
 * Шаблоны коммита и PR без модели (TASK-134.4: кнопки «AI» для них остаются шаблонами).
 * Черновик задачи моделью — `window.api.generateTaskDraft` (назначение «Черновик описания задачи»).
 */

export async function generateCommitMessage(
  taskId?: string,
  taskTitle?: string,
  changedFiles?: string[]
): Promise<string> {
  if (taskId && taskTitle) {
    return `feat(${taskId}): ${taskTitle.toLowerCase()}`;
  }

  if (changedFiles && changedFiles.length > 0) {
    const firstFile = changedFiles[0];
    if (firstFile.includes('docs/') || firstFile.includes('decisions/')) {
      return 'docs: обновление документации и архитектурных решений';
    }
    if (firstFile.includes('test') || firstFile.includes('spec')) {
      return 'test: добавление модульных тестов';
    }
    return `feat: обновление модулей (${changedFiles.slice(0, 2).join(', ')})`;
  }

  return 'feat: реализация запланированных изменений';
}

export async function generatePRDraft(
  taskId?: string,
  taskTitle?: string,
  taskDescription?: string,
  branchName?: string
): Promise<{ title: string; description: string }> {
  const prTitle = taskId && taskTitle ? `${taskId}: ${taskTitle}` : `feat: ${branchName || 'новые изменения'}`;

  const prDesc = `## 📋 Описание изменений
${taskDescription || `В данном Pull Request реализованы изменения по задаче ${taskId || branchName}.`}

## 🔍 Что сделано:
- [x] Реализована логика модуля
- [x] Проверена совместимость с существующей архитектурой
- [x] Протестирована сборка и отсутствие ошибок

## 🔗 Связанные задачи:
- Backlog: ${taskId ? `\`${taskId}\`` : '—'}
`;

  return {
    title: prTitle,
    description: prDesc
  };
}
