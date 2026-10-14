import React from 'react';
import { Code, FolderOpen, TerminalSquare, ShieldAlert, Loader2 } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { ActionRunnerBar } from '../actions/ActionRunnerBar';
import { VoiceBadge } from '../voice/VoiceBadge';
import { ProjectTabs } from './ProjectTabsBar';
import { useDialog } from '../../hooks/useDialog';
import { openInVsCode } from '../../lib/openInVsCode';

/**
 * Шапка проекта (decision-73): вкладки открытых проектов (путь и метка шаблона — в их подсказке),
 * статус агента и действия над проектом (Run/Deploy/Test, открыть в VS Code и в папке, консоль).
 * Сервисы приложения (HITL, уведомления, MCP, голос, лимиты, язык) живут в строке состояния,
 * навигация по вкладкам — в Activity Bar, переключатель сайдбара — там же.
 */
export const Header: React.FC = () => {
  const { t } = useTranslation();
  const dialog = useDialog();
  const {
    selectedProject,
    isTerminalOpen,
    toggleTerminal,
    setActiveTab,
    projectAgentStatuses,
    workspaceRoot
  } = useProjectStore();

  if (!selectedProject) {
    return (
      <header className="h-10 shrink-0 border-b border-ph-line px-4 flex items-center bg-ph-chrome">
        <span className="text-xs text-slate-500">{t.header.selectProjectHint}</span>
      </header>
    );
  }

  const agentStatus = projectAgentStatuses[selectedProject.path];

  // Внешние инструменты открываются в активном рабочем дереве (TASK-62).
  const activeRoot = workspaceRoot || selectedProject.path;

  const handleOpenCode = () => {
    void openInVsCode(activeRoot, () => void dialog.alert({ title: t.header.vsCode, message: t.header.vsCodeOpenFailed }));
  };

  const handleOpenExplorer = () => {
    if (window.api) window.api.openInExplorer(activeRoot);
  };

  const toolButton = 'flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-slate-300 hover:bg-ph-hover hover:text-white transition whitespace-nowrap shrink-0';

  return (
    <header className="h-10 shrink-0 border-b border-ph-line pr-2 flex items-stretch justify-between gap-3 bg-ph-chrome overflow-hidden">
      {/* Слева: вкладки открытых проектов и статус агента выбранного */}
      <div className="flex items-stretch gap-2 min-w-0 flex-1 h-full overflow-hidden">
        <ProjectTabs />

        {agentStatus?.status === 'waiting_approval' && (
          <button
            type="button"
            onClick={() => setActiveTab('ai')}
            className="self-center flex items-center gap-1.5 h-6 px-2 rounded-md bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 text-[11px] font-medium shrink-0 transition"
            title={t.header.requiresDecisionTooltip}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            <span>{t.header.requiresDecision}</span>
          </button>
        )}
        {agentStatus?.status === 'running' && (
          <button
            type="button"
            onClick={() => setActiveTab('ai')}
            className="self-center flex items-center gap-1.5 h-6 px-2 rounded-md text-slate-300 hover:bg-ph-hover text-[11px] min-w-0 transition"
            title={t.header.claudeExecutingTooltip}
          >
            <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
            <span className="truncate max-w-[180px]">{agentStatus.lastMessage || t.header.working}</span>
          </button>
        )}
      </div>

      {/* Справа: действия над проектом */}
      <div className="flex items-center gap-1 shrink-0">
        <ActionRunnerBar />

        <div className="w-px h-4 bg-ph-line mx-1.5" />

        <button onClick={handleOpenCode} title={t.header.vsCode} className={toolButton}>
          <Code className="w-3.5 h-3.5 text-slate-400" />
          <span className="hidden xl:inline">{t.header.vsCode}</span>
          <VoiceBadge command={t.voice.voiceBadges.code} />
        </button>

        <button onClick={handleOpenExplorer} title={t.header.folder} className={toolButton}>
          <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
          <span className="hidden xl:inline">{t.header.folder}</span>
          <VoiceBadge command={t.voice.voiceBadges.folder} />
        </button>

        <button
          onClick={toggleTerminal}
          title={`${t.header.console} (Ctrl+\`)`}
          aria-pressed={isTerminalOpen}
          className={`${toolButton} ${isTerminalOpen ? 'bg-ph-hover text-white' : ''}`}
        >
          <TerminalSquare className={`w-3.5 h-3.5 ${isTerminalOpen ? 'text-indigo-400' : 'text-slate-400'}`} />
          <span className="hidden lg:inline">{t.header.console}</span>
          <VoiceBadge command={t.voice.voiceBadges.terminal} />
        </button>
      </div>
    </header>
  );
};
