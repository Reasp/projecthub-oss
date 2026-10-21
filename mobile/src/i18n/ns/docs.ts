/** Раздел словаря «docs» (TASK-140.15, TASK-140.17): документация проекта на телефоне. */
export const en = {
  search: 'Search by title or ID',
  clearSearch: 'Clear search',
  documents: 'Documents',
  decisions: 'Decisions',
  emptyTitle: 'No documentation yet',
  emptyHint: 'Documents and decisions from backlog/docs and backlog/decisions will appear here.',
  noMatches: (query: string) => `Nothing matches “${query}”`,
  offlineList: 'No connection — showing the saved list. It may be outdated.',
  listError: 'Could not load the list from the computer',
  unsupportedHost: 'Update ProjectHub on the computer to read documentation from the phone.',
  loading: 'Loading the document…',
  checking: 'Checking for updates…',
  fresh: 'Up to date',
  savedCopy: (when: string) => `Saved copy from ${when}. The computer is unreachable, so it may be outdated.`,
  unavailableTitle: 'Not available offline',
  unavailableHint: 'Connect to the computer to open this document. Documents you have opened before stay available without a connection.',
  errorTitle: 'Could not open the document',
  missingRef: (id: string) => `${id} is not in this project’s documentation`,
  availableOffline: 'Available offline',
  changedOnComputer: 'Updated on the computer',
  kind: { doc: 'Document', decision: 'Decision' },
  status: {
    accepted: 'accepted',
    proposed: 'proposed',
    rejected: 'rejected',
    deprecated: 'deprecated'
  } as Record<string, string>
};

export const ru: typeof en = {
  search: 'Поиск по названию или id',
  clearSearch: 'Очистить поиск',
  documents: 'Документы',
  decisions: 'Решения',
  emptyTitle: 'Документации пока нет',
  emptyHint: 'Здесь появятся документы и решения из backlog/docs и backlog/decisions.',
  noMatches: (query: string) => `Ничего не найдено по «${query}»`,
  offlineList: 'Нет связи — показан сохранённый список. Он может быть устаревшим.',
  listError: 'Не удалось получить список с компьютера',
  unsupportedHost: 'Обновите ProjectHub на компьютере, чтобы читать документацию с телефона.',
  loading: 'Загрузка документа…',
  checking: 'Проверяем, не изменился ли…',
  fresh: 'Актуальная версия',
  savedCopy: (when: string) => `Сохранённая копия от ${when}. Компьютер недоступен — версия может быть устаревшей.`,
  unavailableTitle: 'Недоступен без связи',
  unavailableHint: 'Подключитесь к компьютеру, чтобы открыть документ. Открытые раньше документы доступны и без связи.',
  errorTitle: 'Не удалось открыть документ',
  missingRef: (id: string) => `${id} нет в документации этого проекта`,
  availableOffline: 'Доступен без связи',
  changedOnComputer: 'Изменён на компьютере',
  kind: { doc: 'Документ', decision: 'Решение' },
  status: {
    accepted: 'принято',
    proposed: 'предложено',
    rejected: 'отклонено',
    deprecated: 'устарело'
  }
};
