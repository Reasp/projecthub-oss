/**
 * Инициализация проекта (decision-78; TASK-136.1, 136.2, 136.4): снимок проекта с диска,
 * предпросмотр плана основы и шаблона, применение выбранных действий, команды после применения.
 *
 * План строят чистые модули (`initFoundation.ts`, `initTemplateLayer.ts`). Здесь — только
 * чтение и запись. Применение каждый раз строит план заново по свежему снимку: из интерфейса
 * приходят лишь выбранные действия по id пунктов, а не содержимое файлов.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { simpleGit } from 'simple-git';
import {
  buildFoundationPlan,
  DEFAULT_RULE_TARGETS,
  FOUNDATION_DIRS,
  foundationSnapshotFiles,
  missingFoundationParts,
  PROJECTHUB_MCP_ENTRY,
  RULE_TARGETS,
  BACKLOG_CONFIG_PATH,
  type FoundationPart,
  type FoundationSnapshot,
  type InitAction,
  type InitLocale,
  type InitPlanItem,
  type RulesMode
} from './initFoundation';
import {
  buildTemplateLayer,
  templateCopyDestinations,
  templateStateTextPaths,
  type Placement,
  type TemplateRisks
} from './initTemplateLayer';
import { localize } from './templateManifest';
import { BUILTIN_TEMPLATE_ID, loadTemplate, type TemplateEntry } from './templateCatalog';
import { parseBacklogConfig } from './backlogConfigService';
import { assertInsideProject, isRegisteredProjectRoot } from './pathGuard';
import { projectRegistry } from './projectRegistry';
import { invalidateInspectCache } from './projectScanner';
import { processManager } from './processManager';

export interface InitRequest {
  targetDir: string;
  /** Название нового проекта (мастер); для существующего — из config.yml или имени папки. */
  projectName?: string;
  locale: InitLocale;
  rulesMode: RulesMode;
  rulesTargets?: string[];
  /** id шаблона из каталога; `null` — без шаблона. */
  templateId?: string | null;
  placement?: Placement;
  features?: Record<string, boolean>;
  sets?: Record<string, boolean>;
  commands?: Record<string, boolean>;
  gitHooks?: boolean;
}

export interface InitOptionView {
  id: string;
  label: string;
  description: string;
  default: boolean;
  enabled: boolean;
  heavy?: boolean;
}

export interface InitTemplateView {
  entry: TemplateEntry;
  placement: Placement;
  infraDir: string;
  allowRoot: boolean;
  features: InitOptionView[];
  sets: InitOptionView[];
  gitHooks: { available: boolean; enabled: boolean; conflict: string | null; description: string };
  risks: TemplateRisks;
  /** Шаблон не доверенный: применение — только с подтверждением этого хэша. */
  requiresConfirmation: boolean;
}

export interface InitPreview {
  targetDir: string;
  projectName: string;
  /** Папки нет или она пуста (мастер нового проекта). */
  isNew: boolean;
  registered: boolean;
  stacks: Array<{ id: string; label: string }>;
  items: InitPlanItem[];
  template: InitTemplateView | null;
}

export interface InitApplyRequest extends InitRequest {
  /** Выбранное действие по id пункта; пункт без выбора — действие по умолчанию. */
  choices: Record<string, InitAction>;
  /** Хэш недоверенного шаблона, который пользователь подтвердил в предпросмотре. */
  confirmTemplateHash?: string;
}

export interface InitReport {
  projectPath: string;
  registered: boolean;
  written: Array<{ path: string; action: InitAction }>;
  backupDir: string | null;
  commands: Array<{ id: string; run: string; ok: boolean; exitCode: number | null; durationMs: number; error?: string }>;
}

export type InitProgressEvent =
  | { type: 'file'; path: string; action: InitAction }
  | { type: 'command-start'; id: string; run: string; cwd: string }
  | { type: 'command-output'; id: string; text: string }
  | { type: 'command-end'; id: string; ok: boolean; exitCode: number | null };

// ---------------------------------------------------------------------------------------
// Куда можно писать
// ---------------------------------------------------------------------------------------

/** Папки, выбранные пользователем в системном диалоге «Инициализировать папку» в этой сессии. */
const approvedTargets = new Set<string>();

function normalizeKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function approveInitTarget(dir: string): void {
  approvedTargets.add(normalizeKey(dir));
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) return false;
  return (await fs.readdir(dir)).length === 0;
}

/**
 * Писать можно в зарегистрированный проект, в папку, выбранную пользователем в диалоге, и в
 * новую или пустую папку мастера. Любая другая папка (путь, пришедший из рендерера) отклоняется.
 */
async function assertInitTarget(dir: string): Promise<{ root: string; registered: boolean; isNew: boolean }> {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Не указана папка проекта');
  const root = path.resolve(dir);
  if (path.parse(root).root === root) throw new Error('Нельзя инициализировать корень диска');
  const projects = (await projectRegistry.getProjects()).map((p) => p.path);
  const registered = isRegisteredProjectRoot(projects, root);
  const isNew = await isEmptyOrMissing(root);
  if (!registered && !isNew && !approvedTargets.has(normalizeKey(root))) {
    throw new Error('Папка не зарегистрирована в ProjectHub. Выберите её в окне «Инициализировать папку».');
  }
  if (existsSync(root) && !(await fs.stat(root)).isDirectory()) throw new Error(`Это не папка: ${root}`);
  return { root, registered, isNew };
}

// ---------------------------------------------------------------------------------------
// Снимок
// ---------------------------------------------------------------------------------------

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, rel), 'utf-8');
  } catch {
    return null;
  }
}

async function hashFile(root: string, rel: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(path.join(root, rel))).digest('hex');
  } catch {
    return null;
  }
}

async function countMarkdown(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
}

async function readFoundationSnapshot(root: string, projectName: string | undefined, extraTexts: string[]): Promise<FoundationSnapshot> {
  const exists = existsSync(root);
  const rootNames = exists ? await fs.readdir(root) : [];
  const files: Record<string, string | null> = {};
  for (const rel of new Set([...foundationSnapshotFiles(), ...extraTexts])) files[rel] = exists ? await readText(root, rel) : null;
  const dirs = exists ? FOUNDATION_DIRS.filter((dir) => existsSync(path.join(root, dir))) : [];
  const configName = files[BACKLOG_CONFIG_PATH] ? parseBacklogConfig(files[BACKLOG_CONFIG_PATH]).projectName : undefined;
  return {
    projectName: projectName?.trim() || configName || path.basename(root),
    rootNames,
    hasGit: exists && existsSync(path.join(root, '.git')),
    dirs: [...dirs],
    docsCount: await countMarkdown(path.join(root, 'backlog', 'docs')),
    files
  };
}

/** Свои git-хуки проекта: шаблон не должен молча переопределить `core.hooksPath`. */
async function detectHooksConflict(root: string, infraDir: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  for (const marker of ['.husky', 'lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.pre-commit-config.yaml', '.simple-git-hooks.json']) {
    if (existsSync(path.join(root, marker))) return marker;
  }
  const pkg = await readText(root, 'package.json');
  if (pkg && /"(husky|simple-git-hooks|lint-staged)"\s*:/.test(pkg)) return 'package.json (husky / simple-git-hooks)';
  if (existsSync(path.join(root, '.git'))) {
    try {
      const hooksPath = (await simpleGit(root).raw(['config', '--get', 'core.hooksPath'])).trim();
      const ours = `${infraDir ? `${infraDir}/` : ''}scripts/git-hooks`;
      if (hooksPath && hooksPath !== ours) return `core.hooksPath = ${hooksPath}`;
    } catch {
      // core.hooksPath не задан — git возвращает код 1
    }
    const hooksDir = path.join(root, '.git', 'hooks');
    if (existsSync(hooksDir)) {
      const own = (await fs.readdir(hooksDir)).filter((name) => !name.endsWith('.sample'));
      if (own.length > 0) return `.git/hooks/${own[0]}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Предпросмотр
// ---------------------------------------------------------------------------------------

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface BuiltPlan {
  preview: InitPreview;
  templateDir: string | null;
}

async function buildPlan(request: InitRequest): Promise<BuiltPlan> {
  const { root, registered, isNew } = await assertInitTarget(request.targetDir);
  const locale = request.locale === 'en' ? 'en' : 'ru';
  const rulesTargets = (request.rulesTargets ?? DEFAULT_RULE_TARGETS).filter((t) => (RULE_TARGETS as readonly string[]).includes(t));

  let templateView: InitTemplateView | null = null;
  let templateDir: string | null = null;
  let contribution = null;
  let extraTexts: string[] = [];

  if (request.templateId) {
    const loaded = await loadTemplate(request.templateId, locale);
    const { manifest } = loaded.input;
    const placement: Placement = request.placement ?? (isNew ? 'root' : 'subfolder');
    if (placement === 'root' && !isNew && !manifest.placement.allowRoot) throw new Error('Шаблон нельзя положить в корень существующего проекта');
    const textPaths = templateStateTextPaths(loaded.input, placement);
    extraTexts = textPaths;
    const texts: Record<string, string | null> = {};
    for (const rel of textPaths) texts[rel] = existsSync(root) ? await readText(root, rel) : null;
    const hashes: Record<string, string | null> = {};
    for (const rel of templateCopyDestinations(loaded.input, placement)) hashes[rel] = existsSync(root) ? await hashFile(root, rel) : null;
    const infraDirGuess = placement === 'root' ? '' : manifest.placement.subfolder;
    const layer = buildTemplateLayer(
      loaded.input,
      { hashes, texts, hooksConflict: await detectHooksConflict(root, infraDirGuess) },
      {
        locale,
        placement,
        features: request.features ?? {},
        sets: request.sets ?? {},
        commands: request.commands ?? {},
        gitHooks: request.gitHooks,
        projectName: request.projectName?.trim() || path.basename(root)
      }
    );
    contribution = layer.contribution;
    templateDir = loaded.entry.dir;
    templateView = {
      entry: loaded.entry,
      placement,
      infraDir: layer.infraDir,
      allowRoot: manifest.placement.allowRoot,
      features: manifest.features.map((f) => ({
        id: f.id,
        label: localize(f.label, locale),
        description: localize(f.description, locale),
        default: f.default,
        enabled: layer.features[f.id],
        heavy: f.heavy
      })),
      sets: manifest.sets.map((s) => ({
        id: s.id,
        label: localize(s.label, locale),
        description: localize(s.description, locale),
        default: s.default,
        enabled: layer.sets[s.id]
      })),
      gitHooks: { ...layer.gitHooks, description: localize(manifest.gitHooks?.description, locale) },
      risks: layer.risks,
      requiresConfirmation: !loaded.entry.trusted
    };
  }

  const snapshot = await readFoundationSnapshot(root, request.projectName, extraTexts);
  const plan = buildFoundationPlan(
    snapshot,
    { locale, rulesMode: request.rulesMode === 'replace' ? 'replace' : 'append', rulesTargets, mcpEntry: PROJECTHUB_MCP_ENTRY, stamp: nowStamp() },
    contribution
  );

  return {
    preview: {
      targetDir: root,
      projectName: snapshot.projectName,
      isNew,
      registered,
      stacks: plan.stacks.map(({ id, label }) => ({ id, label })),
      items: plan.items,
      template: templateView
    },
    templateDir
  };
}

export async function previewInit(request: InitRequest): Promise<InitPreview> {
  return (await buildPlan(request)).preview;
}

// ---------------------------------------------------------------------------------------
// Применение
// ---------------------------------------------------------------------------------------

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export async function applyInit(request: InitApplyRequest, onEvent: (event: InitProgressEvent) => void = () => {}): Promise<InitReport> {
  const { preview, templateDir } = await buildPlan(request);
  const root = preview.targetDir;

  if (preview.template?.requiresConfirmation && request.confirmTemplateHash !== preview.template.entry.hash) {
    throw new Error('Шаблон не доверенный: подтвердите команды, MCP-серверы и git-хуки в предпросмотре');
  }

  const chosen = preview.items.map((item) => {
    const requested = request.choices?.[item.id];
    const action = requested ?? item.action;
    if (!item.options.includes(action) && action !== item.action) {
      throw new Error(`Недопустимое действие «${action}» для ${item.path}`);
    }
    return { item, action };
  });

  await fs.mkdir(root, { recursive: true });
  const written: InitReport['written'] = [];
  const backupRoot = path.join(root, '.projecthub', 'backup', backupStamp());
  let backupUsed = false;

  // 1. git init — до файлов, чтобы .gitignore лёг в уже созданный репозиторий.
  const gitInit = chosen.find(({ item }) => item.id === 'git:init');
  if (gitInit && gitInit.action !== 'skip') {
    await simpleGit(root).init();
    written.push({ path: '.git/', action: 'create' });
    onEvent({ type: 'file', path: '.git/', action: 'create' });
  }

  // 2. Каталоги и файлы.
  for (const { item, action } of chosen) {
    if (action === 'skip' || item.kind === 'command') continue;
    const target = assertInsideProject(root, path.join(root, item.path));
    if (item.kind === 'dir') {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (action === 'replace' && item.backupOnReplace && existsSync(target)) {
        const backup = path.join(backupRoot, item.path);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(target, backup);
        backupUsed = true;
      }
      if (item.copyFrom) {
        if (!templateDir) throw new Error('Файл шаблона без каталога шаблона');
        const source = assertInsideProject(templateDir, path.join(templateDir, item.copyFrom));
        await fs.copyFile(source, target);
      } else {
        const content = item.contents?.[action];
        if (content === undefined) throw new Error(`Нет содержимого для «${action}» ${item.path}`);
        await fs.writeFile(target, content, 'utf-8');
      }
    }
    written.push({ path: item.path, action });
    onEvent({ type: 'file', path: item.path, action });
  }

  // 3. Регистрация: после основы любая папка распознаётся сканером (есть backlog/).
  let registered = preview.registered;
  if (!registered) {
    await projectRegistry.addProject(root, false);
    registered = true;
  }
  invalidateInspectCache(root);

  // 4. Команды после применения — по очереди; первая неудачная останавливает остальные.
  const commands: InitReport['commands'] = [];
  for (const { item, action } of chosen) {
    if (item.kind !== 'command' || item.id === 'git:init' || action === 'skip' || !item.detail) continue;
    const id = item.id.replace(/^cmd:/, '');
    const cwd = assertInsideProject(root, path.join(root, item.path === './' ? '.' : item.path));
    onEvent({ type: 'command-start', id, run: item.detail, cwd });
    const result = await processManager.runOnce(item.detail, {
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onOutput: (text) => onEvent({ type: 'command-output', id, text })
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.error;
    commands.push({ id, run: item.detail, ok, exitCode: result.exitCode, durationMs: result.durationMs, error: result.error ?? (result.timedOut ? 'timeout' : undefined) });
    onEvent({ type: 'command-end', id, ok, exitCode: result.exitCode });
    if (!ok) break;
  }
  if (commands.length > 0) invalidateInspectCache(root);

  return { projectPath: root, registered, written, backupDir: backupUsed ? backupRoot : null, commands };
}

// ---------------------------------------------------------------------------------------
// Статус основы для карточки проекта
// ---------------------------------------------------------------------------------------

export async function foundationStatus(projectPath: string): Promise<FoundationPart[]> {
  const root = path.resolve(projectPath);
  const rules: Array<string | null> = [];
  for (const target of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) rules.push(await readText(root, target));
  return missingFoundationParts({
    hasGit: existsSync(path.join(root, '.git')),
    hasBacklogConfig: existsSync(path.join(root, BACKLOG_CONFIG_PATH)),
    dirs: FOUNDATION_DIRS.filter((dir) => existsSync(path.join(root, dir))),
    rules
  });
}

export { BUILTIN_TEMPLATE_ID };
