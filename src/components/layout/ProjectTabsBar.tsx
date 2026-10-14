import React, { useRef } from 'react';
import { FolderGit2, Folder, X } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useVoiceState } from '../../hooks/useVoiceState';
import { VoiceBadge } from '../voice/VoiceBadge';

/**
 * Вкладки открытых проектов (decision-73). Живут прямо в шапке, как вкладки окна в браузере:
 * отдельная строка под одну-две вкладки занимала место и дублировала имя проекта в шапке.
 * Номер вкладки нужен для голосовых команд («проект 2»), поэтому виден, пока голос слушает.
 * Путь проекта и метка шаблона — в подсказке вкладки.
 */
export const ProjectTabs: React.FC = () => {
  const { t } = useTranslation();
  const { isListening } = useVoiceState();
  const {
    projects,
    activeProjectPaths,
    selectedProject,
    selectProject,
    deactivateProject,
    projectAgentStatuses,
    workspaceRoot
  } = useProjectStore();

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const activeProjects = projects.filter((p) => activeProjectPaths.includes(p.path));
  // Выбранный проект показываем вкладкой, даже если сессия для него не открыта
  const tabs =
    selectedProject && !activeProjects.some((p) => p.path === selectedProject.path)
      ? [...activeProjects, selectedProject]
      : activeProjects;

  if (tabs.length === 0) return null;

  const handleWheel = (e: React.WheelEvent) => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollLeft += e.deltaY;
  };

  const handleCloseTab = (e: React.MouseEvent, projectPath: string) => {
    e.stopPropagation();
    deactivateProject(projectPath);
  };

  return (
    <div className="flex items-stretch h-full min-w-0 select-none">
      <div
        ref={scrollContainerRef}
        onWheel={handleWheel}
        className="flex items-stretch overflow-x-auto no-scrollbar h-full min-w-0"
        role="tablist"
        aria-label={t.projectTabs.activeProjectsCount.replace('{count}', String(activeProjects.length))}
      >
        {tabs.map((project, idx) => {
          const isSelected = selectedProject?.path === project.path;
          const isOpen = activeProjectPaths.includes(project.path);
          const agentStatus = projectAgentStatuses[project.path];
          const uncommitted = project.uncommittedCount;
          const tabNumber = idx + 1;
          const rootPath = isSelected ? workspaceRoot || project.path : project.path;
          const tooltip = [
            t.projectTabs.tabVoiceTitle.replace('{name}', project.name).replace('{number}', String(tabNumber)),
            rootPath,
            project.hasInfraConfig ? `ProjectTemplate — ${t.header.standardProjectTemplate}` : ''
          ]
            .filter(Boolean)
            .join('\n');

          return (
            <div
              key={project.path}
              role="tab"
              aria-selected={isSelected}
              tabIndex={0}
              onClick={() => selectProject(project)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') selectProject(project);
              }}
              className={`group relative flex items-center gap-2 pl-3 pr-1.5 text-[13px] cursor-pointer border-r border-ph-line max-w-[240px] shrink-0 transition-colors ${
                isSelected ? 'bg-ph-panel text-slate-100' : 'text-slate-400 hover:text-slate-200 hover:bg-ph-hover/50'
              }`}
              title={tooltip}
            >
              {isSelected && <span className="absolute left-0 right-0 top-0 h-px bg-indigo-400" />}

              {isListening && (
                <span
                  className="text-[11px] tabular-nums text-slate-500"
                  title={t.projectTabs.tabVoiceNumberTooltip.replace(/\{number\}/g, String(tabNumber))}
                >
                  {tabNumber}
                </span>
              )}

              {project.hasGit ? (
                <FolderGit2 className={`w-4 h-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
              ) : (
                <Folder className={`w-4 h-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
              )}

              <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>{project.name}</span>
              {project.voiceAlias && (
                <span
                  className="text-[11px] text-slate-500 shrink-0"
                  title={t.projectTabs.voiceAliasTooltip.replace('{alias}', project.voiceAlias)}
                >
                  «{project.voiceAlias}»
                </span>
              )}
              <VoiceBadge
                command={t.projectTabs.tabVoiceCommand.replace('{number}', String(tabNumber))}
                altCommand={project.voiceAlias}
                variant={isSelected ? 'emerald' : 'indigo'}
              />

              {/* Незакоммиченные изменения — точка, как «изменён» у вкладки редактора; число в подсказке */}
              {uncommitted !== undefined && uncommitted > 0 && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                  title={t.git.unstagedCount.replace('{count}', String(uncommitted))}
                />
              )}
              {agentStatus?.status === 'running' && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title={t.header.claudeExecutingTooltip} />
              )}

              {isOpen && (
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(e, project.path)}
                  className={`p-0.5 rounded hover:bg-ph-hover transition shrink-0 ${
                    isSelected
                      ? 'text-slate-400 hover:text-white'
                      : 'text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  }`}
                  title={t.projectTabs.closeTab}
                  aria-label={t.projectTabs.closeTab}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Голосовые подсказки навигации по проектам */}
      <div className="flex items-center gap-1 px-2 shrink-0">
        <VoiceBadge command={t.voice.voiceBadges.nextProject} />
        <VoiceBadge command={t.voice.voiceBadges.closeProject} variant="amber" />
      </div>
    </div>
  );
};
