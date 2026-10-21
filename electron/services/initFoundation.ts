/**
 * План основы инициализации проекта (decision-78, п. 1, 4, 5; TASK-136.1).
 *
 * Основа не зависит от стека: git, трекер задач Backlog.md, документация и короткие правила
 * агентов, плюс запись `projecthub` встроенного MCP в `.mcp.json`. Модуль чистый: на вход —
 * снимок проекта (содержимое нужных файлов и список каталогов), на выход — список действий по
 * файлам. Чтение диска и запись — в `projectInitService.ts`.
 */
import { parseBacklogConfig } from './backlogConfigService.js';
import { buildMemoryIndex } from './memoryFormat.js';
import { detectStacks, gitignoreLinesFor, type StackInfo } from './initStack.js';
import {
  FOUNDATION_STATUSES,
  mergeGitignore,
  mergeMcpServers,
  mergeStatuses,
  parseJsonObject,
  renderBacklogConfig,
  renderSection,
  replaceStatusesBlock,
  sectionMarkers,
  upsertSection,
  extractSection,
  type SectionMarkers
} from './initMerge.js';

export type InitLocale = 'ru' | 'en';

/**
 * Действие над файлом: создать, дописать секцию/строки, слить JSON или YAML, заменить целиком,
 * удалить (файл, который шаблон больше не даёт, TASK-156), пропустить.
 */
export type InitAction = 'create' | 'append' | 'merge' | 'replace' | 'delete' | 'skip';

export type InitGroup = 'git' | 'tasks' | 'docs' | 'rules' | 'mcp' | 'index' | 'template';

/** Почему выбрано действие — код причины, текст подбирает интерфейс (i18n). */
export type InitReason =
  | 'missing'
  | 'exists'
  | 'up-to-date'
  | 'lines-missing'
  | 'section-missing'
  | 'section-outdated'
  | 'statuses-missing'
  | 'config-unreadable'
  | 'docs-exist'
  | 'not-json'
  | 'template-file'
  | 'template-changed'
  // Обновление по lock-файлу (TASK-156): шаблон изменил файл, который пользователь не трогал;
  // пользователь изменил, шаблон — нет; изменили оба; пользователь удалил; шаблон больше не даёт.
  | 'template-updated'
  | 'user-modified'
  | 'conflict'
  | 'user-deleted'
  | 'template-removed'
  | 'hooks-conflict'
  | 'feature-off'
  | 'entry-missing';

export interface InitPlanItem {
  /** Стабильный ключ пункта: по нему интерфейс передаёт выбранное действие. */
  id: string;
  /** Путь относительно корня проекта через `/`; каталоги — с завершающим `/`. */
  path: string;
  kind: 'file' | 'dir' | 'command';
  group: InitGroup;
  /** Действие по умолчанию. */
  action: InitAction;
  /** Допустимые действия; пользователь выбирает только из них. */
  options: InitAction[];
  reason: InitReason;
  /** Готовое содержимое файла для каждого действия, которое что-то пишет. */
  contents?: Partial<Record<InitAction, string>>;
  /** Для «заменить» прежняя версия кладётся в резервную копию. */
  backupOnReplace?: boolean;
  /** Пояснение для пункта (например, найденный стек для `.gitignore`). */
  detail?: string;
  /** Название пункта, если путь его не описывает (команда шаблона). */
  label?: string;
  /** Файл шаблона (путь от корня шаблона), который копируется как есть. */
  copyFrom?: string;
  /**
   * Тексты для диффа в предпросмотре (TASK-156): `current` — файл в проекте, `template` — файл
   * шаблона для `copyFrom`, `base` — что шаблон дал при прошлом применении. Двоичный или слишком
   * большой файл — `binary`.
   */
  compare?: { current?: string | null; template?: string | null; base?: string | null; binary?: boolean };
}

/** Файлы проекта, которые нужны плану основы. `null` — файла нет. */
export interface FoundationSnapshot {
  projectName: string;
  /** Имена файлов и каталогов в корне проекта. */
  rootNames: string[];
  hasGit: boolean;
  /** Существующие каталоги из `FOUNDATION_DIRS`. */
  dirs: string[];
  /** Число `.md` в `backlog/docs` (вложенные каталоги тоже). */
  docsCount: number;
  files: Partial<Record<string, string | null>>;
}

export type RulesMode = 'append' | 'replace';

export interface FoundationOptions {
  locale: InitLocale;
  rulesMode: RulesMode;
  /** Файлы правил, в которые пишется секция основы. */
  rulesTargets: string[];
  /** Запись встроенного MCP ProjectHub для `.mcp.json`; без неё пункт MCP не строится. */
  mcpEntry?: Record<string, unknown> | null;
  /** Метка времени для документа «О проекте» в формате `YYYY-MM-DD HH:mm`. */
  stamp: string;
}

/** Вклад шаблона в общие с основой файлы и его собственные пункты (initTemplateLayer.ts). */
export interface FoundationContribution {
  gitignore: string[];
  rulesSections: Array<{ markers: SectionMarkers; body: string }>;
  rulesTargets: string[];
  mcpServers: Record<string, unknown>;
  mcpRemove: string[];
  statuses?: string[];
  items: InitPlanItem[];
}

export const FOUNDATION_DIRS = [
  'backlog/tasks',
  'backlog/milestones',
  'backlog/docs',
  'backlog/decisions',
  'backlog/memory'
] as const;

export const RULE_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.agents/rules/projecthub.md'] as const;
export const DEFAULT_RULE_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/** Секция основы в файлах правил. */
export const FOUNDATION_MARKERS = sectionMarkers('projecthub');
/** Секция правил шаблона: тот же маркер, что пишет `sync-agent-rules.mjs` шаблона. */
export const TEMPLATE_RULES_MARKER = 'infra-dev';

export const MCP_CONFIG_PATH = '.mcp.json';
export const PROJECTHUB_MCP_KEY = 'projecthub';

/**
 * Запись встроенного MCP ProjectHub в `.mcp.json` (decision-78, п. 12). Адрес и токен агента —
 * только подстановкой из окружения: встроенный терминал ProjectHub передаёт
 * `PROJECTHUB_MCP_URL` и `PROJECTHUB_AGENT_TOKEN`, в файл проекта токен не попадает. Пустое
 * значение по умолчанию нужно, чтобы Claude Code не отверг весь `.mcp.json` вне ProjectHub.
 */
export const PROJECTHUB_MCP_ENTRY: Record<string, unknown> = {
  type: 'sse',
  url: '${PROJECTHUB_MCP_URL:-http://127.0.0.1:42042/sse}',
  headers: { Authorization: 'Bearer ${PROJECTHUB_AGENT_TOKEN:-}' }
};
export const MEMORY_INDEX_PATH = 'backlog/memory/MEMORY.md';
export const BACKLOG_CONFIG_PATH = 'backlog/config.yml';

/** Файлы, содержимое которых читает снимок основы. */
export function foundationSnapshotFiles(): string[] {
  return ['.gitignore', BACKLOG_CONFIG_PATH, MEMORY_INDEX_PATH, MCP_CONFIG_PATH, ...RULE_TARGETS];
}

// ---------------------------------------------------------------------------------------
// Тексты основы
// ---------------------------------------------------------------------------------------

const RULES_TEXT: Record<InitLocale, string> = {
  ru: `## ProjectHub: основа проекта

Проект ведётся в ProjectHub. Правила ниже не зависят от стека проекта.

1. **Git.** Коммиты, push и деплой — только по явной просьбе пользователя. Закончив задачу, предложи команду \`git commit\`, но не выполняй её сам.
2. **Задачи — в \`backlog/tasks/\`** (формат Backlog.md), а не в TODO-комментариях и отдельных заметках. Статусы: To Do → In Progress → Review → Done. Законченную работу переводи в Review, а не сразу в Done. Описание задачи — Markdown с короткими разделами \`###\`.
3. **Документация — в \`backlog/docs/\`, архитектурные решения (ADR) — в \`backlog/decisions/\`, факты памяти — в \`backlog/memory/\`.** Отдельную верхнеуровневую \`docs/\` не заводи. Каждый значимый выбор фиксируй решением \`decision-N\` в той же задаче.
4. **Формат документов.** Имена файлов \`doc-<N> - <Title>.md\` и \`decision-<N> - <Title>.md\`; во frontmatter \`id\`, \`title\` и раздел \`section: "Раздел/Подраздел"\`. Даты и значения, похожие на числа, — строками в кавычках (\`date: "2026-01-31"\`). Ссылки — идентификатором: \`[[decision-3]]\`, \`[[doc-2]]\`, \`[[TASK-12]]\`.
5. **Инструменты ProjectHub.** Если подключён MCP-сервер \`projecthub\`, задачи и документы создавай и меняй его инструментами (\`task_*\`, \`doc_*\`, \`memory_write\`), а перед ответом про устройство проекта ищи в документации (\`docs_search\`). Без него работай с файлами \`backlog/\` напрямую по этим правилам.`,
  en: `## ProjectHub: project foundation

This project is managed in ProjectHub. The rules below do not depend on the project's stack.

1. **Git.** Commit, push or deploy only when the user explicitly asks. When a task is finished, suggest a \`git commit\` command but do not run it yourself.
2. **Tasks live in \`backlog/tasks/\`** (Backlog.md format), not in TODO comments or separate notes. Statuses: To Do → In Progress → Review → Done. Move finished work to Review, not straight to Done. Write task descriptions in Markdown with short \`###\` sections.
3. **Documentation lives in \`backlog/docs/\`, architecture decisions (ADR) in \`backlog/decisions/\`, memory facts in \`backlog/memory/\`.** Do not create a separate top-level \`docs/\`. Record every significant choice as a \`decision-N\` in the same task.
4. **Document format.** File names \`doc-<N> - <Title>.md\` and \`decision-<N> - <Title>.md\`; frontmatter has \`id\`, \`title\` and a section \`section: "Section/Subsection"\`. Dates and number-like values are quoted strings (\`date: "2026-01-31"\`). Link by id: \`[[decision-3]]\`, \`[[doc-2]]\`, \`[[TASK-12]]\`.
5. **ProjectHub tools.** If the \`projecthub\` MCP server is connected, create and edit tasks and documents with its tools (\`task_*\`, \`doc_*\`, \`memory_write\`), and search the documentation (\`docs_search\`) before answering how the project works. Without it, work with the \`backlog/\` files directly by these rules.`
};

export function foundationRulesText(locale: InitLocale): string {
  return RULES_TEXT[locale];
}

const ABOUT_TITLE: Record<InitLocale, string> = { ru: 'О проекте', en: 'About the project' };
const ABOUT_SECTION: Record<InitLocale, string> = { ru: 'Проект', en: 'Project' };

function aboutDocBody(locale: InitLocale, name: string, stacks: StackInfo[]): string {
  const stackLine = stacks.length > 0 ? stacks.map((stack) => stack.label).join(', ') : null;
  if (locale === 'en') {
    return `# ${name}

## Purpose

_What the project does and who it is for._

## Stack

${stackLine ?? '_Languages, engines and frameworks of the project._'}

## Structure

_Main folders and modules, how to build and run the project._

## Where to look

- Tasks — \`backlog/tasks/\`
- Architecture decisions — \`backlog/decisions/\`
- Project memory — \`backlog/memory/\`
`;
  }
  return `# ${name}

## Назначение

_Что делает проект и для кого._

## Стек

${stackLine ?? '_Языки, движки и фреймворки проекта._'}

## Структура

_Основные каталоги и модули, как собрать и запустить проект._

## Где что искать

- Задачи — \`backlog/tasks/\`
- Архитектурные решения — \`backlog/decisions/\`
- Память проекта — \`backlog/memory/\`
`;
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

function slugTitle(title: string): string {
  return title.trim().replace(/\s+/g, '-');
}

/** Документ «О проекте» в формате Backlog.md (правила 13 и 16: строки в кавычках, раздел). */
export function aboutDocument(locale: InitLocale, name: string, stacks: StackInfo[], stamp: string): { path: string; content: string } {
  const title = ABOUT_TITLE[locale];
  const frontmatter = [
    '---',
    'id: doc-1',
    `title: ${yamlQuoted(title)}`,
    'type: readme',
    `created_date: ${yamlQuoted(stamp)}`,
    `section: ${yamlQuoted(ABOUT_SECTION[locale])}`,
    '---',
    ''
  ].join('\n');
  return {
    path: `backlog/docs/doc-1 - ${slugTitle(title)}.md`,
    content: `${frontmatter}\n${aboutDocBody(locale, name, stacks)}`
  };
}

/** Заголовок нового файла правил: как у `sync-agent-rules.mjs` шаблона. */
function rulesFileHeading(target: string): string {
  const base = target.split('/').pop() ?? target;
  return target.startsWith('.agents/') ? '' : `# ${base}\n\n`;
}

// ---------------------------------------------------------------------------------------
// План
// ---------------------------------------------------------------------------------------

function file(snapshot: FoundationSnapshot, relPath: string): string | null {
  return snapshot.files[relPath] ?? null;
}

type RulesSection = { markers: SectionMarkers; body: string };

function rulesItem(snapshot: FoundationSnapshot, target: string, sections: RulesSection[], mode: RulesMode): InitPlanItem {
  const existing = file(snapshot, target);
  const rendered = sections.map((section) => renderSection(section.markers, section.body)).join('\n\n');
  const fresh = `${rulesFileHeading(target)}${rendered}\n`;
  const base: Pick<InitPlanItem, 'id' | 'path' | 'kind' | 'group'> = {
    id: `rules:${target}`,
    path: target,
    kind: 'file',
    group: 'rules'
  };

  if (existing === null) {
    return { ...base, action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: fresh } };
  }

  const appended = sections.reduce((text, section) => upsertSection(text, section.markers, section.body), existing);
  const anyMissing = sections.some((section) => extractSection(existing, section.markers) === null);
  const upToDate = appended === existing;
  const reason: InitReason = upToDate ? 'up-to-date' : anyMissing ? 'section-missing' : 'section-outdated';
  const contents: InitPlanItem['contents'] = { replace: fresh };
  if (!upToDate) contents.append = appended;

  let action: InitAction = upToDate ? 'skip' : 'append';
  if (mode === 'replace' && existing !== fresh) action = 'replace';
  const options: InitAction[] = upToDate ? ['skip', 'replace'] : ['append', 'replace', 'skip'];
  return { ...base, action, options, reason, contents, backupOnReplace: true };
}

function gitignoreItem(snapshot: FoundationSnapshot, stacks: StackInfo[], extra: string[]): InitPlanItem {
  const existing = file(snapshot, '.gitignore');
  const merged = mergeGitignore(existing, [...gitignoreLinesFor(stacks), ...extra], 'ProjectHub');
  const detail = stacks.map((stack) => stack.label).join(', ') || undefined;
  const base = { id: 'git:.gitignore', path: '.gitignore', kind: 'file' as const, group: 'git' as const, detail };
  if (existing === null) {
    return { ...base, action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: merged } };
  }
  if (merged === existing) return { ...base, action: 'skip', options: ['skip'], reason: 'up-to-date' };
  return { ...base, action: 'append', options: ['append', 'skip'], reason: 'lines-missing', contents: { append: merged } };
}

/** Стандартный порядок статусов: статусы шаблона, в которые вставлены недостающие статусы основы. */
export function canonicalStatuses(templateStatuses?: string[]): string[] {
  return templateStatuses && templateStatuses.length > 0 ? mergeStatuses(templateStatuses) : [...FOUNDATION_STATUSES];
}

function backlogConfigItem(snapshot: FoundationSnapshot, templateStatuses?: string[]): InitPlanItem {
  const raw = file(snapshot, BACKLOG_CONFIG_PATH);
  const canonical = canonicalStatuses(templateStatuses);
  const base = { id: 'tasks:config', path: BACKLOG_CONFIG_PATH, kind: 'file' as const, group: 'tasks' as const };
  if (raw === null) {
    return {
      ...base,
      action: 'create',
      options: ['create', 'skip'],
      reason: 'missing',
      contents: { create: renderBacklogConfig(snapshot.projectName, canonical) }
    };
  }
  const parsed = parseBacklogConfig(raw);
  const hasStatusesKey = /^statuses:/m.test(raw);
  if (!parsed.fromConfig && hasStatusesKey) {
    return { ...base, action: 'skip', options: ['skip'], reason: 'config-unreadable' };
  }
  const current = parsed.fromConfig ? parsed.statuses : [];
  const merged = mergeStatuses(current, canonical);
  if (merged.length === current.length) return { ...base, action: 'skip', options: ['skip'], reason: 'up-to-date' };
  const missing = canonical.filter((status) => !current.some((item) => item.toLowerCase() === status.toLowerCase()));
  // Недостающие статусы дописываются только с согласия (decision-78, п. 5): по умолчанию — пропустить.
  return {
    ...base,
    action: 'skip',
    options: ['merge', 'skip'],
    reason: 'statuses-missing',
    detail: missing.join(', '),
    contents: { merge: replaceStatusesBlock(raw, merged) }
  };
}

function mcpItem(snapshot: FoundationSnapshot, servers: Record<string, unknown>, remove: string[]): InitPlanItem {
  const existing = file(snapshot, MCP_CONFIG_PATH);
  const base = { id: 'mcp:.mcp.json', path: MCP_CONFIG_PATH, kind: 'file' as const, group: 'mcp' as const };
  if (existing !== null && existing.trim() && !parseJsonObject(existing)) {
    return { ...base, action: 'skip', options: ['skip'], reason: 'not-json' };
  }
  const merged = mergeMcpServers(existing, servers, remove);
  if (existing === null) {
    return { ...base, action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: merged } };
  }
  if (merged === existing) return { ...base, action: 'skip', options: ['skip'], reason: 'up-to-date' };
  return { ...base, action: 'merge', options: ['merge', 'skip'], reason: 'entry-missing', contents: { merge: merged } };
}

export interface FoundationPlan {
  items: InitPlanItem[];
  stacks: StackInfo[];
}

/**
 * План основы для снимка проекта, с вкладом шаблона в общие файлы, если шаблон выбран.
 * Повторный план для уже применённой основы состоит из «пропустить».
 */
export function buildFoundationPlan(
  snapshot: FoundationSnapshot,
  options: FoundationOptions,
  contribution?: FoundationContribution | null
): FoundationPlan {
  const stacks = detectStacks(snapshot.rootNames);
  const items: InitPlanItem[] = [];
  const dirs = new Set(snapshot.dirs);

  items.push(
    snapshot.hasGit
      ? { id: 'git:init', path: '.git/', kind: 'command', group: 'git', action: 'skip', options: ['skip'], reason: 'exists' }
      : { id: 'git:init', path: '.git/', kind: 'command', group: 'git', action: 'create', options: ['create', 'skip'], reason: 'missing' }
  );
  items.push(gitignoreItem(snapshot, stacks, contribution?.gitignore ?? []));

  items.push(backlogConfigItem(snapshot, contribution?.statuses));
  for (const dir of ['backlog/tasks', 'backlog/milestones'] as const) {
    items.push(dirItem(dir, 'tasks', dirs.has(dir)));
  }

  items.push(dirItem('backlog/docs', 'docs', dirs.has('backlog/docs')));
  items.push(dirItem('backlog/decisions', 'docs', dirs.has('backlog/decisions')));
  const about = aboutDocument(options.locale, snapshot.projectName, stacks, options.stamp);
  items.push(
    snapshot.docsCount > 0
      ? { id: 'docs:about', path: about.path, kind: 'file', group: 'docs', action: 'skip', options: ['skip'], reason: 'docs-exist' }
      : { id: 'docs:about', path: about.path, kind: 'file', group: 'docs', action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: about.content } }
  );
  items.push(
    file(snapshot, MEMORY_INDEX_PATH) !== null
      ? { id: 'docs:memory', path: MEMORY_INDEX_PATH, kind: 'file', group: 'docs', action: 'skip', options: ['skip'], reason: 'exists' }
      : { id: 'docs:memory', path: MEMORY_INDEX_PATH, kind: 'file', group: 'docs', action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: buildMemoryIndex([]) } }
  );

  const foundationSection: RulesSection = { markers: FOUNDATION_MARKERS, body: foundationRulesText(options.locale) };
  const templateTargets = new Set(contribution?.rulesTargets ?? []);
  const targets = [...new Set([...options.rulesTargets, ...templateTargets])];
  for (const target of targets) {
    const sections: RulesSection[] = [];
    if (options.rulesTargets.includes(target)) sections.push(foundationSection);
    if (templateTargets.has(target)) sections.push(...(contribution?.rulesSections ?? []));
    items.push(rulesItem(snapshot, target, sections, options.rulesMode));
  }

  const servers: Record<string, unknown> = { ...(contribution?.mcpServers ?? {}) };
  if (options.mcpEntry) servers[PROJECTHUB_MCP_KEY] = options.mcpEntry;
  if (Object.keys(servers).length > 0 || (contribution?.mcpRemove.length ?? 0) > 0) {
    items.push(mcpItem(snapshot, servers, contribution?.mcpRemove ?? []));
  }

  if (contribution) items.push(...contribution.items);

  return { items, stacks };
}

function dirItem(dir: string, group: InitGroup, exists: boolean): InitPlanItem {
  return exists
    ? { id: `dir:${dir}`, path: `${dir}/`, kind: 'dir', group, action: 'skip', options: ['skip'], reason: 'exists' }
    : { id: `dir:${dir}`, path: `${dir}/`, kind: 'dir', group, action: 'create', options: ['create', 'skip'], reason: 'missing' };
}

// ---------------------------------------------------------------------------------------
// Статус основы для карточки проекта
// ---------------------------------------------------------------------------------------

export type FoundationPart = 'git' | 'tasks' | 'docs' | 'rules';

export interface FoundationStatusInput {
  hasGit: boolean;
  hasBacklogConfig: boolean;
  dirs: string[];
  /** Содержимое файлов правил (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), если они есть. */
  rules: Array<string | null>;
}

/**
 * Чего не хватает проекту из основы — для кнопки «Инициализировать». Правила считаются на
 * месте, если хоть один файл правил несёт секцию основы или секцию шаблона (`infra-dev`):
 * проекты, созданные прежним мастером, не должны выглядеть неинициализированными.
 */
export function missingFoundationParts(input: FoundationStatusInput): FoundationPart[] {
  const dirs = new Set(input.dirs);
  const missing: FoundationPart[] = [];
  if (!input.hasGit) missing.push('git');
  if (!input.hasBacklogConfig || !dirs.has('backlog/tasks')) missing.push('tasks');
  if (!dirs.has('backlog/docs') || !dirs.has('backlog/decisions')) missing.push('docs');
  const templateMarkers = sectionMarkers(TEMPLATE_RULES_MARKER);
  const hasRules = input.rules.some(
    (text) => text !== null && (extractSection(text, FOUNDATION_MARKERS) !== null || extractSection(text, templateMarkers) !== null)
  );
  if (!hasRules) missing.push('rules');
  return missing;
}
