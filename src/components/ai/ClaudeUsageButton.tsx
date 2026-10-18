import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Gauge } from '../common/icons';
import { ClaudeUsageModal } from './ClaudeUsageModal';
import { VoiceBadge } from '../voice/VoiceBadge';
import { useTranslation } from '../../i18n/useTranslation';
import type { ClaudeUsageData } from '../../types/electron';
import { useProjectStore } from '../../store/useProjectStore';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';

interface ClaudeUsageButtonProps {
  className?: string;
  showText?: boolean;
  /** `status` — элемент строки состояния (decision-73), `chip` — кнопка в панели вкладки */
  variant?: 'status' | 'chip';
}

export const ClaudeUsageButton: React.FC<ClaudeUsageButtonProps> = ({
  className = '',
  showText = true,
  variant = 'chip'
}) => {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [usage, setUsage] = useState<ClaudeUsageData | null>(null);
  // Лимиты аккаунта активного проекта (TASK-152.5): при переключении проекта меняются.
  const projectPath = useProjectStore((s) => s.selectedProject?.path);
  const accountCount = useClaudeAccountsStore((s) => s.overview?.accounts.length ?? 1);
  const refreshAccounts = useClaudeAccountsStore((s) => s.refresh);

  // Без фонового опроса (аудит 3.9): бейдж читает usage один раз при монтировании и после
  // закрытия модалки (там пользователь мог принудительно обновить данные). Сами данные
  // в main берутся из локального stats-cache.json и rate-limit событий CLI, без спауна claude.
  // Номер последнего запроса: медленный `/usage` прежнего проекта не должен перетереть ответ нового.
  const requestSeq = useRef(0);
  const loadQuickUsage = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      if (window.api?.getClaudeUsage) {
        const data = await window.api.getClaudeUsage(false, projectPath ? { projectPath } : {});
        if (seq === requestSeq.current) setUsage(data);
      }
    } catch {
      // Бейдж вторичен: ошибка загрузки показывается в модалке
    }
  }, [projectPath]);

  useEffect(() => {
    // Лимиты прежнего аккаунта не показываем, пока не пришли лимиты аккаунта нового проекта.
    setUsage(null);
    void loadQuickUsage();
  }, [loadQuickUsage]);

  useEffect(() => {
    void refreshAccounts().catch(() => undefined);

    const handleOpenEvent = () => {
      setIsModalOpen(true);
    };
    window.addEventListener('projecthub:open-claude-usage', handleOpenEvent);
    return () => {
      window.removeEventListener('projecthub:open-claude-usage', handleOpenEvent);
    };
  }, [refreshAccounts]);

  const handleModalClose = () => {
    setIsModalOpen(false);
    loadQuickUsage();
  };

  const sessionPercent = usage?.sessionLimit?.percent;
  const weeklyPercent = usage?.weeklyLimit?.percent;
  const fablePercent = usage?.fableLimit?.percent;

  const getBadgeStyle = () => {
    const percent = sessionPercent ?? 0;
    if (variant === 'status') {
      // Фон только когда лимит почти исчерпан — это требует действия
      return percent >= 85 ? 'ph-status-item ph-status-item-error' : 'ph-status-item';
    }
    const base = 'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition shrink-0';
    if (percent >= 85) return `${base} bg-rose-500/15 text-rose-300 border-rose-500/40`;
    if (percent >= 60) return `${base} bg-amber-500/15 text-amber-300 border-amber-500/40`;
    return `${base} bg-ph-raised text-slate-300 border-slate-700 hover:bg-ph-hover hover:text-white`;
  };

  const getPercentColor = () => {
    if (sessionPercent === undefined) return 'text-amber-300';
    if (sessionPercent >= 85) return 'text-rose-300';
    if (sessionPercent >= 60) return 'text-amber-300';
    return 'text-emerald-400';
  };

  const getGaugeColor = () => {
    if (sessionPercent === undefined) return 'text-amber-400';
    if (sessionPercent >= 85) return 'text-rose-400';
    if (sessionPercent >= 60) return 'text-amber-400';
    return 'text-emerald-400';
  };

  const getTooltip = () => {
    if (!usage) return t.claudeUsage.modalDesc;
    const sessionLabel = t.claudeUsage.sessionLimit;
    const sessionText = typeof sessionPercent === 'number' ? `${sessionPercent}%` : '—';
    const weeklyLabel = t.claudeUsage.weeklyLimit;
    const weeklyText = typeof weeklyPercent === 'number' ? `${weeklyPercent}%` : '—';
    const parts = [
      `${sessionLabel}: ${sessionText}`,
      `${weeklyLabel}: ${weeklyText}`
    ];
    if (typeof fablePercent === 'number') {
      const fableLabel = t.claudeUsage.fableLimit;
      parts.push(`${fableLabel}: ${fablePercent}%`);
    }
    const account = usage.accountName ? ` — ${usage.accountName}` : '';
    if (usage.cliError?.kind === 'auth') return `Claude Code Usage${account}: ${t.claudeAccounts.notLoggedIn}`;
    return `Claude Code Usage${account} (${sessionLabel}: ${sessionText}). ${parts.join(', ')}.`;
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        title={getTooltip()}
        className={`${getBadgeStyle()} ${className}`}
      >
        <Gauge className={`w-3.5 h-3.5 shrink-0 ${getGaugeColor()}`} />
        {showText && <span>Usage</span>}
        {/* Имя аккаунта — только когда профилей больше одного: без профилей строка как раньше */}
        {accountCount > 1 && usage?.accountName && (
          <span className="max-w-[110px] truncate text-slate-300" data-testid="usage-account-name">{usage.accountName}</span>
        )}
        {accountCount > 1 && usage?.cliError?.kind === 'auth' && (
          <span className="text-amber-300">{t.claudeAccounts.notLoggedInShort}</span>
        )}
        {typeof sessionPercent === 'number' && (
          <span className={`font-mono ${getPercentColor()}`}>
            {sessionPercent}%
          </span>
        )}
        <VoiceBadge command={t.voice.voiceBadges.limits} />
      </button>

      <ClaudeUsageModal
        isOpen={isModalOpen}
        onClose={handleModalClose}
        initialAccountId={usage?.accountId}
      />
    </>
  );
};
