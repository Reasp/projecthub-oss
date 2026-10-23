/**
 * Каталог шаблонов проектов (decision-78, п. 7, 10–11; TASK-136.5).
 *
 * Встроенный шаблон приходит со сборкой и только читается. Свои шаблоны лежат в
 * `<userData>/templates/<id>/`, их происхождение и доверие — в `<userData>/templates/catalog.json`.
 * Доверие привязано к хэшу содержимого: изменился шаблон (git pull, правка файлов) — подтверждение
 * снова обязательно.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { AppError } from '../../src/lib/appError';
import { getUserDataDir } from './appPaths';
import { resolveTemplatePath } from './templateWizard';
import { isInsideProject } from './pathGuard';
import {
  compatManifest,
  compatMcpServers,
  localize,
  MANIFEST_FILE,
  parseManifest,
  type ManifestIssue,
  type McpServerDef,
  type TemplateManifest
} from './templateManifest';
import { ALWAYS_EXCLUDE, matchesAny, type TemplateLayerInput } from './initTemplateLayer';
import { uniqueTemplateId } from './templateFromProject';

export const BUILTIN_TEMPLATE_ID = 'builtin';

export type TemplateOrigin = 'builtin' | 'override' | 'folder' | 'git' | 'zip' | 'copy' | 'project';

export interface TemplateEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  manifestId: string;
  builtin: boolean;
  dir: string;
  origin: TemplateOrigin;
  /** Откуда взят: путь папки, URL репозитория, имя архива, id исходного шаблона, путь проекта. */
  originRef?: string;
  compat: boolean;
  issues: ManifestIssue[];
  hash: string;
  trusted: boolean;
}

interface CatalogRecord {
  origin: TemplateOrigin;
  originRef?: string;
  addedAt: string;
  trustedHash?: string;
}

interface CatalogFile {
  version: 1;
  templates: Record<string, CatalogRecord>;
}

/** Файлы, которые не читаются при обходе шаблона (и не входят в хэш). */
const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.rag-cache', '.env-state']);

export function templatesRoot(): string {
  return path.join(getUserDataDir(), 'templates');
}

function catalogPath(): string {
  return path.join(templatesRoot(), 'catalog.json');
}

async function readCatalog(): Promise<CatalogFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath(), 'utf-8')) as CatalogFile;
    if (parsed && typeof parsed.templates === 'object') return { version: 1, templates: parsed.templates };
  } catch {
    // нет файла или битый — пустой каталог
  }
  return { version: 1, templates: {} };
}

async function writeCatalog(catalog: CatalogFile): Promise<void> {
  await fs.mkdir(templatesRoot(), { recursive: true });
  await fs.writeFile(catalogPath(), `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
}

export interface WalkedTemplate {
  files: Array<{ path: string; hash: string }>;
  hash: string;
}

/** Обход каталога шаблона: файлы с хэшами и общий хэш содержимого. Ссылки не читаются. */
export async function walkTemplate(dir: string): Promise<WalkedTemplate> {
  const files: Array<{ path: string; hash: string }> = [];
  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (WALK_SKIP.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        const buf = await fs.readFile(abs);
        files.push({
          path: path.relative(dir, abs).split(path.sep).join('/'),
          hash: crypto.createHash('sha256').update(buf).digest('hex')
        });
      }
    }
  };
  await walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const total = crypto.createHash('sha256');
  for (const file of files) total.update(`${file.path}\0${file.hash}\n`);
  return { files, hash: total.digest('hex') };
}

async function readText(dir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, rel), 'utf-8');
  } catch {
    return null;
  }
}

export interface LoadedTemplate {
  entry: TemplateEntry;
  input: TemplateLayerInput;
}

/** Манифест шаблона: свой или совместимый режим; ошибки манифеста возвращаются, а не бросаются. */
async function readManifest(dir: string): Promise<{ manifest: TemplateManifest | null; compat: boolean; issues: ManifestIssue[]; compatServers: Record<string, McpServerDef> | null }> {
  const raw = await readText(dir, MANIFEST_FILE);
  if (raw !== null) {
    const parsed = parseManifest(raw);
    if (parsed.ok) return { manifest: parsed.manifest, compat: false, issues: [], compatServers: null };
    return { manifest: null, compat: false, issues: parsed.issues, compatServers: null };
  }
  const manifest = compatManifest({
    folderName: path.basename(dir),
    infraConfig: await readText(dir, 'infra.config.json'),
    packageJson: await readText(dir, 'package.json'),
    hasRules: existsSync(path.join(dir, 'infra-dev.md'))
  });
  return { manifest, compat: true, issues: [], compatServers: compatMcpServers(await readText(dir, '.mcp.json')) };
}

async function describe(id: string, dir: string, origin: TemplateOrigin, record: CatalogRecord | undefined, locale: string): Promise<{ entry: TemplateEntry; manifest: TemplateManifest | null; compatServers: Record<string, McpServerDef> | null; walked: WalkedTemplate }> {
  const walked = await walkTemplate(dir);
  const { manifest, compat, issues, compatServers } = await readManifest(dir);
  const builtin = id === BUILTIN_TEMPLATE_ID;
  const entry: TemplateEntry = {
    id,
    name: manifest ? localize(manifest.name, locale) : path.basename(dir),
    description: manifest ? localize(manifest.description, locale) : '',
    version: manifest?.version ?? '',
    manifestId: manifest?.id ?? '',
    builtin,
    dir,
    origin,
    originRef: record?.originRef,
    compat,
    issues,
    hash: walked.hash,
    // Встроенный шаблон и путь, заданный пользователем в настройках, — доверенные.
    trusted: builtin || record?.trustedHash === walked.hash
  };
  return { entry, manifest, compatServers, walked };
}

/** Встроенный шаблон: путь из настроек/`PROJECT_TEMPLATE_PATH` переопределяет поставляемый. */
async function builtinDir(): Promise<{ dir: string; origin: TemplateOrigin } | null> {
  const resolved = await resolveTemplatePath();
  if (!resolved.path || !existsSync(resolved.path)) return null;
  return { dir: resolved.path, origin: resolved.source === 'builtin' ? 'builtin' : 'override' };
}

export async function listTemplates(locale = 'ru'): Promise<TemplateEntry[]> {
  const result: TemplateEntry[] = [];
  const builtin = await builtinDir();
  if (builtin) result.push((await describe(BUILTIN_TEMPLATE_ID, builtin.dir, builtin.origin, undefined, locale)).entry);

  const catalog = await readCatalog();
  for (const [id, record] of Object.entries(catalog.templates)) {
    const dir = path.join(templatesRoot(), id);
    if (!existsSync(dir)) continue;
    try {
      result.push((await describe(id, dir, record.origin, record, locale)).entry);
    } catch (err) {
      console.warn(`[templates] шаблон ${id} не читается:`, (err as Error).message);
    }
  }
  return result;
}

/** Шаблон целиком для плана инициализации. */
export async function loadTemplate(id: string, locale = 'ru'): Promise<LoadedTemplate> {
  let dir: string;
  let origin: TemplateOrigin;
  let record: CatalogRecord | undefined;
  if (id === BUILTIN_TEMPLATE_ID) {
    const builtin = await builtinDir();
    if (!builtin) throw new AppError('templates.builtinMissing');
    ({ dir, origin } = builtin);
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AppError('templates.invalidId', { id });
    const catalog = await readCatalog();
    record = catalog.templates[id];
    dir = path.join(templatesRoot(), id);
    if (!record || !existsSync(dir)) throw new AppError('templates.notFound', { id });
    origin = record.origin;
  }
  const { entry, manifest, compatServers, walked } = await describe(id, dir, origin, record, locale);
  if (!manifest) {
    throw new AppError('templates.manifestInvalid', { name: entry.name, issues: entry.issues.map((i) => `${i.path || '(root)'} — ${i.message}`).join('; ') });
  }

  // Текст нужен только файлам, которые сливаются или собираются: правила и merge-правила манифеста.
  const texts: Record<string, string> = {};
  const mergeGlobs = manifest.files.filter((rule) => rule.apply !== 'copy').map((rule) => rule.path);
  for (const file of walked.files) {
    const wanted =
      file.path === MANIFEST_FILE || file.path === 'package.json' || file.path === manifest.rules?.source || matchesAny(file.path, mergeGlobs);
    if (!wanted) continue;
    const text = await readText(dir, file.path);
    if (text !== null) texts[file.path] = text;
  }
  return { entry, input: { manifest, compatServers, files: walked.files, texts } };
}

export async function setTemplateTrusted(id: string, trusted: boolean): Promise<TemplateEntry> {
  if (id === BUILTIN_TEMPLATE_ID) throw new AppError('templates.builtinAlwaysTrusted');
  const catalog = await readCatalog();
  const record = catalog.templates[id];
  if (!record) throw new AppError('templates.notFound', { id });
  const dir = path.join(templatesRoot(), id);
  const walked = await walkTemplate(dir);
  if (trusted) record.trustedHash = walked.hash;
  else delete record.trustedHash;
  await writeCatalog(catalog);
  return (await describe(id, dir, record.origin, record, 'ru')).entry;
}

// ---------------------------------------------------------------------------------------
// Добавление и создание
// ---------------------------------------------------------------------------------------

async function takenIds(): Promise<Set<string>> {
  const catalog = await readCatalog();
  const taken = new Set<string>([BUILTIN_TEMPLATE_ID, ...Object.keys(catalog.templates)]);
  if (existsSync(templatesRoot())) {
    for (const name of await fs.readdir(templatesRoot())) taken.add(name.toLowerCase());
  }
  return taken;
}

async function register(id: string, origin: TemplateOrigin, originRef?: string): Promise<TemplateEntry> {
  const catalog = await readCatalog();
  catalog.templates[id] = { origin, originRef, addedAt: new Date().toISOString() };
  await writeCatalog(catalog);
  return (await describe(id, path.join(templatesRoot(), id), origin, catalog.templates[id], 'ru')).entry;
}

/** Копия каталога без служебного содержимого (`.git`, `node_modules`, индексы, данные шаблона-проекта). */
export async function copyTemplateTree(src: string, dest: string, extraExclude: string[] = []): Promise<number> {
  let count = 0;
  const exclude = [...ALWAYS_EXCLUDE.filter((glob) => !['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.mcp.json', '.agents/mcp_config.json', '.agents/rules/**', 'infra.config.json', 'projecthub-template.json'].includes(glob)), ...extraExclude];
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const rel = path.relative(src, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink() || matchesAny(rel, exclude)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        const target = path.join(dest, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(abs, target);
        count++;
      }
    }
  };
  await fs.mkdir(dest, { recursive: true });
  await walk(src);
  return count;
}

async function suggestedId(dir: string, fallback: string): Promise<string> {
  const raw = await readText(dir, MANIFEST_FILE);
  const parsed = raw ? parseManifest(raw) : null;
  return uniqueTemplateId(parsed?.ok ? parsed.manifest.id : fallback, await takenIds());
}

export async function addTemplateFromFolder(folder: string): Promise<TemplateEntry> {
  const src = path.resolve(folder);
  if (!existsSync(src)) throw new AppError('templates.folderNotFound', { path: src });
  if (isInsideProject(templatesRoot(), src)) throw new AppError('templates.folderInsideCatalog');
  const id = await suggestedId(src, path.basename(src));
  await copyTemplateTree(src, path.join(templatesRoot(), id));
  return register(id, 'folder', src);
}

/** URL git: https, ssh (`git@host:repo`) или `file://`. Опции командной строки (`-…`) отвергаются. */
export function isAcceptableGitUrl(url: string): boolean {
  const value = url.trim();
  if (!value || value.startsWith('-') || /\s/.test(value)) return false;
  return /^(https?|ssh|git|file):\/\//i.test(value) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(value);
}

export async function addTemplateFromGit(url: string): Promise<TemplateEntry> {
  if (!isAcceptableGitUrl(url)) throw new AppError('templates.gitUrlInvalid');
  const repoName = url.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? 'template';
  const id = uniqueTemplateId(repoName, await takenIds());
  const dest = path.join(templatesRoot(), id);
  await fs.mkdir(templatesRoot(), { recursive: true });
  try {
    await simpleGit(templatesRoot()).clone(url.trim(), dest, ['--depth', '1']);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw Object.assign(new AppError('templates.cloneFailed', { url, detail: (err as Error).message }), { cause: err });
  }
  return register(id, 'git', url.trim());
}

/** «Обновить» шаблон из git: `git pull`. Новый хэш снимает доверие автоматически. */
export async function updateTemplateFromGit(id: string): Promise<TemplateEntry> {
  const catalog = await readCatalog();
  const record = catalog.templates[id];
  if (!record || record.origin !== 'git') throw new AppError('templates.updateGitOnly');
  const dir = path.join(templatesRoot(), id);
  await simpleGit(dir).pull(['--ff-only']);
  return (await describe(id, dir, record.origin, record, 'ru')).entry;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(stderr.trim() ? new Error(stderr.trim()) : new AppError('templates.commandFailed', { command, code: String(code) }))));
  });
}

/** Распаковка zip системным tar (bsdtar в Windows 10+ и macOS) или unzip (Linux); ссылки и выход за каталог отвергаются. */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  if (process.platform === 'linux') await run('unzip', ['-q', zipPath, '-d', dest], dest);
  else await run('tar', ['-xf', zipPath, '-C', dest], dest);
  // Compare real paths: dest itself may sit under a symlink (macOS /var -> /private/var).
  const realDest = await fs.realpath(dest);
  const check = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new AppError('templates.zipLink', { path: path.relative(dest, abs) });
      const real = await fs.realpath(abs);
      if (!isInsideProject(realDest, real)) throw new AppError('templates.zipOutside', { name: entry.name });
      if (entry.isDirectory()) await check(abs);
    }
  };
  await check(dest);
}

export async function addTemplateFromZip(zipPath: string): Promise<TemplateEntry> {
  const src = path.resolve(zipPath);
  if (!existsSync(src)) throw new AppError('templates.zipNotFound', { path: src });
  const staging = path.join(templatesRoot(), `.staging-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await extractZip(src, staging);
    // Архив с одной папкой внутри — шаблоном считается она.
    const entries = (await fs.readdir(staging, { withFileTypes: true })).filter((e) => !e.name.startsWith('__MACOSX'));
    const root = entries.length === 1 && entries[0].isDirectory() ? path.join(staging, entries[0].name) : staging;
    const id = await suggestedId(root, path.basename(src, path.extname(src)));
    await copyTemplateTree(root, path.join(templatesRoot(), id));
    return await register(id, 'zip', path.basename(src));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Копия шаблона (в том числе встроенного) с новым id и названием в манифесте. */
export async function duplicateTemplate(id: string, name?: string): Promise<TemplateEntry> {
  const source = await loadTemplate(id);
  const newId = uniqueTemplateId(`${source.entry.manifestId || id}-copy`, await takenIds());
  const dest = path.join(templatesRoot(), newId);
  await copyTemplateTree(source.entry.dir, dest);
  if (!source.entry.compat) {
    const manifest = { ...source.input.manifest, id: newId, name: name?.trim() || `${source.entry.name} (copy)` };
    await fs.writeFile(path.join(dest, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }
  return register(newId, 'copy', id);
}

export async function removeTemplate(id: string): Promise<void> {
  if (id === BUILTIN_TEMPLATE_ID) throw new AppError('templates.builtinNotRemovable');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AppError('templates.invalidId', { id });
  const catalog = await readCatalog();
  delete catalog.templates[id];
  await writeCatalog(catalog);
  await fs.rm(path.join(templatesRoot(), id), { recursive: true, force: true });
}

/** Регистрация каталога, уже записанного в `templates/<id>` (сохранение проекта как шаблона). */
export async function registerSavedTemplate(id: string, projectPath: string): Promise<TemplateEntry> {
  return register(id, 'project', projectPath);
}

export async function allocateTemplateId(base: string): Promise<string> {
  return uniqueTemplateId(base, await takenIds());
}
