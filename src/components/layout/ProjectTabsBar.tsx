import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, ExternalLink, FolderGit2, Folder, Monitor, X } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useAIStudioStore } from '../../store/useAIStudioStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useVoiceState } from '../../hooks/useVoiceState';
import { useDialog } from '../../hooks/useDialog';
import { VoiceBadge } from '../voice/VoiceBadge';
import { isOutsideRect, orderProjectsByPaths } from '../../lib/projectWindow';
import { isProjectWindow } from '../../lib/windowContext';

/** Тип данных перетаскивания вкладки проекта: путь проекта. */
const TAB_DRAG_TYPE = 'application/x-projecthub-project-tab';

/** Идёт ли в проекте ход Agents Studio: поток принадлежит окну, начавшему ход, — выносить проект нельзя. */
function hasStreamingStudioRun(projectPath: string): boolean {
  const { sessions, streamingSessions } = useAIStudioStore.getState();
  return (sessions[projectPath] ?? []).some((s) => streamingSessions[s.id]);
}

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
    workspaceRoot,
    reorderProjectTab,
    detachProjectToWindow
  } = useProjectStore();
  const dialog = useDialog();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; projectPath: string } | null>(null);

  // Клик вне меню вкладки закрывает его.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  // Вкладки — в порядке, который человек задал перетаскиванием (TASK-295), а не в порядке каталога.
  const activeProjects = orderProjectsByPaths(projects, activeProjectPaths);
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
    // В окне проекта крестик возвращает проект вкладкой в главное окно (TASK-295).
    if (isProjectWindow) {
      void window.api?.reattachProjectWindow?.();
      return;
    }
    deactivateProject(projectPath);
  };

  const detach = async (projectPath: string, at: { x: number; y: number } | null) => {
    if (hasStreamingStudioRun(projectPath)) {
      await dialog.alert({ message: t.projectTabs.detachBlockedByRun });
      return;
    }
    await detachProjectToWindow(projectPath, at);
  };

  // Вкладку бросили за пределами окна — выносим проект в отдельное окно у курсора. Точку даёт main: координаты
  // `dragend` при броске вне окна Chromium отдаёт не всегда.
  const handleDragEnd = async (e: React.DragEvent, projectPath: string) => {
    const dropped = e.dataTransfer.dropEffect !== 'none';
    setDragPath(null);
    setDropTargetPath(null);
    if (dropped || isProjectWindow) return;
    const context = await window.api?.getWindowDropContext?.();
    if (context && isOutsideRect(context.cursor, context.bounds)) await detach(projectPath, context.cursor);
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
            project.remote ? t.projectTabs.remoteTabTooltip.replace('{host}', project.remote.machineName).replace('{path}', project.remote.hostPath) : rootPath,
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
              // Перетаскивание (TASK-295): между вкладками — порядок, за пределы окна — отдельное окно.
              draggable={!isProjectWindow && isOpen}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_TYPE, project.path);
                e.dataTransfer.effectAllowed = 'move';
                setDragPath(project.path);
              }}
              onDragOver={(e) => {
                if (!dragPath || !e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dropTargetPath !== project.path) setDropTargetPath(project.path);
              }}
              onDragLeave={() => {
                if (dropTargetPath === project.path) setDropTargetPath(null);
              }}
              onDrop={(e) => {
                const from = e.dataTransfer.getData(TAB_DRAG_TYPE);
                e.preventDefault();
                if (from) reorderProjectTab(from, project.path);
                setDropTargetPath(null);
              }}
              onDragEnd={(e) => void handleDragEnd(e, project.path)}
              onContextMenu={(e) => {
                if (project.remote) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, projectPath: project.path });
              }}
              data-testid="project-tab"
              data-project-path={project.path}
              className={`group relative flex items-center gap-2 pl-3 pr-1.5 text-[13px] cursor-pointer border-r border-ph-line max-w-[240px] shrink-0 transition-colors ${
                isSelected ? 'bg-ph-panel text-slate-100' : 'text-slate-400 hover:text-slate-200 hover:bg-ph-hover/50'
              } ${dragPath === project.path ? 'opacity-50' : ''}`}
              title={tooltip}
            >
              {isSelected && <span className="absolute left-0 right-0 top-0 h-px bg-indigo-400" />}
              {dropTargetPath === project.path && dragPath !== project.path && (
                <span className="absolute top-1 bottom-1 left-0 w-0.5 bg-indigo-400" />
              )}

              {isListening && (
                <span
                  className="text-[11px] tabular-nums text-slate-500"
                  title={t.projectTabs.tabVoiceNumberTooltip.replace(/\{number\}/g, String(tabNumber))}
                >
                  {tabNumber}
                </span>
              )}

              {project.remote ? (
                <Monitor className={`w-4 h-4 shrink-0 ${isSelected ? 'text-sky-400' : 'text-slate-500'}`} />
              ) : project.hasGit ? (
                <FolderGit2 className={`w-4 h-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
              ) : (
                <Folder className={`w-4 h-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
              )}

              <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>{project.name}</span>
              {/* Проект другого ПК (TASK-280): компьютер рядом с именем, остальное — как у локального */}
              {project.remote && (
                <span className="text-[11px] text-sky-300/80 truncate max-w-[110px] shrink-0" data-testid="project-tab-remote">
                  {project.remote.machineName}
                </span>
              )}
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
                  title={isProjectWindow ? t.projectTabs.returnToMainWindow : t.projectTabs.closeTab}
                  aria-label={isProjectWindow ? t.projectTabs.returnToMainWindow : t.projectTabs.closeTab}
                >
                  {isProjectWindow ? <CornerDownLeft className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Голосовые подсказки навигации по проектам — голос живёт в главном окне */}
      {!isProjectWindow && (
        <div className="flex items-center gap-1 px-2 shrink-0">
          <VoiceBadge command={t.voice.voiceBadges.nextProject} />
          <VoiceBadge command={t.voice.voiceBadges.closeProject} variant="amber" />
        </div>
      )}

      {/* Меню вкладки (createPortal, decision-17) */}
      {menu &&
        createPortal(
          <div
            role="menu"
            style={{ top: `${menu.y}px`, left: `${menu.x}px` }}
            className="fixed z-[10000] w-56 bg-ph-elevated border border-slate-700 rounded-lg shadow-xl py-1 text-xs text-slate-200 select-none"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="project-tab-menu-window"
              onClick={() => {
                const target = menu.projectPath;
                setMenu(null);
                if (isProjectWindow) void window.api?.reattachProjectWindow?.();
                else void detach(target, null);
              }}
              className="w-[calc(100%-0.5rem)] mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:bg-ph-hover hover:text-white text-left"
            >
              {isProjectWindow ? <CornerDownLeft className="w-3.5 h-3.5 text-slate-400" /> : <ExternalLink className="w-3.5 h-3.5 text-slate-400" />}
              <span>{isProjectWindow ? t.projectTabs.returnToMainWindow : t.projectTabs.openInNewWindow}</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};
