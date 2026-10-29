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
