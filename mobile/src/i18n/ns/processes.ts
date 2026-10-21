/** Раздел словаря «processes» (TASK-140.15): процессы проекта, логи, действия `.projecthub.json`. */
export const en = {
  status: {
    running: 'running',
    stopped: 'stopped',
    failed: 'crashed',
    unknown: 'unknown'
  },
  noLogs: 'No logs yet.',
  reload: 'Reload',
  toEnd: 'Jump to end',
  projectActions: 'Project actions',
  tests: 'Tests',
  processes: 'Processes',
  emptyTitle: 'No processes',
  emptyHint: 'Running dev servers and watchers will appear here.',
  port: (port: number) => `port ${port}`,
  stop: 'Stop',
  restart: 'Restart',
  start: 'Start',
  deployTitle: 'Run deploy?',
  deployBody: 'The deploy command from .projecthub.json will run on the computer.',
  deployConfirm: 'Run'
};

export const ru: typeof en = {
  status: {
    running: 'работает',
    stopped: 'остановлен',
    failed: 'упал',
    unknown: 'неизвестно'
  },
  noLogs: 'Логов пока нет.',
  reload: 'Перечитать',
  toEnd: 'К концу',
  projectActions: 'Действия проекта',
  tests: 'Тесты',
  processes: 'Процессы',
  emptyTitle: 'Нет процессов',
  emptyHint: 'Запущенные dev-серверы и вотчеры появятся здесь.',
  port: (port: number) => `порт ${port}`,
  stop: 'Стоп',
  restart: 'Перезапуск',
  start: 'Запустить',
  deployTitle: 'Запустить deploy?',
  deployBody: 'Команда deploy из .projecthub.json выполнится на ПК.',
  deployConfirm: 'Запустить'
};
