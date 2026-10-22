import React, { useState } from 'react';
import {
  FolderGit2,
  RefreshCw,
  Search,
  Layers,
  FolderPlus,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  Star,
  FolderSearch,
  Trash2,
  BookOpen,
  Activity,
  Zap,
  Power,
  Mic,
  Server,
  Bot,
  ShieldAlert,
  Loader2,
  Wand2,
  Package
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { useHitlStore } from '../../store/useHitlStore';
import { useFederationStore } from '../../store/useFederationStore';
import { useTranslation } from '../../i18n/useTranslation';
import { describeAgentStatus } from '../../lib/agentStatusText';
import { useDialog } from '../../hooks/useDialog';
import { useVoiceState } from '../../hooks/useVoiceState';
import { ScanSettingsModal } from '../projects/ScanSettingsModal';
import { ProjectInitModal, type ProjectInitMode } from '../projects/ProjectInitModal';
import { TemplatesModal } from '../projects/TemplatesModal';
import { VoiceBadge } from '../voice/VoiceBadge';
import { ComputersSection } from '../fleet/ComputersSection';

/**
 * Сайдбар каталога проектов (decision-73), по образцу Explorer в VS Code:
 * заголовок секции с панелью действий, поиск и фильтры, плотный список проектов.
 * Строка проекта: имя и быстрые действия (по наведению), ниже — git и счётчики,
 * при работе агента — его статус. Путь проекта — в подсказке строки.
 */
export const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const dialog = useDialog();
  const { isListening } = useVoiceState();
  const {
    projects,
    selectedProject,
    selectProject,
    fetchProjects,
    isLoading,
    isScanning,
    searchQuery,
    setSearchQuery,
    filterOnlyFavorites,
    setFilterOnlyFavorites,
    activeProjectPaths,
    filterOnlyActive,
    setFilterOnlyActive,
    toggleProjectActive,
    addProjectByPath,
    removeProjectFromCatalog,
    toggleFavoriteProject,
    refreshSingleProject,
    setProjectVoiceAlias,
    projectAgentStatuses,
    worktreeCountByProject
  } = useProjectStore();
  const swarms = useSwarmStore((s) => s.swarms);
  const hitlPendingCount = useHitlStore((s) => s.pending.length);
  const openHitlCenter = useHitlStore((s) => s.openCenter);
  const openRemoteHosts = useFederationStore((s) => s.open);
  const connectedPeersCount = useFederationStore((s) => s.peers.filter((p) => p.status === 'connected').length);

  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  // Окно инициализации (decision-78): мастер нового проекта, папка без основы или проект из каталога.
  const [initTarget, setInitTarget] = useState<{ mode: ProjectInitMode; path?: string } | null>(null);
  const missingLabel = (parts: string[]) =>
    parts
      .map((part) => ({ git: t.init.partGit, tasks: t.init.partTasks, docs: t.init.partDocs, rules: t.init.partRules })[part as 'git'] ?? part)
      .join(', ');

  const handleEditVoiceAlias = async (e: React.MouseEvent, project: any) => {
    e.stopPropagation();
    const newAlias = await dialog.prompt({
      message: t.sidebar.promptVoiceAlias,
      defaultValue: project.voiceAlias || '',
      title: t.sidebar.voiceAlias
    });
    if (newAlias !== null) {
      await setProjectVoiceAlias(project.path, newAlias);
    }
  };

  // Папка без признаков проекта не добавляется в каталог — для неё открывается инициализация основы.
  const handleAddFolder = async () => {
    if (window.api) {
      const folder = await window.api.initSelectFolder();
      if (!folder) return;
      const added = await addProjectByPath(folder);
      if (!added) setInitTarget({ mode: 'folder', path: folder });
    }
  };

  const filteredProjects = projects.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.path.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    if (filterOnlyFavorites && !p.favorite) return false;
    if (filterOnlyActive && !activeProjectPaths.includes(p.path)) return false;
    return true;
  });

  const rowAction = 'p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-ph-hover transition';
  const filterChip = (active: boolean) =>
    `flex items-center gap-1 h-6 px-2 rounded-md text-[11px] transition ${
      active ? 'bg-ph-hover text-slate-100' : 'text-slate-400 hover:text-slate-200 hover:bg-ph-hover'
    }`;

  return (
    <>
      <aside className="w-72 h-full flex flex-col bg-ph-chrome border-r border-ph-line shrink-0 select-none">
        {/* Заголовок секции с панелью действий */}
        <div className="h-9 pl-4 pr-2 flex items-center justify-between shrink-0">
          <h1 className="ph-section-title truncate">{t.sidebar.title}</h1>
          <div className="flex items-center">
            <button onClick={() => openRemoteHosts()} title={t.federation.title} className="ph-icon-button relative">
              <Server className="w-4 h-4" />
              {connectedPeersCount > 0 && (
                <span className="absolute top-0 right-0 min-w-[12px] h-3 px-0.5 rounded-full bg-emerald-600 text-[8px] font-semibold text-white flex items-center justify-center">
                  {connectedPeersCount}
                </span>
              )}
            </button>
            <button onClick={() => setIsScanModalOpen(true)} title={t.sidebar.scanRootsConfig} className="ph-icon-button">
              <FolderSearch className="w-4 h-4" />
            </button>
            <button
              onClick={() => fetchProjects()}
              title={t.common.refresh}
              disabled={isLoading || isScanning}
              className="ph-icon-button"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading || isScanning ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Поиск и фильтры */}
        <div className="px-3 pb-2 space-y-1.5 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.sidebar.searchProjects}
              className="w-full h-7 bg-ph-raised border border-transparent rounded-md pl-7 pr-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setFilterOnlyFavorites(!filterOnlyFavorites)}
                className={filterChip(filterOnlyFavorites)}
                title={filterOnlyFavorites ? t.common.all : t.sidebar.favoritesOnly}
                aria-pressed={filterOnlyFavorites}
              >
                <Star className={`w-3 h-3 ${filterOnlyFavorites ? 'fill-amber-400 text-amber-400' : ''}`} />
                <span>{filterOnlyFavorites ? t.sidebar.favoritesOnly : t.common.all}</span>
              </button>
              <button
                onClick={() => setFilterOnlyActive(!filterOnlyActive)}
                className={filterChip(filterOnlyActive)}
                title={filterOnlyActive ? t.common.all : t.sidebar.activeOnly}
                aria-pressed={filterOnlyActive}
              >
                <Zap className={`w-3 h-3 ${filterOnlyActive ? 'text-emerald-400' : ''}`} />
                <span>{t.sidebar.activeOnly}</span>
                {activeProjectPaths.length > 0 && <span className="text-slate-500">{activeProjectPaths.length}</span>}
              </button>
            </div>
            <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
              {filteredProjects.length}/{projects.length}
            </span>
          </div>
        </div>

        {/* Подсказка голосовых команд — только пока голос слушает, как и остальные голосовые подсказки */}
        {isListening && (
          <div
            className="mx-3 mb-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-ph-raised text-[11px] text-slate-400"
            title={t.sidebar.voiceHintDetails}
          >
            <Mic className="w-3 h-3 text-indigo-400 shrink-0" />
            <span className="truncate flex-1">{t.sidebar.voiceHint}</span>
            <kbd className="text-[11px] font-mono text-slate-500 shrink-0" title={t.sidebar.toggleMenu}>Ctrl+[</kbd>
          </div>
        )}

        {/* Ожидающие решения HITL */}
        {hitlPendingCount > 0 && (
          <button
            type="button"
            onClick={() => openHitlCenter('queue')}
            className="mx-3 mb-2 flex items-center gap-2 h-7 px-2 rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-xs text-amber-200 transition"
            title={t.hitl.badgeTooltip}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="truncate">{t.hitl.sidebarPending.replace('{count}', String(hitlPendingCount))}</span>
          </button>
        )}

        {/* Компьютеры → проекты → сессии (TASK-174, decision-129) */}
        <ComputersSection />

        {/* Список проектов */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredProjects.length === 0 && !isLoading && (
            <div className="p-6 text-center text-xs text-slate-500 space-y-2">
              <p>{t.sidebar.noProjectsFound}</p>
              <button onClick={() => setIsScanModalOpen(true)} className="text-indigo-400 hover:text-indigo-300 underline text-xs">
                {t.sidebar.scanRootsConfig}
              </button>
            </div>
          )}

          {filteredProjects.map((project, index) => {
            const isSelected = selectedProject?.path === project.path;
            const isSessionActive = activeProjectPaths.includes(project.path);
            const todoCount = project.taskCounts?.todo || 0;
            const inProgressCount = project.taskCounts?.inProgress || 0;
            const reviewCount = project.taskCounts?.review || 0;
            // Задачи со статусом вне четырёх стандартных (TASK-68): их набор задаёт
            // backlog/config.yml проекта, в строке они показаны одним агрегатом.
            const otherCount = project.taskCounts?.other || 0;
            const activeProcs = project.processStatus?.runningCount || 0;
            const hasRagReady = project.ragStatus?.ready;
            const agentStatus = projectAgentStatuses[project.path];
            // Параллельность проекта (TASK-62): рабочие деревья и занятые ими агенты.
            const worktreeCount = worktreeCountByProject[project.path] || 0;
            const activeAgents = (swarms[project.path] || []).reduce(
              (sum, session) =>
                sum + session.agents.filter((a) => a.status === 'running' || a.status === 'preparing').length,
              0
            );
            const agentsBusy = activeAgents + (agentStatus && agentStatus.status !== 'idle' && agentStatus.status !== 'done' ? 1 : 0);

            return (
              <div
                key={project.path}
                role="button"
                tabIndex={0}
                aria-current={isSelected}
                onClick={() => selectProject(project)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') selectProject(project);
                }}
                title={project.path}
                className={`group relative mx-1.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
                  isSelected ? 'bg-indigo-500/15' : 'hover:bg-ph-hover/70'
                }`}
              >
                {/* Строка 1: номер, имя, голосовой алиас, действия */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`w-4 text-right text-[11px] font-mono tabular-nums shrink-0 ${isSelected ? 'text-indigo-300' : 'text-slate-600'}`}
                    title={t.sidebar.voiceProjectCmd.replace('{number}', String(index + 1))}
                  >
                    {index + 1}
                  </span>
                  <span className="relative shrink-0">
                    <FolderGit2 className={`w-4 h-4 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
                    {isSessionActive && (
                      <span
                        className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 ring-2 ring-ph-chrome"
                        title={t.sidebar.projectActive}
                      />
                    )}
                  </span>
                  <span className={`text-[13px] truncate ${isSelected ? 'text-white font-medium' : 'text-slate-200'}`}>
                    {project.name}
                  </span>
                  {project.voiceAlias ? (
                    <span
                      className="text-[11px] text-slate-500 truncate shrink-0 max-w-[70px]"
                      title={`${t.sidebar.voiceAlias}: «${project.voiceAlias}»`}
                    >
                      «{project.voiceAlias}»
                    </span>
                  ) : (
                    <VoiceBadge
                      command={t.projectTabs.tabVoiceCommand.replace('{number}', String(index + 1))}
                      variant="indigo"
                      className="shrink-0 text-[11px]"
                    />
                  )}

                  <div className="ml-auto flex items-center shrink-0">
                    {project.foundationMissing && project.foundationMissing.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setInitTarget({ mode: 'existing', path: project.path });
                        }}
                        className={`${rowAction} text-amber-400 hover:text-amber-300`}
                        title={`${t.init.initButton} · ${t.init.initTooltip.replace('{parts}', missingLabel(project.foundationMissing))}`}
                        aria-label={t.init.initButton}
                      >
                        <Wand2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProjectActive(project);
                      }}
                      className={`${rowAction} ${
                        isSessionActive ? 'text-emerald-400 hover:text-rose-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                      }`}
                      title={isSessionActive ? t.sidebar.deactivateProject : t.sidebar.activateProject}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleEditVoiceAlias(e, project)}
                      className={`${rowAction} ${project.voiceAlias ? 'text-indigo-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                      title={project.voiceAlias ? `${t.sidebar.changeVoiceAlias}: «${project.voiceAlias}»` : t.sidebar.setVoiceAlias}
                    >
                      <Mic className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavoriteProject(project.path);
                      }}
                      className={`${rowAction} ${project.favorite ? 'text-amber-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                      title={project.favorite ? t.sidebar.inFavorites : t.sidebar.addToFavorites}
                    >
                      <Star className={`w-3.5 h-3.5 ${project.favorite ? 'fill-amber-400' : ''}`} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        refreshSingleProject(project.path);
                      }}
                      className={`${rowAction} hidden group-hover:block focus-visible:block`}
                      title={t.sidebar.refreshMetadata}
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (
                          await dialog.confirm({
                            message: t.sidebar.confirmRemoveProject.replace('{name}', project.name),
                            danger: true
                          })
                        ) {
                          removeProjectFromCatalog(project.path);
                        }
                      }}
                      className={`${rowAction} hover:text-rose-400 hidden group-hover:block focus-visible:block`}
                      title={t.sidebar.removeFromCatalog}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Строка 2: git и счётчики */}
                <div className="flex items-center gap-2 pl-[42px] mt-0.5 text-[11px] text-slate-500 min-w-0">
                  {project.hasGit && project.gitBranch ? (
                    <span className="flex items-center gap-1 font-mono truncate min-w-0">
                      <GitBranch className="w-3 h-3 shrink-0" />
                      <span className="truncate">{project.gitBranch}</span>
                      {project.uncommittedCount !== undefined && project.uncommittedCount > 0 && (
                        <span className="text-amber-400 shrink-0">+{project.uncommittedCount}</span>
                      )}
                    </span>
                  ) : (
                    <span className="italic">{t.sidebar.noGit}</span>
                  )}

                  {worktreeCount > 0 && (
                    <span
                      className="flex items-center gap-0.5 text-cyan-400 shrink-0"
                      title={t.header.worktreeCountTooltip.replace('{count}', String(worktreeCount))}
                    >
                      <FolderGit2 className="w-3 h-3" />
                      {worktreeCount}
                    </span>
                  )}
                  {agentsBusy > 0 && (
                    <span
                      className="flex items-center gap-0.5 text-indigo-300 shrink-0"
                      title={t.worktrees.agentsCount.replace('{count}', String(agentsBusy))}
                    >
                      <Bot className="w-3 h-3" />
                      {agentsBusy}
                    </span>
                  )}
                  {activeProcs > 0 && (
                    <span className="flex items-center gap-1 text-emerald-400 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      {activeProcs} proc
                    </span>
                  )}
                  {hasRagReady && (
                    <span
                      className="shrink-0"
                      title={t.sidebar.ragReadyTooltip.replace('{count}', String(project.ragStatus?.chunksCount || 0))}
                    >
                      <BookOpen className="w-3 h-3" />
                    </span>
                  )}

                  {project.taskCounts && project.taskCounts.total > 0 ? (
                    <span className="ml-auto flex items-center gap-1.5 shrink-0 tabular-nums">
                      {inProgressCount > 0 && (
                        <span className="flex items-center gap-0.5 text-amber-400" title={t.sidebar.inProgressTooltip}>
                          <Clock className="w-3 h-3" />
                          {inProgressCount}
                        </span>
                      )}
                      {todoCount > 0 && (
                        <span className="flex items-center gap-0.5" title={t.sidebar.toDoTooltip}>
                          <CheckCircle2 className="w-3 h-3" />
                          {todoCount}
                        </span>
                      )}
                      {reviewCount > 0 && (
                        <span className="flex items-center gap-0.5 text-purple-400" title={t.sidebar.reviewTooltip}>
                          <Activity className="w-3 h-3" />
                          {reviewCount}
                        </span>
                      )}
                      {otherCount > 0 && (
                        <span className="flex items-center gap-0.5 text-amber-400" title={t.sidebar.otherStatusesTooltip}>
                          <Layers className="w-3 h-3" />
                          {otherCount}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-slate-600">{t.sidebar.noTasks}</span>
                  )}
                </div>

                {/* Строка 3: статус агента Claude */}
                {agentStatus?.status === 'waiting_approval' && (
                  <div className="flex items-center gap-1.5 pl-[42px] mt-1 text-[11px] text-amber-300">
                    <ShieldAlert className="w-3 h-3 shrink-0" />
                    <span className="font-medium truncate">{t.sidebar.requiresDecisionExclamation}</span>
                    <span className="text-amber-500/80 shrink-0">HITL</span>
                  </div>
                )}
                {agentStatus?.status === 'running' && (
                  <div className="flex items-center gap-1.5 pl-[42px] mt-1 text-[11px] text-slate-400 min-w-0">
                    <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />
                    <span className="truncate">{describeAgentStatus(agentStatus, t.hitl.statusMessages, t.hitl.requestText) || t.sidebar.agentWorking}</span>
                  </div>
                )}
                {agentStatus?.status === 'done' && (
                  <div className="flex items-center gap-1.5 pl-[42px] mt-1 text-[11px] text-emerald-400">
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span className="truncate">{t.sidebar.agentFinishedTask}</span>
                  </div>
                )}
                {agentStatus?.status === 'error' && (
                  <div
                    className="flex items-center gap-1.5 pl-[42px] mt-1 text-[11px] text-red-400 min-w-0"
                    title={describeAgentStatus(agentStatus, t.hitl.statusMessages, t.hitl.requestText) || undefined}
                  >
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span className="truncate">{t.sidebar.agentFailedTask}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Добавление проектов */}
        <div className="p-2 border-t border-ph-line flex flex-col gap-1.5 shrink-0">
          <button
            onClick={handleAddFolder}
            className="flex items-center justify-center gap-1.5 h-7 px-2 rounded-md bg-ph-raised hover:bg-ph-hover text-xs text-slate-200 transition min-w-0"
            title={t.sidebar.addProject}
          >
            <FolderPlus className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="truncate">{t.sidebar.addProject}</span>
          </button>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setInitTarget({ mode: 'new' })}
              className="flex-1 flex items-center justify-center gap-1.5 h-7 px-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs text-white transition min-w-0"
              title={t.sidebar.newFromTemplate}
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{t.sidebar.newFromTemplate}</span>
            </button>
            <button
              onClick={() => setIsTemplatesOpen(true)}
              className="flex items-center justify-center h-7 w-7 rounded-md bg-ph-raised hover:bg-ph-hover text-slate-300 transition shrink-0"
              title={t.templates.title}
              aria-label={t.templates.title}
            >
              <Package className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <ScanSettingsModal isOpen={isScanModalOpen} onClose={() => setIsScanModalOpen(false)} />
      <ProjectInitModal
        isOpen={initTarget !== null}
        onClose={() => setInitTarget(null)}
        mode={initTarget?.mode ?? 'new'}
        projectPath={initTarget?.mode === 'existing' || initTarget?.mode === 'update' ? initTarget.path : undefined}
        initialFolder={initTarget?.mode === 'folder' ? initTarget.path : undefined}
      />
      <TemplatesModal
        isOpen={isTemplatesOpen}
        onClose={() => setIsTemplatesOpen(false)}
        projectPath={selectedProject?.path}
        onUpdateProject={(path) => {
          setIsTemplatesOpen(false);
          setInitTarget({ mode: 'update', path });
        }}
      />
    </>
  );
};
