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
