/**
 * Редактор полей ввода на полэкрана (TASK-177, [[decision-132]]): чистая логика без React и браузерных API.
 */

/** Доля высоты экрана под редактор: верхняя половина — текст, нижняя — клавиатура. */
export const EDITOR_SCREEN_SHARE = 0.5;
/** Ниже этой высоты редактор не сжимается, даже если клавиатура съела больше половины экрана. */
export const EDITOR_MIN_HEIGHT = 180;

/**
 * Значение из редактора в исходное поле. Однострочное поле не примет перевод строки — он становится пробелом;
 * диктовка могла превысить `maxLength` — хвост отрезается.
 */
export function fitFieldValue(text: string, opts: { multiline: boolean; maxLength?: number }): string {
  const flat = opts.multiline ? text : text.replace(/\s*[\r\n]+\s*/g, ' ');
  return opts.maxLength !== undefined && opts.maxLength >= 0 ? flat.slice(0, opts.maxLength) : flat;
}

/**
 * Высота панели редактора: половина экрана, но не больше видимой области над клавиатурой (минус отступ, чтобы был
 * виден фон и его можно было нажать).
 */
export function editorPanelHeight(screenHeight: number, visibleHeight: number): number {
  const half = Math.round(screenHeight * EDITOR_SCREEN_SHARE);
  return Math.max(Math.min(EDITOR_MIN_HEIGHT, visibleHeight), Math.min(half, visibleHeight - 24));
}

/**
 * Поля открываются в редакторе только на сенсорном экране. На ПК (клиент `/remote` в браузере, Telegram Desktop)
 * поле остаётся обычным: там есть физическая клавиатура.
 */
export function expandsFields(matchMedia: ((query: string) => { matches: boolean }) | undefined): boolean {
  if (!matchMedia) return false;
  try {
    return matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
