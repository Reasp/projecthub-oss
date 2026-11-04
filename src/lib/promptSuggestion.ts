/**
 * Подсказка следующего промпта Claude Code в поле ввода вкладки (TASK-294, decision-217). CLI присылает её после хода;
 * поле показывает её, пока человек ничего не набрал, и вставляет по Tab или клику. Модуль без React — покрыт unit-тестами.
 */

export interface PromptSuggestionView {
  suggestion: string | null | undefined;
  /** Текст поля ввода. */
  input: string;
  isStreaming: boolean;
  /** Открыт список автодополнения `@` или `/` — Tab принадлежит ему. */
  completionOpen: boolean;
}

/** Показать подсказку под полем: она есть, поле пусто, ход не идёт и список автодополнения закрыт. */
export function promptSuggestionShown(view: PromptSuggestionView): boolean {
  return !!view.suggestion?.trim() && view.input.length === 0 && !view.isStreaming && !view.completionOpen;
}

/** Tab без модификаторов вставляет показанную подсказку. */
export function acceptsPromptSuggestion(
  key: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  shown: boolean
): boolean {
  return shown && key.key === 'Tab' && !key.shiftKey && !key.ctrlKey && !key.altKey && !key.metaKey;
}
