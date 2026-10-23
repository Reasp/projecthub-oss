/**
 * «Сохранить проект как шаблон» с диском (decision-78, п. 10; TASK-136.5): обход обвязки проекта,
 * проверка секретов, запись в `<userData>/templates/<id>/` и регистрация в каталоге.
 * Какие файлы брать и какой манифест строить — в чистом `templateFromProject.ts`.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AppError } from '../../src/lib/appError';
import { detectSecrets } from './secretPatterns';
import { ALLOW_SECRET_MARKER } from './diffSecretScan';
import { MANIFEST_FILE, type TemplateManifest } from './templateManifest';
import { DEFAULT_SUBFOLDER } from './templateManifest';
import { manifestFromProject, selectTemplateFiles, type SaveCandidate } from './templateFromProject';
import { allocateTemplateId, registerSavedTemplate, templatesRoot, type TemplateEntry } from './templateCatalog';

/** Каталоги, в которые обход проекта не заходит вовсе — ради скорости на больших проектах. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'backlog',
  '.rag-index',
  '.rag-cache',
  '.lightrag-index',
  '.env-state',
  '.venv',
  '__pycache__',
  'dist',
  'dist-electron',
  'build',
  'release',
  'target',
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  'Library',
  '.gradle',
  '.next',
  'coverage'
]);

const SECRET_SCAN_LIMIT = 1024 * 1024;

export interface SaveTemplateFile extends SaveCandidate {
  size: number;
  /** Виды найденных секретов (без значений); непустой список останавливает сохранение. */
  secrets: string[];
}

export interface SaveTemplatePreview {
  projectPath: string;
  infraDir: string | null;
  files: SaveTemplateFile[];
  manifest: TemplateManifest;
  secretsFound: boolean;
}

export interface SaveTemplateOptions {
  name: string;
  description?: string;
  /** Пути в проекте, которые пользователь снял в предпросмотре. */
  exclude?: string[];
}

/** Каталог инфраструктуры проекта: подпапка шаблона, корень или `null`, если её нет. */
function detectInfraDir(root: string): string | null {
  if (existsSync(path.join(root, DEFAULT_SUBFOLDER, 'infra.config.json'))) return DEFAULT_SUBFOLDER;
  if (existsSync(path.join(root, 'infra.config.json'))) return '';
  return null;
}

async function listFiles(root: string, start: string): Promise<string[]> {
  const result: string[] = [];
  const base = path.join(root, start);
  if (!existsSync(base)) return result;
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.isFile()) {
        result.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  await walk(base);
  return result;
}

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, rel), 'utf-8');
  } catch {
    return null;
  }
}

export async function previewSaveProject(projectPath: string, options: SaveTemplateOptions): Promise<SaveTemplatePreview> {
  const root = path.resolve(projectPath);
  const infraDir = detectInfraDir(root);
  // Обходятся только каталоги, где может лежать обвязка: исходники проекта не читаются.
  const starts = infraDir ? [infraDir, '.claude', '.agents'] : infraDir === '' ? ['scripts', '.claude', '.agents'] : ['.claude', '.agents'];
  const all = new Set<string>();
  for (const start of starts) for (const file of await listFiles(root, start)) all.add(file);
  if (infraDir === '') {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isFile()) all.add(entry.name);
  }
  const excluded = new Set(options.exclude ?? []);
  const candidates = selectTemplateFiles([...all], infraDir).filter((c) => !excluded.has(c.projectPath));

  const files: SaveTemplateFile[] = [];
  for (const candidate of candidates) {
    const abs = path.join(root, candidate.projectPath);
    const stat = await fs.stat(abs);
    let secrets: string[] = [];
    if (stat.size <= SECRET_SCAN_LIMIT) {
      const buf = await fs.readFile(abs);
      // Сохранение шаблона запускает человек, поэтому строки с маркером `projecthub:allow-secret`
      // (фиктивные ключи в тестах) не считаются секретом — как в проверке диффов человека.
      const text = buf.includes(0)
        ? ''
        : buf
            .toString('utf-8')
            .split('\n')
            .filter((line) => !line.includes(ALLOW_SECRET_MARKER))
            .join('\n');
      if (text) secrets = detectSecrets(text).map((f) => f.kind);
    }
    files.push({ ...candidate, size: stat.size, secrets });
  }

  const prefix = infraDir ? `${infraDir}/` : '';
  const manifest = manifestFromProject({
    id: 'preview',
    name: options.name.trim() || path.basename(root),
    description: options.description,
    infraDir: infraDir ?? '',
    appliedManifest: infraDir !== null ? await readText(root, `${prefix}${MANIFEST_FILE}`) : null,
    infraConfig: infraDir !== null ? await readText(root, `${prefix}infra.config.json`) : null,
    mcpConfig: await readText(root, '.mcp.json'),
    hasAgentsMcp: existsSync(path.join(root, '.agents', 'mcp_config.json')),
    hasRules: files.some((f) => f.templatePath === 'infra-dev.md'),
    hasPackageJson: files.some((f) => f.templatePath === 'package.json')
  });

  return { projectPath: root, infraDir, files, manifest, secretsFound: files.some((f) => f.secrets.length > 0) };
}

/** Сохраняет обвязку проекта шаблоном. Найденный секрет останавливает сохранение целиком. */
export async function saveProjectAsTemplate(projectPath: string, options: SaveTemplateOptions): Promise<TemplateEntry> {
  const name = options.name.trim();
  if (!name) throw new AppError('templates.nameRequired');
  const preview = await previewSaveProject(projectPath, options);
  const withSecrets = preview.files.filter((f) => f.secrets.length > 0);
  if (withSecrets.length > 0) {
    throw new AppError('templates.secretsFound', { files: withSecrets.map((f) => `${f.projectPath} (${f.secrets.join(', ')})`).join('; ') });
  }
  if (preview.files.length === 0) throw new AppError('templates.nothingToSave');

  const id = await allocateTemplateId(name);
  const dest = path.join(templatesRoot(), id);
  try {
    for (const file of preview.files) {
      const target = path.join(dest, file.templatePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(preview.projectPath, file.projectPath), target);
    }
    const manifest = { ...preview.manifest, id, name };
    await fs.writeFile(path.join(dest, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }
  return registerSavedTemplate(id, preview.projectPath);
}
