import type { WorkspaceTabId } from '../hooks/useWorkspaceTabs';

/**
 * Смысловые группы вкладок Activity Bar (decision-73): между группами рисуется разделитель,
 * чтобы 11 иконок не читались одной сплошной колонкой.
 */
export type ActivityGroup = 'plan' | 'code' | 'knowledge' | 'agents' | 'system';

const GROUP_BY_TAB: Record<WorkspaceTabId, ActivityGroup> = {
  kanban: 'plan',
  milestones: 'plan',
  git: 'code',
  files: 'code',
  prs: 'code',
  docs: 'knowledge',
  analytics: 'knowledge',
  ai: 'agents',
  'claude-cli': 'agents',
  processes: 'system',
  security: 'system'
};

export const activityGroupOf = (id: WorkspaceTabId): ActivityGroup => GROUP_BY_TAB[id];

/**
 * Для каждой вкладки в порядке пользователя — нужен ли разделитель перед ней.
 * Разделитель ставится, когда группа меняется; перед первой вкладкой его нет.
 * Порядок не меняется: пользователь может перемешать вкладки, тогда разделителей просто станет больше.
 */
export const withGroupSeparators = (ids: WorkspaceTabId[]): { id: WorkspaceTabId; separatorBefore: boolean }[] =>
  ids.map((id, i) => ({
    id,
    separatorBefore: i > 0 && activityGroupOf(ids[i - 1]) !== activityGroupOf(id)
  }));
