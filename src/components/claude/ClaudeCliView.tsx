import React, { useEffect } from 'react';
import { Bot, RefreshCw,
} from '../common/icons';
import { ClaudeLogo } from '../common/BrandLogo';
import { useProjectStore } from '../../store/useProjectStore';
import { PtyTabTerminal } from '../terminal/PtyTabTerminal';
import { useTranslation } from '../../i18n/useTranslation';

export const ClaudeCliView: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProject,
    ptySessions,
    activePtySessionId,
    createPtySessionAction,
    closePtySessionAction,
    workspaceRoot
  } = useProjectStore();

  const projectPath = selectedProject?.path || '';
  // Сессия CLI живёт в том дереве, где была создана; активное дерево могли переключить позже.
  const sessionCwd = (session?: { cwd?: string }) => session?.cwd || projectPath;

  // Find or create Claude Code PTY session for current project
  const claudeSessions = ptySessions.filter(
    (s) => s.projectPath === projectPath && s.type === 'claude'
  );
  const activeSession =
    claudeSessions.find((s) => s.id === activePtySessionId) ||
    claudeSessions[claudeSessions.length - 1];

  useEffect(() => {
    if (projectPath && claudeSessions.length === 0) {
      createPtySessionAction(projectPath, 'claude');
    }
  }, [projectPath, claudeSessions.length, createPtySessionAction]);

  if (!selectedProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
        <Bot className="w-12 h-12 text-slate-700 mb-3" />
        <h3 className="text-sm font-semibold text-slate-300 mb-1">{t.header.noProjectSelected}</h3>
        <p className="text-xs text-slate-500 max-w-sm">{t.header.selectProjectHint}</p>
      </div>
    );
  }

  const handleRestartSession = async () => {
    if (activeSession) {
      await closePtySessionAction(activeSession.id);
    }
    // Перезапуск поднимает сессию уже в активном рабочем дереве (TASK-62).
    await createPtySessionAction(projectPath, 'claude', undefined, workspaceRoot || undefined);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-ph-base overflow-hidden">
      {/* Claude CLI Sub-header */}
      <div className="px-6 py-2.5 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-ph-raised flex items-center justify-center">
            <ClaudeLogo className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-white">{t.claudeCli.title}</h3>
              {activeSession && workspaceRoot && sessionCwd(activeSession) !== workspaceRoot && (
                <span
                  className="px-2 py-0.5 rounded-full text-[11px] font-mono border bg-amber-500/10 border-amber-500/30 text-amber-300"
                  title={t.worktrees.switcherHint}
                >
                  {t.claudeCli.restart} → {t.worktrees.switcherLabel}
                </span>
              )}
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-mono border ${
                activeSession?.status === 'running'
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400'
              }`}>
                {activeSession?.status === 'running' ? t.claudeCli.running : t.claudeCli.exited}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono truncate max-w-md">
              {t.claudeCli.cwd}: {sessionCwd(activeSession)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRestartSession}
            title={t.claudeCli.restartTitle}
            className="ph-btn ph-btn-secondary"
          >
            <RefreshCw className="w-3 h-3 text-indigo-400" />
            <span>{t.claudeCli.restart}</span>
          </button>
        </div>
      </div>

      {/* Terminal View Container */}
      <div className="flex-1 p-3 bg-ph-base overflow-hidden flex flex-col">
        {activeSession ? (
          <div className="flex-1 rounded-xl overflow-hidden border border-slate-800/80 bg-ph-base p-2">
            <PtyTabTerminal key={activeSession.id} session={activeSession} isActive={true} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-500">
            <Bot className="w-6 h-6 text-slate-600 mb-2" />
            {/* Сессии нет: раньше здесь висело «Инициализация…» при статусе «Завершён» (decision-73) */}
            <p className="text-xs text-slate-400 max-w-sm">{t.claudeCli.notRunning}</p>
          </div>
        )}
      </div>
    </div>
  );
};
