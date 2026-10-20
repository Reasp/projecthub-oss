/**
 * Быстрые промпты Agents Studio (кнопки «Следующая задача», «Коммит», «Деплой»). Один источник для русского
 * словаря ПК (`src/i18n/ru.ts`) и меню быстрых команд телефона (TASK-140.10): хост отдаёт их в
 * `studio_get_options`, не таща в main и в мобильный клиент весь словарь интерфейса.
 */
export const STUDIO_QUICK_PROMPTS_RU = {
  nextTask: {
    label: 'Следующая задача',
    prompt:
      'Возьми следующую задачу из Backlog.md (проверь статус To Do / In Progress), прочитай её требования и начни реализацию по правилам проекта.'
  },
  commit: {
    label: 'Комить',
    prompt:
      'Проверь git status и diff изменений, запусти npm run lint:docs, сформируй краткое конвенциональное сообщение для коммита по правилам проекта и предложи команду git commit.'
  },
  deploy: {
    label: 'Деплой',
    prompt:
      'Проверь готовность проекта к релизу, запусти тесты и валидацию документации, после чего выполни сборку десктопного приложения (npm run pack:win / pack:mac).'
  }
} as const;

export type StudioQuickPromptId = keyof typeof STUDIO_QUICK_PROMPTS_RU;

export function studioQuickPromptList(): Array<{ id: StudioQuickPromptId; label: string; prompt: string }> {
  return (Object.keys(STUDIO_QUICK_PROMPTS_RU) as StudioQuickPromptId[]).map((id) => ({ id, ...STUDIO_QUICK_PROMPTS_RU[id] }));
}
