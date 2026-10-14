import React, { useState, useEffect, useRef } from 'react';
import {
  BrainCircuit,
  Bot,
  User,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  GitFork,
  Settings,
  Trash2,
  ShieldCheck,
  LogOut,
  Pencil,
  ListTodo,
  Rocket,
  GitCommit,
  Zap,
  Users,
  FolderGit2,
  MessageSquare,
  Landmark
} from '../common/icons';
import { ClaudeLogo } from '../common/BrandLogo';
import { useAIStudioStore, type AISession } from '../../store/useAIStudioStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDialog } from '../../hooks/useDialog';
import { AISettingsModal } from './AISettingsModal';
import { RolesSettingsModal } from './roles/RolesSettingsModal';
import { InteractiveApprovalCard } from './InteractiveApprovalCard';
import { SubagentsPanel } from './SubagentsPanel';
import { PromptInputArea } from './PromptInputArea';
import { ContextAppliedCard } from './ContextAppliedCard';
import { ModelSelectorDropdown } from './ModelSelectorDropdown';
import { RateLimitWarningBanner } from './RateLimitWarningBanner';
import { AgentStepsAccordion } from './AgentStepsAccordion';
import { LiveActivitySidebar } from './LiveActivitySidebar';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { VoiceBadge } from '../voice/VoiceBadge';
import { SwarmArenaView } from './swarm/SwarmArenaView';
import { ProviderErrorCard } from './ProviderErrorCard';

export const AIStudioView: React.FC = () => {
  const { t, language } = useTranslation();
  const dialog = useDialog();
  const { selectedProject, tasks, gitRepoDetails, workspaceRoot } = useProjectStore();
  const {
    sessions,
    sessionsLoaded,
    activeSessionId,
    isStreaming,
    config,
    mode,
    isSettingsOpen,
    claudeAuth,
    pendingApprovals,
    subagents,
    rateLimitWarnings,
    projectStatuses,
    liveOutputs,
    isSubagentsPanelOpen,
    isActivitySidebarOpen,
    setIsSubagentsPanelOpen,
    setIsActivitySidebarOpen,
    clearLiveOutput,
    sendApprovalResponse,
    fetchSubagents,
    fetchConfig,
    fetchClaudeAuth,
    startClaudeLogin,
    claudeLogout,
    saveConfig,
    dismissRateLimitWarning,
    setMode,
    setIsSettingsOpen,
    loadSessions,
    createSession,
    switchSession,
    closeSession,
    renameSession,
    clearSession,
    setSessionTask,
    toggleContextPart,
    sendMessage,
    retryFailedMessage,
    abortStream,
    acceptDiff,
    rejectDiff
  } = useAIStudioStore();

  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [aiViewMode, setAiViewMode] = useState<'studio' | 'swarm'>('studio');
  const [isRolesModalOpen, setIsRolesModalOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const projectPath = selectedProject?.path || '';
  const projectSessions: AISession[] = sessions[projectPath] || [];
  const currentSessionId = activeSessionId[projectPath] || projectSessions[0]?.id;
  const currentSession = projectSessions.find((s) => s.id === currentSessionId) || projectSessions[0];
  const messages = currentSession?.messages || [];
  const projectApprovals = pendingApprovals[projectPath] || [];
  const projectSubagents = subagents[projectPath] || [];
  const projectRateLimitWarning = rateLimitWarnings[projectPath] || null;
  const projectAgentStatus = projectStatuses[projectPath] || null;
  const currentLiveOutput = liveOutputs[projectPath] || '';

  useEffect(() => {
    fetchConfig();
    fetchClaudeAuth();
    if (projectPath) {
      fetchSubagents(projectPath);
    }
  }, [fetchConfig, fetchClaudeAuth, fetchSubagents, projectPath]);

  // История диалогов читается с диска один раз на проект (TASK-35)
  useEffect(() => {
    if (projectPath) {
      void loadSessions(projectPath);
    }
  }, [projectPath, loadSessions]);

  // Ensure at least one session exists — но только после загрузки истории, иначе пустой
  // диалог создастся раньше, чем придут сохранённые
  const isLoaded = !!sessionsLoaded[projectPath];
  useEffect(() => {
    if (projectPath && isLoaded && projectSessions.length === 0) {
      createSession(projectPath);
    }
  }, [projectPath, isLoaded, projectSessions.length, createSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming, projectApprovals.length]);

  // NewSwarmModal живёт внутри SwarmArenaView: запуск из карточки задачи («В Swarm Arena»,
  // «До готовности», TASK-75) должен показать арену, иначе модалка открыта, но не видна.
  const isNewSwarmModalOpen = useSwarmStore((s) => s.isNewSwarmModalOpen);
  useEffect(() => {
    if (isNewSwarmModalOpen) setAiViewMode('swarm');
  }, [isNewSwarmModalOpen]);

  if (!selectedProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
        <Bot className="w-12 h-12 text-slate-700 mb-3" />
        <h3 className="text-sm font-semibold text-slate-300 mb-1">{t.header.noProjectSelected}</h3>
        <p className="text-xs text-slate-500 max-w-sm">{t.header.selectProjectHint}</p>
      </div>
    );
  }

  const toggleThought = (msgId: string) => {
    setExpandedThoughts((prev) => ({
      ...prev,
      [msgId]: !prev[msgId]
    }));
  };

  if (aiViewMode === 'swarm') {
    return (
      <div className="flex-1 flex flex-col h-full bg-ph-panel overflow-hidden">
        <div className="border-b border-slate-800/90 flex items-center justify-between px-4 py-2 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setAiViewMode('studio')}
                className="px-3 py-1 rounded text-xs font-semibold text-slate-400 hover:text-slate-200 transition"
              >
                {t.aiStudio.singleAgentStudio}
              </button>
              <button
                type="button"
                onClick={() => setAiViewMode('swarm')}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs transition"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Swarm Arena & Fleet</span>
              </button>
            </div>
          </div>
        </div>
        <SwarmArenaView />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-ph-panel overflow-hidden">
      {/* 1. Multi-Session Tabs Bar (VS Code Extension Style) */}
      <div className="bg-ph-chrome border-b border-ph-line flex items-center justify-between gap-2 px-2 h-10 shrink-0 select-none relative z-30">
        <div className="flex items-center min-w-[150px] max-w-[45%] h-full">
        <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0 h-full">
          {projectSessions.map((session, idx) => {
            const isActive = session.id === currentSessionId;
            const tabNumber = idx + 1;

            return (
              <div
                key={session.id}
                onClick={() => switchSession(projectPath, session.id)}
                className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-lg border-t-2 text-xs font-medium cursor-pointer transition whitespace-nowrap max-w-xs shrink-0 ${
                  isActive
                    ? 'bg-ph-panel border-indigo-400 text-slate-100'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-ph-hover/60'
                }`}
                title={t.aiStudio.chatVoiceTooltip.replace('{title}', session.title || t.aiStudio.newChat).replace('{num}', String(tabNumber))}
              >
                {/* Voice / Tab Order Badge */}
                <span
                  className={`text-[11px] font-mono px-1 py-0.2 rounded border transition ${
                    isActive
                      ? 'text-slate-400 border-transparent'
                      : 'text-slate-500 border-transparent'
                  }`}
                  title={t.aiStudio.chatVoiceCommandTitle.replace('{num}', String(tabNumber))}
                >
                  {tabNumber}
                </span>

                {/* Claude Anthropic Orange Spark Icon */}
                <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                  <ClaudeLogo className="w-3.5 h-3.5" />
                </div>

                <span
                  className="truncate text-xs font-sans max-w-[120px]"
                  title={session.title}
                  onDoubleClick={async (e) => {
                    e.stopPropagation();
                    const newTitle = await dialog.prompt({
                      title: t.aiStudio.renameSession,
                      message: t.aiStudio.renamePrompt,
                      defaultValue: session.title
                    });
                    if (newTitle !== null && newTitle.trim()) {
                      renameSession(projectPath, session.id, newTitle.trim());
                    }
                  }}
                >
                  {session.title || t.aiStudio.newChat}
                </span>

                <VoiceBadge
                  command={t.aiStudio.voiceChatCmd.replace('{num}', String(tabNumber))}
                  variant="amber"
                />

                {/* Rename Session Button */}
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const newTitle = await dialog.prompt({
                      title: t.aiStudio.renameSession,
                      message: t.aiStudio.renamePrompt,
                      defaultValue: session.title
                    });
                    if (newTitle !== null && newTitle.trim()) {
                      renameSession(projectPath, session.id, newTitle.trim());
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-ph-hover text-slate-400 hover:text-slate-100 transition shrink-0"
                  title={t.aiStudio.renameSession}
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>

                {/* Close Session Button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(projectPath, session.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-700/80 text-slate-400 hover:text-white transition shrink-0"
                  title={t.aiStudio.closeSession}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

        </div>

          {/* Новый чат: только «+», вынесена из прокручиваемой полосы вкладок, чтобы не обрезалась; подпись — в подсказке */}
          <button
            type="button"
            onClick={() => createSession(projectPath)}
            title={t.aiStudio.newSession}
            aria-label={t.aiStudio.newSession}
            className="relative ph-icon-button shrink-0 ml-0.5"
          >
            <Plus className="w-4 h-4" />
            <VoiceBadge command={t.voice.voiceBadges.newChat} variant="amber" />
          </button>
        </div>

        {/* Studio Controls Header Right */}
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
          {/* Studio vs Swarm Mode Switcher (TASK-54) */}
          <div className="flex items-center p-0.5 rounded-md bg-ph-raised shrink-0">
            <button
              type="button"
              onClick={() => setAiViewMode('studio')}
              className="h-6 px-2 rounded text-xs bg-ph-hover text-slate-100 transition"
            >
              {t.aiStudio.studioTab}
            </button>
            <button
              type="button"
              onClick={() => setAiViewMode('swarm')}
              className="flex items-center gap-1.5 h-6 px-2 rounded text-xs text-slate-400 hover:text-slate-100 transition"
              title={t.aiStudio.openSwarmArenaTooltip}
            >
              <Zap className="w-3 h-3" />
              <span>Swarm Arena</span>
            </button>
          </div>

          {/* Claude.ai Auth Status & Logout Button Group */}
          {claudeAuth?.isLoggedIn ? (
            <div className="flex items-center shrink-0">
              <button
                onClick={() => setIsSettingsOpen(true)}
                title={`${t.aiStudio.loggedInAs}: ${claudeAuth.email} (${claudeAuth.seatTier || 'Pro'})`}
                className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 text-slate-300 hover:bg-ph-hover hover:text-white"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <ClaudeLogo className="w-3.5 h-3.5" />
                <span className="max-w-[110px] lg:max-w-[170px] truncate">
                  {claudeAuth.email}
                </span>
              </button>
              <button
                onClick={async () => {
                  await claudeLogout();
                  await fetchClaudeAuth();
                }}
                title={t.aiStudio.logoutClaudeTitle}
                className="ph-icon-button hover:text-rose-300"
              >
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => startClaudeLogin()}
              title={t.aiStudio.loginClaudeTitle}
              className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 bg-ph-raised hover:bg-ph-hover text-slate-100"
            >
              <ClaudeLogo className="w-3.5 h-3.5" />
              <span>{t.aiStudio.loginClaude}</span>
            </button>
          )}

          {/* Subagents Button */}
          <button
            onClick={() => setIsSubagentsPanelOpen(!isSubagentsPanelOpen)}
            className={`flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 ${
              isSubagentsPanelOpen || projectSubagents.some((s) => s.status === 'running')
                ? 'bg-ph-hover text-slate-100'
                : 'text-slate-400 hover:text-slate-100 hover:bg-ph-hover'
            }`}
            title={t.aiStudio.subagentsTitle}
          >
            <GitFork className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t.aiStudio.subagents}</span>
            {projectSubagents.length > 0 && (
              <span className="text-slate-500 tabular-nums">
                {projectSubagents.length}
              </span>
            )}
          </button>

          {/* Рабочее дерево агента: он стартует с cwd в активном worktree (TASK-62) */}
          {workspaceRoot && selectedProject && workspaceRoot !== selectedProject.path && (
            <span
              className="flex items-center gap-1.5 h-7 px-2 text-cyan-300 text-xs max-w-[200px] truncate shrink-0"
              title={`${t.worktrees.switcherTitle}: ${workspaceRoot}`}
            >
              <FolderGit2 className="w-3 h-3 shrink-0" />
              {workspaceRoot.split(/[\\/]/).pop()}
            </span>
          )}

          {/* Quick Model Selector Dropdown matching official Claude Code UI */}
          <ModelSelectorDropdown
            config={config}
            onSelect={(selection) => saveConfig({ ...config, ...selection })}
          />

          {/* Лимиты Claude Code — в строке состояния (decision-73), здесь не дублируются */}

          {/* Auto-Approve Quick Toggle */}
          <button
            type="button"
            onClick={() => saveConfig({ ...config, autoApprove: !config.autoApprove })}
            title={config.autoApprove ? t.aiStudio.autoApproveOn : t.aiStudio.autoApproveOff}
            className={`flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 ${
              config.autoApprove ? 'text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15' : 'text-slate-400 hover:text-slate-100 hover:bg-ph-hover'
            }`}
          >
            <ShieldCheck className={`w-3.5 h-3.5 ${config.autoApprove ? 'text-emerald-400' : 'text-slate-400'}`} />
            <span className="hidden xl:inline">{t.aiStudio.autoApprove}</span>
            <span className="text-[11px] text-slate-500">{config.autoApprove ? 'ON' : 'OFF'}</span>
          </button>

          {/* Mode Switcher */}
          <div className="flex items-center p-0.5 rounded-md bg-ph-raised shrink-0">
            {(['agent', 'chat', 'architect'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 h-6 px-2 rounded text-xs transition ${
                  mode === m ? 'bg-ph-hover text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'agent' ? <Zap className="w-3.5 h-3.5" /> : m === 'chat' ? <MessageSquare className="w-3.5 h-3.5" /> : <Landmark className="w-3.5 h-3.5" />}
                {m === 'agent' ? t.aiStudio.input.agentMode : m === 'chat' ? t.aiStudio.input.chatMode : t.aiStudio.input.adrMode}
              </button>
            ))}
          </div>

          <button
            onClick={() => clearSession(projectPath, currentSessionId)}
            title={t.aiStudio.clearSession}
            className="ph-icon-button hover:text-rose-300 shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setIsRolesModalOpen(true)}
            title={t.roles.title}
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 text-slate-400 hover:text-slate-100 hover:bg-ph-hover"
          >
            <Users className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{t.roles.title}</span>
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            title={t.aiStudio.settings}
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs transition shrink-0 text-slate-400 hover:text-slate-100 hover:bg-ph-hover"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{t.aiStudio.settings}</span>
          </button>
        </div>
      </div>

      {/* Subagents Panel Drawer */}
      {isSubagentsPanelOpen && (
        <div className="p-3 bg-ph-panel border-b border-slate-800/90 animate-in slide-in-from-top-2 duration-200">
          <SubagentsPanel
            subagents={projectSubagents}
            onClose={() => setIsSubagentsPanelOpen(false)}
          />
        </div>
      )}

      {/* Rate Limit & Quota Warning Banner */}
      {projectRateLimitWarning && (
        <RateLimitWarningBanner
          warning={projectRateLimitWarning}
          config={config}
          onSelectModel={(model) => saveConfig({ ...config, model })}
          onClearSession={() => clearSession(projectPath, currentSessionId)}
          onDismiss={() => dismissRateLimitWarning(projectPath)}
        />
      )}

      {/* 2. Main Content Split: Messages Feed + Live Activity Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 select-text">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 max-w-xl mx-auto space-y-6">
              <div className="w-12 h-12 rounded-xl bg-ph-raised flex items-center justify-center">
                <ClaudeLogo className="w-6 h-6" />
              </div>

              <div className="space-y-2">
                <h3 className="text-[15px] font-medium text-slate-100">
                  {t.aiStudio.welcomeTitle} — {currentSession?.title || t.aiStudio.newChat}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {t.aiStudio.welcomeDesc}
                </p>

                {/* Вход в Claude.ai: статус и выход — в панели над чатом; здесь только приглашение войти */}
                {claudeAuth?.isLoggedIn ? null : (
                  <div className="p-3 rounded-lg bg-ph-elevated border border-ph-line flex items-center justify-between gap-3 text-left">
                    <div className="text-xs text-slate-300">
                      <p className="font-medium text-slate-100">{t.aiStudio.useSubscriptionTitle}</p>
                      <p className="text-[11px] text-slate-400">{t.aiStudio.useSubscriptionDesc}</p>
                    </div>
                    <button
                      onClick={() => startClaudeLogin()}
                      className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs transition whitespace-nowrap"
                    >
                      {t.aiStudio.loginClaude}
                    </button>
                  </div>
                )}
              </div>

              {/* Quick Prompt Cards */}
              <div className="grid grid-cols-2 gap-2.5 w-full text-left">
                <button
                  onClick={() => {
                    const candidate =
                      tasks.find((tk) => tk.status === 'In Progress') || tasks.find((tk) => tk.status === 'To Do');
                    if (candidate && currentSessionId) setSessionTask(projectPath, currentSessionId, candidate.id);
                    sendMessage(projectPath, t.aiStudio.quickActions.nextTaskPrompt);
                  }}
                  className="p-3 rounded-lg bg-ph-elevated border border-ph-line hover:border-slate-600 transition text-xs text-slate-300 space-y-1 group"
                >
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <ListTodo className="w-3.5 h-3.5 text-slate-400" />
                    {t.aiStudio.quickActions.nextTask}
                  </div>
                  <p className="text-[11px] text-slate-500 group-hover:text-slate-400 truncate">
                    {t.aiStudio.quickActions.nextTaskPrompt}
                  </p>
                </button>

                <button
                  onClick={() => sendMessage(projectPath, t.aiStudio.quickActions.commitPrompt)}
                  className="p-3 rounded-lg bg-ph-elevated border border-ph-line hover:border-slate-600 transition text-xs text-slate-300 space-y-1 group"
                >
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <GitCommit className="w-3.5 h-3.5 text-slate-400" />
                    {t.aiStudio.quickActions.commit}
                  </div>
                  <p className="text-[11px] text-slate-500 group-hover:text-slate-400 truncate">
                    {t.aiStudio.quickActions.commitPrompt}
                  </p>
                </button>

                <button
                  onClick={() => sendMessage(projectPath, t.aiStudio.quickActions.deployPrompt)}
                  className="p-3 rounded-lg bg-ph-elevated border border-ph-line hover:border-slate-600 transition text-xs text-slate-300 space-y-1 group"
                >
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <Rocket className="w-3.5 h-3.5 text-slate-400" />
                    {t.aiStudio.quickActions.deploy}
                  </div>
                  <p className="text-[11px] text-slate-500 group-hover:text-slate-400 truncate">
                    {t.aiStudio.quickActions.deployPrompt}
                  </p>
                </button>

                <button
                  onClick={() =>
                    sendMessage(
                      projectPath,
                      t.aiStudio.promptCards.adrCreatePrompt
                    )
                  }
                  className="p-3 rounded-lg bg-ph-elevated border border-ph-line hover:border-slate-600 transition text-xs text-slate-300 space-y-1 group"
                >
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5 text-slate-400" />
                    {t.aiStudio.promptCards.adrCreate}
                  </div>
                  <p className="text-[11px] text-slate-500 group-hover:text-slate-400 truncate">
                    {t.aiStudio.promptCards.adrCreateDesc}
                  </p>
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === 'user';
              const isThoughtOpen = expandedThoughts[msg.id] ?? false;

              return (
                <div
                  key={msg.id}
                  className={`flex gap-3.5 ${isUser ? 'justify-end' : 'justify-start'} animate-in fade-in duration-150`}
                >
                  {/* Assistant Avatar */}
                  {!isUser && (
                    <div className="w-7 h-7 rounded-md bg-ph-raised flex items-center justify-center shrink-0 mt-0.5">
                      <ClaudeLogo className="w-4 h-4" />
                    </div>
                  )}

                  <div className={`max-w-3xl flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
                    {/* Thinking / Reasoning Accordion */}
                    {msg.thought && (
                      <div className="w-full rounded-xl bg-ph-raised border border-amber-500/20 overflow-hidden text-xs">
                        <button
                          onClick={() => toggleThought(msg.id)}
                          className="w-full px-3.5 py-2 flex items-center justify-between text-amber-300/90 hover:text-amber-200 hover:bg-amber-500/5 transition font-mono text-[11px]"
                        >
                          <span className="flex items-center gap-1.5">
                            <BrainCircuit className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                            {t.aiStudio.thinkingProcess}
                          </span>
                          {isThoughtOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                          )}
                        </button>
                        {isThoughtOpen && (
                          <div className="px-4 py-3 bg-ph-panel border-t border-slate-800/80 text-[11px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                            {msg.thought}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Message Bubble */}
                    <div
                      className={`p-4 rounded-2xl text-xs leading-relaxed ${
                        isUser
                          ? 'bg-indigo-600 text-white shadow-lg rounded-tr-sm'
                          : 'bg-ph-hover text-slate-200 border border-slate-800/80 shadow-md rounded-tl-sm w-full'
                      }`}
                    >
                      {msg.content ? (
                        isUser ? (
                          <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
                        ) : (
                          <MarkdownViewer content={msg.content} emptyMessage={null} className="text-slate-200" />
                        )
                      ) : isStreaming && !msg.thought && (!msg.toolCalls || msg.toolCalls.length === 0) ? (
                        <div className="flex items-center gap-1.5 text-amber-400 py-1 font-mono">
                          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                          {t.aiStudio.generating}
                        </div>
                      ) : null}

                      {/* Collapsible Agent Steps / Tool Calls Accordion (Remark 2) */}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <AgentStepsAccordion
                          toolCalls={msg.toolCalls}
                          messageId={msg.id}
                          projectPath={projectPath}
                          onAcceptDiff={(mId, tId, fPath, nContent) =>
                            acceptDiff(projectPath, mId, tId, fPath, nContent)
                          }
                          onRejectDiff={(mId, tId) => rejectDiff(projectPath, mId, tId)}
                        />
                      )}

                      {/* Ошибка ответа (TASK-70.6): локализованная карточка и повтор — чат остаётся рабочим */}
                      {!isUser && msg.error && (
                        <ProviderErrorCard
                          error={msg.error}
                          info={msg.providerError}
                          onRetry={() => void retryFailedMessage(projectPath, msg.id)}
                          retryDisabled={isStreaming}
                        />
                      )}
                    </div>

                    <span className="text-[11px] text-slate-500 font-mono px-1">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* User Avatar */}
                  {isUser && (
                    <div className="w-8 h-8 rounded-lg bg-ph-raised flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Pending Interactive Approval Cards (Queue: One at a time) */}
          {projectApprovals.length > 0 && (
            <InteractiveApprovalCard
              key={projectApprovals[0].id}
              request={projectApprovals[0]}
              queueInfo={{ current: 1, total: projectApprovals.length }}
              onApprove={(customText) =>
                sendApprovalResponse(projectPath, projectApprovals[0].id, true, customText)
              }
              onReject={(customText) =>
                sendApprovalResponse(projectPath, projectApprovals[0].id, false, customText)
              }
            />
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Live Activity Sidebar / Execution Monitor (Remark 3) */}
        <LiveActivitySidebar
          isStreaming={isStreaming}
          activeStatus={projectAgentStatus}
          subagents={projectSubagents}
          liveOutput={currentLiveOutput}
          onClearOutput={() => clearLiveOutput(projectPath)}
          isOpen={isActivitySidebarOpen}
          onToggleOpen={() => setIsActivitySidebarOpen(!isActivitySidebarOpen)}
        />
      </div>

      {/* Карточка подставленного контекста (TASK-64) — только когда сессия привязана к задаче */}
      {currentSession?.activeTaskId && currentSessionId && (
        <div className="px-4 pt-3">
          <ContextAppliedCard
            projectPath={projectPath}
            taskId={currentSession.activeTaskId}
            contextParts={currentSession.contextParts}
            onTogglePart={(key, enabled) => toggleContextPart(projectPath, currentSessionId, key, enabled)}
            onClearTask={() => setSessionTask(projectPath, currentSessionId, undefined)}
          />
        </div>
      )}

      {/* 3. Isolated Memoized Prompt Input Area (0ms typing lag) */}
      <PromptInputArea
        mode={mode}
        isStreaming={isStreaming}
        tasks={tasks}
        gitRepoDetails={gitRepoDetails}
        onSend={(text) => sendMessage(projectPath, text)}
        onAbort={abortStream}
      />

      {/* Settings Modal */}
      <AISettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      {/* Roles Registry (decision-9, TASK-60) */}
      <RolesSettingsModal isOpen={isRolesModalOpen} onClose={() => setIsRolesModalOpen(false)} />
    </div>
  );
};
