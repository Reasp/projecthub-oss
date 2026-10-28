import type { Language } from '../../src/i18n/types.js';

/**
 * Имена и критерии готовности (DoD) встроенных ролей по `slug` (TASK-202.13): на языке хоста, как и окно. Системные
 * промпты ролей — английские тексты для модели (decision-165 п. 6) и здесь не переводятся.
 */
export interface BuiltinRoleText {
  name: string;
  dod: string[];
}

export type BuiltinRoleSlug = 'architect' | 'implementer' | 'reviewer' | 'tester' | 'manager' | 'doc-writer';

export const BUILTIN_ROLE_TEXT: Record<Language, Record<BuiltinRoleSlug, BuiltinRoleText>> = {
  en: {
    architect: {
      name: 'Architect',
      dod: ['The specification covers every acceptance criterion of the task', 'Affected files and modules are listed', 'Risks and alternatives are noted']
    },
    implementer: {
      name: 'Implementer',
      dod: ['The code implements the specification or the task', 'The project builds', 'Changes stay within the task']
    },
    reviewer: {
      name: 'Reviewer',
      dod: ['Correctness and fit to the task are checked', 'Remarks are specific, with file and line']
    },
    tester: {
      name: 'Tester',
      dod: ['Tests for the changed logic are added or updated', 'Tests and the build pass']
    },
    manager: {
      name: 'Manager',
      dod: [
        'Tasks do not duplicate existing ones (checked with task_list)',
        'Every task has verifiable acceptance criteria',
        'Tasks wait for human confirmation — the summary lists what to confirm'
      ]
    },
    'doc-writer': {
      name: 'Technical writer',
      dod: ['The documentation reflects the actual behavior', 'The backlog/docs format is followed (frontmatter, id/title)']
    }
  },
  ru: {
    architect: {
      name: 'Архитектор',
      dod: ['Спецификация покрывает все критерии приёмки задачи', 'Указаны затронутые файлы и модули', 'Отмечены риски и альтернативы']
    },
    implementer: {
      name: 'Реализатор',
      dod: ['Код реализует спецификацию/задачу', 'Проект собирается', 'Изменения ограничены рамками задачи']
    },
    reviewer: {
      name: 'Ревьюер',
      dod: ['Проверены корректность и соответствие задаче', 'Даны конкретные замечания с указанием файла/строки']
    },
    tester: {
      name: 'Тестировщик',
      dod: ['Добавлены/обновлены тесты на изменённую логику', 'Тесты и сборка проходят']
    },
    manager: {
      name: 'Менеджер',
      dod: [
        'Задачи не дублируют существующие (проверено через task_list)',
        'У каждой задачи проверяемые критерии приёмки',
        'Задачи ждут подтверждения человека — в итоге перечислено, что подтвердить'
      ]
    },
    'doc-writer': {
      name: 'Технический писатель',
      dod: ['Документация отражает фактическое поведение', 'Соблюдён формат backlog/docs (frontmatter, id/title)']
    }
  }
};

export function builtinRoleText(slug: string, language: Language): BuiltinRoleText | undefined {
  return (BUILTIN_ROLE_TEXT[language] ?? BUILTIN_ROLE_TEXT.en)[slug as BuiltinRoleSlug];
}
