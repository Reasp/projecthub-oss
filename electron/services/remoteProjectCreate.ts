/**
 * Новый проект с телефона (TASK-179.4, [[decision-137]] п. 9): папка под корнем проектов этого ПК, основа ProjectHub
 * ([[decision-78]]) без стекового шаблона, запись в реестр. Чистые функции — имя папки и корень; сама инициализация —
 * `applyInit`, как у мастера окна.
 */
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Имя папки из сказанного имени: пробелы → дефисы, без символов, запрещённых в Windows, без путей. Пустое или
 * зарезервированное имя — ошибка: создавать нечего.
 */
export function projectFolderName(name: string): string {
  if (/[\\/]|\.\./.test(name)) throw new Error('Имя проекта не может содержать путь');
  const folder = [...name.trim()]
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"|?*'.includes(ch))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  if (!folder || RESERVED.test(folder)) throw new Error('Недопустимое имя проекта');
  return folder;
}

/**
 * Корень проектов: папка, где лежит больше всего зарегистрированных проектов. Проектов нет — `~/Projects`.
 * При равенстве — папка первого проекта реестра.
 */
export function projectsRoot(projectPaths: readonly string[], home: string): string {
  const counts = new Map<string, number>();
  for (const p of projectPaths) {
    const parent = path.dirname(path.resolve(p));
    if (path.parse(parent).root === parent) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [dir, n] of counts) if (best === null || n > counts.get(best)!) best = dir;
  return best ?? path.join(home, 'Projects');
}
