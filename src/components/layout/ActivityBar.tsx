import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Kanban,
  Target,
  GitBranch,
  FolderTree,
  GitPullRequest,
  BookOpen,
  Cpu,
  ShieldCheck,
  Sparkles,
  BarChart2,
  Bot,
  SlidersHorizontal,
  Eye,
  EyeOff,
  MoreHorizontal,
  HelpCircle,
  FolderKanban,
  KeyRound,
  Unplug,
  Network,
  ShareNetwork
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useSecretRestoreStore } from '../../store/useSecretRestoreStore';
import { useConnectionsStore } from '../../store/useConnectionsStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useWorkspaceTabs, type WorkspaceTabId } from '../../hooks/useWorkspaceTabs';
import { WorkspaceTabsConfigModal } from '../projects/WorkspaceTabsConfigModal';
import { VoiceBadge } from '../voice/VoiceBadge';
import { withGroupSeparators } from '../../lib/activityBarGroups';

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  tabId: WorkspaceTabId | null;
}

type TabDef = { label: string; hotkey?: string; icon: React.ComponentType<{ className?: string }> };

/**
 * Activity Bar (decision-73): вертикальная полоса слева, как в VS Code и JetBrains.
 * Сверху — список проектов (сайдбар), ниже — вкладки рабочей области проекта.
 * Поведение прежней горизонтальной полосы вкладок сохранено целиком: порядок перетаскиванием,
 * скрытие через контекстное меню, меню скрытых вкладок, окно настройки, горячие клавиши в подсказке
 * и голосовые подсказки.
 */
export const ActivityBar: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProject,
    activeTab,
    setActiveTab,
    isSidebarOpen,
    toggleSidebar,
    setHotkeysHelpOpen
  } = useProjectStore();

  const {
    tabsConfig,
    visibleTabs,
    hiddenTabs,
    toggleTabVisibility,
    reorderTabs,
    moveTab,
    resetToDefault,
    showAllTabs
  } = useWorkspaceTabs();

  const restorableSecrets = useSecretRestoreStore((s) => s.restorableCount);
  const openSecretRestore = useSecretRestoreStore((s) => s.open);
  const openConnections = useConnectionsStore((s) => s.open);

  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [hiddenMenuAnchor, setHiddenMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<WorkspaceTabId | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<WorkspaceTabId | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0, tabId: null });
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // Если активная вкладка оказалась скрыта, выбираем первую видимую.
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((vt) => vt.id === activeTab)) {
      setActiveTab(visibleTabs[0].id as any);
    }
  }, [visibleTabs, activeTab, setActiveTab]);

  // Клик вне меню закрывает контекстное меню и меню скрытых вкладок.
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (moreButtonRef.current && moreButtonRef.current.contains(e.target as Node)) return;
      setHiddenMenuAnchor(null);
      setContextMenu((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  const tabDefs: Record<WorkspaceTabId, TabDef> = {
    kanban: { label: t.tabs.tasks, hotkey: 'Ctrl+B', icon: Kanban },
    milestones: { label: t.tabs.milestones, hotkey: 'Ctrl+M', icon: Target },
    git: { label: t.tabs.git, hotkey: 'Ctrl+G', icon: GitBranch },
    files: { label: t.tabs.files, hotkey: 'Ctrl+E', icon: FolderTree },
    prs: { label: t.tabs.prs, hotkey: 'Ctrl+P', icon: GitPullRequest },
    'code-graph': { label: t.tabs.codeGraph, icon: Network },
    docs: { label: t.tabs.docs, hotkey: 'Ctrl+D', icon: BookOpen },
    'docs-graph': { label: t.tabs.docsGraph, icon: ShareNetwork },
    analytics: { label: t.tabs.analytics, hotkey: 'Ctrl+A', icon: BarChart2 },
    ai: { label: t.tabs.ai, hotkey: 'Ctrl+I', icon: Sparkles },
    'claude-cli': { label: t.tabs.claudeCli, hotkey: 'Ctrl+T', icon: Bot },
    processes: { label: t.tabs.processes, icon: Cpu },
    security: { label: t.tabs.security, icon: ShieldCheck }
  };

  const voiceCommandMap: Record<WorkspaceTabId, string> = {
    kanban: t.voice.voiceBadges.tasks,
    milestones: t.voice.voiceBadges.milestones,
    git: t.voice.voiceBadges.git,
    files: t.voice.voiceBadges.files,
    prs: t.voice.voiceBadges.prs,
    'code-graph': t.voice.voiceBadges.codeGraph,
    docs: t.voice.voiceBadges.docs,
    'docs-graph': t.voice.voiceBadges.docsGraph,
    analytics: t.voice.voiceBadges.analytics,
    ai: t.voice.voiceBadges.studio,
    'claude-cli': t.voice.voiceBadges.claudeCli,
    processes: t.voice.voiceBadges.processes,
    security: t.voice.voiceBadges.security
  };

  const handleDragStart = (e: React.DragEvent, id: WorkspaceTabId) => {
    setDraggedTabId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (e: React.DragEvent, id: WorkspaceTabId) => {
    e.preventDefault();
    if (draggedTabId && draggedTabId !== id) setDragOverTabId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: WorkspaceTabId) => {
    e.preventDefault();
    if (draggedTabId && draggedTabId !== targetId) {
      const fromIndex = tabsConfig.findIndex((tc) => tc.id === draggedTabId);
      const toIndex = tabsConfig.findIndex((tc) => tc.id === targetId);
      if (fromIndex !== -1 && toIndex !== -1) reorderTabs(fromIndex, toIndex);
    }
    setDraggedTabId(null);
    setDragOverTabId(null);
  };

  const openHiddenMenu = () => {
    if (hiddenMenuAnchor) {
      setHiddenMenuAnchor(null);
      return;
    }
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) setHiddenMenuAnchor({ top: rect.top, left: rect.right + 4 });
  };

  const itemClass = (isActive: boolean) =>
    `relative w-12 h-10 flex items-center justify-center transition-colors ${
      isActive ? 'text-slate-50' : 'text-slate-500 hover:text-slate-200'
    }`;

  const activeIndicator = <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-indigo-400" />;

  return (
    <nav
      className="w-12 h-full flex flex-col items-center bg-ph-chrome border-r border-ph-line shrink-0 select-none"
      aria-label={t.tabs.customizeTabs}
    >
      {/* Список проектов: показывает и прячет сайдбар (Ctrl+[) */}
      <button
        type="button"
        onClick={toggleSidebar}
        className={itemClass(isSidebarOpen)}
        title={`${isSidebarOpen ? t.sidebar.hideSidebar : t.sidebar.showSidebar} (Ctrl+[)`}
        aria-label={t.sidebar.title}
        aria-pressed={isSidebarOpen}
      >
        {isSidebarOpen && activeIndicator}
        <FolderKanban className="w-5 h-5" />
        <VoiceBadge
          command={isSidebarOpen ? t.sidebar.hideMenuCommand : t.sidebar.showMenuCommand}
          position="right"
        />
      </button>

      {selectedProject && (
        <>
          <div className="w-6 h-px bg-ph-line my-1" />

          {withGroupSeparators(visibleTabs.map((vt) => vt.id)).map(({ id, separatorBefore }) => {
            const tabItem = { id };
            const def = tabDefs[tabItem.id];
            if (!def) return null;
            const Icon = def.icon;
            const isActive = activeTab === tabItem.id;
            const isDragOver = dragOverTabId === tabItem.id;
            return (
              <React.Fragment key={tabItem.id}>
              {separatorBefore && <div className="w-5 h-px bg-ph-line my-1" />}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={def.label}
                draggable
                onDragStart={(e) => handleDragStart(e, tabItem.id)}
                onDragOver={(e) => handleDragOver(e, tabItem.id)}
                onDragLeave={() => {
                  if (dragOverTabId === tabItem.id) setDragOverTabId(null);
                }}
                onDrop={(e) => handleDrop(e, tabItem.id)}
                onDragEnd={() => {
                  setDraggedTabId(null);
                  setDragOverTabId(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, tabId: tabItem.id });
                }}
                onClick={() => setActiveTab(tabItem.id as any)}
                title={`${def.label}${def.hotkey ? ` (${def.hotkey})` : ''} · ${t.tabs.dragHint}`}
                className={`${itemClass(isActive)} ${isDragOver ? 'border-t-2 border-indigo-400' : ''}`}
              >
                {isActive && activeIndicator}
                <Icon className="w-5 h-5" />
                {voiceCommandMap[tabItem.id] && (
                  <VoiceBadge command={voiceCommandMap[tabItem.id]} position="right" />
                )}
              </button>
              </React.Fragment>
            );
          })}

          {/* Скрытые вкладки */}
          {hiddenTabs.length > 0 && (
            <button
              ref={moreButtonRef}
              type="button"
              onClick={openHiddenMenu}
              className={itemClass(false)}
              title={`${t.tabs.hiddenTabsHeader} (${hiddenTabs.length})`}
              aria-label={t.tabs.more}
              aria-haspopup="menu"
              aria-expanded={!!hiddenMenuAnchor}
            >
              <MoreHorizontal className="w-5 h-5" />
              <span className="absolute bottom-1.5 right-2 min-w-[14px] h-[14px] px-0.5 rounded-full bg-slate-700 text-[10px] font-semibold text-slate-200 flex items-center justify-center">
                {hiddenTabs.length}
              </span>
            </button>
          )}
        </>
      )}

      <div className="flex-1" />

      {/* Вернуть секреты из резервной копии (TASK-154): видно, пока в копии есть что восстановить. */}
      {restorableSecrets > 0 && (
        <button
          type="button"
          onClick={openSecretRestore}
          className={itemClass(false)}
          title={t.secretIssues.restoreTitle}
          aria-label={t.secretIssues.restoreTitle}
        >
          <KeyRound className="w-[18px] h-[18px] text-amber-400" />
          <span className="absolute bottom-1.5 right-2 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-600 text-[10px] font-semibold text-white flex items-center justify-center">
            {restorableSecrets}
          </span>
        </button>
      )}

      {/* Подключения к внешним сервисам (TASK-138.1, decision-102): уровень пользователя, не проекта. */}
      <button
        type="button"
        onClick={openConnections}
        className={itemClass(false)}
        title={t.connections.open}
        aria-label={t.connections.open}
        data-testid="activity-connections"
      >
        <Unplug className="w-[18px] h-[18px]" />
      </button>

      {selectedProject && (
        <button
          type="button"
          onClick={() => setIsConfigModalOpen(true)}
          className={itemClass(false)}
          title={t.tabs.modalDesc}
          aria-label={t.tabs.customize}
        >
          <SlidersHorizontal className="w-[18px] h-[18px]" />
        </button>
      )}

      <button
        type="button"
        onClick={() => setHotkeysHelpOpen(true)}
        className={`${itemClass(false)} mb-1`}
        title={`${t.header.hotkeysHelp} (?)`}
        aria-label={t.header.hotkeysHelp}
      >
        <HelpCircle className="w-[18px] h-[18px]" />
        <VoiceBadge command={t.voice.voiceBadges.help} position="right" />
      </button>

      {/* Меню скрытых вкладок: справа от кнопки «⋯» (createPortal, decision-17) */}
      {hiddenMenuAnchor &&
        createPortal(
          <div
            role="menu"
            style={{ top: hiddenMenuAnchor.top, left: hiddenMenuAnchor.left }}
            className="fixed z-[10000] w-56 bg-ph-elevated border border-slate-700 rounded-lg shadow-xl py-1 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pt-1 pb-1.5 ph-section-title">{t.tabs.hiddenTabsHeader}</div>
            {hiddenTabs.map((hTab) => {
              const def = tabDefs[hTab.id];
              if (!def) return null;
              const Icon = def.icon;
              return (
                <div key={hTab.id} className="flex items-center justify-between px-1 group">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActiveTab(hTab.id as any);
                      setHiddenMenuAnchor(null);
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-ph-hover flex-1 text-left truncate"
                  >
                    <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{def.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleTabVisibility(hTab.id)}
                    title={t.tabs.restoreTab}
                    className="ph-icon-button"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
            <div className="h-px bg-ph-line my-1" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setHiddenMenuAnchor(null);
                setIsConfigModalOpen(true);
              }}
              className="w-[calc(100%-0.5rem)] mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-ph-hover"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
              <span>{t.tabs.customizeAll}</span>
            </button>
          </div>,
          document.body
        )}

      {/* Контекстное меню вкладки (createPortal, decision-17) */}
      {contextMenu.isOpen &&
        contextMenu.tabId &&
        createPortal(
          <div
            role="menu"
            style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
            className="fixed z-[10000] w-48 bg-ph-elevated border border-slate-700 rounded-lg shadow-xl py-1 text-xs text-slate-200 select-none"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (contextMenu.tabId) toggleTabVisibility(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, isOpen: false }));
              }}
              disabled={visibleTabs.length <= 1}
              className="w-[calc(100%-0.5rem)] mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:bg-ph-hover hover:text-white disabled:opacity-40 text-left"
            >
              <EyeOff className="w-3.5 h-3.5 text-slate-400" />
              <span>{t.tabs.hideTab}</span>
            </button>
            <div className="h-px bg-ph-line my-1" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu((prev) => ({ ...prev, isOpen: false }));
                setIsConfigModalOpen(true);
              }}
              className="w-[calc(100%-0.5rem)] mx-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:bg-ph-hover hover:text-white text-left"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
              <span>{t.tabs.customizeTabs}</span>
            </button>
          </div>,
          document.body
        )}

      <WorkspaceTabsConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
        tabsConfig={tabsConfig}
        onToggleVisibility={toggleTabVisibility}
        onReorder={reorderTabs}
        onMoveTab={moveTab}
        onReset={resetToDefault}
        onShowAll={showAllTabs}
      />
    </nav>
  );
};
