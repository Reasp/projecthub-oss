import type { Language } from '../../src/i18n/types.js';
import type { PlanOutcome } from '../services/planTypes.js';

/**
 * Тексты, которые ProjectHub пишет в проект человека (TASK-202.13, decision-165 п. 14): отчёт плана в родительской
 * задаче и заметки приёма и возврата с проверки. Язык — язык хоста в момент записи, как у окна.
 */
export interface ProjectContentText {
  plan: {
    after: (deps: string) => string;
    name: (taskId: string) => string;
    states: Record<string, string>;
    outcomes: Record<PlanOutcome, string>;
    commit: (sha: string) => string;
    iterations: (n: number) => string;
    finished: (outcome: string, total: number, merged: number) => string;
    subtasks: string;
    integrationBranch: (branch: string) => string;
    cost: (usd: string) => string;
  };
  inbox: {
    phone: string;
    accepted: (who: string, at: string) => string;
    returned: (who: string, at: string) => string;
  };
  /** Заготовки нового документа, решения и вехи (окно «Документация», вехи доски). */
  templates: {
    doc: (title: string) => string;
    decision: (title: string) => string;
    milestoneDescription: string;
  };
  /** Задача из находки аудита зависимостей и сводка уровней. */
  audit: {
    none: string;
    via: (packages: string) => string;
    vulnerability: string;
    title: (pkg: string, core: string) => string;
    intro: (ecosystem: string, project?: string) => string;
    package: (pkg: string, transitive: boolean) => string;
    severity: (level: string) => string;
    range: (range: string) => string;
    comesVia: (list: string) => string;
    fix: (target: string, major: boolean) => string;
    fixAvailable: string;
    noFix: string;
    /** Итог прогона автоматизации: сколько находок новые. */
    newFindings: (n: number) => string;
  };
}

const en: ProjectContentText = {
  plan: {
    after: (deps) => ` (after ${deps})`,
    name: (taskId) => `Plan ${taskId}`,
    states: {
      pending: 'not started',
      running: 'running',
      completed: 'done, not merged',
      merging: 'merging',
      merged: 'merged',
      conflict: 'merge conflict',
      failed: 'failed',
      blocked: 'blocked',
      skipped: 'skipped',
      missing: 'removed from Backlog'
    },
    outcomes: {
      success: 'all subtasks merged',
      partial: 'partly done',
      failed: 'failed',
      budget_exceeded: 'stopped by the budget',
      stopped: 'stopped by a human'
    },
    commit: (sha) => `commit ${sha}`,
    iterations: (n) => `iterations ${n}`,
    finished: (outcome, total, merged) => `Plan finished: ${outcome}. Subtasks — ${total}, merged — ${merged}.`,
    subtasks: '**Subtasks**',
    integrationBranch: (branch) => `**Integration branch**: \`${branch}\` — merge it yourself, the planner does not merge into the base branch.`,
    cost: (usd) => `**Plan cost**: ${usd} $`
  },
  inbox: {
    phone: 'phone',
    accepted: (who, at) => `Accepted from review (${who}, ${at})`,
    returned: (who, at) => `Returned from review (${who}, ${at})`
  },
  templates: {
    doc: (title) =>
      `# ${title}\n\n## Overview\nA short description of what this document is about.\n\n## Main sections\n### 1. Introduction\nThe architecture or the process.\n\n### 2. Specification\nDetailed specifications, diagrams or usage examples.\n`,
    decision: (title) =>
      `# ${title}\n\n## Context\nDescribe the problem, the technical constraints and the requirements that made this architecture decision necessary.\n\n## Options considered\n1. **Option 1**: pros and cons\n2. **Option 2**: pros and cons\n\n## Decision\nDescribe the chosen approach and why it was chosen.\n\n## Consequences\n### Positive\n-\n\n### Negative / risks\n-\n`,
    milestoneDescription: 'Milestone description'
  },
  audit: {
    none: 'no vulnerabilities',
    via: (packages) => `via ${packages}`,
    vulnerability: 'vulnerability',
    title: (pkg, core) => `Vulnerability ${pkg}: ${core}`,
    intro: (ecosystem, project) => `ProjectHub dependency audit finding (${ecosystem}${project ? `, project ${project}` : ''}).`,
    package: (pkg, transitive) => `- Package: ${pkg}${transitive ? ' (transitive dependency)' : ''}`,
    severity: (level) => `- Severity: ${level}`,
    range: (range) => `- Vulnerable versions: \`${range}\``,
    comesVia: (list) => `- Comes via: ${list}`,
    fix: (target, major) => `- Fix: ${target}${major ? ' (major update)' : ''}`,
    fixAvailable: 'available',
    noFix: '- No fix yet',
    newFindings: (n) => `new findings: ${n}`
  }
};

const ru: ProjectContentText = {
  plan: {
    after: (deps) => ` (после ${deps})`,
    name: (taskId) => `План ${taskId}`,
    states: {
      pending: 'не запускалась',
      running: 'выполняется',
      completed: 'выполнена, не слита',
      merging: 'сливается',
      merged: 'влита',
      conflict: 'конфликт слияния',
      failed: 'не выполнена',
      blocked: 'заблокирована',
      skipped: 'пропущена',
      missing: 'удалена из Backlog'
    },
    outcomes: {
      success: 'все подзадачи влиты',
      partial: 'выполнен частично',
      failed: 'провален',
      budget_exceeded: 'остановлен по бюджету',
      stopped: 'остановлен человеком'
    },
    commit: (sha) => `коммит ${sha}`,
    iterations: (n) => `итераций ${n}`,
    finished: (outcome, total, merged) => `План выполнен: ${outcome}. Подзадач — ${total}, влито — ${merged}.`,
    subtasks: '**Подзадачи**',
    integrationBranch: (branch) => `**Интеграционная ветка**: \`${branch}\` — слейте её сами, планировщик в базовую ветку не сливает.`,
    cost: (usd) => `**Стоимость плана**: ${usd} $`
  },
  inbox: {
    phone: 'телефон',
    accepted: (who, at) => `Принято с проверки (${who}, ${at})`,
    returned: (who, at) => `Возвращено с проверки (${who}, ${at})`
  },
  templates: {
    doc: (title) =>
      `# ${title}\n\n## Обзор\nКраткое описание назначения и содержания данного документа.\n\n## Основные разделы\n### 1. Введение\nОписание архитектуры или процесса.\n\n### 2. Спецификация\nДетальные спецификации, схемы или примеры использования.\n`,
    decision: (title) =>
      `# ${title}\n\n## Контекст и проблематика\nОпишите контекст проблемы, технические ограничения и требования, которые привели к необходимости принятия этого архитектурного решения.\n\n## Рассматриваемые варианты\n1. **Вариант 1**: Плюсы и минусы\n2. **Вариант 2**: Плюсы и минусы\n\n## Принятое решение\nОпишите выбранный подход и обоснование выбора.\n\n## Последствия\n### Положительные\n-\n\n### Отрицательные / Риски\n-\n`,
    milestoneDescription: 'Описание майлстоуна'
  },
  audit: {
    none: 'уязвимостей нет',
    via: (packages) => `через ${packages}`,
    vulnerability: 'уязвимость',
    title: (pkg, core) => `Уязвимость ${pkg}: ${core}`,
    intro: (ecosystem, project) => `Находка аудита зависимостей ProjectHub (${ecosystem}${project ? `, проект ${project}` : ''}).`,
    package: (pkg, transitive) => `- Пакет: ${pkg}${transitive ? ' (транзитивная зависимость)' : ''}`,
    severity: (level) => `- Уровень: ${level}`,
    range: (range) => `- Уязвимые версии: \`${range}\``,
    comesVia: (list) => `- Приходит через: ${list}`,
    fix: (target, major) => `- Исправление: ${target}${major ? ' (мажорное обновление)' : ''}`,
    fixAvailable: 'доступно',
    noFix: '- Исправления пока нет',
    newFindings: (n) => `новых находок: ${n}`
  }
};

export const PROJECT_CONTENT_TEXT: Record<Language, ProjectContentText> = { en, ru };

export function projectContentText(language: Language): ProjectContentText {
  return PROJECT_CONTENT_TEXT[language] ?? en;
}
