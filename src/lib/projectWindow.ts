/**
 * Окно проекта, вынесенное из вкладки (TASK-295, [[decision-201]]): адрес окна, порядок вкладок и место нового окна.
 * Чистый модуль без React и Electron — его используют рендерер и main.
 */

/** Хэш адреса окна проекта: `#/project-window?path=<путь>`, как `#/voice-overlay` у оверлея голоса. */
export const PROJECT_WINDOW_ROUTE = '/project-window';

export function buildProjectWindowHash(projectPath: string): string {
  return `${PROJECT_WINDOW_ROUTE}?path=${encodeURIComponent(projectPath)}`;
}

/** Путь проекта из хэша окна (`#/project-window?path=…` или без `#`); не окно проекта — `null`. */
export function parseProjectWindowHash(hash: string): string | null {
  const route = hash.replace(/^#/, '');
  if (!route.startsWith(`${PROJECT_WINDOW_ROUTE}?`)) return null;
  const value = new URLSearchParams(route.slice(PROJECT_WINDOW_ROUTE.length + 1)).get('path');
  return value && value.trim() ? value : null;
}

/** Открытые проекты в порядке вкладок: порядок задаёт список открытых путей, а не каталог. */
export function orderProjectsByPaths<T extends { path: string }>(projects: T[], paths: string[]): T[] {
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const ordered: T[] = [];
  for (const p of paths) {
    const project = byPath.get(p);
    if (project) ordered.push(project);
  }
  return ordered;
}

/**
 * Перенос вкладки `from` на место вкладки `to`: при движении вправо она встаёт после `to`, влево — перед ней,
 * как в браузере. Неизвестный путь или перенос на себя — список без изменений.
 */
export function moveTab(paths: string[], from: string, to: string): string[] {
  const fromIdx = paths.indexOf(from);
  const toIdx = paths.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return paths;
  const next = paths.filter((p) => p !== from);
  next.splice(toIdx, 0, from);
  return next;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Точка экрана вне окна — вкладку бросили за его пределами, её выносят в отдельное окно. */
export function isOutsideRect(point: { x: number; y: number }, rect: ScreenRect): boolean {
  return point.x < rect.x || point.y < rect.y || point.x >= rect.x + rect.width || point.y >= rect.y + rect.height;
}

/** Насколько ниже полосы вкладок надо оттянуть вкладку, чтобы она оторвалась в окно (CSS-пиксели). */
export const TAB_TEAR_OFF_DISTANCE = 80;

export interface TabDragEndContext {
  /** Курсор в момент броска, экранные координаты (DIP). */
  cursor: { x: number; y: number };
  /** Границы окна целиком и его клиентской области (DIP). */
  bounds: ScreenRect;
  content: ScreenRect;
  /** Масштаб страницы: CSS-пиксель = zoom DIP. */
  zoom: number;
  /** Границы главного окна — только для окна проекта: туда возвращают его вкладку (TASK-296). */
  mainBounds?: ScreenRect | null;
}

/**
 * Выносить ли вкладку в окно по окончании перетаскивания. Решает место броска, а не `dropEffect`: над другим
 * приложением, которое принимает перетаскивание (VS Code, браузер), Chromium отдаёт `move`/`copy`, и бросок за окно
 * не считался выносом. Выносим, если вкладку бросили за окном или оттянули от полосы вкладок вниз, как отрыв вкладки
 * в браузере: у развёрнутого окна «за окном» — только панель задач. Бросок на вкладку — перестановка.
 */
export function shouldDetachTab(
  context: TabDragEndContext,
  strip: { top: number; bottom: number },
  droppedOnTab: boolean,
  tearOff = TAB_TEAR_OFF_DISTANCE
): boolean {
  if (droppedOnTab) return false;
  if (isOutsideRect(context.cursor, context.bounds)) return true;
  const zoom = context.zoom > 0 ? context.zoom : 1;
  const clientY = (context.cursor.y - context.content.y) / zoom;
  return clientY > strip.bottom + tearOff || clientY < strip.top - tearOff;
}

/**
 * Вернуть ли проект из его окна вкладкой в главное окно (TASK-296). Бросок на полосу вкладок главного окна принимает
 * само главное окно (`accepted`); здесь — бросок в остальную часть главного окна: курсор над ним и не над своим окном.
 */
export function shouldReturnToMainWindow(context: TabDragEndContext, accepted: boolean): boolean {
  if (accepted || !context.mainBounds) return false;
  return !isOutsideRect(context.cursor, context.mainBounds) && isOutsideRect(context.cursor, context.bounds);
}

/** Размер нового окна проекта по умолчанию. */
export const PROJECT_WINDOW_SIZE = { width: 1280, height: 820 };

/**
 * Границы нового окна: шапка окна под курсором (вкладку «держат» за шапку), окно целиком на рабочей области экрана.
 * Без точки — по центру рабочей области.
 */
export function projectWindowBounds(
  at: { x: number; y: number } | null,
  workArea: ScreenRect,
  size: { width: number; height: number } = PROJECT_WINDOW_SIZE
): ScreenRect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(value, max)));
  if (!at) {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height
    };
  }
  return {
    x: clamp(at.x - 120, workArea.x, workArea.x + workArea.width - width),
    y: clamp(at.y - 16, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}
