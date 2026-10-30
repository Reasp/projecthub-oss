import { parseProjectWindowHash } from './projectWindow';

/**
 * Окно, в котором работает этот рендерер (TASK-295): главное или окно одного проекта, вынесенного из вкладки.
 * Определяется один раз по адресу окна.
 */
export const projectWindowPath: string | null =
  typeof window === 'undefined' || !window.location ? null : parseProjectWindowHash(window.location.hash ?? '');

/** Рендерер — окно проекта: каталога проектов и глобальных служб в нём нет. */
export const isProjectWindow = projectWindowPath !== null;
