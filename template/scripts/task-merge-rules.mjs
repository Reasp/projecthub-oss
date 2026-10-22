import matter from 'gray-matter';

// Трёхстороннее слияние файла задачи Backlog.md по полям frontmatter (TASK-139.2, decision-154). Чистый модуль без
// git: тело сливает переданная функция (драйвер — `git merge-file`). Копия в template/scripts/ — совпадение сторожит
// тест taskMergeRules.test.ts.
//
// Поле — ключ верхнего уровня со всеми строками значения. Значения сравниваются как YAML: `status: Done` и
// `status: 'Done'` — одно и то же (CLI Backlog.md и gray-matter переписывают кавычки). Поле изменила одна сторона —
// берётся её строка; обе по-разному — `updated_date` берёт большее, списки скаляров (`labels`, `dependencies`,
// `references`, …) сливаются как множества, остальное — конфликт с маркерами вокруг этого поля. Незнакомые поля не
// теряются: модуль не знает схемы задачи и переносит строки как есть.

const FM_KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:/;

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const withEol = (text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** `{ fields: [{ key, text }], body }` или `null`, если frontmatter нет. Переводы строк — `\n`. */
export function parseTaskFile(raw) {
  const lines = splitLines(raw.replace(/\r\n/g, '\n'));
  if (!lines.length || lines[0].replace(/\n$/, '').trimEnd() !== '---') return null;
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\n$/, '').trimEnd() === '---');
  if (close < 0) return null;
  const fields = [];
  const seen = new Map();
  let current = null;
  for (const line of lines.slice(1, close)) {
    const m = FM_KEY_RE.exec(line);
    if (m && !/^\s/.test(line)) {
      const n = (seen.get(m[1]) ?? 0) + 1;
      seen.set(m[1], n);
      current = { key: n === 1 ? m[1] : `${m[1]}#${n}`, text: line };
      fields.push(current);
    } else if (current) {
      current.text += line;
    } else {
      // Комментарии и пустые строки до первого ключа.
      current = { key: '', text: line };
      fields.push(current);
    }
  }
  return { fields, body: lines.slice(close + 1).join('') };
}

const valueCache = new Map();

/** Значение поля как YAML: `{ ok: true, value }`; строка не разбирается — `{ ok: false }`. */
function fieldValue(text) {
  if (valueCache.has(text)) return valueCache.get(text);
  let result;
  try {
    const data = matter(`---\n${withEol(text)}---\n`).data;
    const values = Object.values(data);
    result = { ok: true, value: values.length === 1 ? normalize(values[0]) : normalize(data) };
  } catch {
    result = { ok: false };
  }
  if (valueCache.size > 2000) valueCache.clear();
  valueCache.set(text, result);
  return result;
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function sameField(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a.replace(/\s+$/, '') === b.replace(/\s+$/, '')) return true;
  const [x, y] = [fieldValue(a), fieldValue(b)];
  return x.ok && y.ok && same(x.value, y.value);
}

const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isScalarList = (v) => Array.isArray(v) && v.every(isScalar);

/** Скаляр в YAML: без кавычек, если так читается то же значение, иначе в одинарных кавычках. */
function formatScalar(value) {
  if (typeof value !== 'string') return value === null ? 'null' : String(value);
  const parsed = fieldValue(`x: ${value}\n`);
  if (value !== '' && !/^\s|\s$|\n/.test(value) && parsed.ok && parsed.value === value) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function formatList(name, items, like) {
  if (!items.length) return `${name}: []\n`;
  const indent = /\n([ \t]*)- /.exec(like ?? '')?.[1] ?? '  ';
  return `${name}:\n${items.map((v) => `${indent}- ${formatScalar(v)}\n`).join('')}`;
}

/** Слияние множеств: порядок основной стороны, удалённое любой стороной убирается, новое из ветки — в конце. */
function mergeLists(base, ours, theirs) {
  const has = (list, v) => list.some((x) => same(x, v));
  const removedByTheirs = base.filter((v) => !has(theirs, v));
  const removedByOurs = base.filter((v) => !has(ours, v));
  const out = ours.filter((v) => !has(removedByTheirs, v));
  for (const v of theirs) if (!has(out, v) && !has(removedByOurs, v)) out.push(v);
  return out;
}

function conflictBlock(ours, theirs, { markerSize = 7, oursLabel = 'ours', theirsLabel = 'theirs' } = {}) {
  return (
    `${'<'.repeat(markerSize)} ${oursLabel}\n${withEol(ours ?? '')}` +
    `${'='.repeat(markerSize)}\n${withEol(theirs ?? '')}${'>'.repeat(markerSize)} ${theirsLabel}\n`
  );
}

/** Поле, изменённое обеими сторонами по-разному: `{ text }` (может быть `undefined` — поля нет) или `null` — конфликт. */
function resolveBothChanged(key, b, o, t) {
  const name = key.replace(/#\d+$/, '');
  if (o === undefined || t === undefined) return null;
  const [vo, vt] = [fieldValue(o), fieldValue(t)];
  if (!vo.ok || !vt.ok) return null;
  if (name === 'updated_date' && typeof vo.value === 'string' && typeof vt.value === 'string') {
    return { text: vo.value >= vt.value ? o : t };
  }
  const vb = b === undefined ? { ok: true, value: [] } : fieldValue(b);
  const baseList = vb.ok && (vb.value === null || isScalarList(vb.value)) ? vb.value ?? [] : null;
  if (baseList && isScalarList(vo.value) && isScalarList(vt.value)) {
    const merged = mergeLists(baseList, vo.value, vt.value);
    if (same(merged, vo.value)) return { text: o };
    if (same(merged, vt.value)) return { text: t };
    return { text: formatList(name, merged, o) };
  }
  return null;
}

function mergeFields(base, ours, theirs, conflicts, markers) {
  const baseMap = new Map(base.map((f) => [f.key, f.text]));
  const theirsMap = new Map(theirs.map((f) => [f.key, f.text]));
  const oursKeys = new Set(ours.map((f) => f.key));
  const result = [];

  const pick = (key, b, o, t) => {
    if (sameField(o, t)) return o;
    if (sameField(b, o)) return t;
    if (sameField(b, t)) return o;
    const resolved = resolveBothChanged(key, b, o, t);
    if (resolved) return resolved.text;
    conflicts.push(key.replace(/#\d+$/, '') || '(начало frontmatter)');
    return conflictBlock(o, t, markers);
  };

  for (const f of ours) {
    const text = pick(f.key, baseMap.get(f.key), f.text, theirsMap.get(f.key));
    if (text !== undefined) result.push({ key: f.key, text });
  }
  // Поля только из ветки — после ближайшего предшествующего поля ветки, что уже есть в итоге.
  for (let i = 0; i < theirs.length; i++) {
    const t = theirs[i];
    if (oursKeys.has(t.key)) continue;
    const text = pick(t.key, baseMap.get(t.key), undefined, t.text);
    if (text === undefined) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.findIndex((f) => f.key === theirs[j].key);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    result.splice(at, 0, { key: t.key, text });
  }
  return result;
}

/**
 * Слияние файла задачи. `base` — общий предок (`''` или `null` — файла не было), `ours`/`theirs` — стороны;
 * `mergeBody(base, ours, theirs)` → `{ text, conflicted }` сливает тело (и весь файл, если у стороны нет
 * frontmatter). `markers` — `{ markerSize, oursLabel, theirsLabel }`. Результат: `{ text, conflicts }`, где
 * `conflicts` — имена спорных полей и `'(тело)'`.
 */
export function mergeTaskText(base, ours, theirs, mergeBody, markers = {}) {
  const crlf = ours.includes('\r\n') || (!ours && theirs.includes('\r\n'));
  const out = (text) => (crlf ? text.replace(/\n/g, '\r\n') : text);
  const b = base ? parseTaskFile(base) : { fields: [], body: '' };
  const o = parseTaskFile(ours);
  const t = parseTaskFile(theirs);
  const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');
  if (!b || !o || !t) {
    const whole = mergeBody(norm(base), norm(ours), norm(theirs));
    return { text: out(whole.text), conflicts: whole.conflicted ? ['(файл)'] : [] };
  }
  const conflicts = [];
  const fields = mergeFields(b.fields, o.fields, t.fields, conflicts, markers);
  const body = mergeBody(b.body, o.body, t.body);
  if (body.conflicted) conflicts.push('(тело)');
  const fm = fields.map((f) => withEol(f.text)).join('');
  return { text: out(`---\n${fm}---\n${body.text}`), conflicts };
}
