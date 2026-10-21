/**
 * Трёхстороннее слияние документа Markdown по разделам и полям frontmatter (TASK-194, decision-151).
 * Чистый модуль без Electron и git.
 *
 * Документ режется на части: ключи frontmatter верхнего уровня (со всеми строками значения) и разделы тела —
 * текст до первого заголовка и каждый заголовок ATX с текстом до следующего заголовка любого уровня. Ключ раздела —
 * путь заголовков от корня (`## Decision › ### Хранение`), повтор того же пути под тем же родителем нумеруется.
 * Две правки разных частей не конфликтуют; правка одной части с обеих сторон по-разному — конфликт с текстом
 * базы и обеих сторон. Заголовки внутри блоков кода (``` и ~~~) разделами не считаются. Поля frontmatter
 * сравниваются по значению YAML, а не по тексту.
 */
import matter from 'gray-matter';

export type DocPartScope = 'frontmatter' | 'section';

export interface DocPart {
  /** Ключ части: `fm:<поле>`, `body:` (текст до первого заголовка) или `h:<путь заголовков>`. */
  key: string;
  /** Подпись для человека и агента: имя поля или заголовок. */
  label: string;
  scope: DocPartScope;
  /** Текст части с `\n` в конце строк. */
  text: string;
}

export interface ParsedDoc {
  /** Части frontmatter или `null`, если frontmatter нет. */
  frontmatter: DocPart[] | null;
  body: DocPart[];
}

export interface DocConflict {
  key: string;
  label: string;
  scope: DocPartScope;
  /** Текст части в базе; `null` — части не было. */
  base: string | null;
  /** Текст в основной ветке; `null` — часть удалена. */
  ours: string | null;
  /** Текст в ветке документации; `null` — часть удалена. */
  theirs: string | null;
}

/** Как разрешить конфликт части: взять основную, ветку, обе подряд или свой текст. */
export type DocResolution = 'ours' | 'theirs' | 'both' | { text: string };

export interface DocMergeResult {
  /** Итоговый текст; при неразрешённых конфликтах в спорных частях стоит текст основной ветки. */
  text: string;
  conflicts: DocConflict[];
}

export type DocChangeKind = 'added' | 'removed' | 'modified';

export interface DocPartChange {
  key: string;
  label: string;
  scope: DocPartScope;
  change: DocChangeKind;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FM_KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:/;

function splitLines(text: string): string[] {
  // Каждая строка с `\n`; последняя — без, если файл кончается без перевода строки.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseFrontmatter(lines: string[]): DocPart[] {
  const parts: DocPart[] = [];
  let current: DocPart | null = null;
  const seen = new Map<string, number>();
  for (const line of lines) {
    const m = FM_KEY_RE.exec(line);
    if (m && !/^\s/.test(line)) {
      const name = m[1];
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      current = { key: n === 1 ? `fm:${name}` : `fm:${name}#${n}`, label: name, scope: 'frontmatter', text: line };
      parts.push(current);
    } else if (current) {
      current.text += line;
    } else {
      // Комментарии и пустые строки до первого ключа.
      current = { key: 'fm:', label: '(начало frontmatter)', scope: 'frontmatter', text: line };
      parts.push(current);
    }
  }
  return parts;
}

function parseBody(lines: string[]): DocPart[] {
  const parts: DocPart[] = [{ key: 'body:', label: '(текст до первого заголовка)', scope: 'section', text: '' }];
  const stack: Array<{ level: number; title: string }> = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of lines) {
    const bare = line.replace(/\n$/, '');
    const fenceMatch = FENCE_RE.exec(bare);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0].repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const heading = fence === null && !fenceMatch ? HEADING_RE.exec(bare) : null;
    if (!heading) {
      parts[parts.length - 1].text += line;
      continue;
    }
    const level = heading[1].length;
    const title = heading[2];
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    const pathKey = stack.map((s) => `${s.level}:${normalizeHeading(s.title)}`).join('>');
    const n = (seen.get(pathKey) ?? 0) + 1;
    seen.set(pathKey, n);
    parts.push({
      key: n === 1 ? `h:${pathKey}` : `h:${pathKey}#${n}`,
      label: stack.map((s) => `${'#'.repeat(s.level)} ${s.title}`).join(' › '),
      scope: 'section',
      text: line
    });
  }
  return parts;
}

/** Разбор документа на части. Переводы строк приводятся к `\n`. */
export function parseDocParts(raw: string): ParsedDoc {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = splitLines(text);
  if (lines.length > 0 && lines[0].replace(/\n$/, '').trimEnd() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.replace(/\n$/, '').trimEnd() === '---');
    if (close > 0) {
      return { frontmatter: parseFrontmatter(lines.slice(1, close)), body: parseBody(lines.slice(close + 1)) };
    }
  }
  return { frontmatter: null, body: parseBody(lines) };
}

function joinParts(parts: DocPart[]): string {
  let out = '';
  for (const part of parts) {
    if (out && !out.endsWith('\n')) out += '\n';
    out += part.text;
  }
  return out;
}

/** Документ из частей (с `\n`). */
export function serializeDocParts(doc: ParsedDoc): string {
  const body = joinParts(doc.body);
  if (doc.frontmatter === null) return body;
  const fm = joinParts(doc.frontmatter);
  return `---\n${fm}${fm && !fm.endsWith('\n') ? '\n' : ''}---\n${body}`;
}

const sameText = (a: string | undefined | null, b: string | undefined | null): boolean =>
  (a ?? null) !== null && (b ?? null) !== null && a!.replace(/\s+$/, '') === b!.replace(/\s+$/, '');

const fmValueCache = new Map<string, string | null>();

/**
 * Значение поля frontmatter для сравнения: `title: Хранение` и `title: "Хранение"` — одно и то же. Инструменты
 * (gray-matter, Backlog.md CLI) переписывают кавычки, и сравнение текста давало бы ложные правки и конфликты.
 */
function fmValue(text: string): string | null {
  const cached = fmValueCache.get(text);
  if (cached !== undefined) return cached;
  let value: string | null;
  try {
    const data = matter(`---\n${text.endsWith('\n') ? text : `${text}\n`}---\n`).data;
    value = JSON.stringify(data, (_k, v) => (v instanceof Date ? v.toISOString() : v));
  } catch {
    value = null;
  }
  if (fmValueCache.size > 2000) fmValueCache.clear();
  fmValueCache.set(text, value);
  return value;
}

function samePart(a: string | undefined | null, b: string | undefined | null, scope: DocPartScope): boolean {
  if (sameText(a, b)) return true;
  if (scope !== 'frontmatter' || a === undefined || a === null || b === undefined || b === null) return false;
  const [x, y] = [fmValue(a), fmValue(b)];
  return x !== null && x === y;
}

function resolvedText(resolution: DocResolution, ours: string | null, theirs: string | null): string | null {
  if (resolution === 'ours') return ours;
  if (resolution === 'theirs') return theirs;
  if (resolution === 'both') {
    if (ours === null) return theirs;
    if (theirs === null) return ours;
    return `${ours}${ours.endsWith('\n') ? '' : '\n'}${theirs}`;
  }
  const text = resolution.text;
  return text.trim() ? (text.endsWith('\n') ? text : `${text}\n`) : null;
}

function mergePartLists(
  base: DocPart[],
  ours: DocPart[],
  theirs: DocPart[],
  resolutions: ReadonlyMap<string, DocResolution>,
  conflicts: DocConflict[]
): DocPart[] {
  const baseMap = new Map(base.map((p) => [p.key, p]));
  const theirsMap = new Map(theirs.map((p) => [p.key, p]));
  const oursKeys = new Set(ours.map((p) => p.key));
  const result: DocPart[] = [];

  const conflict = (proto: DocPart, b: DocPart | undefined, o: DocPart | undefined, t: DocPart | undefined): DocPart | null => {
    const resolution = resolutions.get(proto.key);
    if (resolution !== undefined) {
      const text = resolvedText(resolution, o?.text ?? null, t?.text ?? null);
      return text === null ? null : { ...proto, text };
    }
    conflicts.push({ key: proto.key, label: proto.label, scope: proto.scope, base: b?.text ?? null, ours: o?.text ?? null, theirs: t?.text ?? null });
    return o ?? null;
  };

  for (const o of ours) {
    const b = baseMap.get(o.key);
    const t = theirsMap.get(o.key);
    const same = (x: string | undefined, y: string | undefined) => samePart(x, y, o.scope);
    let next: DocPart | null;
    if (!t) {
      // В ветке части нет: добавлена в основной — оставляем; удалена в ветке — удаляем, если основная её не меняла.
      next = !b ? o : same(o.text, b.text) ? null : conflict(o, b, o, undefined);
    } else if (same(o.text, t.text)) {
      next = o;
    } else if (b && same(b.text, o.text)) {
      next = { ...o, text: t.text, label: t.label };
    } else if (b && same(b.text, t.text)) {
      next = o;
    } else {
      next = conflict(o, b, o, t);
    }
    if (next) result.push(next);
  }

  // Части только из ветки: новые — вставляются после ближайшей предшествующей части ветки, что уже есть в итоге.
  for (let i = 0; i < theirs.length; i++) {
    const t = theirs[i];
    if (oursKeys.has(t.key)) continue;
    const b = baseMap.get(t.key);
    let next: DocPart | null;
    if (b) next = samePart(t.text, b.text, t.scope) ? null : conflict(t, b, undefined, t);
    else next = t;
    if (!next) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.findIndex((p) => p.key === theirs[j].key);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    result.splice(at, 0, next);
  }
  return result;
}

function resolutionMap(resolutions?: Iterable<[string, DocResolution]> | Record<string, DocResolution>): Map<string, DocResolution> {
  if (!resolutions) return new Map();
  if (Symbol.iterator in Object(resolutions)) return new Map(resolutions as Iterable<[string, DocResolution]>);
  return new Map(Object.entries(resolutions as Record<string, DocResolution>));
}

/** Перевод строк основной стороны (а если её нет — ветки). */
function eolOf(...texts: Array<string | null>): '\n' | '\r\n' {
  const first = texts.find((t) => t !== null && t.length > 0);
  return first && first.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Трёхстороннее слияние: `base` — документ на момент ответвления (`null` — его не было), `ours` — основная ветка,
 * `theirs` — ветка документации. `resolutions` — решения по ключам частей из прошлых конфликтов.
 */
export function mergeDocText(
  base: string | null,
  ours: string,
  theirs: string,
  resolutions?: Iterable<[string, DocResolution]> | Record<string, DocResolution>
): DocMergeResult {
  const eol = eolOf(ours, theirs);
  const b = base === null ? { frontmatter: null, body: [] } : parseDocParts(base);
  const o = parseDocParts(ours);
  const t = parseDocParts(theirs);
  const map = resolutionMap(resolutions);
  const conflicts: DocConflict[] = [];
  const hasFm = o.frontmatter !== null || t.frontmatter !== null;
  const frontmatter = hasFm ? mergePartLists(b.frontmatter ?? [], o.frontmatter ?? [], t.frontmatter ?? [], map, conflicts) : null;
  const body = mergePartLists(b.body, o.body, t.body, map, conflicts);
  const text = serializeDocParts({ frontmatter, body });
  return { text: eol === '\n' ? text : text.replace(/\n/g, '\r\n'), conflicts };
}

/**
 * `next` с полями frontmatter, записанными как в `original`, если их значение не изменилось; порядок полей — как в
 * исходном, новые — в конце. Сериализатор YAML переписывает кавычки всех полей, а правка одного поля не должна
 * менять строки остальных: иначе каждая правка документа выглядит в git и в ветке как правка всего frontmatter.
 */
export function keepFrontmatterFormatting(original: string, next: string): string {
  const o = parseDocParts(original);
  const n = parseDocParts(next);
  if (!o.frontmatter || !n.frontmatter) return next;
  const nextMap = new Map(n.frontmatter.map((p) => [p.key, p]));
  const fm: DocPart[] = [];
  for (const prev of o.frontmatter) {
    const cur = nextMap.get(prev.key);
    if (!cur) continue;
    fm.push(samePart(prev.text, cur.text, 'frontmatter') ? prev : cur);
    nextMap.delete(prev.key);
  }
  fm.push(...nextMap.values());
  const text = serializeDocParts({ frontmatter: fm, body: n.body });
  return next.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

/** Какие части документа изменились от `base` к `next` (для диффа ветки). */
export function diffDocParts(base: string | null, next: string): DocPartChange[] {
  const b = base === null ? { frontmatter: [], body: [] } : parseDocParts(base);
  const n = parseDocParts(next);
  const out: DocPartChange[] = [];
  const compare = (from: DocPart[], to: DocPart[]) => {
    const fromMap = new Map(from.map((p) => [p.key, p]));
    const toKeys = new Set(to.map((p) => p.key));
    for (const p of to) {
      const prev = fromMap.get(p.key);
      if (!prev) {
        if (p.key !== 'body:' || p.text.trim()) out.push({ key: p.key, label: p.label, scope: p.scope, change: 'added' });
      } else if (!samePart(prev.text, p.text, p.scope)) out.push({ key: p.key, label: p.label, scope: p.scope, change: 'modified' });
    }
    for (const p of from) if (!toKeys.has(p.key)) out.push({ key: p.key, label: p.label, scope: p.scope, change: 'removed' });
  };
  compare(b.frontmatter ?? [], n.frontmatter ?? []);
  compare(b.body, n.body);
  return out;
}
