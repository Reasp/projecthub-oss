/** Раздел словаря «agents» (TASK-140.15): экран роёв и агентов. */
export const en = {
  outputTruncated: '… the beginning of the output is not shown\n\n',
  noOutput: 'No output yet.',
  startTitle: 'Start an agent',
  startOnComputer: 'Start on computer',
  task: 'Task',
  chooseTask: 'Choose a task',
  role: 'Role',
  chooseRole: 'Choose a role',
  noRoles: 'No roles',
  promptLabel: 'Prompt (optional)',
  promptPlaceholder: (taskId: string) => `Complete task ${taskId}.`,
  worktreeHint: 'The agent works in a separate worktree on the computer; the engine and model come from the role.',
  stop: 'Stop',
  startTask: 'Run a task with an agent',
  emptyTitle: 'No agents have run yet',
  emptyHint: 'Swarms and assigned tasks of this project will appear here.',
  running: 'Running',
  finished: 'Finished',
  stopConfirmTitle: 'Stop the agents?'
};

export const ru: typeof en = {
  outputTruncated: '… начало вывода не показано\n\n',
  noOutput: 'Вывода пока нет.',
  startTitle: 'Запустить агента',
  startOnComputer: 'Запустить на ПК',
  task: 'Задача',
  chooseTask: 'Выберите задачу',
  role: 'Роль',
  chooseRole: 'Выберите роль',
  noRoles: 'Ролей нет',
  promptLabel: 'Промпт (необязательно)',
  promptPlaceholder: (taskId: string) => `Выполни задачу ${taskId}.`,
  worktreeHint: 'Агент работает в отдельном worktree на ПК, движок и модель — из роли.',
  stop: 'Остановить',
  startTask: 'Запустить задачу агентом',
  emptyTitle: 'Агенты не запускались',
  emptyHint: 'Рои и назначенные задачи этого проекта появятся здесь.',
  running: 'Работают',
  finished: 'Завершённые',
  stopConfirmTitle: 'Остановить агентов?'
};
