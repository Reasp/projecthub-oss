/**
 * Встроенный заголовок окна (TASK-210): системной полосы нет, кнопки окна Windows и Linux рисуются поверх шапки
 * (`titleBarOverlay`). Окно узнаёт их место из Window Controls Overlay и отдаёт его CSS: класс `titlebar-overlay`
 * у `<html>` включает перетаскивание за шапку, переменные `--titlebar-inset-*` — отступ под кнопки окна.
 *
 * Без overlay (macOS, браузерный стенд, старый Chromium) ничего не меняется: шапка не перетаскивает окно.
 */

interface TitlebarOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

/** Отступы под кнопки окна: слева и справа от области заголовка. */
export function titlebarInsets(area: { x: number; width: number }, viewportWidth: number): { left: number; right: number } {
  return {
    left: Math.max(0, Math.round(area.x)),
    right: Math.max(0, Math.round(viewportWidth - area.x - area.width))
  };
}

export function installTitlebarOverlay(root: HTMLElement = document.documentElement): () => void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: TitlebarOverlay }).windowControlsOverlay;
  if (!overlay) return () => undefined;
  const apply = () => {
    if (!overlay.visible) {
      root.classList.remove('titlebar-overlay');
      root.style.removeProperty('--titlebar-inset-left');
      root.style.removeProperty('--titlebar-inset-right');
      return;
    }
    const insets = titlebarInsets(overlay.getTitlebarAreaRect(), window.innerWidth);
    root.classList.add('titlebar-overlay');
    root.style.setProperty('--titlebar-inset-left', `${insets.left}px`);
    root.style.setProperty('--titlebar-inset-right', `${insets.right}px`);
  };
  apply();
  overlay.addEventListener('geometrychange', apply);
  window.addEventListener('resize', apply);
  return () => {
    overlay.removeEventListener('geometrychange', apply);
    window.removeEventListener('resize', apply);
  };
}
