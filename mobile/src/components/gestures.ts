import { useRef, type PointerEvent as ReactPointerEvent, type RefObject, type TouchEvent as ReactTouchEvent } from 'react';

/**
 * Жесты мобильного клиента: свайп между вкладками и «потянуть для обновления».
 * Решение «был ли свайп» — чистая функция, чтобы её можно было проверить тестом.
 */

export type SwipeDirection = 'left' | 'right' | null;

/** Горизонтальный свайп: ≥ 60 px, заметно горизонтальнее вертикали и не дольше 600 мс. */
export function classifySwipe(dx: number, dy: number, durationMs: number): SwipeDirection {
  if (durationMs > 600) return null;
  if (Math.abs(dx) < 60) return null;
  if (Math.abs(dx) < Math.abs(dy) * 1.8) return null;
  return dx < 0 ? 'left' : 'right';
}

/** Сопротивление при оттягивании: чем дальше, тем туже. */
export function pullDistance(rawDy: number): number {
  if (rawDy <= 0) return 0;
  return Math.min(110, rawDy * 0.5);
}

export const PULL_TRIGGER = 64;

/** Элемент внутри области, которая сама прокручивается вбок (доска Kanban), — свайп не перехватываем. */
function insideHorizontalScroller(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-swipe-ignore]'));
}

export function useTabSwipe(onSwipe: (dir: 'left' | 'right') => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  return {
    onPointerDown(e: ReactPointerEvent) {
      if (e.pointerType === 'mouse' || insideHorizontalScroller(e.target)) {
        start.current = null;
        return;
      }
      start.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    onPointerUp(e: ReactPointerEvent) {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dir = classifySwipe(e.clientX - s.x, e.clientY - s.y, performance.now() - s.t);
      if (dir) onSwipe(dir);
    },
    onPointerCancel() {
      start.current = null;
    }
  };
}

/**
 * «Потянуть для обновления» для прокручиваемого контейнера: срабатывает, только если список уже
 * прокручен к началу.
 */
export function usePullToRefresh(scrollRef: RefObject<HTMLElement | null>, onPull: (distance: number) => void, onRelease: (triggered: boolean) => void) {
  const startY = useRef<number | null>(null);
  const distance = useRef(0);
  return {
    onTouchStart(e: ReactTouchEvent) {
      const el = scrollRef.current;
      startY.current = el && el.scrollTop <= 0 ? e.touches[0].clientY : null;
      distance.current = 0;
    },
    onTouchMove(e: ReactTouchEvent) {
      if (startY.current === null) return;
      distance.current = pullDistance(e.touches[0].clientY - startY.current);
      onPull(distance.current);
    },
    onTouchEnd() {
      if (startY.current === null) return;
      startY.current = null;
      onRelease(distance.current >= PULL_TRIGGER);
      distance.current = 0;
    }
  };
}
