/**
 * Чистые функции слияния для инициализации проекта (decision-78, п. 4–5, TASK-136.1).
 *
 * Главное свойство всех функций модуля — идемпотентность: повторное применение к уже
 * слитому результату ничего не меняет. Движок инициализации опирается на это, чтобы
 * помечать файл «пропустить», если слияние не дало разницы.
 */

/** Перевод строк приводится к `\n`; исходный перевод строк файла запоминается отдельно. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function withEol(text: string, eol: '\r\n' | '\n'): string {
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}

// ---------------------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------------------

/**
 * Ключ сравнения строки `.gitignore`: `node_modules`, `node_modules/` и `/node_modules`
 * для нашей цели — одно и то же правило. Комментарии и пустые строки ключа не имеют.
 */
export function gitignoreKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Дописывает в `.gitignore` недостающие строки одним блоком под заголовком-комментарием.
 * Существующие строки, порядок и комментарии не трогаются. Если добавлять нечего,
 * возвращается исходный текст без изменений.
 */
export function mergeGitignore(existing: string | null, lines: string[], header: string): string {
  const source = existing ?? '';
  const eol = existing ? detectEol(existing) : '\n';
  const present = new Set<string>();
  for (const line of toLf(source).split('\n')) {
    const key = gitignoreKey(line);
    if (key) present.add(key);
  }

  const missing: string[] = [];
  for (const line of lines) {
    const key = gitignoreKey(line);
    if (!key || present.has(key)) continue;
    present.add(key);
    missing.push(line.trim());
  }
  if (missing.length === 0) return source;

  let body = toLf(source);
  if (body && !body.endsWith('\n')) body += '\n';
  const separator = body ? '\n' : '';
  body += `${separator}# ${header}\n${missing.join('\n')}\n`;
  return withEol(body, eol);
}

// ---------------------------------------------------------------------------------------
// Секция правил между маркерами
// ---------------------------------------------------------------------------------------

export interface SectionMarkers {
  /** Имя секции: `projecthub` даёт маркеры `<!-- projecthub:start -->`/`<!-- projecthub:end -->`. */
  name: string;
  /** Маркер начала, который пишется в файл (может нести пояснение после имени). */
  start: string;
  end: string;
}

/**
 * Маркеры секции. Пояснение в маркере начала (как у `sync-agent-rules.mjs` шаблона:
 * `<!-- infra-dev:start (сгенерировано из infra-dev.md…) -->`) при поиске не учитывается.
 */
export function sectionMarkers(name: string, note?: string): SectionMarkers {
  const start = note ? `<!-- ${name}:start (${note}) -->` : `<!-- ${name}:start -->`;
  return { name, start, end: `<!-- ${name}:end -->` };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Позиции секции в тексте с `\n`: начало маркера начала и конец маркера конца. */
function locateSection(lf: string, markers: SectionMarkers): { from: number; bodyFrom: number; bodyTo: number; to: number } | null {
  const startRe = new RegExp(`<!--\\s*${escapeRegExp(markers.name)}:start\\b[^>]*-->`);
  const startMatch = startRe.exec(lf);
  if (!startMatch) return null;
  const bodyFrom = startMatch.index + startMatch[0].length;
  const endRe = new RegExp(`<!--\\s*${escapeRegExp(markers.name)}:end\\s*-->`, 'g');
  endRe.lastIndex = bodyFrom;
  const endMatch = endRe.exec(lf);
  if (!endMatch) return null;
  return { from: startMatch.index, bodyFrom, bodyTo: endMatch.index, to: endMatch.index + endMatch[0].length };
}

/** Текст секции вместе с маркерами, без завершающего перевода строки. */
export function renderSection(markers: SectionMarkers, body: string): string {
  return `${markers.start}\n\n${toLf(body).trim()}\n\n${markers.end}`;
}

/** Содержимое секции между маркерами (без маркеров) или `null`, если секции нет. */
export function extractSection(text: string, markers: SectionMarkers): string | null {
  const lf = toLf(text);
  const found = locateSection(lf, markers);
  return found ? lf.slice(found.bodyFrom, found.bodyTo).trim() : null;
}

/**
 * Режим «дописать»: секция заменяется на месте, если она уже есть, иначе дописывается в
 * конец файла через пустую строку. Остальной текст файла сохраняется байт в байт.
 * Если содержимое секции не изменилось, возвращается исходный текст (вместе с маркером).
 */
export function upsertSection(existing: string | null, markers: SectionMarkers, body: string): string {
  const section = renderSection(markers, body);
  if (existing === null || !existing.trim()) return `${section}\n`;

  const eol = detectEol(existing);
  const lf = toLf(existing);
  const found = locateSection(lf, markers);

  let result: string;
  if (found) {
    if (lf.slice(found.bodyFrom, found.bodyTo).trim() === toLf(body).trim()) return existing;
    result = lf.slice(0, found.from) + section + lf.slice(found.to);
  } else {
    const trimmedEnd = lf.replace(/\s+$/, '');
    result = `${trimmedEnd}\n\n${section}\n`;
  }
  return withEol(result, eol);
}

// ---------------------------------------------------------------------------------------
// JSON-конфиги MCP и настроек Claude Code
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Разбор JSON-файла проекта; битый или не-объект — `null` (вызывающий решает, что делать). */
export function parseJsonObject(text: string | null): JsonObject | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Слияние `mcpServers`: ключи из `servers` записываются поверх, чужие записи проекта
 * остаются как есть. Ключи из `remove` (выключенные фичи шаблона) удаляются.
 * Если текст не JSON-объект, бросается ошибка — перезаписывать чужой битый файл нельзя.
 */
export function mergeMcpServers(
  existing: string | null,
  servers: Record<string, unknown>,
  remove: string[] = []
): string {
  const base = existing === null || !existing.trim() ? {} : parseJsonObject(existing);
  if (!base) throw new Error('Файл не является JSON-объектом');
  const current = isObject(base.mcpServers) ? { ...base.mcpServers } : {};
  for (const key of remove) delete current[key];
  for (const [key, value] of Object.entries(servers)) current[key] = value;
  const next = { ...base, mcpServers: current };
  const rendered = stringifyJson(next);
  if (existing !== null && sameJson(existing, next)) return existing;
  return rendered;
}

function sameJson(text: string, value: unknown): boolean {
  const parsed = parseJsonObject(text);
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(value);
}

/**
 * Слияние `.claude/settings.json`: объединение `permissions.allow` (и `deny`) без дублей
 * в исходном порядке, остальные ключи проекта не трогаются. Ключи верхнего уровня,
 * которых у проекта нет, берутся из шаблона.
 */
export function mergeClaudeSettings(existing: string | null, template: JsonObject): string {
  const base = existing === null || !existing.trim() ? {} : parseJsonObject(existing);
  if (!base) throw new Error('Файл не является JSON-объектом');
  const next: JsonObject = { ...base };

  for (const [key, value] of Object.entries(template)) {
    if (key === 'permissions') continue;
    if (!(key in next)) next[key] = value;
  }

  if (isObject(template.permissions)) {
    const basePerms = isObject(base.permissions) ? base.permissions : {};
    const merged: JsonObject = { ...basePerms };
    for (const [key, value] of Object.entries(template.permissions)) {
      if (Array.isArray(value)) {
        const current = Array.isArray(basePerms[key]) ? (basePerms[key] as unknown[]) : [];
        merged[key] = unionList(current, value);
      } else if (!(key in merged)) {
        merged[key] = value;
      }
    }
    next.permissions = merged;
  }

  if (existing !== null && sameJson(existing, next)) return existing;
  return stringifyJson(next);
}

function unionList(current: unknown[], extra: unknown[]): unknown[] {
  const seen = new Set(current.map((item) => JSON.stringify(item)));
  const result = [...current];
  for (const item of extra) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// backlog/config.yml
// ---------------------------------------------------------------------------------------

export const FOUNDATION_STATUSES = ['To Do', 'In Progress', 'Review', 'Done'] as const;

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Конфиг Backlog.md для новой основы. Все строковые значения в кавычках (правило 16);
 * `default_editor` не пишется: путь Windows в двойных кавычках ломает js-yaml.
 */
export function renderBacklogConfig(projectName: string, statusList: readonly string[] = FOUNDATION_STATUSES): string {
  const statuses = statusList.map(yamlString).join(', ');
  return [
    `project_name: ${yamlString(projectName)}`,
    'default_status: "To Do"',
    `statuses: [${statuses}]`,
    'labels: []',
    'date_format: yyyy-mm-dd',
    'max_column_width: 20',
    'auto_open_browser: false',
    'default_port: 6420',
    'remote_operations: true',
    'auto_commit: false',
    'bypass_git_hooks: false',
    'check_active_branches: true',
    'active_branch_days: 30',
    'task_prefix: "task"',
    ''
  ].join('\n');
}

const norm = (status: string) => status.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Недостающие статусы встают рядом со своими соседями по стандартному порядку `canonical`:
 * `Review` в списке `To Do, In Progress, Done` встаёт перед `Done`. Свои статусы проекта
 * и их порядок сохраняются.
 */
export function mergeStatuses(existing: string[], canonical: readonly string[] = FOUNDATION_STATUSES): string[] {
  const result = [...existing];
  const has = (status: string) => result.some((item) => norm(item) === norm(status));
  canonical.forEach((status, index) => {
    if (has(status)) return;
    let insertAt = index === 0 ? 0 : -1;
    for (let prev = index - 1; prev >= 0; prev--) {
      const pos = result.findIndex((item) => norm(item) === norm(canonical[prev]));
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
    }
    if (insertAt < 0) {
      const nextPos = canonical
        .slice(index + 1)
        .map((next) => result.findIndex((item) => norm(item) === norm(next)))
        .find((pos) => pos >= 0);
      insertAt = nextPos ?? result.length;
    }
    result.splice(insertAt, 0, status);
  });
  return result;
}

/**
 * Замена блока `statuses:` верхнего уровня в YAML на однострочный список. Остальные ключи
 * и их форматирование сохраняются. Если ключа нет, он дописывается в конец.
 */
export function replaceStatusesBlock(yaml: string, statuses: string[]): string {
  const eol = detectEol(yaml);
  const lines = toLf(yaml).split('\n');
  const rendered = `statuses: [${statuses.map(yamlString).join(', ')}]`;
  const start = lines.findIndex((line) => /^statuses:(\s|$)/.test(line));
  if (start < 0) {
    const body = toLf(yaml).replace(/\s*$/, '');
    return withEol(`${body}\n${rendered}\n`, eol);
  }
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
  // Пустые строки перед следующим ключом остаются на своём месте.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(start, end - start, rendered);
  return withEol(lines.join('\n'), eol);
}
