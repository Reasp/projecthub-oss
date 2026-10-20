/**
 * Номера сущностей Backlog.md и их перенумерация при слиянии веток (decision-76, TASK-135).
 *
 * Чистый модуль без импортов: его загружают и main-процесс, и команда `npm run backlog:merge`
 * (`node --experimental-strip-types`), поэтому относительных импортов здесь быть не должно.
 *
 * Номер, выданный в ветке, — предварительный, окончательный — только в основной ветке (п. 1). Коллизия —
 * `id`, которого не было на merge-base и который добавили обе стороны (п. 2). Уступает входящая сторона (п. 3).
 */

/** Перенумеровываемые типы. Milestones (`m-N`) в перенумерацию не входят: шаблон `m-N` в тексте слишком общий. */
export type BacklogKind = 'task' | 'decision' | 'doc' | 'mem';
/** Типы для проверки дублей и выдачи номера: перенумеровываемые и milestones. */
export type BacklogIdKind = BacklogKind | 'milestone';

export const BACKLOG_KINDS: readonly BacklogKind[] = ['task', 'decision', 'doc', 'mem'];

/** Каталоги задач Backlog.md: живые, завершённые, черновики и архив (decision-76 Context). */
export const TASK_DIRS = ['tasks', 'completed', 'drafts', 'archive/tasks', 'archive/drafts'] as const;

export interface BacklogEntityRef {
  kind: BacklogIdKind;
  /** Канонический id: `TASK-127`, `TASK-127.1`, `decision-73`, `doc-5`, `mem-3`, `m-2`. */
  id: string;
  /** Номера по уровням: `TASK-127.1` → `[127, 1]`. */
  path: number[];
}

const FILE_PATTERNS: Array<{ kind: BacklogIdKind; dir: RegExp; file: RegExp }> = [
  { kind: 'task', dir: /^(?:tasks|completed|drafts|archive\/tasks|archive\/drafts)$/, file: /^task-(\d+(?:\.\d+)*)(?: - .*)?\.md$/i },
  { kind: 'decision', dir: /^decisions$/, file: /^decision-(\d+)(?: - .*)?\.md$/i },
  { kind: 'doc', dir: /^docs(?:\/.+)?$/, file: /^doc-(\d+)(?: - .*)?\.md$/i },
  { kind: 'mem', dir: /^memory$/, file: /^mem-(\d+)(?: - .*)?\.md$/i },
  { kind: 'milestone', dir: /^(?:milestones|archive\/milestones)$/, file: /^(?:m|milestone)-(\d+)(?: - .*)?\.md$/i }
];

/** Канонический id по типу и номерам. */
export function formatBacklogId(kind: BacklogIdKind, path: readonly number[]): string {
  const num = path.join('.');
  switch (kind) {
    case 'task':
      return `TASK-${num}`;
    case 'milestone':
      return `m-${num}`;
    default:
      return `${kind}-${num}`;
  }
}

/**
 * Сущность по пути файла относительно корня `backlog/` (`tasks/task-127 - X.md`, `docs/sub/doc-5 - Y.md`).
 * Не файл сущности — `null`. Разделители путей приводятся к `/`.
 */
export function entityFromBacklogPath(relPath: string): BacklogEntityRef | null {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = norm.lastIndexOf('/');
  if (slash < 0) return null;
  const dir = norm.slice(0, slash);
  const file = norm.slice(slash + 1);
  for (const p of FILE_PATTERNS) {
    if (!p.dir.test(dir)) continue;
    const m = p.file.exec(file);
    if (!m) continue;
    const path = m[1].split('.').map((n) => parseInt(n, 10));
    if (path.some((n) => !Number.isFinite(n))) return null;
    // milestone-N и m-N — одна нумерация (нативная форма Backlog.md — m-N)
    return { kind: p.kind, id: formatBacklogId(p.kind, path), path };
  }
  return null;
}

/** Разбор канонического или записанного по-другому id (`task-127`, `TASK-127.1`, `Decision-7`) — или `null`. */
export function parseBacklogId(raw: string): BacklogEntityRef | null {
  const m = /^\s*(task|decision|doc|mem|m|milestone)-(\d+(?:\.\d+)*)\s*$/i.exec(String(raw ?? ''));
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const kind: BacklogIdKind = prefix === 'm' || prefix === 'milestone' ? 'milestone' : (prefix as BacklogKind);
  const path = m[2].split('.').map((n) => parseInt(n, 10));
  if (kind !== 'task' && path.length > 1) return null;
  return { kind, id: formatBacklogId(kind, path), path };
}

/** Набор id по типам из списка путей относительно `backlog/`; `paths` — id → пути файлов с этим id. */
export interface BacklogIdIndex {
  ids: Map<BacklogIdKind, Set<string>>;
  paths: Map<string, string[]>;
}

export function indexBacklogPaths(relPaths: Iterable<string>): BacklogIdIndex {
  const ids = new Map<BacklogIdKind, Set<string>>();
  const paths = new Map<string, string[]>();
  for (const rel of relPaths) {
    const ref = entityFromBacklogPath(rel);
    if (!ref) continue;
    if (!ids.has(ref.kind)) ids.set(ref.kind, new Set());
    ids.get(ref.kind)!.add(ref.id);
    const list = paths.get(ref.id) ?? [];
    list.push(rel.replace(/\\/g, '/'));
    paths.set(ref.id, list);
  }
  return { ids, paths };
}

/** Следующий номер верхнего уровня: максимум по занятым плюс один (пропуски не заполняются — удалённые номера не переиспользуются). */
export function nextTopNumber(kind: BacklogIdKind, taken: Iterable<string>): number {
  let max = kind === 'milestone' ? -1 : 0;
  for (const id of taken) {
    const ref = parseBacklogId(id);
    if (ref && ref.kind === kind && ref.path[0] > max) max = ref.path[0];
  }
  return max + 1;
}

/** Следующий номер подзадачи родителя (`TASK-80` → 4 для `TASK-80.4`). */
export function nextSubtaskNumber(parentId: string, taken: Iterable<string>): number {
  const parent = parseBacklogId(parentId);
  if (!parent || parent.kind !== 'task') throw new Error(`Не задача: ${parentId}`);
  let max = 0;
  for (const id of taken) {
    const ref = parseBacklogId(id);
    if (!ref || ref.kind !== 'task' || ref.path.length !== parent.path.length + 1) continue;
    if (parent.path.every((n, i) => ref.path[i] === n) && ref.path[ref.path.length - 1] > max) max = ref.path[ref.path.length - 1];
  }
  return max + 1;
}

export interface BacklogRenumbering {
  kind: BacklogKind;
  from: string;
  to: string;
}

export interface RenumberInput {
  /** Пути относительно `backlog/` на merge-base, в основной ветке и во входящей. */
  base: Iterable<string>;
  ours: Iterable<string>;
  theirs: Iterable<string>;
}

/**
 * План перенумерации входящей стороны (decision-76 п. 2–3).
 *
 * - Коллизия — id, которого нет на merge-base и который обе стороны добавили разными файлами. Один и тот же путь с
 *   обеих сторон — не коллизия: такой файл git сольёт или покажет конфликтом.
 * - Входящие добавленные id обходятся по возрастанию. Id, совпавший с занятым (основная ветка, merge-base, уже
 *   назначенные замены), получает максимум занятых плюс один. Так получаются цепочки `73 → 74`, `74 → 75`: замена
 *   занимает номер, и следующий входящий id с этим номером тоже уступает.
 * - Подзадачи следуют за родителем: `TASK-127 → TASK-134` уносит `TASK-127.1 → TASK-134.1`. Подзадачи общего
 *   родителя нумеруются внутри него (`TASK-80.4 → TASK-80.6`).
 */
export function planBacklogRenumber(input: RenumberInput): BacklogRenumbering[] {
  const base = indexBacklogPaths(input.base);
  const ours = indexBacklogPaths(input.ours);
  const theirs = indexBacklogPaths(input.theirs);
  const plan: BacklogRenumbering[] = [];

  for (const kind of BACKLOG_KINDS) {
    const baseIds = base.ids.get(kind) ?? new Set<string>();
    const ourIds = ours.ids.get(kind) ?? new Set<string>();
    const theirIds = theirs.ids.get(kind) ?? new Set<string>();
    // Один и тот же путь с обеих сторон — тот же файл, а не коллизия номеров.
    const sameFile = (id: string) => {
      const a = [...(ours.paths.get(id) ?? [])].sort().join('\n');
      const b = [...(theirs.paths.get(id) ?? [])].sort().join('\n');
      return a !== '' && a === b;
    };

    const taken = new Set<string>([...baseIds, ...ourIds]);
    const assigned = new Set<string>();
    const added = [...theirIds]
      .filter((id) => !baseIds.has(id))
      .map((id) => parseBacklogId(id))
      .filter((r): r is BacklogEntityRef => r !== null);
    const maxDepth = Math.max(0, ...added.map((r) => r.path.length));
    const moved = new Map<string, string>();

    // По уровням: сначала верхний, затем подзадачи — чтобы родитель решился раньше своих подзадач.
    for (let depth = 1; depth <= maxDepth; depth++) {
      const level = added
        .filter((r) => r.path.length === depth)
        .sort((a, b) => a.path[depth - 1] - b.path[depth - 1]);
      for (const ref of level) {
        // Предок перенумерован — подзадача уезжает вместе с ним.
        const movedAncestor = [...moved.keys()].find((anc) => ref.id.startsWith(`${anc}.`));
        if (movedAncestor) {
          const to = moved.get(movedAncestor)! + ref.id.slice(movedAncestor.length);
          plan.push({ kind, from: ref.id, to });
          taken.add(to);
          assigned.add(to);
          continue;
        }
        if (!taken.has(ref.id)) {
          taken.add(ref.id);
          continue;
        }
        if (ourIds.has(ref.id) && !assigned.has(ref.id) && sameFile(ref.id)) continue;
        let to: string;
        if (depth === 1) {
          to = formatBacklogId(kind, [nextTopNumber(kind, taken)]);
        } else {
          const parentId = formatBacklogId(kind, ref.path.slice(0, -1));
          to = `${parentId}.${nextSubtaskNumber(parentId, taken)}`;
        }
        moved.set(ref.id, to);
        plan.push({ kind, from: ref.id, to });
        taken.add(to);
        assigned.add(to);
      }
    }
  }
  return plan;
}

const TOKEN_PATTERNS: Record<BacklogKind, RegExp> = {
  task: /(?<![A-Za-z0-9_])(task)-(\d+(?:\.\d+)*)(?!\d)/gi,
  decision: /(?<![A-Za-z0-9_])(decision)-(\d+)(?!\d)/gi,
  doc: /(?<![A-Za-z0-9_])(doc)-(\d+)(?!\d)/gi,
  mem: /(?<![A-Za-z0-9_])(mem)-(\d+)(?!\d)/gi
};

/** Отображение «канонический id → новый номер» с поиском по ближайшему перенумерованному предку. */
function makeLookup(plan: readonly BacklogRenumbering[]): (kind: BacklogKind, path: number[]) => number[] | null {
  const byId = new Map(plan.map((r) => [r.from, parseBacklogId(r.to)!.path]));
  return (kind, path) => {
    for (let len = path.length; len >= 1; len--) {
      const to = byId.get(formatBacklogId(kind, path.slice(0, len)));
      if (to) return [...to, ...path.slice(len)];
    }
    return null;
  };
}

/**
 * Замена упоминаний перенумерованных id в тексте (decision-76 п. 4): `TASK-127`, `task-127` в именах файлов и
 * ссылках, `[[decision-73#раздел|подпись]]`, `decision-73` в коде. Регистр префикса сохраняется.
 *
 * Замена идёт одним проходом функцией-заменителем по исходному тексту: каждое упоминание меняется ровно один раз,
 * поэтому цепочки `73 → 74`, `74 → 75` не зависят от порядка и временные метки не нужны. Граница номера
 * проверяется: `decision-7` не задевает `decision-74`.
 */
export function replaceBacklogIds(text: string, plan: readonly BacklogRenumbering[]): string {
  if (plan.length === 0) return text;
  const lookup = makeLookup(plan);
  let out = text;
  for (const kind of BACKLOG_KINDS) {
    if (!plan.some((r) => r.kind === kind)) continue;
    out = out.replace(TOKEN_PATTERNS[kind], (match, prefix: string, num: string) => {
      const to = lookup(kind, num.split('.').map((n) => parseInt(n, 10)));
      return to ? `${prefix}-${to.join('.')}` : match;
    });
  }
  return out;
}

/** Упоминания перенумерованных id в тексте: номер строки и сама строка (для `--dry-run`). */
export function findBacklogIdMentions(text: string, plan: readonly BacklogRenumbering[]): Array<{ line: number; text: string }> {
  if (plan.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const out: Array<{ line: number; text: string }> = [];
  lines.forEach((line, i) => {
    if (replaceBacklogIds(line, plan) !== line) out.push({ line: i + 1, text: line });
  });
  return out;
}

/**
 * Отметка `renumbered_from` во frontmatter перенумерованной сущности (decision-76 п. 5). Ставится сразу после `id:`;
 * уже стоящая отметка сохраняется — она хранит самый первый номер.
 */
export function markRenumberedFrom(text: string, from: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return text;
  const end = lines.indexOf('---', 1);
  if (end < 0) return text;
  if (lines.slice(1, end).some((l) => /^renumbered_from\s*:/.test(l))) return text;
  const idLine = lines.slice(1, end).findIndex((l) => /^id\s*:/.test(l));
  const at = idLine >= 0 ? idLine + 2 : 1;
  lines.splice(at, 0, `renumbered_from: "${from}"`);
  return lines.join(eol);
}

/** Новый путь файла сущности (относительно `backlog/`) после перенумерации: меняется только номер в начале имени. */
export function renameBacklogPath(relPath: string, plan: readonly BacklogRenumbering[]): string {
  const norm = relPath.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = norm.slice(0, slash + 1);
  const file = norm.slice(slash + 1);
  const ref = entityFromBacklogPath(norm);
  if (!ref || ref.kind === 'milestone') return relPath;
  const renamed = plan.find((r) => r.from === ref.id);
  if (!renamed) return relPath;
  return dir + file.replace(/^(task|decision|doc|mem)-\d+(?:\.\d+)*/i, (m, prefix: string) => `${prefix}-${parseBacklogId(renamed.to)!.path.join('.')}`);
}

/** Таблица замен для сообщения коммита слияния и карточки подтверждения. */
export function formatRenumberTable(plan: readonly BacklogRenumbering[]): string {
  if (plan.length === 0) return '';
  return ['| Было | Стало |', '|---|---|', ...plan.map((r) => `| ${r.from} | ${r.to} |`)].join('\n');
}

/** Дубли id: два и более файла с одним id (decision-76 п. 7). */
export function findDuplicateIds(relPaths: Iterable<string>): Array<{ id: string; paths: string[] }> {
  const { paths } = indexBacklogPaths(relPaths);
  return [...paths.entries()].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, paths: list }));
}
