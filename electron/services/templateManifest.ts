/**
 * Манифест шаблона проекта `projecthub-template.json` и сборка правил шаблона по блокам
 * (decision-78, п. 8–9; TASK-136.3). Чистый модуль без fs и Electron.
 *
 * Папка без манифеста читается в совместимом режиме: фичи — из `infra.config.json`, правила —
 * `infra-dev.md` целиком, MCP-серверы — из `.mcp.json` шаблона.
 */
import { z } from 'zod';

export const MANIFEST_FILE = 'projecthub-template.json';
export const DEFAULT_SUBFOLDER = '.projecthub/infra';

/** Текст на нескольких языках: строка или `{ ru, en }`. */
const LocalizedText = z.union([z.string().min(1), z.record(z.string(), z.string())]);
export type LocalizedText = z.infer<typeof LocalizedText>;

const McpServerDef = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    type: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional()
  })
  .passthrough()
  .refine((def) => Boolean(def.command || def.url), { message: 'нужен command или url' });
export type McpServerDef = z.infer<typeof McpServerDef>;

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'латиница, цифры, - и _');

/** Путь внутри шаблона или проекта: относительный, без `..`, через `/`. */
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'путь должен быть относительным и без ..'
  });

const FileRule = z.object({
  /** Glob относительно корня шаблона: `scripts/**`, `package.json`. */
  path: RelPath,
  /** copy — файл как есть; merge-lines — дописать недостающие строки; merge-settings — слить `.claude/settings.json`. */
  apply: z.enum(['copy', 'merge-lines', 'merge-settings']).default('copy'),
  /** infra — каталог инфраструктуры (корень или подпапка), project — корень проекта. */
  target: z.enum(['infra', 'project']).default('infra'),
  /** Только при включённой фиче или наборе. */
  when: Id.optional()
});

const Feature = z.object({
  id: Id,
  label: LocalizedText,
  description: LocalizedText.optional(),
  default: z.boolean().default(false),
  /** Тяжёлая фича (Python, локальная LLM): в окне помечается и по умолчанию выключена. */
  heavy: z.boolean().optional(),
  /** MCP-серверы фичи; `{infra}` в command/args заменяется на путь каталога инфраструктуры. */
  mcp: z.record(z.string(), McpServerDef).optional(),
  /** Строки `.gitignore` корня проекта, нужные только с этой фичей. */
  gitignore: z.array(z.string()).optional()
});

const RuleSet = z.object({
  id: Id,
  label: LocalizedText,
  description: LocalizedText.optional(),
  default: z.boolean().default(true)
});

const Command = z.object({
  id: Id,
  label: LocalizedText,
  run: z.string().min(1),
  cwd: z.enum(['infra', 'project']).default('infra'),
  default: z.boolean().default(true),
  when: Id.optional()
});

export const ManifestSchema = z.object({
  schema: z.literal(1).default(1),
  id: Id,
  name: LocalizedText,
  description: LocalizedText.optional(),
  version: z.string().min(1),
  placement: z
    .object({
      subfolder: RelPath.default(DEFAULT_SUBFOLDER),
      /** Можно ли класть инфраструктуру в корень существующего проекта. */
      allowRoot: z.boolean().default(true)
    })
    .default({ subfolder: DEFAULT_SUBFOLDER, allowRoot: true }),
  files: z.array(FileRule).default([]),
  exclude: z.array(z.string()).default([]),
  features: z.array(Feature).default([]),
  sets: z.array(RuleSet).default([]),
  rules: z
    .object({
      source: RelPath.default('infra-dev.md'),
      marker: Id.default('infra-dev'),
      note: z.string().optional(),
      targets: z.array(RelPath).default(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']),
      /** Файл правил Antigravity, куда собранные правила кладутся целиком. */
      agentsRules: RelPath.optional()
    })
    .optional(),
  /** Конфиги MCP, в которые пишутся серверы фич (относительно корня проекта). */
  mcpConfigs: z.array(RelPath).default(['.mcp.json']),
  commands: z.array(Command).default([]),
  /** Git-хуки шаблона: ставятся командой, выключаются ключом infra.config.json. */
  gitHooks: z
    .object({
      description: LocalizedText.optional(),
      configKey: z.string().default('gitHooks')
    })
    .optional(),
  /** Статусы Backlog.md, которые шаблон предлагает дописать в config.yml. */
  statuses: z.array(z.string().min(1)).optional()
});

export type TemplateManifest = z.infer<typeof ManifestSchema>;
export type ManifestFeature = TemplateManifest['features'][number];

export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: TemplateManifest; compat: boolean }
  | { ok: false; issues: ManifestIssue[] };

/** Разбор и проверка манифеста. Ошибки — с путём поля, чтобы автор шаблона нашёл место. */
export function parseManifest(raw: string): ManifestParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, issues: [{ path: '', message: `не JSON: ${(err as Error).message}` }] };
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    };
  }
  const issues = crossCheck(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest: parsed.data, compat: false };
}

/** Проверки, которые схема не выражает: уникальность id и ссылки `when` на существующие фичи и наборы. */
function crossCheck(manifest: TemplateManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const ids = new Set<string>();
  for (const [kind, list] of [['features', manifest.features], ['sets', manifest.sets]] as const) {
    list.forEach((item, index) => {
      if (ids.has(item.id) || item.id === 'subfolder') issues.push({ path: `${kind}.${index}.id`, message: `повторяющийся id ${item.id}` });
      ids.add(item.id);
    });
  }
  const checkWhen = (when: string | undefined, where: string) => {
    if (when && !ids.has(when)) issues.push({ path: where, message: `нет фичи или набора ${when}` });
  };
  manifest.files.forEach((rule, index) => checkWhen(rule.when, `files.${index}.when`));
  manifest.commands.forEach((cmd, index) => checkWhen(cmd.when, `commands.${index}.when`));
  return issues;
}

export interface CompatInputs {
  folderName: string;
  infraConfig: string | null;
  packageJson: string | null;
  hasRules: boolean;
}

/**
 * Манифест для папки без `projecthub-template.json` (совместимый режим): фичи — ключи
 * `features` из `infra.config.json` со значениями как умолчаниями, MCP — все серверы из
 * `.mcp.json` шаблона без привязки к фичам, правила — `infra-dev.md` целиком.
 */
export function compatManifest(input: CompatInputs): TemplateManifest {
  const infra = safeJson(input.infraConfig);
  const features = infra && typeof infra.features === 'object' && infra.features ? (infra.features as Record<string, unknown>) : {};
  const pkg = safeJson(input.packageJson);
  const id = input.folderName.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z]+/, '') || 'template';

  return ManifestSchema.parse({
    id,
    name: input.folderName,
    version: typeof pkg?.version === 'string' ? pkg.version : '0.0.0',
    files: [{ path: '**', apply: 'copy', target: 'infra' }],
    exclude: [],
    features: Object.entries(features)
      .filter(([key]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(key))
      .map(([key, value]) => ({ id: key, label: key, default: value === true })),
    rules: input.hasRules ? { source: 'infra-dev.md', marker: 'infra-dev' } : undefined,
    mcpConfigs: ['.mcp.json', '.agents/mcp_config.json'],
    commands: pkg ? [{ id: 'install', label: 'npm install', run: 'npm install', cwd: 'infra', default: true }] : []
  });
}

/** MCP-серверы совместимого шаблона: берутся из его `.mcp.json` как есть. */
export function compatMcpServers(mcpConfig: string | null): Record<string, McpServerDef> {
  const mcp = safeJson(mcpConfig);
  return mcp && typeof mcp.mcpServers === 'object' && mcp.mcpServers ? (mcp.mcpServers as Record<string, McpServerDef>) : {};
}

function safeJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Текст на языке интерфейса с запасным английским, затем любым. */
export function localize(text: LocalizedText | undefined, locale: string): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}

// ---------------------------------------------------------------------------------------
// Сборка правил по блокам
// ---------------------------------------------------------------------------------------

const BLOCK_OPEN = /^\s*<!--\s*if:([A-Za-z][A-Za-z0-9_-]*)\s*-->\s*$/;
const BLOCK_CLOSE = /^\s*<!--\s*endif\s*-->\s*$/;
const LINE_TAG = /\s*<!--\s*if:([A-Za-z][A-Za-z0-9_-]*)\s*-->\s*$/;

/**
 * Собирает правила шаблона: блок `<!-- if:X -->…<!-- endif -->` и строка с хвостом
 * `<!-- if:X -->` остаются, только если X включён (фича, набор правил или `subfolder`).
 * Маркеры в результат не попадают, `{{var}}` подставляются, правила раздела `## Правила`
 * перенумеровываются, а ссылки «правило N» переписываются под новые номера.
 */
export function assembleRules(source: string, enabled: ReadonlySet<string>, vars: Record<string, string> = {}): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const stack: boolean[] = [];
  const active = () => stack.every(Boolean);

  for (const line of lines) {
    const open = BLOCK_OPEN.exec(line);
    if (open) {
      stack.push(enabled.has(open[1]));
      continue;
    }
    if (BLOCK_CLOSE.test(line)) {
      stack.pop();
      continue;
    }
    if (!active()) continue;
    const tag = LINE_TAG.exec(line);
    if (tag) {
      if (enabled.has(tag[1])) out.push(line.slice(0, tag.index));
      continue;
    }
    out.push(line);
  }

  let text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, name: string) => vars[name] ?? match);
  return renumberRules(text);
}

/** Условия, которые встречаются в тексте правил (для проверки манифеста и подсказок). */
export function ruleConditions(source: string): string[] {
  const found = new Set<string>();
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const match = BLOCK_OPEN.exec(line) ?? LINE_TAG.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found];
}

const RULES_HEADING = /^##\s+(Правила|Rules)\s*$/;
const RULE_ITEM = /^(\d+)\.(\s)/;
const RULE_REF = /(правил[а-яё]*|rules?)(\s+)(\d+)((?:\s*(?:,|и|and)\s*\d+)*)/gi;

/**
 * Перенумерация правил верхнего уровня (`N. ` в начале строки) в разделе «Правила» и замена
 * ссылок на них во всём тексте. Ссылка на номер, которого больше нет, остаётся как была.
 */
export function renumberRules(text: string): string {
  const lines = text.split('\n');
  const mapping = new Map<number, number>();
  let inRules = false;
  let next = 1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) inRules = RULES_HEADING.test(lines[i]);
    if (!inRules) continue;
    const item = RULE_ITEM.exec(lines[i]);
    if (!item) continue;
    const old = Number(item[1]);
    if (!mapping.has(old)) mapping.set(old, next);
    lines[i] = `${next}.${item[2]}${lines[i].slice(item[0].length)}`;
    next++;
  }
  if ([...mapping].every(([from, to]) => from === to)) return lines.join('\n');

  const remap = (num: string) => String(mapping.get(Number(num)) ?? num);
  return lines
    .join('\n')
    .replace(RULE_REF, (_m, word: string, space: string, first: string, rest: string) => {
      const tail = rest.replace(/\d+/g, remap);
      return `${word}${space}${remap(first)}${tail}`;
    });
}
