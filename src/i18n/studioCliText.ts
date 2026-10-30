/**
 * Тексты диалога слеш-команд Claude Code в Agents Studio (TASK-230), en и ru. Свой словарь окна, без общего.
 */
import type { Language } from './types';

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
  rewindConversationDone: 'Conversation rewound. The next message continues from before the chosen one.'
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
  rewindConversationDone: 'Разговор откачен. Следующее сообщение продолжит его с места перед выбранной репликой.'
};

export const STUDIO_CLI_TEXT: Record<Language, StudioCliText> = { en, ru };

export function studioCliText(language: Language): StudioCliText {
  return STUDIO_CLI_TEXT[language] ?? en;
}
