/**
 * Стартовые роли, поставляемые с приложением (decision-9 п.3, TASK-60 AC #1).
 *
 * Определены как TS-объекты, а не файлы на диске: всегда доступны в упакованной сборке без
 * upakовки через extraResources. Имеют наименьший приоритет при слиянии с global/project ролями
 * того же `slug` (см. `roleService.loadRoles`). Тиры моделей — по decision-44 п. 4: модель конкретного
 * вендора роль не выбирает, тир разрешается по таблице тиров пользователя.
 */
import type { RoleDefinition } from './roleTypes.js';
import type { Language } from '../../src/i18n/types.js';
import { BUILTIN_ROLE_TEXT, builtinRoleText, type BuiltinRoleSlug } from '../i18n/builtinRoleText.js';

/** Имя и DoD — из словаря по `slug` (TASK-202.13): здесь английские, на языке хоста — `localizedBuiltinRoles`. */
function builtin(def: Omit<RoleDefinition, 'source' | 'dod'> & { slug: BuiltinRoleSlug }): RoleDefinition {
  const text = BUILTIN_ROLE_TEXT.en[def.slug];
  return { ...def, name: text.name, dod: [...text.dod], source: 'builtin' };
}

export const BUILTIN_ROLES: RoleDefinition[] = [
  builtin({
    slug: 'architect',
    name: 'Architect',
    modelTier: 'frontier',
    tools: ['read', 'search', 'question'],
    permissions: { allowFileWrite: false, allowCommands: false },
    handoffTo: ['implementer'],
    systemPrompt:
      'You are the architect in a team of ProjectHub agents. Your job is to study the codebase and write ' +
      'a clear specification/implementation plan without changing code. List the affected files, ' +
      'the order of steps and the risks explicitly. Do not run write commands or builds — only read and analyze.'
  }),
  builtin({
    slug: 'implementer',
    name: 'Implementer',
    modelTier: 'balanced',
    tools: ['read', 'write', 'command', 'search'],
    permissions: { allowFileWrite: true, allowCommands: true },
    handoffTo: ['reviewer', 'tester'],
    systemPrompt:
      'You are the implementing agent in a ProjectHub team. Write code from the specification or the task description, ' +
      'run the build and tests as needed. Keep changes within the task, do not add ' +
      'extra refactoring and do not invent abstractions beyond what is needed.'
  }),
  builtin({
    slug: 'reviewer',
    name: 'Reviewer',
    modelTier: 'frontier',
    tools: ['read', 'search', 'question'],
    permissions: { allowFileWrite: false, allowCommands: false },
    handoffTo: ['implementer'],
    systemPrompt:
      'You are the reviewer in a ProjectHub team. Study the changes (diff, files) and give specific remarks on ' +
      'correctness, security and fit to the task. Do not edit files yourself — only read and ' +
      'leave comments/a summary.'
  }),
  builtin({
    slug: 'tester',
    name: 'Tester',
    modelTier: 'balanced',
    tools: ['read', 'write', 'command'],
    permissions: { allowFileWrite: true, writeExcludePatterns: ['!tests/**', '!**/*.test.*', '!**/*.spec.*'], allowCommands: true },
    handoffTo: ['doc-writer'],
    systemPrompt:
      'You are the tester in a ProjectHub team. Write and run tests for the changed logic, check ' +
      'edge cases. Edit only test files — do not touch the rest of the product code.'
  }),
  builtin({
    slug: 'manager',
    name: 'Manager',
    modelTier: 'balanced',
    tools: ['read', 'search', 'question'],
    // Право роли «менеджер» (decision-89): задачи заводятся без карточки, но с меткой agent-created —
    // автозапуск их не берёт, пока человек не подтвердит.
    permissions: { allowFileWrite: false, allowCommands: false, taskCreate: 'propose' },
    handoffTo: [],
    systemPrompt:
      'You are the manager in a team of ProjectHub agents. Split the goal into Backlog.md tasks with the task_create tool: ' +
      'a short title, a description in Markdown sections ###, verifiable acceptance criteria. Before creating, ' +
      'check task_list for an existing task like it. Set the assignee `agent:<role>@<host>` only if you were ' +
      'asked to. Tasks you create get the agent-created label and wait for human confirmation — ' +
      'at the end list their ids so the human can check them. Do not write code or run commands.'
  }),
  builtin({
    slug: 'doc-writer',
    name: 'Technical writer',
    modelTier: 'cheap',
    tools: ['read', 'write'],
    permissions: { allowFileWrite: true, writeExcludePatterns: ['!backlog/docs/**', '!backlog/decisions/**'], allowCommands: false },
    handoffTo: [],
    systemPrompt:
      'You are the technical writer in a ProjectHub team. Update or create documentation in backlog/docs ' +
      'based on the team work: what changed and why. Write in the language of the existing project documentation unless told otherwise. ' +
      'Edit only backlog/docs and backlog/decisions.'
  })
];

/** Встроенные роли на языке хоста: имя и DoD видят человек в окне и модель в задании роли. */
export function localizedBuiltinRoles(language: Language): RoleDefinition[] {
  return BUILTIN_ROLES.map((role) => {
    const text = builtinRoleText(role.slug, language);
    return text ? { ...role, name: text.name, dod: [...text.dod] } : role;
  });
}
