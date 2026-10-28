/**
 * Быстрые промпты Agents Studio (кнопки «Следующая задача», «Коммит», «Деплой»). Один источник для словарей ПК
 * (`src/i18n/en.ts`, `ru.ts`) и меню быстрых команд телефона (TASK-140.10): хост отдаёт их в `studio_get_options` на
 * своём языке (TASK-202.13), не таща в main и в мобильный клиент весь словарь интерфейса.
 */
import type { Language } from '../i18n/types';

interface QuickPrompt {
  label: string;
  prompt: string;
}

export type StudioQuickPromptId = 'nextTask' | 'commit' | 'deploy';

export const STUDIO_QUICK_PROMPTS: Record<Language, Record<StudioQuickPromptId, QuickPrompt>> = {
  en: {
    nextTask: {
      label: 'Next Task',
      prompt:
        'Inspect active tasks in Backlog.md (status To Do / In Progress), analyze the requirements of the next task and start implementation following project rules.'
    },
    commit: {
      label: 'Commit',
      prompt:
        'Check git status and diff, run npm run lint:docs, generate a concise conventional commit message according to project rules, and propose the git commit command.'
    },
    deploy: {
      label: 'Deploy',
      prompt: 'Verify release readiness, run tests and documentation validation, then build the desktop application (npm run pack:win / pack:mac).'
    }
  },
  ru: {
    nextTask: {
      label: 'Следующая задача',
      prompt:
        'Возьми следующую задачу из Backlog.md (проверь статус To Do / In Progress), прочитай её требования и начни реализацию по правилам проекта.'
    },
    commit: {
      label: 'Коммит',
      prompt:
        'Проверь git status и diff изменений, запусти npm run lint:docs, сформируй краткое конвенциональное сообщение для коммита по правилам проекта и предложи команду git commit.'
    },
    deploy: {
      label: 'Деплой',
      prompt:
        'Проверь готовность проекта к релизу, запусти тесты и валидацию документации, после чего выполни сборку десктопного приложения (npm run pack:win / pack:mac).'
    }
  }
};

/** Русские промпты — для `ru.ts`. */
export const STUDIO_QUICK_PROMPTS_RU = STUDIO_QUICK_PROMPTS.ru;

export function studioQuickPromptList(language: Language = 'en'): Array<{ id: StudioQuickPromptId; label: string; prompt: string }> {
  const prompts = STUDIO_QUICK_PROMPTS[language] ?? STUDIO_QUICK_PROMPTS.en;
  return (Object.keys(prompts) as StudioQuickPromptId[]).map((id) => ({ id, ...prompts[id] }));
}
