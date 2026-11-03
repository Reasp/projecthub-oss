/**
 * Тексты диалога слеш-команд Claude Code в Agents Studio (TASK-230), en и ru. Свой словарь окна, без общего.
 */
import type { Language } from './types';
import type { StudioCommandName } from '../lib/studioCliCommands';

const en = {
  resumeTitle: 'Resume a Claude Code session',
  resumeHint: 'Sessions of Claude Code in this folder under the tab’s account. The next message of this tab continues the chosen one.',
  loading: 'Loading…',
  empty: 'No Claude Code sessions in this folder yet.',
  current: 'current',
  untitled: '(no text)',
  attached: 'The next message continues this session.',
  terminalTitle: (command: string) => `/${command} needs a terminal`,
  terminalHint: (command: string) =>
    `Agents Studio runs Claude Code without a terminal, and Claude Code does not offer /${command} there. “Continue in terminal” opens this conversation in a ProjectHub terminal and runs /${command} in it.`,
  remoteHint: 'To follow Agents Studio sessions from a phone, use ProjectHub Remote Control: the phone sees them without a terminal.',
  noSession: 'This tab has no Claude Code session yet — the terminal starts a new one.',
  openTerminal: 'Continue in terminal',
  close: 'Close',
  forkTitle: (title: string) => `${title} (branch)`,
  forkNothing: 'This tab has no Claude Code conversation yet, so there is nothing to branch. Send a message first.',
  btwTitle: 'Side question',
  btwHint: 'Answered from this tab’s conversation without tools. Neither the question nor the answer is added to it.',
  btwUsage: 'Type the question after /btw, for example: /btw which file did we change last?',
  btwAnswering: 'Answering…',
  btwStop: 'Stop',
  rewindTitle: 'Rewind',
  rewindHint:
    'Pick the message to go back to. The conversation continues from just before it in a new Claude Code session; the original session stays intact. The message returns to the input field.',
  rewindAction: 'Rewind to here',
  rewindNoSession: 'This tab has no Claude Code conversation yet — there is nothing to rewind.',
  rewindEmpty: 'No messages to rewind to in this conversation.',
  rewindStreaming: 'Wait for the current reply to finish or stop it first.',
  rewindFilesLoading: 'Checking files…',
  rewindNoFiles: 'Files: nothing to restore — the agent has not changed files after this message, or they are already as they were.',
  rewindFilesTitle: (n: number) => `Files the rewind will restore (${n}):`,
  rewindFilesWarning:
    'Restoring code returns these files to their state before the message. Changes made in them later, including your own, are lost. Other files are not touched.',
  rewindChange: { modify: 'restore content', delete: 'delete (created later)', restore: 'bring back (deleted later)' } as Record<'modify' | 'delete' | 'restore', string>,
  rewindConversation: 'Restore conversation',
  rewindBoth: 'Restore code and conversation',
  rewindCodeOnly: 'Restore code only',
  cancel: 'Cancel',
  rewindFilesDone: (n: number) => `Files restored to their state before the message (${n}).`,
  rewindFilesFailed: (detail: string) => `Claude Code could not restore the files: ${detail}`,
  rewindConversationDone: 'Conversation rewound. The next message continues from before the chosen one.',
  addDirTitle: 'Additional directories',
  addDirAdded: (dir: string) =>
    `Added ${dir}. Claude Code in this tab can read it from the next message; every change to its files waits for your approval.`,
  addDirExists: (dir: string) => `${dir} is already added to this tab.`,
  addDirLimit: (max: number) => `A tab can have up to ${max} additional directories. Remove one first.`,
  addDirFailed: (dir: string, reason: 'empty' | 'notFound' | 'notDirectory' | 'insideWorkDir') =>
    reason === 'insideWorkDir'
      ? `${dir} is inside the tab’s folder — Claude Code already has access to it.`
      : reason === 'notDirectory'
        ? `${dir} is not a directory.`
        : reason === 'empty'
          ? 'Type the path after /add-dir, or send /add-dir alone to pick a directory.'
          : `Directory ${dir} was not found.`,
  addDirHint: 'Claude Code in this tab runs with --add-dir for these directories. Reading is allowed; changes need your approval.',
  addDirRemove: (dir: string) => `Remove ${dir}`,
  addDirMore: 'Add directory',
  bgTitle: 'Background tasks',
  bgWaiting: 'The reply is done, but the turn waits for these tasks: Claude Code reports their result when they finish. Stop them to end the turn now.',
  bgKind: { shell: 'Command', agent: 'Agent', mcp: 'MCP', workflow: 'Workflow', other: 'Task' } as Record<'shell' | 'agent' | 'mcp' | 'workflow' | 'other', string>,
  bgStatus: { running: 'running', completed: 'finished', failed: 'failed', stopped: 'stopped' } as Record<'running' | 'completed' | 'failed' | 'stopped', string>,
  bgShowOutput: 'Output',
  bgHideOutput: 'Hide output',
  bgStop: 'Stop',
  bgStopAll: 'Stop all',
  bgStopFailed: 'Could not stop the task: Claude Code did not accept the request.',
  bgOutputEmpty: 'No output yet.',
  bgOutputUnavailable: 'Output is no longer available: the turn has ended.',
  bgOutputTruncated: (kib: number) => `Last 8 KiB of ${kib} KiB`,
  memoryTitle: 'Claude Code memory',
  memoryHint: 'Instruction files and saved memories that Claude Code loads in this tab, for its account and folder. Changes apply from the next message.',
  memoryLoading: 'Asking Claude Code for its memory files…',
  memoryFailed: (reason: 'start' | 'timeout' | 'cli'): string =>
    reason === 'start'
      ? 'Could not start Claude Code.'
      : reason === 'timeout'
        ? 'Claude Code did not answer in time.'
        : 'Claude Code did not return its memory files. Update Claude Code and try again.',
  memoryFiles: 'Instruction files',
  memorySaved: 'Saved memories',
  memoryFolders: 'Folders',
  memoryNoSaved: 'No saved memories yet.',
  memoryIndex: 'Index of saved memories',
  memoryAuto: (enabled: boolean): string => (enabled ? 'Auto-memory: on' : 'Auto-memory: off'),
  memoryFileKind: {
    user: 'User instructions',
    project: 'Project instructions',
    'project-alt': 'Project instructions (.claude)',
    local: 'Local instructions',
    other: ''
  } as Record<'user' | 'project' | 'project-alt' | 'local' | 'other', string>,
  memoryFolderKind: { auto: 'Auto-memory folder', team: 'Team memory folder', agent: '' } as Record<'auto' | 'team' | 'agent', string>,
  memoryType: { user: 'user', feedback: 'feedback', project: 'project', reference: 'reference' } as Record<
    'user' | 'feedback' | 'project' | 'reference',
    string
  >,
  memoryNotCreated: 'not created',
  memoryCreateHint: 'The file does not exist yet. Saving creates it.',
  memorySelect: 'Select a file to view and edit it.',
  memorySave: 'Save',
  memorySavedOk: 'Saved',
  memorySaveFailed: 'Could not save the file.',
  memoryReadFailed: (reason: 'denied' | 'tooLarge' | 'io'): string =>
    reason === 'denied'
      ? 'This file is no longer in the Claude Code memory list. Refresh the list.'
      : reason === 'tooLarge'
        ? 'The file is too large to edit here (over 2 MB).'
        : 'Could not read the file.',
  memoryUnsaved: 'Discard unsaved changes in this file?',
  memoryRefresh: 'Refresh',
  memoryOpenFolder: 'Open folder',
  statusTitle: 'Session status',
  statusHint: 'This tab and its Claude Code session. The Claude Code part is what /status shows in the terminal.',
  statusTab: 'Agents Studio tab',
  statusTabTitle: 'Tab',
  statusSession: 'Claude Code session',
  statusNoSession: 'not started yet: the first message starts it',
  statusCopy: 'Copy session ID',
  statusCopied: 'Copied',
  statusFolder: 'Folder',
  statusAddDirs: 'Added folders',
  statusAccount: 'Account',
  statusAccountDefault: 'default for this project',
  statusModel: 'Model',
  statusModelDefault: 'model default',
  statusEffort: 'Reasoning effort',
  statusMode: 'Mode',
  statusLoading: 'Asking Claude Code for its status…',
  statusFailed: (reason: 'start' | 'timeout' | 'cli'): string =>
    reason === 'start'
      ? 'Could not start Claude Code. Check that it is installed.'
      : reason === 'timeout'
        ? 'Claude Code did not answer in 30 seconds.'
        : 'Claude Code did not return its status. Update Claude Code and try again.',
  statusNewSession: 'Claude Code did not find this tab’s conversation for this account and folder, so it shows a new session.',
  statusCliSection: (title: string): string => (title ? `Claude Code · ${title}` : 'Claude Code'),
  helpTitle: 'Commands',
  helpHint: 'Slash commands of this Claude Code tab and who runs each of them. Click a command to put it into the message.',
  helpFilter: 'Filter commands',
  helpStudio: 'Agents Studio runs',
  helpCli: 'Claude Code runs',
  helpTerminal: 'Need a terminal',
  helpTerminalHint: 'Agents Studio continues the conversation in a ProjectHub terminal and runs the command there.',
  helpCliLoading: 'Asking Claude Code for its commands…',
  helpCliFailed: (reason: 'start' | 'timeout' | 'cli'): string =>
    reason === 'start'
      ? 'Could not start Claude Code. Check that it is installed.'
      : reason === 'timeout'
        ? 'Claude Code did not answer in 30 seconds.'
        : 'Claude Code did not return its commands. Update Claude Code and try again.',
  helpNoMatch: 'No commands match.',
  helpVersion: (version: string): string => `Claude Code ${version}`,
  copyAction: 'Copy reply',
  copied: 'Copied',
  copyDone: (n: number): string => (n === 1 ? 'The last reply is copied to the clipboard.' : `Reply ${n} from the end is copied to the clipboard.`),
  copyNothing: (total: number): string => (total ? `This tab has ${total} replies — pick a number from 1 to ${total}.` : 'No reply to copy yet.'),
  copyUsage: 'Type the reply number from the end after /copy, for example: /copy 2. Without a number — the last reply.',
  copyFailed: 'Could not write to the clipboard.',
  exportAction: 'Export conversation',
  exportNothing: 'This tab has no messages yet — there is nothing to export.',
  exportDone: (file: string, format: 'markdown' | 'cli'): string =>
    format === 'cli' ? `Claude Code transcript saved to ${file}` : `Conversation saved to ${file}`,
  exportFailed: (reason: 'start' | 'timeout' | 'cli' | 'io'): string =>
    reason === 'io'
      ? 'Could not save the file.'
      : reason === 'start'
        ? 'Could not start Claude Code for its transcript. Save as Markdown instead.'
        : reason === 'timeout'
          ? 'Claude Code did not return the transcript in 30 seconds.'
          : 'Claude Code did not return the transcript of this tab’s session. Save as Markdown instead.',
  exportLabels: {
    user: 'You',
    assistant: 'Assistant',
    system: 'System',
    tools: 'Agent steps ({count})',
    thinking: 'Thinking',
    error: 'Error',
    exported: 'Exported from ProjectHub Agents Studio on {date}'
  },
  helpCommand: {
    resume: 'Pick a Claude Code session to continue in this tab',
    plan: 'Switch the tab to plan mode; with a task, plan it right away',
    fork: 'Open a copy of this conversation in a new tab',
    branch: 'Same as /fork',
    btw: 'Ask a side question; the answer does not go into the conversation',
    rewind: 'Roll the conversation, and the code if you confirm, back to a message',
    'add-dir': 'Give this tab access to another folder',
    memory: 'View and edit the Claude Code memory files of this tab',
    copy: 'Copy the last reply, or reply N from the end, to the clipboard',
    export: 'Save this conversation as Markdown, or as the Claude Code transcript',
    status: 'Show this tab and its Claude Code session',
    help: 'Show all commands and who runs each of them'
  } as Record<StudioCommandName, string>
};

export type StudioCliText = typeof en;

const ru: StudioCliText = {
  resumeTitle: 'Продолжить сессию Claude Code',
  resumeHint: 'Сессии Claude Code в этой папке под аккаунтом вкладки. Следующее сообщение вкладки продолжит выбранную.',
  loading: 'Загрузка…',
  empty: 'В этой папке ещё нет сессий Claude Code.',
  current: 'текущая',
  untitled: '(без текста)',
  attached: 'Следующее сообщение продолжит эту сессию.',
  terminalTitle: (command) => `/${command} работает только в терминале`,
  terminalHint: (command) =>
    `Agents Studio запускает Claude Code без терминала, и там Claude Code не выполняет /${command}. «Продолжить в терминале» откроет этот разговор в терминале ProjectHub и выполнит в нём /${command}.`,
  remoteHint: 'Следить за сессиями Agents Studio с телефона можно через Remote Control ProjectHub: телефон видит их без терминала.',
  noSession: 'У вкладки ещё нет сессии Claude Code — терминал начнёт новую.',
  openTerminal: 'Продолжить в терминале',
  close: 'Закрыть',
  forkTitle: (title) => `${title} (ветка)`,
  forkNothing: 'У вкладки ещё нет разговора Claude Code — ответвлять нечего. Сначала отправьте сообщение.',
  btwTitle: 'Побочный вопрос',
  btwHint: 'Ответ по разговору вкладки, без инструментов. Ни вопрос, ни ответ в разговор не попадают.',
  btwUsage: 'Напишите вопрос после /btw, например: /btw какой файл мы меняли последним?',
  btwAnswering: 'Отвечает…',
  btwStop: 'Остановить',
  rewindTitle: 'Откат',
  rewindHint:
    'Выберите реплику, к которой вернуться. Разговор продолжится с места перед ней в новой сессии Claude Code, исходная сессия не меняется. Реплика вернётся в поле ввода.',
  rewindAction: 'Откатить к этой реплике',
  rewindNoSession: 'У вкладки ещё нет разговора Claude Code — откатывать нечего.',
  rewindEmpty: 'В этом разговоре нет реплик для отката.',
  rewindStreaming: 'Дождитесь конца ответа или остановите его.',
  rewindFilesLoading: 'Проверяю файлы…',
  rewindNoFiles: 'Файлы: возвращать нечего — после этой реплики агент файлы не менял, или они уже в прежнем виде.',
  rewindFilesTitle: (n) => `Файлы, которые вернёт откат (${n}):`,
  rewindFilesWarning:
    'Откат кода возвращает эти файлы к состоянию перед репликой. Изменения, сделанные в них позже, в том числе ваши, пропадут. Другие файлы не трогаются.',
  rewindChange: { modify: 'вернуть содержимое', delete: 'удалить (создан позже)', restore: 'вернуть (удалён позже)' },
  rewindConversation: 'Откатить разговор',
  rewindBoth: 'Откатить код и разговор',
  rewindCodeOnly: 'Откатить только код',
  cancel: 'Отмена',
  rewindFilesDone: (n) => `Файлы возвращены к состоянию перед репликой (${n}).`,
  rewindFilesFailed: (detail) => `Claude Code не смог вернуть файлы: ${detail}`,
  rewindConversationDone: 'Разговор откачен. Следующее сообщение продолжит его с места перед выбранной репликой.',
  addDirTitle: 'Дополнительные каталоги',
  addDirAdded: (dir) =>
    `Каталог ${dir} добавлен. Claude Code этой вкладки читает его со следующего сообщения; любое изменение его файлов ждёт вашего одобрения.`,
  addDirExists: (dir) => `Каталог ${dir} уже добавлен вкладке.`,
  addDirLimit: (max) => `У вкладки может быть не больше ${max} дополнительных каталогов. Сначала уберите какой-нибудь.`,
  addDirFailed: (dir, reason) =>
    reason === 'insideWorkDir'
      ? `${dir} внутри папки вкладки — доступ к нему у Claude Code уже есть.`
      : reason === 'notDirectory'
        ? `${dir} — не каталог.`
        : reason === 'empty'
          ? 'Напишите путь после /add-dir или отправьте /add-dir без пути, чтобы выбрать каталог.'
          : `Каталог ${dir} не найден.`,
  addDirHint: 'Claude Code этой вкладки запускается с --add-dir для этих каталогов. Чтение разрешено, изменения — с вашего одобрения.',
  addDirRemove: (dir) => `Убрать ${dir}`,
  addDirMore: 'Добавить каталог',
  bgTitle: 'Фоновые задачи',
  bgWaiting: 'Ответ готов, но ход ждёт эти задачи: когда они закончатся, Claude Code сообщит результат. Остановите их, чтобы закончить ход сейчас.',
  bgKind: { shell: 'Команда', agent: 'Агент', mcp: 'MCP', workflow: 'Workflow', other: 'Задача' },
  bgStatus: { running: 'идёт', completed: 'завершена', failed: 'ошибка', stopped: 'остановлена' },
  bgShowOutput: 'Вывод',
  bgHideOutput: 'Скрыть вывод',
  bgStop: 'Остановить',
  bgStopAll: 'Остановить все',
  bgStopFailed: 'Не удалось остановить задачу: Claude Code не принял запрос.',
  bgOutputEmpty: 'Вывода пока нет.',
  bgOutputUnavailable: 'Вывод больше недоступен: ход закончился.',
  bgOutputTruncated: (kib) => `Последние 8 КиБ из ${kib} КиБ`,
  memoryTitle: 'Память Claude Code',
  memoryHint: 'Файлы инструкций и сохранённая память, которые Claude Code загружает в этой вкладке — для её аккаунта и каталога. Изменения действуют со следующего сообщения.',
  memoryLoading: 'Запрашиваю у Claude Code файлы памяти…',
  memoryFailed: (reason) =>
    reason === 'start'
      ? 'Не удалось запустить Claude Code.'
      : reason === 'timeout'
        ? 'Claude Code не ответил вовремя.'
        : 'Claude Code не вернул файлы памяти. Обновите Claude Code и повторите.',
  memoryFiles: 'Файлы инструкций',
  memorySaved: 'Сохранённая память',
  memoryFolders: 'Папки',
  memoryNoSaved: 'Сохранённой памяти пока нет.',
  memoryIndex: 'Указатель сохранённой памяти',
  memoryAuto: (enabled) => (enabled ? 'Автопамять: включена' : 'Автопамять: выключена'),
  memoryFileKind: {
    user: 'Инструкции пользователя',
    project: 'Инструкции проекта',
    'project-alt': 'Инструкции проекта (.claude)',
    local: 'Локальные инструкции',
    other: ''
  },
  memoryFolderKind: { auto: 'Папка автопамяти', team: 'Папка командной памяти', agent: '' },
  memoryType: { user: 'пользователь', feedback: 'отзыв', project: 'проект', reference: 'ссылка' },
  memoryNotCreated: 'не создан',
  memoryCreateHint: 'Файла пока нет. Сохранение создаст его.',
  memorySelect: 'Выберите файл, чтобы посмотреть и изменить его.',
  memorySave: 'Сохранить',
  memorySavedOk: 'Сохранено',
  memorySaveFailed: 'Не удалось сохранить файл.',
  memoryReadFailed: (reason) =>
    reason === 'denied'
      ? 'Этого файла больше нет в списке памяти Claude Code. Обновите список.'
      : reason === 'tooLarge'
        ? 'Файл слишком большой для правки здесь (больше 2 МБ).'
        : 'Не удалось прочитать файл.',
  memoryUnsaved: 'Отменить несохранённые изменения в этом файле?',
  memoryRefresh: 'Обновить',
  memoryOpenFolder: 'Открыть папку',
  statusTitle: 'Состояние сессии',
  statusHint: 'Эта вкладка и её сессия Claude Code. Часть Claude Code — то же, что /status показывает в терминале.',
  statusTab: 'Вкладка Agents Studio',
  statusTabTitle: 'Вкладка',
  statusSession: 'Сессия Claude Code',
  statusNoSession: 'ещё не начата: её начнёт первое сообщение',
  statusCopy: 'Скопировать id сессии',
  statusCopied: 'Скопировано',
  statusFolder: 'Папка',
  statusAddDirs: 'Добавленные папки',
  statusAccount: 'Аккаунт',
  statusAccountDefault: 'по умолчанию для проекта',
  statusModel: 'Модель',
  statusModelDefault: 'по умолчанию модели',
  statusEffort: 'Усилие рассуждений',
  statusMode: 'Режим',
  statusLoading: 'Запрашиваю у Claude Code состояние…',
  statusFailed: (reason) =>
    reason === 'start'
      ? 'Не удалось запустить Claude Code. Проверьте, что он установлен.'
      : reason === 'timeout'
        ? 'Claude Code не ответил за 30 секунд.'
        : 'Claude Code не вернул состояние. Обновите Claude Code и попробуйте снова.',
  statusNewSession: 'Claude Code не нашёл разговор этой вкладки для этого аккаунта и папки и показывает новую сессию.',
  statusCliSection: (title) => (title ? `Claude Code · ${title}` : 'Claude Code'),
  helpTitle: 'Команды',
  helpHint: 'Слеш-команды этой вкладки Claude Code и кто их выполняет. Щелчок по команде вставит её в сообщение.',
  helpFilter: 'Найти команду',
  helpStudio: 'Выполняет Agents Studio',
  helpCli: 'Выполняет Claude Code',
  helpTerminal: 'Нужен терминал',
  helpTerminalHint: 'Agents Studio продолжит разговор в терминале ProjectHub и выполнит команду там.',
  helpCliLoading: 'Запрашиваю у Claude Code список команд…',
  helpCliFailed: (reason) =>
    reason === 'start'
      ? 'Не удалось запустить Claude Code. Проверьте, что он установлен.'
      : reason === 'timeout'
        ? 'Claude Code не ответил за 30 секунд.'
        : 'Claude Code не вернул список команд. Обновите Claude Code и попробуйте снова.',
  helpNoMatch: 'Таких команд нет.',
  helpVersion: (version) => `Claude Code ${version}`,
  copyAction: 'Скопировать ответ',
  copied: 'Скопировано',
  copyDone: (n) => (n === 1 ? 'Последний ответ скопирован в буфер обмена.' : `Ответ ${n} с конца скопирован в буфер обмена.`),
  copyNothing: (total) => (total ? `Ответов во вкладке: ${total} — укажите номер от 1 до ${total}.` : 'Копировать пока нечего — ответов нет.'),
  copyUsage: 'Напишите после /copy номер ответа с конца, например: /copy 2. Без номера — последний ответ.',
  copyFailed: 'Не удалось записать в буфер обмена.',
  exportAction: 'Экспорт переписки',
  exportNothing: 'Во вкладке ещё нет сообщений — экспортировать нечего.',
  exportDone: (file, format) => (format === 'cli' ? `Расшифровка Claude Code сохранена в ${file}` : `Переписка сохранена в ${file}`),
  exportFailed: (reason) =>
    reason === 'io'
      ? 'Не удалось сохранить файл.'
      : reason === 'start'
        ? 'Не удалось запустить Claude Code для расшифровки. Сохраните переписку в Markdown.'
        : reason === 'timeout'
          ? 'Claude Code не вернул расшифровку за 30 секунд.'
          : 'Claude Code не вернул расшифровку сессии этой вкладки. Сохраните переписку в Markdown.',
  exportLabels: {
    user: 'Вы',
    assistant: 'Ассистент',
    system: 'Система',
    tools: 'Шаги агента ({count})',
    thinking: 'Рассуждения',
    error: 'Ошибка',
    exported: 'Экспорт из Agents Studio ProjectHub, {date}'
  },
  helpCommand: {
    resume: 'Выбрать сессию Claude Code и продолжить её в этой вкладке',
    plan: 'Перевести вкладку в режим плана; с задачей — сразу спланировать её',
    fork: 'Открыть копию этого разговора в новой вкладке',
    branch: 'То же, что /fork',
    btw: 'Задать побочный вопрос; ответ не попадёт в разговор',
    rewind: 'Откатить разговор, а по подтверждению и код, к реплике',
    'add-dir': 'Дать вкладке доступ к другой папке',
    memory: 'Посмотреть и поправить файлы памяти Claude Code этой вкладки',
    copy: 'Скопировать в буфер последний ответ или ответ N с конца',
    export: 'Сохранить переписку в Markdown или расшифровкой Claude Code',
    status: 'Показать эту вкладку и её сессию Claude Code',
    help: 'Показать все команды и кто их выполняет'
  }
};

export const STUDIO_CLI_TEXT: Record<Language, StudioCliText> = { en, ru };

export function studioCliText(language: Language): StudioCliText {
  return STUDIO_CLI_TEXT[language] ?? en;
}
