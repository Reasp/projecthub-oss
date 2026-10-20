import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

// Уникальность номеров Backlog.md для lint:docs (decision-76 п. 7, TASK-135): два файла с одним id и номер в
// имени файла, не совпадающий с id во frontmatter. Ловит слияния в обход `npm run backlog:merge` — кнопкой на
// GitHub или обычным `git merge`. Скрипт шаблона инфраструктуры работает и без приложения ProjectHub, поэтому
// правила разбора повторены здесь; совпадение с electron/services/backlogIds.ts сторожит тест backlogIdRules.test.ts.

export const ENTITY_DIRS = [
  { kind: 'task', dir: 'tasks' },
  { kind: 'task', dir: 'completed' },
  { kind: 'task', dir: 'drafts' },
  { kind: 'task', dir: 'archive/tasks' },
  { kind: 'task', dir: 'archive/drafts' },
  { kind: 'decision', dir: 'decisions' },
  { kind: 'doc', dir: 'docs', recursive: true },
  { kind: 'mem', dir: 'memory' },
  { kind: 'milestone', dir: 'milestones' },
  { kind: 'milestone', dir: 'archive/milestones' }
];

const FILE_RE = {
  task: /^task-(\d+(?:\.\d+)*)(?: - .*)?\.md$/i,
  decision: /^decision-(\d+)(?: - .*)?\.md$/i,
  doc: /^doc-(\d+)(?: - .*)?\.md$/i,
  mem: /^mem-(\d+)(?: - .*)?\.md$/i,
  milestone: /^(?:m|milestone)-(\d+)(?: - .*)?\.md$/i
};

const ID_RE = /^\s*(task|decision|doc|mem|m|milestone)-(\d+(?:\.\d+)*)\s*$/i;

/** Канонический id: `TASK-127.1`, `decision-73`, `doc-5`, `mem-3`, `m-2` (milestone-N и m-N — одна нумерация). */
export function canonicalBacklogId(kind, num) {
  const n = String(num).split('.').map((x) => String(parseInt(x, 10))).join('.');
  if (kind === 'task') return `TASK-${n}`;
  if (kind === 'milestone') return `m-${n}`;
  return `${kind}-${n}`;
}

/** id из имени файла сущности или null. */
export function idFromFileName(kind, fileName) {
  const m = FILE_RE[kind].exec(fileName);
  return m ? canonicalBacklogId(kind, m[1]) : null;
}

/** Канонический id из значения frontmatter или null. */
export function canonicalFromValue(raw) {
  const m = ID_RE.exec(String(raw ?? ''));
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const kind = prefix === 'm' || prefix === 'milestone' ? 'milestone' : prefix;
  if (kind !== 'task' && m[2].includes('.')) return null;
  return canonicalBacklogId(kind, m[2]);
}

function listFiles(abs, recursive) {
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { recursive: Boolean(recursive), withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/**
 * Ошибки по файлам: Map<путь от корня проекта, string[]>. Дубль сообщается у каждого файла с этим id.
 * Несовпадение имени и id у памяти проверяет memory-rules.mjs — здесь только дубли.
 */
export function checkBacklogIds(projectRoot) {
  const byId = new Map();
  const errors = new Map();
  const add = (rel, msg) => {
    if (!errors.has(rel)) errors.set(rel, []);
    errors.get(rel).push(msg);
  };
  for (const { kind, dir, recursive } of ENTITY_DIRS) {
    for (const abs of listFiles(path.join(projectRoot, 'backlog', dir), recursive)) {
      const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
      const fromName = idFromFileName(kind, path.basename(abs));
      if (!fromName) continue;
      if (!byId.has(fromName)) byId.set(fromName, []);
      byId.get(fromName).push(rel);
      if (kind === 'mem') continue;
      let fmId;
      try {
        const data = matter(fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')).data ?? {};
        fmId = data.id;
      } catch {
        continue; // битый frontmatter сообщает основная проверка validate-docs
      }
      if (fmId === undefined || fmId === null || fmId === '') continue; // отсутствие id сообщает основная проверка
      const fromFm = canonicalFromValue(fmId);
      if (fromFm !== fromName) add(rel, `Номер в имени файла (${fromName}) не совпадает с id во frontmatter (${fmId})`);
    }
  }
  for (const [id, files] of byId) {
    if (files.length < 2) continue;
    for (const rel of files) {
      const others = files.filter((f) => f !== rel).join(', ');
      add(rel, `Дубль номера ${id}: тот же id у ${others}. Перенумеруйте входящую сторону — слияние в ProjectHub делает это само (ProjectHub decision-76)`);
    }
  }
  return errors;
}
