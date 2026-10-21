import React, { useEffect, useState } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { ActivityBar } from './components/layout/ActivityBar';
import { StatusBar } from './components/layout/StatusBar';
import { ProjectWorkspace } from './components/projects/ProjectWorkspace';
import { TerminalPanel } from './components/terminal/TerminalPanel';
import { OmniSearchModal } from './components/search/OmniSearchModal';
import { HotkeysHelpModal } from './components/layout/HotkeysHelpModal';
import { AISettingsHost } from './components/ai/AISettingsHost';
import { VoiceControlWidget } from './components/voice/VoiceControlWidget';
import { DialogHost } from './components/common/DialogHost';
import { HitlCenterModal } from './components/hitl/HitlCenterModal';
import { ClaudeLoginModal } from './components/ai/ClaudeLoginModal';
import { ClaudeAccountsModal } from './components/ai/ClaudeAccountsModal';
import { ConnectionsModal } from './components/connections/ConnectionsModal';
import { ComputerControlBanner } from './components/computer/ComputerControlBanner';
import { SecretIssuesNotice } from './components/security/SecretIssuesNotice';
import { SecretRestoreModal } from './components/security/SecretRestoreModal';
import { NotificationSettingsModal } from './components/notifications/NotificationSettingsModal';
import { AutomationsModal } from './components/automations/AutomationsModal';
import { EditionOverlays } from './extensions/editionUi';
import { useAutomationsStore } from './store/useAutomationsStore';
import { RemoteHostsModal } from './components/federation/RemoteHostsModal';
import { useProjectStore } from './store/useProjectStore';
import { useAIStudioStore } from './store/useAIStudioStore';
import { handleStudioRemoteRequest } from './store/studioRemoteHandler';
import { useHitlStore } from './store/useHitlStore';
import { useNotificationStore } from './store/useNotificationStore';
import { useFederationStore } from './store/useFederationStore';
import { useTranslation } from './i18n/useTranslation';
import { useToast } from './hooks/useTimeoutState';
import { Bot, ShieldAlert, X } from './components/common/icons';


/** Фокус в элементе, где пользователь вводит текст: input/textarea/contentEditable или терминал xterm. */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target.isContentEditable) return true;
  return !!target.closest('.xterm, [contenteditable="true"]');
};

export const App: React.FC = () => {
  const { t } = useTranslation();
  const {
    projects,
    fetchProjects,
    selectedProject,
    selectProject,
    activeTab,
    setActiveTab,
    toggleTerminal,
    isSidebarOpen,
    toggleSidebar,
    isHotkeysHelpOpen,
    setHotkeysHelpOpen,
    loadProjectData,
    refreshSingleProject
  } = useProjectStore();

  const [isOmniSearchOpen, setIsOmniSearchOpen] = useState(false);
  // Автоскрытие тоста через хук: таймер снимается при размонтировании (TASK-50)
  const [remoteActionToast, showRemoteToast] = useToast<string>(4000);
  const fallbackNotice = useHitlStore((s) => s.fallbackNotice);
  const dismissFallbackNotice = useHitlStore((s) => s.dismissFallbackNotice);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Единый HITL-контур: подписка на шину событий main и загрузка очереди (TASK-57)
  useEffect(() => {
    useHitlStore.getState().init();
  }, []);

  // Уведомления: журнал доставок, звук и настройки каналов (TASK-63)
  useEffect(() => {
    useNotificationStore.getState().init();
  }, []);

  // Automations: правила, их состояние и журнал из main (TASK-74)
  useEffect(() => {
    useAutomationsStore.getState().init();
  }, []);

  // Федерация: список удалённых хостов и их события в hub-режиме (TASK-66)
  useEffect(() => {
    useFederationStore.getState().init();
  }, []);

  /**
   * Переход по клику на уведомлении ОС или пункте меню трея (TASK-63, decision-13 п.1).
   * Окно уже показано и сфокусировано в main — здесь только выбор проекта и вкладки.
   */
  useEffect(() => {
    if (!window.api?.onNotificationNavigate) return;
    return window.api.onNotificationNavigate((action) => {
      if (!action) return;
      const focusProject = (projectPath?: string) => {
        if (!projectPath) return;
        const match = projects.find((p) => p.path === projectPath);
        if (match) selectProject(match);
      };
      switch (action.type) {
        case 'openHitl':
          useHitlStore.getState().openCenter('queue');
          break;
        case 'openSwarm':
          focusProject(action.projectPath);
          setActiveTab('ai');
          break;
        case 'openProcesses':
          focusProject(action.projectPath);
          setActiveTab('processes');
          break;
        case 'openPrs':
          focusProject(action.projectPath);
          setActiveTab('prs');
          break;
        case 'openAutomations':
          useAutomationsStore.getState().open(action.projectPath);
          break;
        case 'openSecurity':
          focusProject(action.projectPath);
          setActiveTab('security');
          break;
        // Задачи агента ждут подтверждения (decision-89): одна — открыть её карточку, пачка — доску.
        case 'openTask':
          focusProject(action.projectPath);
          if (action.taskId) useProjectStore.getState().requestOpenTask(action.taskId);
          else setActiveTab('kanban');
          break;
        case 'openRemote':
        case 'openApp':
        default:
          break;
      }
    });
  }, [projects, selectProject, setActiveTab]);

  // Sync state with built-in MCP server
  useEffect(() => {
    if (window.api?.setMcpAppState) {
      window.api.setMcpAppState({
        activeProject: selectedProject ? { name: selectedProject.name, path: selectedProject.path } : null,
        activeTab
      });
    }
  }, [selectedProject, activeTab]);

  // Agents Studio с телефона (TASK-140.10, decision-83): промпт и остановка идут через стор, как с вкладки на ПК.
  useEffect(() => {
    if (!window.api?.onStudioRemoteRequest) return;
    return window.api.onStudioRemoteRequest((req) => {
      void handleStudioRemoteRequest(req, {
        getState: () => useAIStudioStore.getState(),
        listFromDisk: (projectPath) => window.api.listAISessions(projectPath)
      })
        .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .then((reply) => window.api.replyStudioRemote(req.requestId, reply));
    });
  }, []);

  // Handle remote actions from external MCP clients (Claude Code, Cursor, Antigravity)
  useEffect(() => {
    if (!window.api?.onRemoteAction) return;

    const unsub = window.api.onRemoteAction((action) => {
      console.log('[App] Remote MCP Action received:', action);

      if (action.type === 'switch_project') {
        const query = (action.payload?.query || '').toLowerCase().trim();
        if (query && projects.length > 0) {
          const matched = projects.find((p) => {
            const pName = p.name.toLowerCase();
            const pPath = p.path.toLowerCase();
            return pName === query || pPath === query || pName.includes(query) || pPath.includes(query);
          });
          if (matched) {
            selectProject(matched);
            showRemoteToast(t.app.remoteSwitchedProject.replace('{name}', matched.name));
          }
        }
      } else if (action.type === 'switch_tab') {
        const tab = action.payload?.tab;
        if (tab) {
          setActiveTab(tab);
          showRemoteToast(t.app.remoteSwitchedTab.replace('{tab}', tab));
        }
      } else if (action.type === 'send_studio_prompt') {
        const { prompt, sendImmediately } = action.payload || {};
        if (prompt && selectedProject) {
          setActiveTab('ai');
          showRemoteToast(t.app.remoteStudioPrompt);
          if (sendImmediately) {
            useAIStudioStore.getState().sendMessage(selectedProject.path, prompt);
          }
        }
      } else if (action.type === 'approve_action') {
        // Решение уже применено в main строго по requestId (hitlService.decide, TASK-57);
        // здесь только уведомление. Одобрение «верхнего в очереди» не поддерживается.
        const { requestId, approved, applied, reason } = action.payload || {};
        if (applied) {
          showRemoteToast((approved ? t.hitl.remoteApplied : t.hitl.remoteRejected).replace('{id}', String(requestId || '')));
        } else {
          showRemoteToast(t.hitl.remoteFailed.replace('{reason}', String(reason || requestId || '')));
        }
      }
    });

    return unsub;
  }, [projects, selectedProject, selectProject, setActiveTab]);

  // Event listener for opening omni-search via voice or external triggers
  useEffect(() => {
    const handleOpenSearch = () => setIsOmniSearchOpen(true);
    window.addEventListener('projecthub:open-search', handleOpenSearch);
    return () => window.removeEventListener('projecthub:open-search', handleOpenSearch);
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Фокус в поле ввода / редакторе / xterm: навигационные хоткеи не должны
      // перехватывать Ctrl+A/B/D/E/... (выделение, удаление слова, конец строки и т.п.).
      const isInput = isEditableTarget(e.target);

      // 1. Help modal with '?' or F1 (when not typing in an input)
      if (!isInput && (e.key === '?' || e.key === 'F1')) {
        e.preventDefault();
        setHotkeysHelpOpen(true);
        return;
      }

      // 2. Escape: close modals (глобально)
      if (e.key === 'Escape') {
        if (isHotkeysHelpOpen) {
          setHotkeysHelpOpen(false);
          return;
        }
        if (isOmniSearchOpen) {
          setIsOmniSearchOpen(false);
          return;
        }
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();

      // 3. Глобальные Ctrl-хоткеи — работают и при фокусе в полях ввода
      // Ctrl + K: Search
      if (key === 'k') {
        e.preventDefault();
        setIsOmniSearchOpen((prev) => !prev);
        return;
      }
      // Ctrl + \ or Ctrl + `: Toggle Terminal
      if (key === '\\' || key === '`') {
        e.preventDefault();
        toggleTerminal();
        return;
      }

      // 4. Навигационные Ctrl-хоткеи — только вне полей ввода
      if (isInput) return;

      // Navigation: Ctrl + B, Ctrl + M, Ctrl + G, Ctrl + E, Ctrl + P, Ctrl + D, Ctrl + A, Ctrl + I, Ctrl + T
      if (key === 'b' && !e.shiftKey) {
        e.preventDefault();
        setActiveTab('kanban');
      } else if (key === 'm') {
        e.preventDefault();
        setActiveTab('milestones');
      } else if (key === 'g') {
        e.preventDefault();
        setActiveTab('git');
      } else if (key === 'e') {
        e.preventDefault();
        setActiveTab('files');
      } else if (key === 'p' && !e.shiftKey) {
        e.preventDefault();
        setActiveTab('prs');
      } else if (key === 'd') {
        e.preventDefault();
        setActiveTab('docs');
      } else if (key === 'a') {
        e.preventDefault();
        setActiveTab('analytics');
      } else if (key === 'i') {
        e.preventDefault();
        setActiveTab('ai');
      } else if (key === 't' && !e.shiftKey) {
        e.preventDefault();
        setActiveTab('claude-cli');
      }
      // Ctrl + R: Refresh project
      else if (key === 'r') {
        if (selectedProject) {
          e.preventDefault();
          loadProjectData(selectedProject);
          refreshSingleProject(selectedProject.path);
        }
      }
      // Ctrl + [ or Ctrl + Shift + B: Toggle Project Sidebar Menu (в xterm Ctrl+[ — это Esc)
      else if (key === '[' || (key === 'b' && e.shiftKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isHotkeysHelpOpen,
    isOmniSearchOpen,
    selectedProject,
    setActiveTab,
    toggleTerminal,
    toggleSidebar,
    setHotkeysHelpOpen,
    loadProjectData,
    refreshSingleProject
  ]);

  return (
    <div className="flex flex-col h-screen w-screen bg-ph-panel text-slate-100 overflow-hidden font-sans">
      {/*
        Раскладка как в IDE (decision-73): Activity Bar → сайдбар проектов → рабочая область
        (шапка с вкладками открытых проектов, вид вкладки, нижняя панель терминала) → строка состояния.
      */}
      <div className="flex-1 flex min-h-0">
        <ActivityBar />

        {isSidebarOpen && <Sidebar />}

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Header />
          <div className="flex-1 flex flex-col overflow-hidden relative">
            <ProjectWorkspace />
          </div>
          <TerminalPanel />
        </div>
      </div>

      <StatusBar />

      {/* Global Omni-search Modal (Ctrl + K) */}
      <OmniSearchModal
        isOpen={isOmniSearchOpen}
        onClose={() => setIsOmniSearchOpen(false)}
      />

      {/* Hotkeys Help Modal (?) */}
      <HotkeysHelpModal
        isOpen={isHotkeysHelpOpen}
        onClose={() => setHotkeysHelpOpen(false)}
      />

      {/* Настройки AI по событию из любого места: панель плана, ошибки выбора модели (decision-75) */}
      <AISettingsHost />

      {/* Global Voice Control Widget (STT/TTS) */}
      <VoiceControlWidget />

      {/* Remote MCP Action Toast Notification */}
      {remoteActionToast && (
        <div className="fixed top-14 right-4 z-50 flex items-center gap-2.5 px-3.5 py-2 rounded-lg bg-ph-elevated border border-slate-700 shadow-xl text-xs text-slate-100 animate-in slide-in-from-top-3 duration-200">
          <Bot className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="font-medium">{remoteActionToast}</span>
        </div>
      )}

      {/* Предупреждение о запуске агента без проверки разрешений (fallback HITL, TASK-57) */}
      {fallbackNotice && (
        <div className="fixed bottom-9 right-4 z-[10000] max-w-md flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-ph-elevated border border-rose-500/50 shadow-xl text-xs text-rose-100">
          <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span className="flex-1">{t.hitl.fallbackNotice.replace('{reason}', fallbackNotice)}</span>
          <button type="button" onClick={dismissFallbackNotice} className="p-0.5 rounded hover:bg-rose-900/60 text-rose-300">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Центр решений HITL: очередь всех сессий и история (TASK-57) */}
      <HitlCenterModal />
      <ComputerControlBanner />
      <SecretIssuesNotice />
      <SecretRestoreModal />

      {/* Настройки уведомлений: каналы, тихие часы, Telegram-бот (TASK-63) */}
      <NotificationSettingsModal />

      {/* Automations: правила, подтверждение проектных, журнал запусков (TASK-74) */}
      <AutomationsModal />

      {/* Удалённые хосты федерации, hub-режим (TASK-66) */}
      <RemoteHostsModal />

      {/* Аккаунты Claude Code и вход во встроенном терминале (TASK-152) */}
      <ClaudeAccountsModal />
      <ConnectionsModal />
      <ClaudeLoginModal />

      {/* Модалки модулей платной редакции (decision-123 п. 4) */}
      <EditionOverlays />

      {/* Global Promise-based Modals (ConfirmDialog, PromptDialog, AlertDialog) */}
      <DialogHost />
    </div>
  );
};
