/**
 * Esc во вкладке Agents Studio, как в терминальном Claude Code (TASK-299): во время хода — прервать ход, Esc Esc при
 * пустом поле — окно отката. Здесь только решение: слушатель в поле ввода передаёт состояние и признаки события.
 */

/** Второй Esc в пределах этого интервала после первого — двойное нажатие. */
export const STUDIO_ESC_DOUBLE_MS = 800;

export type StudioEscAction =
  /** Прервать ход вкладки (как кнопка «Стоп»). */
  | 'abort'
  /** Открыть окно отката. */
  | 'rewind'
  /** Первый Esc из двух: запомнить время и показать подсказку. */
  | 'arm'
  /** Не наш Esc. */
  | 'none';

export interface StudioEscState {
  streaming: boolean;
  inputEmpty: boolean;
  /** Во вкладке есть разговор Claude Code, который можно откатить. */
  canRewind: boolean;
  /** Время прошлого «первого» Esc или `null`. */
  armedAt: number | null;
  now: number;
}

export function studioEscAction(state: StudioEscState): StudioEscAction {
  if (state.streaming) return 'abort';
  if (!state.inputEmpty || !state.canRewind) return 'none';
  if (state.armedAt !== null && state.now - state.armedAt <= STUDIO_ESC_DOUBLE_MS) return 'rewind';
  return 'arm';
}

/** Признаки события клавиатуры, нужные для решения (подмножество `KeyboardEvent`). */
export interface StudioEscEvent {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  defaultPrevented?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Esc без модификаторов, не из IME (набор иероглифов закрывается своим Esc) и не повтор зажатой клавиши. Esc, который
 * уже обработал кто-то другой (`defaultPrevented`), не наш.
 */
export function isPlainEscape(e: StudioEscEvent): boolean {
  if (e.key !== 'Escape') return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.repeat || e.defaultPrevented) return false;
  return !(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey);
}

/**
 * Что поверх Studio закрывается своим Esc: модальные окна (портал в `body` на весь экран), меню, списки выбора и
 * диалоги. Пока такое открыто, Esc принадлежит ему — ход не прерывается.
 */
export const STUDIO_ESC_OVERLAY_SELECTOR = [
  'body > .fixed.inset-0',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]'
].join(', ');

export function hasEscOverlay(root: { querySelector(selector: string): unknown }): boolean {
  return !!root.querySelector(STUDIO_ESC_OVERLAY_SELECTOR);
}
