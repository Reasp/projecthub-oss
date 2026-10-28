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
    `Agents Studio runs Claude Code without a terminal, and Claude Code does not offer /${command} there. Continue this conversation in a ProjectHub terminal and run /${command} in it.`,
  remoteHint: 'To follow Agents Studio sessions from a phone, use ProjectHub Remote Control: the phone sees them without a terminal.',
  noSession: 'This tab has no Claude Code session yet — the terminal starts a new one.',
  openTerminal: 'Continue in terminal',
  close: 'Close'
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
    `Agents Studio запускает Claude Code без терминала, и там Claude Code не выполняет /${command}. Продолжите этот разговор в терминале ProjectHub и выполните /${command} в нём.`,
  remoteHint: 'Следить за сессиями Agents Studio с телефона можно через Remote Control ProjectHub: телефон видит их без терминала.',
  noSession: 'У вкладки ещё нет сессии Claude Code — терминал начнёт новую.',
  openTerminal: 'Продолжить в терминале',
  close: 'Закрыть'
};

export const STUDIO_CLI_TEXT: Record<Language, StudioCliText> = { en, ru };

export function studioCliText(language: Language): StudioCliText {
  return STUDIO_CLI_TEXT[language] ?? en;
}
