/**
 * Диктовка промпта в поле ввода Agents Studio (TASK-275, decision-202).
 *
 * В режиме диктовки распознанные куски речи склеиваются в поле ввода активной вкладки, а не
 * разбираются как команды. Узнаются только служебные команды режима: «отправь», «очисти»,
 * «новая строка» и стоп-фраза диктовки. Фразы — из настроек голосовых команд, как у остальных
 * команд; стоп-фраза общая с системной диктовкой (`dictation_stop`).
 *
 * Чистый модуль без React и Electron — покрыт unit-тестами.
 */
import { CONFIGURABLE_COMMANDS } from './voiceCommandPhrases';
import { isFuzzyDictationStop, normalizeSpokenPhrase } from './dictationStopMatch';
import { matchWakeWord } from './wakeWord';

export type PromptDictationCommand = 'send' | 'clear' | 'newline' | 'stop';

/** Интенты каталога голосовых команд для каждой служебной команды режима. */
export const PROMPT_DICTATION_INTENTS: Readonly<Record<PromptDictationCommand, string>> = {
  send: 'prompt_dictation_send',
  clear: 'prompt_dictation_clear',
  newline: 'prompt_dictation_newline',
  stop: 'dictation_stop'
};

/**
 * Команды, которые узнаются и в конце фразы после знака препинания: «Проверь тесты. Отправь.»
 * Без знака конец фразы не отделяется — «напиши письмо и отправь» остаётся текстом. «Очисти» в
 * конце фразы стёрло бы и её саму, поэтому оно узнаётся только отдельной фразой.
 */
const TRAILING_COMMANDS: PromptDictationCommand[] = ['send', 'stop', 'newline'];

export interface PromptDictationInput {
  /** Пользовательские фразы команд (настройки голоса); нет — фразы по умолчанию. */
  phrases?: Record<string, string[]>;
  /** Ключевое слово включено: фраза с обращением может быть обычной командой приложения. */
  wakeWordEnabled?: boolean;
  wakeWordPhrases?: string[];
}

export type PromptDictationResult =
  /** Текст дописывается в поле, затем выполняется команда (если есть). */
  | { kind: 'dictate'; text: string; command: PromptDictationCommand | null }
  /** Фраза с ключевым словом, но не команда режима: её разбирает обычный конвейер команд. */
  | { kind: 'escape' }
  /** Пустая фраза или одно ключевое слово — ничего не делать. */
  | { kind: 'ignore' };

function phrasesFor(intent: string, custom?: Record<string, string[]>): string[] {
  const own = custom?.[intent];
  if (own && own.length > 0) return own;
  return CONFIGURABLE_COMMANDS.find((c) => c.intent === intent)?.defaultPhrases ?? [];
}

/** Вся фраза — служебная команда режима. Стоп-фраза узнаётся и с ошибкой распознавания. */
function matchWholeCommand(text: string, custom?: Record<string, string[]>): PromptDictationCommand | null {
  const spoken = normalizeSpokenPhrase(text);
  if (!spoken) return null;
  for (const command of Object.keys(PROMPT_DICTATION_INTENTS) as PromptDictationCommand[]) {
    const hit = phrasesFor(PROMPT_DICTATION_INTENTS[command], custom).some(
      (phrase) => normalizeSpokenPhrase(phrase) === spoken
    );
    if (hit) return command;
  }
  return isFuzzyDictationStop(text, custom) ? 'stop' : null;
}

/** «Текст. Отправь.» → текст и команда; конец без знака препинания перед ним не отделяется. */
function splitTrailingCommand(text: string, custom?: Record<string, string[]>): { text: string; command: PromptDictationCommand } | null {
  const trimmed = text.trim().replace(/[\s.!?…]+$/u, '');
  const boundary = Math.max(...['.', '!', '?', '…', ',', ';', ':', '—', '\n'].map((mark) => trimmed.lastIndexOf(mark)));
  if (boundary <= 0) return null;
  const tail = trimmed.slice(boundary + 1);
  const command = matchWholeCommand(tail, custom);
  if (!command || !TRAILING_COMMANDS.includes(command)) return null;
  const head = trimmed.slice(0, boundary + 1).trim();
  // Запятая перед командой — разделитель, а не часть текста: «Проверь тесты, отправь».
  return { text: head.replace(/[,;:—]$/u, '').trim(), command };
}

/** Что сделать с распознанной фразой, пока включена диктовка в поле. */
export function interpretPromptDictation(raw: string, input: PromptDictationInput = {}): PromptDictationResult {
  let text = (raw ?? '').trim();
  if (!text) return { kind: 'ignore' };

  // Диктуют прозу, поэтому обращение не требуется. Но «Хаб, отправь» — команда, а «Хаб, открой
  // гит» — обычная команда приложения, а не текст промпта.
  if (input.wakeWordEnabled) {
    const wake = matchWakeWord(text, input.wakeWordPhrases);
    if (wake.matched) {
      if (!wake.command) return { kind: 'ignore' };
      const command = matchWholeCommand(wake.command, input.phrases);
      return command ? { kind: 'dictate', text: '', command } : { kind: 'escape' };
    }
  }

  const whole = matchWholeCommand(text, input.phrases);
  if (whole) return { kind: 'dictate', text: '', command: whole };

  const trailing = splitTrailingCommand(text, input.phrases);
  if (trailing) return { kind: 'dictate', text: trailing.text, command: trailing.command };

  text = text.replace(/\s+/g, ' ');
  return { kind: 'dictate', text, command: null };
}

/**
 * Дописывает кусок к полю. Фразы рвутся по паузам (VAD), поэтому склейка — через пробел; знак
 * препинания в начале куска прилипает к предыдущему слову, после перевода строки пробел не нужен.
 */
export function appendDictationChunk(current: string, chunk: string): string {
  const piece = (chunk ?? '').trim();
  if (!piece) return current;
  if (!current.trim()) return piece;
  if (current.endsWith('\n')) return current + piece;
  if (/^[,.!?;:…)»]/u.test(piece)) return current.replace(/[ \t]+$/u, '') + piece;
  return `${current.replace(/[ \t]+$/u, '')} ${piece}`;
}

/** Команда «новая строка». Пустое поле не начинается с перевода строки. */
export function appendDictationNewline(current: string): string {
  if (!current.trim()) return current;
  return `${current.replace(/[ \t]+$/u, '')}\n`;
}

/**
 * Поле ввода, которое сейчас принимает диктовку. В окне одно поле Studio — у открытой вкладки;
 * поле регистрируется при монтировании. Возвращает, что сделано: отправлять пустое поле нечего.
 */
export interface PromptDictationTarget {
  apply(text: string, command: PromptDictationCommand | null): { sent: boolean };
}

let activeTarget: PromptDictationTarget | null = null;

export function registerPromptDictationTarget(target: PromptDictationTarget): () => void {
  activeTarget = target;
  return () => {
    if (activeTarget === target) activeTarget = null;
  };
}

export function getPromptDictationTarget(): PromptDictationTarget | null {
  return activeTarget;
}
