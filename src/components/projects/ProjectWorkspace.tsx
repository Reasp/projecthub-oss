import React, { useState } from 'react';
import {
  AlertTriangle,
  FolderPlus,
  Star,
  FolderGit2,
  PanelLeft,
  Loader2,
  Sparkles,
  X
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { KanbanBoard } from '../kanban/KanbanBoard';
import { MilestonesRoadmapView } from '../milestones/MilestonesRoadmapView';
import { GitInspector } from '../git/GitInspector';
import { FileExplorer } from '../explorer/FileExplorer';
import { PullRequestView } from '../pr/PullRequestView';
import { DocsRagView } from '../docs/DocsRagView';
import { ProjectAnalyticsView } from '../analytics/ProjectAnalyticsView';
import { AIStudioView } from '../ai/AIStudioView';
import { ClaudeCliView } from '../claude/ClaudeCliView';
import { ProcessesView } from '../processes/ProcessesView';
import { SecurityHealthView } from '../security/SecurityHealthView';
import { ProjectInitModal, type ProjectInitMode } from './ProjectInitModal';

/**
 * Рабочая область выбранного проекта. Переключение вкладок, их порядок, скрытие и настройка
 * живут в Activity Bar (decision-73); здесь — содержимое активной вкладки и стартовый экран.
 */
export const ProjectWorkspace: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProject,
    activeTab,
    projects,
    selectProject,
    isSidebarOpen,
    setSidebarOpen,
    addProjectByPath,
    removedProjectNotice,
    clearRemovedProjectNotice,
    isProjectDataLoading
  } = useProjectStore();

  const [initTarget, setInitTarget] = useState<{ mode: ProjectInitMode; path?: string } | null>(null);

  if (!selectedProject) {
    const startAction =
      'flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-[13px] text-indigo-300 hover:text-indigo-200 hover:bg-ph-hover transition text-left';

    return (
      <div className="flex-1 overflow-y-auto bg-ph-panel select-none">
        <div className="max-w-4xl mx-auto px-8 sm:px-12 py-12">
          {/* Предупреждение: ранее выбранный проект удалён или не найден */}
          {removedProjectNotice && (
            <div className="mb-8 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h4 className="text-xs font-semibold text-amber-200">{t.emptyState.removedNoticeTitle}</h4>
                  <p className="text-[11px] text-amber-300/80 font-mono mt-1 break-all">{removedProjectNotice}</p>
                  <p className="text-[11px] text-slate-400 mt-1.5">{t.emptyState.removedNoticeHint}</p>
                </div>
              </div>
              <button onClick={clearRemovedProjectNotice} className="ph-icon-button shrink-0" title={t.common.close}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <h2 className="text-2xl font-semibold text-slate-100 tracking-tight">ProjectHub</h2>
          <p className="text-[13px] text-slate-400 mt-1.5 max-w-xl leading-relaxed">{t.emptyState.subtitle}</p>

          <div className="mt-10 grid grid-cols-1 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-10">
            {/* Начать */}
            <section>
              <h3 className="ph-section-title mb-2 px-2">{t.emptyState.start}</h3>
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={async () => {
                    if (window.api) {
                      // Папка без признаков проекта не добавляется — для неё открывается инициализация основы.
                      const folder = await window.api.initSelectFolder();
                      if (folder && !(await addProjectByPath(folder))) setInitTarget({ mode: 'folder', path: folder });
                    }
                  }}
                  className={startAction}
                >
                  <FolderPlus className="w-4 h-4 shrink-0" />
                  <span>{t.sidebar.addProject}</span>
                </button>
                <button type="button" onClick={() => setInitTarget({ mode: 'new' })} className={startAction}>
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <span>{t.sidebar.newFromTemplate}</span>
                </button>
                {!isSidebarOpen && (
                  <button type="button" onClick={() => setSidebarOpen(true)} className={startAction}>
                    <PanelLeft className="w-4 h-4 shrink-0" />
                    <span>{t.sidebar.showSidebar}</span>
                  </button>
                )}
              </div>
            </section>

            {/* Проекты из каталога */}
            {projects.length > 0 && (
              <section className="min-w-0">
                <h3 className="ph-section-title mb-2 px-2">
                  {t.emptyState.availableProjects} <span className="text-slate-600">{projects.length}</span>
                </h3>
                <div className="max-h-[55vh] overflow-y-auto space-y-px">
                  {projects.map((p) => (
                    <button
                      type="button"
                      key={p.path}
                      onClick={() => selectProject(p)}
                      className="group w-full flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-ph-hover transition text-left"
                      title={`${t.emptyState.openProject}: ${p.path}`}
                    >
                      <FolderGit2 className="w-4 h-4 text-slate-500 group-hover:text-indigo-400 shrink-0" />
                      <span className="text-[13px] text-indigo-300 group-hover:text-indigo-200 truncate shrink-0 max-w-[40%]">
                        {p.name}
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono truncate min-w-0 flex-1">{p.path}</span>
                      {p.favorite && <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />}
                      <span className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                        {p.taskCounts && p.taskCounts.total > 0
                          ? `${p.taskCounts.total} ${t.emptyState.tasksCount}`
                          : t.emptyState.noTasks}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>

        <ProjectInitModal
          isOpen={initTarget !== null}
          onClose={() => setInitTarget(null)}
          mode={initTarget?.mode ?? 'new'}
          initialFolder={initTarget?.mode === 'folder' ? initTarget.path : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-ph-panel">
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/*
          Ключ по пути проекта (TASK-67): при смене проекта вкладка перемонтируется, поэтому
          локальное состояние вью (поиск по задачам, открытая карточка, выбранный файл диффа)
          не переносится с предыдущего проекта.
        */}
        <div key={selectedProject?.path || 'no-project'} className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'kanban' && <KanbanBoard />}
          {activeTab === 'milestones' && <MilestonesRoadmapView />}
          {activeTab === 'git' && <GitInspector />}
          {activeTab === 'files' && <FileExplorer />}
          {activeTab === 'prs' && <PullRequestView />}
          {activeTab === 'docs' && <DocsRagView />}
          {activeTab === 'analytics' && <ProjectAnalyticsView />}
          {activeTab === 'ai' && <AIStudioView />}
          {activeTab === 'claude-cli' && <ClaudeCliView />}

          {activeTab === 'processes' && <ProcessesView />}
          {activeTab === 'security' && <SecurityHealthView />}
        </div>

        {/* Пока данные нового проекта не пришли, вместо пустого экрана показываем индикатор. */}
        {isProjectDataLoading && selectedProject && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-ph-panel/85">
            <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
            <div className="text-center">
              <p className="text-xs font-medium text-slate-200">{t.tabs.loadingProject}</p>
              <p className="text-[11px] text-slate-500 font-mono mt-0.5 truncate max-w-xs">{selectedProject.name}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
