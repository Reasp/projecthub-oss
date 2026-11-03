/**
 * Автодополнение в поле ввода Agents Studio (TASK-300, decision-214): токен под курсором (`/команда` в начале поля или
 * `@путь` после пробела), нечёткий поиск и подстановка выбранного. Без React и Electron — модуль общий для рендерера и
 * поиска файлов в main.
 */

export type CompletionKind = 'slash' | 'mention';

export interface CompletionToken {
  kind: CompletionKind;
  /** Что набрано после `/` или `@` до курсора (у `@"…` — без кавычки). */
  query: string;
  /** Начало токена — позиция `/` или `@`. */
  start: number;
  /** Конец токена: курсор плюс непробельные символы сразу за ним. */
  end: number;
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** Конец слова, начатого до курсора: непробельные символы за курсором входят в токен. */
function wordEnd(text: string, caret: number): number {
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return end;
}

/**
 * Токен автодополнения под курсором или `null`. `/команда` — только в самом начале поля и до первого пробела, как в
 * терминальном Claude Code. `@путь` — в начале поля или после пробела (почта `a@b` не упоминание); путь в кавычках
 * `@"папка с пробелом/…` допускает пробелы до закрывающей кавычки.
 */
export function completionToken(text: string, caret: number, selectionEnd: number = caret): CompletionToken | null {
  if (caret !== selectionEnd || caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);

  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: wordEnd(text, caret) };

  const quoted = /(^|\s)@"([^"\n]*)$/.exec(before);
  if (quoted) {
    const start = caret - quoted[2].length - 2;
    const close = text.indexOf('"', caret);
    const lineEnd = text.indexOf('\n', caret);
    const end = close >= 0 && (lineEnd < 0 || close < lineEnd) ? close + 1 : caret;
    return { kind: 'mention', query: quoted[2], start, end };
  }

  const at = /(^|\s)@([^\s"]*)$/.exec(before);
  if (at) return { kind: 'mention', query: at[2], start: caret - at[2].length - 1, end: wordEnd(text, caret) };
  return null;
}

/** Текст упоминания: путь с пробелом или кавычкой CLI понимает только в кавычках `@"…"`. */
export function mentionText(relPath: string): string {
  const p = relPath.replace(/\\/g, '/');
  return /[\s"]/.test(p) ? `@"${p.replace(/"/g, '')}"` : `@${p}`;
}

/**
 * Подставить выбранное вместо токена. Каталог (`путь/`) вставляется без пробела и без закрывающей кавычки — список
 * продолжает показывать его содержимое; файл и команда — с пробелом после.
 */
export function applyCompletion(text: string, token: CompletionToken, replacement: string, keepOpen = false): { text: string; caret: number } {
  let insert = replacement;
  if (keepOpen && insert.endsWith('"')) insert = insert.slice(0, -1);
  const rest = text.slice(token.end);
  const space = keepOpen || rest.startsWith(' ') ? '' : ' ';
  const next = text.slice(0, token.start) + insert + space + rest;
  return { text: next, caret: token.start + insert.length + space.length };
}

const BOUNDARY = /[\\/_\-.\s:]/;

function subsequenceScore(query: string, candidate: string): number | null {
  const c = candidate.toLowerCase();
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (const qc of query) {
    const i = c.indexOf(qc, pos);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 5;
    if (i === 0 || BOUNDARY.test(candidate[i - 1]) || (candidate[i] !== c[i] && candidate[i - 1] === c[i - 1])) score += 6;
    score -= Math.min(i - pos, 5) * 0.3;
    prev = i;
    pos = i + 1;
  }
  return score;
}

/**
 * Нечёткое совпадение: все символы запроса по порядку. Выше — точное имя, начало имени, подстрока, совпадения подряд и на
 * границах слов; у путей важнее совпадение в последнем сегменте. `null` — не подходит.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q) return 0;
  const lower = candidate.toLowerCase();
  const trimmed = lower.endsWith('/') ? lower.slice(0, -1) : lower;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const full = subsequenceScore(q, candidate);
  if (full === null) return null;
  let score = full;
  if (!q.includes('/')) {
    const inBase = subsequenceScore(q, candidate.slice(candidate.length - base.length - (lower.endsWith('/') ? 1 : 0)));
    if (inBase !== null) score = Math.max(score, inBase + 10);
    if (base === q) score += 40;
    else if (base.replace(/\.[^.]*$/, '') === q) score += 35;
    else if (base.startsWith(q)) score += 25;
    else if (base.includes(q)) score += 12;
  } else if (trimmed.includes(q)) {
    score += trimmed.startsWith(q) ? 25 : 12;
  }
  return score - candidate.length * 0.02;
}

/** Лучшие `limit` элементов по {@link fuzzyScore}; при равенстве — короче, затем по алфавиту. Пустой запрос — порядок как есть. */
export function rankFuzzy<T>(items: readonly T[], query: string, keyOf: (item: T) => string, limit: number): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; key: string; score: number }[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const score = fuzzyScore(query, key);
    if (score !== null) scored.push({ item, key, score });
  }
  scored.sort((a, b) => b.score - a.score || a.key.length - b.key.length || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((s) => s.item);
}
