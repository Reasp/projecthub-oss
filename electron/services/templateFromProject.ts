/**
 * «Сохранить проект как шаблон» (decision-78, п. 10; TASK-136.5): из проекта берётся только
 * обвязка — каталог инфраструктуры, настройки и скиллы агентов. Задачи, документы, память,
 * индексы, `.env*`, `node_modules` и служебные каталоги в шаблон не попадают никогда.
 * Чистый модуль: список файлов и тексты конфигов приходят снаружи.
 */
import { isEnvFile } from './diffSecretScan.js';
import { matchesAny } from './initTemplateLayer.js';
import { MANIFEST_FILE, ManifestSchema, parseManifest, type TemplateManifest } from './templateManifest.js';

/** Что не берётся из проекта ни при каких условиях. */
export const SAVE_EXCLUDE = [
  '.git/**',
  '**/node_modules/**',
  'node_modules/**',
  'backlog/**',
  '.rag-index/**',
  '.rag-cache/**',
  '**/.rag-cache/**',
  '.lightrag-index/**',
  '**/.env-state/**',
  '.env-state/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '.claude/memory/**',
  '.claude/worktrees/**',
  '.claude/agents/**',
  '.claude/settings.local.json',
  '.claude/scheduled_tasks.lock',
  '.projecthub/backup/**',
  '.projecthub/roles/**',
  '.projecthub/hooks/**',
  '.playwright-mcp/**',
  '**/*.log',
  '**/*.zip'
];

/** Файлы уровня проекта, которые шаблон кладёт в корень проекта, а не в каталог инфраструктуры. */
export const PROJECT_LEVEL = ['.claude/settings.json', '.claude/skills/**', '.claude/commands/**', '.agents/skills/**'];

/** Обвязка, если инфраструктура лежит в корне проекта (там же и код проекта). */
export const ROOT_INFRA = [
  'scripts/**',
  'package.json',
  'package-lock.json',
  'infra-dev.md',
  'start-web.bat',
  'start-web.sh',
  '.gitattributes',
  '.gitignore',
  MANIFEST_FILE
];

export interface SaveCandidate {
  /** Путь файла в проекте. */
  projectPath: string;
  /** Путь файла в шаблоне. */
  templatePath: string;
  /** Файл уровня проекта (`target: "project"` в манифесте). */
  projectLevel: boolean;
}

/**
 * Файлы проекта, которые предлагается сохранить в шаблон. `infraDir` — каталог инфраструктуры
 * (`''` — корень проекта), `null` — инфраструктуры нет: тогда берутся только файлы уровня проекта,
 * а не собственные `scripts/` и `package.json` проекта.
 */
export function selectTemplateFiles(projectFiles: string[], infraDir: string | null): SaveCandidate[] {
  const prefix = infraDir ? `${infraDir}/` : '';
  const result: SaveCandidate[] = [];
  for (const file of [...projectFiles].sort()) {
    if (matchesAny(file, SAVE_EXCLUDE) || isEnvFile(file)) continue;
    if (matchesAny(file, PROJECT_LEVEL)) {
      result.push({ projectPath: file, templatePath: file, projectLevel: true });
      continue;
    }
    if (infraDir === null) continue;
    if (prefix) {
      if (file.startsWith(prefix)) result.push({ projectPath: file, templatePath: file.slice(prefix.length), projectLevel: false });
      continue;
    }
    if (matchesAny(file, ROOT_INFRA)) result.push({ projectPath: file, templatePath: file, projectLevel: false });
  }
  return result;
}

export interface ManifestFromProjectInput {
  id: string;
  name: string;
  description?: string;
  infraDir: string;
  /** Манифест шаблона, применённого к проекту (`<infra>/projecthub-template.json`). */
  appliedManifest: string | null;
  infraConfig: string | null;
  mcpConfig: string | null;
  hasAgentsMcp: boolean;
  hasRules: boolean;
  hasPackageJson: boolean;
}

function safeJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const sanitizeId = (raw: string) => raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 64) || 'feature';

/**
 * Манифест нового шаблона. Если к проекту применялся шаблон с манифестом — берётся он с новыми
 * `id`/`name`. Иначе манифест строится по проекту: фичи — из `infra.config.json`, каждый
 * MCP-сервер `.mcp.json` (кроме записей ProjectHub) — фичей с путём `{infra}` вместо каталога
 * инфраструктуры.
 */
export function manifestFromProject(input: ManifestFromProjectInput): TemplateManifest {
  if (input.appliedManifest) {
    const parsed = parseManifest(input.appliedManifest);
    if (parsed.ok) {
      return { ...parsed.manifest, id: input.id, name: input.name, description: input.description ?? parsed.manifest.description, version: '1.0.0' };
    }
  }

  const infra = safeJson(input.infraConfig);
  const flags = infra && typeof infra.features === 'object' && infra.features ? (infra.features as Record<string, unknown>) : {};
  const features = new Map<string, { id: string; label: string; default: boolean; mcp?: Record<string, unknown> }>();
  for (const [key, value] of Object.entries(flags)) {
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) features.set(key, { id: key, label: key, default: value === true });
  }

  const prefix = input.infraDir ? `${input.infraDir}/` : '';
  const mcp = safeJson(input.mcpConfig);
  const servers = mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers ? (mcp.mcpServers as Record<string, Record<string, unknown>>) : {};
  for (const [name, def] of Object.entries(servers)) {
    if (name.startsWith('projecthub')) continue;
    const args = Array.isArray(def.args) ? (def.args as unknown[]).map(String) : undefined;
    const templ = {
      ...def,
      ...(args ? { args: args.map((arg) => (prefix && arg.startsWith(prefix) ? `{infra}${arg.slice(prefix.length)}` : arg)) } : {})
    };
    const id = sanitizeId(name);
    const existing = features.get(id);
    if (existing) existing.mcp = { ...(existing.mcp ?? {}), [name]: templ };
    else features.set(id, { id, label: name, default: true, mcp: { [name]: templ } });
  }

  return ManifestSchema.parse({
    id: input.id,
    name: input.name,
    description: input.description,
    version: '1.0.0',
    placement: { subfolder: input.infraDir || '.projecthub/infra', allowRoot: true },
    files: [
      { path: '.claude/settings.json', apply: 'merge-settings', target: 'project' },
      { path: '.claude/skills/**', target: 'project' },
      { path: '.claude/commands/**', target: 'project' },
      { path: '.agents/skills/**', target: 'project' },
      { path: '.gitignore', apply: 'merge-lines' },
      { path: '**' }
    ],
    features: [...features.values()],
    rules: input.hasRules ? { source: 'infra-dev.md', marker: 'infra-dev' } : undefined,
    mcpConfigs: input.hasAgentsMcp ? ['.mcp.json', '.agents/mcp_config.json'] : ['.mcp.json'],
    commands: input.hasPackageJson ? [{ id: 'install', label: 'npm install', run: 'npm install', cwd: 'infra', default: true }] : []
  });
}

/** id каталога шаблона: латиница, цифры, `-` и `_`, без повторов среди занятых. */
export function uniqueTemplateId(base: string, taken: ReadonlySet<string>): string {
  const clean = sanitizeId(base.toLowerCase()) || 'template';
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
