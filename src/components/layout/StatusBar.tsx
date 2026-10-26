import React from 'react';
import { GitBranch, FolderGit2, CircleDot } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { WorktreeSwitcher } from '../git/WorktreeSwitcher';
import { HitlBadge } from '../hitl/HitlBadge';
import { NotificationsBadge } from '../notifications/NotificationsBadge';
import { AutomationsBadge } from '../automations/AutomationsBadge';
import { RemoteControlBadge } from '../remote/RemoteControlBadge';
import { McpServerStatusBadge } from '../mcp/McpServerStatusBadge';
import { DiagnosticsBadge } from '../diagnostics/DiagnosticsBadge';
import { VoiceControlHeader } from '../voice/VoiceControlHeader';
import { ClaudeUsageButton } from '../ai/ClaudeUsageButton';
import { EditionStatusItems } from '../../extensions/editionUi';
import { SupportButton } from '../support/SupportButton';

/**
 * Строка состояния (decision-73), по правилам VS Code:
 * слева — состояние активного проекта (ветка, рабочее дерево, незакоммиченные изменения),
 * справа — сервисы приложения (HITL, уведомления, Automations, Remote, MCP, диагностика, голос,
 * лимиты Claude, язык). Раньше всё это занимало шапку и не помещалось в окно.
 * Цветной фон получают только элементы, которые требуют действия (ожидающее решение HITL,
 * исчерпанный лимит, ошибка микрофона).
 */
export const StatusBar: React.FC = () => {
  const { language, setLanguage, t } = useTranslation();
  const { selectedProject, setActiveTab, worktrees, gitRepoDetails } = useProjectStore();

  const activeBranch = selectedProject ? gitRepoDetails?.currentBranch || selectedProject.gitBranch || '' : '';
  const extraWorktreeCount = worktrees.filter((w) => !w.isMain).length;
  const showGit = !!selectedProject?.hasGit && !!selectedProject.gitBranch;

  return (
    <footer
      className="h-6 shrink-0 flex items-stretch justify-between bg-ph-chrome border-t border-ph-line text-[11px] select-none overflow-hidden"
      role="status"
    >
      {/* Слева: активный проект */}
      <div className="flex items-stretch min-w-0 overflow-hidden">
        {showGit && selectedProject && (
          <>
            <button
              type="button"
              onClick={() => setActiveTab('git')}
              className="ph-status-item"
              title={t.header.currentGitBranch.replace('{branch}', activeBranch)}
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[200px]">{activeBranch}</span>
            </button>

            {/* Активное рабочее дерево проекта (TASK-62) */}
            <WorktreeSwitcher />

            {extraWorktreeCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('git')}
                title={t.header.worktreeCountTooltip.replace('{count}', String(worktrees.length))}
                className="ph-status-item text-cyan-300"
              >
                <FolderGit2 className="w-3.5 h-3.5 shrink-0" />
                <span className="tabular-nums">{extraWorktreeCount}</span>
              </button>
            )}

            {selectedProject.uncommittedCount !== undefined && (
              <span
                className={`ph-status-item cursor-default hover:bg-transparent ${
                  selectedProject.uncommittedCount === 0 ? '' : 'text-amber-300 hover:text-amber-300'
                }`}
                title={
                  selectedProject.uncommittedCount === 0
                    ? t.git.cleanWorkingTree
                    : t.git.unstagedCount.replace('{count}', String(selectedProject.uncommittedCount))
                }
              >
                <CircleDot className="w-3 h-3 shrink-0" />
                {selectedProject.uncommittedCount === 0
                  ? t.header.statusClean
                  : t.header.statusChanges.replace('{count}', String(selectedProject.uncommittedCount))}
              </span>
            )}
          </>
        )}
      </div>

      {/* Справа: сервисы приложения, сгруппированы по смыслу */}
      <div className="flex items-stretch shrink-0">
        {/* Внимание человека: решения HITL, уведомления, Automations (TASK-57, TASK-63, TASK-74) */}
        <HitlBadge />
        <NotificationsBadge />
        <AutomationsBadge />
        {/* Модули платной редакции (decision-123 п. 4): например, бюджеты Team */}
        <EditionStatusItems />

        {/* Подключения: Remote Control, встроенный MCP-сервер (TASK-51) */}
        <span className="w-px my-1.5 bg-ph-line" aria-hidden />
        <RemoteControlBadge />
        <McpServerStatusBadge />

        {/* Голос: микрофон, озвучка, настройки */}
        <span className="w-px my-1.5 bg-ph-line" aria-hidden />
        <VoiceControlHeader />

        {/* Лимиты Claude Code, версия и диагностика (TASK-58), язык интерфейса */}
        <span className="w-px my-1.5 bg-ph-line" aria-hidden />
        <ClaudeUsageButton variant="status" />
        {/* Поддержка проекта — только в открытой редакции (TASK-144.6) */}
        <SupportButton />
        <DiagnosticsBadge />
        <button
          type="button"
          onClick={() => setLanguage(language === 'ru' ? 'en' : 'ru')}
          title={language === 'ru' ? 'English language' : t.header.ruLanguageTooltip}
          className="ph-status-item uppercase"
        >
          {language}
        </button>
      </div>
    </footer>
  );
};
