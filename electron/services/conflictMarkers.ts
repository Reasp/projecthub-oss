/**
 * Разбор маркеров конфликта git для окна слияния (TASK-139.3, decision-157): выбор «моё / их / оба» по блокам.
 * Чистый модуль без Node и Electron — его импортирует и рендерер.
 */

// ── Разбор маркеров ─────────────────────────────────────────────────────────────────────────────────────────

export type ConflictSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'conflict';
      ours: string;
      /** Общий предок — только в стиле `merge.conflictStyle=diff3`/`zdiff3`. */
      base: string | null;
      theirs: string;
      oursLabel: string;
      theirsLabel: string;
      /** Блок как в файле, с маркерами: им собирается неразрешённый блок. */
      raw: string;
    };

export type ConflictChoice = 'ours' | 'theirs' | 'both';

const OPEN = /^<{7}(?: (.*))?\r?\n?$/;
const BASE = /^\|{7}(?: .*)?\r?\n?$/;
const SPLIT = /^={7}\r?\n?$/;
const CLOSE = /^>{7}(?: (.*))?\r?\n?$/;

/** Строки с их окончаниями: склейка возвращает исходный текст байт в байт. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Текст файла с маркерами git → чередование общего текста и конфликтных блоков. Незакрытый блок (маркер `<<<<<<<`
 * без `>>>>>>>`) остаётся текстом: его не разрешить выбором, только правкой итога.
 */
export function parseConflictSegments(content: string): ConflictSegment[] {
  const segments: ConflictSegment[] = [];
  const lines = splitLines(content);
  let text = '';
  const flushText = () => {
    if (text) segments.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < lines.length) {
    const open = OPEN.exec(lines[i]);
    if (!open) {
      text += lines[i++];
      continue;
    }
    let j = i + 1;
    let ours = '';
    let base: string | null = null;
    let theirs = '';
    let part: 'ours' | 'base' | 'theirs' = 'ours';
    let theirsLabel: string | null = null;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (part === 'ours' && BASE.test(line)) {
        part = 'base';
        base = '';
      } else if (part !== 'theirs' && SPLIT.test(line)) {
        part = 'theirs';
      } else if (part === 'theirs' && CLOSE.test(line)) {
        theirsLabel = (CLOSE.exec(line)?.[1] ?? '').trim();
        break;
      } else if (part === 'ours') ours += line;
      else if (part === 'base') base += line;
      else theirs += line;
    }
    if (theirsLabel === null) {
      // Блок не закрыт — дальше обычный текст.
      text += lines.slice(i).join('');
      break;
    }
    flushText();
    segments.push({
      kind: 'conflict',
      ours,
      base,
      theirs,
      oursLabel: (open[1] ?? '').trim(),
      theirsLabel,
      raw: lines.slice(i, j + 1).join('')
    });
    i = j + 1;
  }
  flushText();
  return segments;
}

export function countConflicts(segments: readonly ConflictSegment[]): number {
  return segments.filter((s) => s.kind === 'conflict').length;
}

/**
 * Итог по выбору для каждого блока (по порядку блоков). Блок без выбора остаётся с маркерами — такой итог не
 * записать (`resolveConflictFile` откажет).
 */
export function applyConflictChoices(segments: readonly ConflictSegment[], choices: ReadonlyArray<ConflictChoice | null | undefined>): string {
  let n = 0;
  let out = '';
  for (const s of segments) {
    if (s.kind === 'text') {
      out += s.text;
      continue;
    }
    const choice = choices[n++];
    if (choice === 'ours') out += s.ours;
    else if (choice === 'theirs') out += s.theirs;
    else if (choice === 'both') out += s.ours && !/\n$/.test(s.ours) && s.theirs ? `${s.ours}\n${s.theirs}` : s.ours + s.theirs;
    else out += s.raw;
  }
  return out;
}

// ── Что за файл ─────────────────────────────────────────────────────────────────────────────────────────────

export type ConflictFileKind = 'task' | 'decision' | 'doc' | 'memory' | 'other';

/** Вид файла для окна: документы и задачи показываются с предпросмотром Markdown. `prefix` — каталог проекта. */
export function conflictFileKind(file: string, prefix = ''): ConflictFileKind {
  const p = file.replace(/\\/g, '/');
  const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  if (!rel.toLowerCase().endsWith('.md')) return 'other';
  if (/^backlog\/(tasks|completed|drafts|archive)\//.test(rel)) return 'task';
  if (rel.startsWith('backlog/decisions/')) return 'decision';
  if (rel.startsWith('backlog/docs/')) return 'doc';
  if (rel.startsWith('backlog/memory/')) return 'memory';
  return 'other';
}

/** Маркеры конфликта git в начале строки: итог с ними не записывается (окно, `sync_base_branch`). */
export function hasConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7})(\s|$)/m.test(content) || /^={7}\r?$/m.test(content);
}

// ── Frontmatter итога ───────────────────────────────────────────────────────────────────────────────────────

export interface FrontmatterLoss {
  /** У сторон frontmatter есть, а итог не начинается закрытым блоком `---` … `---`. */
  broken: boolean;
  /** Поля верхнего уровня, которые есть у всех сторон с frontmatter, но пропали из итога. */
  lostKeys: string[];
}

/** Ключи верхнего уровня frontmatter; `null` — файл не начинается закрытым блоком `---`. */
function frontmatterKeys(content: string): Set<string> | null {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const keys = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Что итог потерял во frontmatter по сравнению со сторонами (TASK-203): агент или правка вручную может выкинуть
 * поля задачи или документа, и после коммита канбан и `lint:docs` сломаются. Поле, которое одна сторона удалила,
 * потерей не считается. `null` — у сторон нет frontmatter или итог его сохранил.
 */
export function frontmatterLoss(result: string, ours: string | null, theirs: string | null): FrontmatterLoss | null {
  const sides = [ours, theirs].filter((s): s is string => s !== null).map(frontmatterKeys).filter((k): k is Set<string> => k !== null);
  if (sides.length === 0) return null;
  const own = frontmatterKeys(result);
  if (!own) return { broken: true, lostKeys: [] };
  const lostKeys = [...sides[0]].filter((key) => sides.every((s) => s.has(key)) && !own.has(key));
  return lostKeys.length > 0 ? { broken: false, lostKeys } : null;
}
