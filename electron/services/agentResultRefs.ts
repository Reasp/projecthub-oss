/**
 * Сохранность результата агента перед удалением его worktree ([[decision-8]] п. 5, TASK-237). Чистый модуль: имя ref
 * и выбор, что в нём сохранить. Ref `refs/projecthub/results/<сессия>/<агент>` держит коммит или снимок `stash create`
 * после `branch -D`: без него снимок висит без ссылки, и сборка мусора git может его убрать.
 */

export const AGENT_RESULT_REF_PREFIX = 'refs/projecthub/results/';

/** Компонент имени ref: только безопасные символы, без `..`, `.lock` и ведущей точки. */
function refPart(value: string): string {
  // Обрезка до чистки концов: после `slice` компонент не закончится точкой.
  const clean = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 80)
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.lock$/i, '-lock');
  return clean || 'x';
}

export function agentResultRef(sessionId: string, agentId: string): string {
  return `${AGENT_RESULT_REF_PREFIX}${refPart(sessionId)}/${refPart(agentId)}`;
}

/** Компонент сессии в имени ref: по нему отличают ref живых сессий при очистке (TASK-238). */
export function resultRefSessionPart(sessionId: string): string {
  return refPart(sessionId);
}

/** Сохранённый результат агента из `for-each-ref` (TASK-238). */
export interface AgentResultRefEntry {
  ref: string;
  sessionId: string;
  agentId: string;
  sha: string;
  /** Дата коммита или снимка, мс. У ref без работы агента это может быть давний HEAD базовой ветки. */
  date: number;
  /**
   * Когда ProjectHub сохранил результат, мс: время из reflog ref, без него — время файла ref, затем дата коммита. По нему
   * считаются срок и лимит: иначе давний коммит удалялся бы в ту же минуту, когда его сохранили.
   */
  savedAt: number;
  subject: string;
}

/** Сообщение reflog при сохранении результата: по нему же отличают свои записи. */
export const RESULT_REFLOG_MESSAGE = 'projecthub: agent result saved';

/** Формат `git for-each-ref` для `parseResultRefs`: поля через NUL, ref на строке. */
export const RESULT_REF_FORMAT = '%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)';

/** Разбор вывода `for-each-ref --format=RESULT_REF_FORMAT refs/projecthub/results/`; новые сверху. */
export function parseResultRefs(output: string): AgentResultRefEntry[] {
  const out: AgentResultRefEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [ref, sha, unix, ...subject] = line.split('\0');
    if (!ref?.startsWith(AGENT_RESULT_REF_PREFIX) || !/^[0-9a-f]{40,64}$/i.test(sha ?? '')) continue;
    const parts = ref.slice(AGENT_RESULT_REF_PREFIX.length).split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const seconds = Number(unix);
    out.push({
      ref,
      sessionId: parts[0],
      agentId: parts[1],
      sha,
      date: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      savedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      subject: subject.join('\0').trim()
    });
  }
  return sortBySaved(out);
}

function sortBySaved<T extends Pick<AgentResultRefEntry, 'savedAt' | 'ref'>>(entries: T[]): T[] {
  return entries.sort((a, b) => b.savedAt - a.savedAt || a.ref.localeCompare(b.ref));
}

/** Время последней записи reflog (`<old> <new> Имя <почта> <unix> <tz>\t<сообщение>`), мс; нет записей — `null`. */
export function reflogSavedAt(content: string): number | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const m = /> (\d+) [+-]\d{4}(?:\t|$)/.exec(lines[lines.length - 1] ?? '');
  return m ? Number(m[1]) * 1000 : null;
}

/** Подставляет время сохранения по ref (из reflog или файла ref) и пересортировывает: новые сверху. */
export function withSavedAt(entries: AgentResultRefEntry[], savedAt: ReadonlyMap<string, number>): AgentResultRefEntry[] {
  return sortBySaved(entries.map((e) => (savedAt.has(e.ref) ? { ...e, savedAt: savedAt.get(e.ref) ?? e.savedAt } : e)));
}

/** Сколько хранить результаты: срок в днях и число на репозиторий проекта; `0` — без ограничения. */
export interface ResultRetention {
  maxAgeDays: number;
  maxCount: number;
}

export const DEFAULT_RESULT_RETENTION: ResultRetention = { maxAgeDays: 30, maxCount: 50 };

function limit(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.trunc(value)) : fallback;
}

export function normalizeResultRetention(raw: unknown): ResultRetention {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    maxAgeDays: limit(v.maxAgeDays, DEFAULT_RESULT_RETENTION.maxAgeDays, 3650),
    maxCount: limit(v.maxCount, DEFAULT_RESULT_RETENTION.maxCount, 10000)
  };
}

/**
 * Какие ref удалить: сохранённые раньше срока или сверх лимита (считая от новых). Ref живых сессий не трогаются и в лимит
 * не входят: их результат ещё виден в карточке сессии.
 */
export function expiredResultRefs(
  entries: readonly AgentResultRefEntry[],
  retention: ResultRetention,
  now: number,
  liveSessionParts: ReadonlySet<string> = new Set()
): AgentResultRefEntry[] {
  const candidates = sortBySaved([...entries].filter((e) => !liveSessionParts.has(e.sessionId)));
  const cutoff = retention.maxAgeDays > 0 ? now - retention.maxAgeDays * 86_400_000 : -Infinity;
  return candidates.filter((e, i) => e.savedAt < cutoff || (retention.maxCount > 0 && i >= retention.maxCount));
}

/**
 * Имя ветки для восстановления: `projecthub/restored/<сессия>-<агент>`, занятое — с суффиксом `-2`, `-3`… `existing` —
 * полные имена веток без `refs/heads/`. Ветка не может лежать «внутри» другой (`projecthub` и `projecthub/x`): если
 * занят сам каталог `projecthub/restored`, берётся `projecthub-restored/`.
 */
export function restoreBranchName(entry: Pick<AgentResultRefEntry, 'sessionId' | 'agentId'>, existing: ReadonlySet<string>): string {
  const free = (name: string) => ![...existing].some((x) => x === name || name.startsWith(`${x}/`) || x.startsWith(`${name}/`));
  const leaf = refPart(`${entry.sessionId}-${entry.agentId}`);
  const prefix = free('projecthub/restored/x') ? 'projecthub/restored/' : 'projecthub-restored/';
  const base = `${prefix}${leaf}`;
  if (free(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (free(name)) return name;
  }
}

/**
 * Снимок `git stash create`: коммит рабочего дерева с родителями HEAD и индекса (`index on …`). В ветку его превращают
 * обычным коммитом с тем же деревом поверх HEAD: иначе в истории ветки остался бы служебный коммит индекса.
 */
export function isStashSnapshot(parents: readonly string[], secondParentSubject: string): boolean {
  return parents.length >= 2 && /^index on /.test(secondParentSubject.trim());
}

export interface WorktreeResultState {
  /** HEAD worktree после фиксации результата. */
  head?: string;
  /** Есть незафиксированные изменения (`git status --porcelain` не пуст). */
  dirty: boolean;
  /** Снимок `git stash create`, если авто-коммит выключен или не прошёл. */
  stashHash?: string;
}

/**
 * Что сохранить в ref перед удалением worktree. Изменения не зафиксированы — нужен снимок, иначе удалять нельзя
 * (`null`): работа агента пропала бы вместе с каталогом. Нет изменений — достаточно HEAD.
 */
export function resultToKeep(state: WorktreeResultState): string | null {
  const isSha = (v: string | undefined): v is string => typeof v === 'string' && /^[0-9a-f]{40,64}$/i.test(v.trim());
  if (state.dirty) return isSha(state.stashHash) ? state.stashHash.trim() : null;
  return isSha(state.head) ? state.head.trim() : null;
}
