/**
 * Слой шаблона в плане инициализации (decision-78, п. 3–6, 8–9, 11; TASK-136.4).
 *
 * Шаблон кладёт свои файлы в каталог инфраструктуры — корень проекта или подпапку
 * `.projecthub/infra/` — и вносит вклад в общие с основой файлы: строки `.gitignore`, секцию
 * правил `infra-dev`, серверы `.mcp.json`, статусы `backlog/config.yml`. Вклад в общие файлы
 * собирает план основы, чтобы на один файл приходился один пункт предпросмотра.
 *
 * Модуль чистый: содержимое и хэши файлов приходят из `projectInitService.ts`.
 */
import {
  mergeClaudeSettings,
  mergeGitignore,
  mergeMcpServers,
  parseJsonObject,
  sectionMarkers
} from './initMerge.js';
import type { FoundationContribution, InitAction, InitLocale, InitPlanItem, InitReason } from './initFoundation.js';
import { assembleRules, localize, MANIFEST_FILE, type McpServerDef, type TemplateManifest } from './templateManifest.js';
import { sha256, threeWayDecision } from './templateLock.js';

/** Файлы шаблона, которые никогда не копируются: данные самого шаблона и генерируемые файлы. */
export const ALWAYS_EXCLUDE = [
  '.git/**',
  'node_modules/**',
  '**/node_modules/**',
  'backlog/**',
  '.rag-index/**',
  '.rag-cache/**',
  '.lightrag-index/**',
  '.env-state/**',
  '.claude/memory/**',
  '.claude/worktrees/**',
  '.claude/scheduled_tasks.lock',
  '.projecthub/**',
  '.env',
  '.env.*',
  '**/*.zip',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.mcp.json',
  '.agents/mcp_config.json',
  '.agents/rules/**',
  'infra.config.json',
  'projecthub-template.json'
];

/** Glob → RegExp: `**` — любые каталоги, `*` — часть имени, `?` — один символ. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

export type Placement = 'root' | 'subfolder';

export interface TemplateFileInfo {
  path: string;
  hash: string;
}

export interface TemplateLayerInput {
  manifest: TemplateManifest;
  /** Шаблон без манифеста: MCP-серверы берутся из его `.mcp.json` как есть. */
  compatServers?: Record<string, McpServerDef> | null;
  /** Все файлы шаблона с хэшами содержимого. */
  files: TemplateFileInfo[];
  /** Текст файлов шаблона, нужных для слияния: правила, `.gitignore`, `settings.json`. */
  texts: Record<string, string>;
}

export interface TemplateProjectState {
  /** Хэши файлов проекта по путям назначения (`null` — файла нет). */
  hashes: Record<string, string | null>;
  /** Текст файлов проекта, которые сливаются (`infra.config.json`, `settings.json` и т.п.). */
  texts: Record<string, string | null>;
  /** У проекта свои git-хуки (husky, lefthook, core.hooksPath, файлы в .git/hooks). */
  hooksConflict: string | null;
  /**
   * Хэши того, что шаблон дал файлам при прошлом применении, из lock-файла (TASK-156). `null` —
   * lock-файла нет или он от другого шаблона: план как при повторной инициализации.
   */
  base?: Record<string, string> | null;
}

export interface TemplateLayerOptions {
  locale: InitLocale;
  placement: Placement;
  features: Record<string, boolean>;
  sets: Record<string, boolean>;
  /** Команды после применения, выключенные пользователем. */
  commands: Record<string, boolean>;
  /** Ставить git-хуки шаблона; по умолчанию — если нет конфликта. */
  gitHooks?: boolean;
  /** Имя проекта — для `package.json` инфраструктуры. */
  projectName?: string;
}

type PlanContribution = FoundationContribution;

export interface TemplateRisks {
  commands: Array<{ id: string; run: string; cwd: string }>;
  mcpServers: Array<{ name: string; command: string; args: string[] }>;
  gitHooks: boolean;
}

export interface TemplateLayerResult {
  contribution: PlanContribution;
  infraDir: string;
  /** Итоговые значения фич, наборов и хуков с учётом умолчаний манифеста. */
  features: Record<string, boolean>;
  sets: Record<string, boolean>;
  gitHooks: { available: boolean; enabled: boolean; conflict: string | null };
  risks: TemplateRisks;
  /**
   * Файлы, содержимое которых целиком задаёт шаблон, — для lock-файла: путь от корня проекта →
   * хэш и источник (файл шаблона или готовый текст). Сливаемые файлы сюда не входят.
   */
  tracked: Record<string, TrackedFile>;
  /** Секция правил шаблона → sha256 её текста. */
  rulesHashes: Record<string, string>;
}

export interface TrackedFile {
  hash: string;
  copyFrom?: string;
  text?: string;
}

const INFRA_CONFIG = 'infra.config.json';

function join(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

/** Каталог инфраструктуры относительно корня проекта (`''` — корень). */
export function infraDirFor(manifest: TemplateManifest, placement: Placement): string {
  return placement === 'root' ? '' : manifest.placement.subfolder.replace(/\/+$/, '');
}

/** `projectRoot` для `infra.config.json`: путь от каталога инфраструктуры к корню проекта. */
export function projectRootFrom(infraDir: string): string {
  if (!infraDir) return '.';
  return infraDir.split('/').map(() => '..').join('/');
}

/** `{infra}` в command/args/env сервера → путь каталога инфраструктуры с `/` на конце. */
export function resolveServer(def: McpServerDef, infraDir: string): Record<string, unknown> {
  const prefix = infraDir ? `${infraDir}/` : '';
  const sub = (value: string) => value.replace(/\{infra\}/g, prefix);
  const out: Record<string, unknown> = { ...def };
  if (def.command) out.command = sub(def.command);
  if (def.args) out.args = def.args.map(sub);
  if (def.env) out.env = Object.fromEntries(Object.entries(def.env).map(([key, value]) => [key, sub(value)]));
  return out;
}

/**
 * Серверы совместимого шаблона: относительный аргумент, который совпадает с файлом шаблона,
 * получает префикс каталога инфраструктуры — иначе в подпапке сервер не найдёт свой скрипт.
 */
function resolveCompatServer(def: McpServerDef, infraDir: string, templatePaths: Set<string>): Record<string, unknown> {
  const prefix = infraDir ? `${infraDir}/` : '';
  return { ...def, args: def.args?.map((arg) => (templatePaths.has(arg.replace(/^\.\//, '')) ? `${prefix}${arg.replace(/^\.\//, '')}` : arg)) };
}

function enabledMap<T extends { id: string; default: boolean }>(list: T[], chosen: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(list.map((item) => [item.id, chosen[item.id] ?? item.default]));
}

function copyItem(dest: string, source: string, projectHash: string | null, templateHash: string, baseHash: string | undefined): InitPlanItem {
  return { id: `tpl:${dest}`, path: dest, kind: 'file', group: 'template', copyFrom: source, ...threeWayDecision(projectHash, templateHash, baseHash) };
}

/**
 * Файл, который шаблон собирает целиком (правила, манифест, package.json инфраструктуры). С
 * записью в lock-файле — решение по трём версиям, без неё — прежнее поведение `legacy`.
 */
function trackedTextItem(id: string, dest: string, existing: string | null, next: string, baseHash: string | undefined, legacy: () => InitPlanItem): InitPlanItem {
  if (baseHash === undefined) return legacy();
  const decision = threeWayDecision(existing === null ? null : sha256(existing), sha256(next), baseHash);
  const contents: InitPlanItem['contents'] = {};
  for (const action of decision.options) if (action === 'create' || action === 'replace') contents[action] = next;
  return { id, path: dest, kind: 'file', group: 'template', ...decision, contents };
}

function textItem(
  id: string,
  dest: string,
  existing: string | null,
  next: string,
  { mergeAction = 'merge', changedDefault }: { mergeAction?: InitAction; changedDefault?: InitAction } = {}
): InitPlanItem {
  const base = { id, path: dest, kind: 'file' as const, group: 'template' as const };
  if (existing === null) return { ...base, action: 'create', options: ['create', 'skip'], reason: 'missing', contents: { create: next } };
  if (existing === next) return { ...base, action: 'skip', options: ['skip'], reason: 'up-to-date' };
  const reason: InitReason = mergeAction === 'replace' ? 'template-changed' : 'lines-missing';
  return {
    ...base,
    action: changedDefault ?? mergeAction,
    options: [mergeAction, 'skip'],
    reason,
    contents: { [mergeAction]: next },
    backupOnReplace: mergeAction === 'replace'
  };
}

function notJsonItem(id: string, dest: string): InitPlanItem {
  return { id, path: dest, kind: 'file', group: 'template', action: 'skip', options: ['skip'], reason: 'not-json' };
}

/**
 * Вклад шаблона в план. Пути назначения считаются от корня проекта; `infraDir` — каталог,
 * куда ложатся файлы с `target: "infra"`.
 */
export function buildTemplateLayer(input: TemplateLayerInput, state: TemplateProjectState, options: TemplateLayerOptions): TemplateLayerResult {
  const { manifest } = input;
  const infraDir = infraDirFor(manifest, options.placement);
  const features = enabledMap(manifest.features, options.features);
  const sets = enabledMap(manifest.sets, options.sets);
  const isOn = (id: string | undefined) => !id || features[id] === true || sets[id] === true;
  const hooksAvailable = Boolean(manifest.gitHooks);
  const hooksEnabled = hooksAvailable && (options.gitHooks ?? !state.hooksConflict);

  const items: InitPlanItem[] = [];
  const tracked: Record<string, TrackedFile> = {};
  const rulesHashes: Record<string, string> = {};
  const baseOf = (dest: string) => state.base?.[dest];
  const contribution: PlanContribution = {
    gitignore: [],
    rulesSections: [],
    rulesTargets: [],
    mcpServers: {},
    mcpRemove: [],
    items
  };

  // 1. Файлы шаблона по правилам манифеста; первое совпавшее правило решает судьбу файла.
  const excluded = [...ALWAYS_EXCLUDE, ...manifest.exclude];
  const templatePaths = new Set(input.files.map((f) => f.path));
  const sorted = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (matchesAny(file.path, excluded)) continue;
    if (manifest.rules && file.path === manifest.rules.source) continue;
    const rule = manifest.files.find((candidate) => globToRegExp(candidate.path).test(file.path));
    if (!rule || !isOn(rule.when)) continue;
    const dest = rule.target === 'project' ? file.path : join(infraDir, file.path);

    if (rule.apply === 'merge-lines') {
      const lines = (input.texts[file.path] ?? '').replace(/\r\n/g, '\n').split('\n');
      if (dest === '.gitignore') {
        contribution.gitignore.push(...lines);
      } else {
        const existing = state.texts[dest] ?? null;
        items.push(textItem(`tpl:${dest}`, dest, existing, mergeGitignore(existing, lines, 'ProjectHub template'), { mergeAction: 'append' }));
      }
      continue;
    }

    if (rule.apply === 'merge-settings') {
      const existing = state.texts[dest] ?? null;
      const template = parseJsonObject(input.texts[file.path] ?? null);
      if (!template) continue;
      if (existing !== null && existing.trim() && !parseJsonObject(existing)) {
        items.push(notJsonItem(`tpl:${dest}`, dest));
        continue;
      }
      items.push(textItem(`tpl:${dest}`, dest, existing, mergeClaudeSettings(existing, template)));
      continue;
    }

    // package.json инфраструктуры получает имя проекта: в корне — имя самого проекта, в подпапке — `<имя>-infra`.
    if (file.path === 'package.json' && rule.target === 'infra' && options.projectName && input.texts[file.path]) {
      const pkg = parseJsonObject(input.texts[file.path]);
      if (pkg) {
        const slug = options.projectName.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
        const next: Record<string, unknown> = { ...pkg, name: infraDir ? `${slug}-infra` : slug, version: infraDir ? pkg.version : '0.1.0', private: true };
        if (!infraDir) delete next.description;
        const existing = state.texts[dest] ?? null;
        const rendered = `${JSON.stringify(next, null, 2)}\n`;
        tracked[dest] = { hash: sha256(rendered), text: rendered };
        items.push(
          trackedTextItem(`tpl:${dest}`, dest, existing, rendered, baseOf(dest), () =>
            existing === null
              ? { id: `tpl:${dest}`, path: dest, kind: 'file', group: 'template', action: 'create', options: ['create', 'skip'], reason: 'template-file', contents: { create: rendered } }
              : existing === rendered
                ? { id: `tpl:${dest}`, path: dest, kind: 'file', group: 'template', action: 'skip', options: ['skip'], reason: 'up-to-date' }
                : { id: `tpl:${dest}`, path: dest, kind: 'file', group: 'template', action: 'skip', options: ['replace', 'skip'], reason: 'template-changed', contents: { replace: rendered }, backupOnReplace: true }
          )
        );
        continue;
      }
    }

    tracked[dest] = { hash: file.hash, copyFrom: file.path };
    items.push(copyItem(dest, file.path, state.hashes[dest] ?? null, file.hash, baseOf(dest)));
  }

  // 2. infra.config.json: корень проекта, фичи, хуки и происхождение шаблона.
  const configPath = join(infraDir, INFRA_CONFIG);
  const existingConfig = state.texts[configPath] ?? null;
  const baseConfig = existingConfig === null ? {} : parseJsonObject(existingConfig);
  if (baseConfig === null) {
    items.push(notJsonItem('tpl:infra-config', configPath));
  } else {
    const next: Record<string, unknown> = { ...baseConfig, projectRoot: projectRootFrom(infraDir) };
    next.features = { ...(typeof baseConfig.features === 'object' && baseConfig.features ? baseConfig.features : {}), ...features };
    if (hooksAvailable) next[manifest.gitHooks!.configKey] = hooksEnabled;
    next.template = { id: manifest.id, version: manifest.version };
    const rendered = `${JSON.stringify(next, null, 2)}\n`;
    const same = existingConfig !== null && JSON.stringify(parseJsonObject(existingConfig)) === JSON.stringify(next);
    items.push(textItem('tpl:infra-config', configPath, existingConfig, same ? existingConfig! : rendered));
  }

  // Манифест применённого шаблона остаётся в каталоге инфраструктуры: по нему проект можно
  // снова сохранить шаблоном («Сохранить проект как шаблон») без потери фич и MCP-серверов.
  const manifestPath = join(infraDir, MANIFEST_FILE);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const replaceText = (id: string, dest: string, next: string) => {
    const existing = state.texts[dest] ?? null;
    tracked[dest] = { hash: sha256(next), text: next };
    items.push(trackedTextItem(id, dest, existing, next, baseOf(dest), () => textItem(id, dest, existing, next, { mergeAction: 'replace', changedDefault: 'replace' })));
  };
  replaceText('tpl:manifest', manifestPath, manifestText);

  // 3. Правила: собранный текст — секцией в файлы правил, целиком в infra-dev.md и в правила Antigravity.
  if (manifest.rules) {
    const source = input.texts[manifest.rules.source];
    if (source !== undefined) {
      const enabled = new Set<string>([
        ...Object.entries(features).filter(([, on]) => on).map(([id]) => id),
        ...Object.entries(sets).filter(([, on]) => on).map(([id]) => id)
      ]);
      if (infraDir) enabled.add('subfolder');
      const body = assembleRules(source, enabled, { infraDir }).trim();
      contribution.rulesSections.push({ markers: sectionMarkers(manifest.rules.marker, manifest.rules.note), body });
      contribution.rulesTargets.push(...manifest.rules.targets);
      rulesHashes[manifest.rules.marker] = sha256(body);
      replaceText('tpl:rules-source', join(infraDir, manifest.rules.source), `${body}\n`);
      if (manifest.rules.agentsRules) replaceText('tpl:agents-rules', manifest.rules.agentsRules, `${body}\n`);
    }
  }

  // 4. MCP-серверы включённых фич; ключи выключенных фич шаблона снимаются.
  const servers: Record<string, Record<string, unknown>> = {};
  for (const feature of manifest.features) {
    for (const [name, def] of Object.entries(feature.mcp ?? {})) {
      if (features[feature.id]) servers[name] = resolveServer(def, infraDir);
      else contribution.mcpRemove.push(name);
    }
  }
  for (const [name, def] of Object.entries(input.compatServers ?? {})) {
    servers[name] = resolveCompatServer(def, infraDir, templatePaths);
  }
  for (const config of manifest.mcpConfigs) {
    if (config === '.mcp.json') {
      Object.assign(contribution.mcpServers, servers);
      continue;
    }
    // Конфиг Antigravity ведёт основа вместе с записью встроенного MCP (TASK-161): шаблон отдаёт ей свои серверы.
    if (config === '.agents/mcp_config.json') {
      contribution.agentsMcpServers = { ...(contribution.agentsMcpServers ?? {}), ...servers };
      continue;
    }
    const existing = state.texts[config] ?? null;
    if (existing !== null && existing.trim() && !parseJsonObject(existing)) {
      items.push(notJsonItem(`tpl:${config}`, config));
      continue;
    }
    const merged = mergeMcpServers(existing, servers, contribution.mcpRemove);
    items.push(textItem(`tpl:${config}`, config, existing, merged));
  }

  // 5. Строки .gitignore фич и статусы задач шаблона.
  for (const feature of manifest.features) {
    if (features[feature.id] && feature.gitignore) contribution.gitignore.push(...feature.gitignore);
  }
  if (manifest.statuses) contribution.statuses = manifest.statuses;

  // 6. Файлы, которые шаблон давал при прошлом применении, а теперь нет (удалены из шаблона или
  //    выключена их фича): предложить удалить, по умолчанию оставить.
  for (const dest of Object.keys(state.base ?? {}).sort()) {
    if (tracked[dest] || state.hashes[dest] == null) continue;
    items.push({ id: `tpl-removed:${dest}`, path: dest, kind: 'file', group: 'template', action: 'skip', options: ['delete', 'skip'], reason: 'template-removed', backupOnReplace: true });
  }

  // 7. Команды после применения — пунктами плана, чтобы пользователь видел и мог снять каждую.
  const commandItems: TemplateRisks['commands'] = [];
  for (const command of manifest.commands) {
    if (!isOn(command.when)) continue;
    const cwd = command.cwd === 'project' ? '' : infraDir;
    const on = options.commands[command.id] ?? command.default;
    items.push({
      id: `cmd:${command.id}`,
      path: cwd ? `${cwd}/` : './',
      kind: 'command',
      group: 'template',
      action: on ? 'create' : 'skip',
      options: ['create', 'skip'],
      reason: 'template-file',
      detail: command.run,
      label: localize(command.label, options.locale)
    });
    if (on) commandItems.push({ id: command.id, run: command.run, cwd: cwd || '.' });
  }

  const risks: TemplateRisks = {
    commands: commandItems,
    mcpServers: Object.entries(servers).map(([name, def]) => ({
      name,
      command: String(def.command ?? def.url ?? ''),
      args: Array.isArray(def.args) ? (def.args as string[]) : []
    })),
    gitHooks: hooksEnabled
  };

  return {
    contribution,
    infraDir,
    features,
    sets,
    gitHooks: { available: hooksAvailable, enabled: hooksEnabled, conflict: state.hooksConflict },
    risks,
    tracked,
    rulesHashes
  };
}

/** Пути проекта, текст которых нужен слою шаблона (для снимка). */
export function templateStateTextPaths(input: TemplateLayerInput, placement: Placement): string[] {
  const infraDir = infraDirFor(input.manifest, placement);
  const paths = new Set<string>([join(infraDir, INFRA_CONFIG), join(infraDir, MANIFEST_FILE), ...input.manifest.mcpConfigs]);
  if (input.manifest.rules) {
    paths.add(join(infraDir, input.manifest.rules.source));
    if (input.manifest.rules.agentsRules) paths.add(input.manifest.rules.agentsRules);
  }
  for (const rule of input.manifest.files) {
    if (rule.apply === 'copy') continue;
    for (const file of input.files) {
      if (globToRegExp(rule.path).test(file.path)) paths.add(rule.target === 'project' ? file.path : join(infraDir, file.path));
    }
  }
  if (input.files.some((f) => f.path === 'package.json')) paths.add(join(infraDir, 'package.json'));
  return [...paths];
}

/** Пути назначения файлов шаблона с копированием — для хэшей в снимке. */
export function templateCopyDestinations(input: TemplateLayerInput, placement: Placement): string[] {
  const infraDir = infraDirFor(input.manifest, placement);
  const excluded = [...ALWAYS_EXCLUDE, ...input.manifest.exclude];
  const result: string[] = [];
  for (const file of input.files) {
    if (matchesAny(file.path, excluded)) continue;
    const rule = input.manifest.files.find((candidate) => globToRegExp(candidate.path).test(file.path));
    if (!rule || rule.apply !== 'copy') continue;
    result.push(rule.target === 'project' ? file.path : join(infraDir, file.path));
  }
  return result;
}
