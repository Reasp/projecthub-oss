/**
 * Заголовки и пояснения карточек HITL по коду (TASK-204, TASK-205). Один словарь на три клиента: окно ProjectHub
 * (`hitl.requestText`), мобильный клиент (`models.hitlText`) и main-процесс — системные уведомления и Telegram.
 *
 * Чистый модуль без React и Electron.
 */
import type { HitlTextLabels } from '../lib/agentStatusText';

const SYNC_DETAILS_EN = 'Merge the base branch into the agent worktree branch; the main tree and the base branch stay unchanged';
const SYNC_DETAILS_RU = 'Слияние основной ветки в ветку worktree агента; основное дерево и основная ветка не меняются';
const RUN_DETAILS_EN = 'Run the command in the agent working directory';
const RUN_DETAILS_RU = 'Выполнение команды в рабочем каталоге агента';

export const hitlRequestTextEn: HitlTextLabels = {
  titles: {
    file_write: 'Write file',
    file_write_excluded: '⚠️ File is on the exclusion list',
    command: 'Run command',
    command_denied: '⚠️ Command is on the deny list',
    process: 'Background process',
    sync_merge: 'Pull the base branch',
    sync_continue: 'Finish merging the base branch',
    sync_abort: 'Abort merging the base branch',
    read: 'Read',
    read_outside: 'Read',
    question: 'Question from Claude Code'
  },
  details: {
    file_write: 'Change the file contents',
    file_write_excluded: 'Change the file contents',
    command: RUN_DETAILS_EN,
    command_denied: RUN_DETAILS_EN,
    process: RUN_DETAILS_EN,
    sync_merge: SYNC_DETAILS_EN,
    sync_continue: SYNC_DETAILS_EN,
    sync_abort: SYNC_DETAILS_EN,
    read: 'Allow the agent to read {target}?',
    read_outside: '{target} is outside the agent working directory. Allow reading?',
    question: ''
  },
  readQuestion: { title: 'Read file', allow: 'Allow reading', deny: 'Deny reading' }
};

export const hitlRequestTextRu: HitlTextLabels = {
  titles: {
    file_write: 'Запись файла',
    file_write_excluded: '⚠️ Файл в списке исключений',
    command: 'Запуск команды',
    command_denied: '⚠️ Команда из списка запрещённых',
    process: 'Фоновый процесс',
    sync_merge: 'Подтянуть основную ветку',
    sync_continue: 'Завершить слияние основной ветки',
    sync_abort: 'Отменить слияние основной ветки',
    read: 'Чтение',
    read_outside: 'Чтение',
    question: 'Вопрос от Claude Code'
  },
  details: {
    file_write: 'Изменение содержимого файла',
    file_write_excluded: 'Изменение содержимого файла',
    command: RUN_DETAILS_RU,
    command_denied: RUN_DETAILS_RU,
    process: RUN_DETAILS_RU,
    sync_merge: SYNC_DETAILS_RU,
    sync_continue: SYNC_DETAILS_RU,
    sync_abort: SYNC_DETAILS_RU,
    read: 'Разрешить агенту прочитать {target}?',
    read_outside: 'Путь {target} вне рабочего каталога агента. Разрешить чтение?',
    question: ''
  },
  readQuestion: { title: 'Чтение файла', allow: 'Разрешить чтение', deny: 'Запретить чтение' }
};
