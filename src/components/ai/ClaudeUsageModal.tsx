import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Gauge,
  RefreshCw,
  AlertTriangle,
  Clock,
  Sparkles,
  Server,
  Zap,
  Bot,
  Terminal,
  Calendar,
  Layers,
  FileCode2
} from '../common/icons';
import type { ClaudeUsageData } from '../../types/electron';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { useClaudeAccountsStore } from '../../store/useClaudeAccountsStore';

interface ClaudeUsageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Профиль, открытый первым: аккаунт активного проекта (TASK-152.5). */
  initialAccountId?: string;
}

export const ClaudeUsageModal: React.FC<ClaudeUsageModalProps> = ({ isOpen, onClose, initialAccountId }) => {
  const { t } = useTranslation();
  /** Пояснение об источниках данных без вывода CLI — на языке окна. */
  const sourcesText = (src: NonNullable<ClaudeUsageData['sources']>): string => {
    const ts = t.claudeUsage.sources;
    return [
      ts.account.replace('{name}', src.accountName).replace('{dir}', src.configDir),
      (src.hasStatsCache ? ts.statsCache : ts.statsCacheMissing).replace('{file}', src.statsFile),
      src.rateLimitsAt !== undefined ? ts.rateLimitsAt.replace('{at}', new Date(src.rateLimitsAt).toLocaleString()) : ts.rateLimitsSnapshot,
      ts.directQuery
    ].join('\n');
  };
  const overview = useClaudeAccountsStore((s) => s.overview);
  const refreshAccounts = useClaudeAccountsStore((s) => s.refresh);
  const openLogin = useClaudeAccountsStore((s) => s.openLogin);
  const accounts = overview?.accounts ?? [];
  const [accountId, setAccountId] = useState<string>(initialAccountId ?? 'default');
  const [usageData, setUsageData] = useState<ClaudeUsageData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'limits' | 'models' | 'raw'>('limits');
  const [breakdownPeriod, setBreakdownPeriod] = useState<'24h' | '7d'>('24h');

  const loadUsage = async (force = false, id = accountId) => {
    setIsLoading(true);
    setError(null);
    try {
      if (window.api?.getClaudeUsage) {
        const data = await window.api.getClaudeUsage(force, { accountId: id });
        setUsageData(data);
      } else {
        setError(t.claudeUsage.apiUnavailable);
      }
    } catch (err: any) {
      setError(ipcErrorText(err) || t.claudeUsage.loadError);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      const id = initialAccountId ?? 'default';
      setAccountId(id);
      setUsageData(null);
      void refreshAccounts().catch(() => undefined);
      loadUsage(false, id);
    }
  }, [isOpen, initialAccountId]);

  const selectAccount = (id: string) => {
    if (id === accountId) return;
    setAccountId(id);
    setUsageData(null);
    loadUsage(false, id);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sessionPercent = usageData?.sessionLimit?.percent ?? 0;
  const weeklyPercent = usageData?.weeklyLimit?.percent ?? 0;
  const fablePercent = usageData?.fableLimit?.percent ?? 0;
  const hasFable = !!usageData?.fableLimit;
  const currentBreakdown = breakdownPeriod === '24h' ? usageData?.last24h : usageData?.last7d;
  const cliError = usageData?.cliError;
  const cliErrorText = cliError
    ? {
        auth: t.claudeUsage.cliAuthExpired,
        timeout: t.claudeUsage.cliTimeout,
        failed: t.claudeUsage.cliFailed,
        unrecognized: t.claudeUsage.cliUnrecognized
      }[cliError.kind]
    : null;
  // Окна лимита нет — это «нет данных», а не нулевой расход.
  const unknownBadgeColor = 'bg-slate-800/80 text-slate-400 border-slate-700/60';

  const getProgressColor = (percent: number) => {
    if (percent >= 85) return 'bg-rose-500';
    if (percent >= 60) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const getBadgeColor = (percent: number) => {
    if (percent >= 85) return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    if (percent >= 60) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
  };

  const formatTokens = (num: number) => {
    if (!num) return '0';
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-150 select-none"
    >
      <div className={`w-full ${hasFable ? 'max-w-4xl' : 'max-w-2xl'} bg-ph-elevated border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-slate-200 font-sans transition-all duration-200`}>
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-ph-hover/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 shadow-sm">
              <Gauge className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">{t.claudeUsage.modalTitle}</h3>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {usageData?.planType || 'Subscription'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {usageData?.accountName && accounts.length > 1
                  ? `${t.claudeAccounts.accountLabel}: ${usageData.accountName}`
                  : t.claudeUsage.modalDesc}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => loadUsage(true)}
              disabled={isLoading}
              title={t.claudeUsage.refreshTitle}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium border border-slate-700/60 transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
              <span className="hidden sm:inline">{t.claudeUsage.refresh}</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Профили аккаунтов (TASK-152.5): лимиты каждого отдельно */}
        {accounts.length > 1 && (
          <div className="px-5 pt-3 flex items-center gap-1.5 flex-wrap bg-ph-elevated" role="tablist" aria-label={t.claudeAccounts.usageAccountsLabel}>
            {accounts.map((account) => (
              <button
                key={account.id}
                role="tab"
                aria-selected={account.id === accountId}
                onClick={() => selectAccount(account.id)}
                className={`px-2.5 py-1 rounded-md text-xs border transition ${
                  account.id === accountId
                    ? 'bg-indigo-500/15 border-indigo-400/60 text-white'
                    : 'bg-ph-panel border-ph-line text-slate-400 hover:text-slate-200'
                }`}
              >
                {account.name}
              </button>
            ))}
          </div>
        )}

        {/* Modal Tabs Bar */}
        <div className="px-5 pt-3 pb-0 border-b border-slate-800/80 flex items-center gap-2 bg-ph-elevated">
          <button
            onClick={() => setActiveTab('limits')}
            className={`pb-2.5 px-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'limits'
                ? 'border-indigo-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            {t.claudeUsage.tabLimits}
          </button>
          <button
            onClick={() => setActiveTab('models')}
            className={`pb-2.5 px-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'models'
                ? 'border-indigo-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            {t.claudeUsage.tabModels}
          </button>
          <button
            onClick={() => setActiveTab('raw')}
            className={`pb-2.5 px-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'raw'
                ? 'border-indigo-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            {t.claudeUsage.tabRaw}
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-5 overflow-y-auto space-y-5 custom-scrollbar flex-1">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-300 flex items-center gap-2">
              <X className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {cliError && (
            <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <div>{cliErrorText}</div>
                {cliError.detail && (
                  <div className="font-mono text-[11px] text-amber-300/70 break-words select-text">{cliError.detail}</div>
                )}
              </div>
              {cliError.kind === 'auth' && (
                <button
                  onClick={() => openLogin(accountId)}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold transition"
                >
                  {t.claudeUsage.signIn}
                </button>
              )}
            </div>
          )}

          {isLoading && !usageData && (
            <div className="py-12 flex flex-col items-center justify-center space-y-3">
              <RefreshCw className="w-7 h-7 text-amber-400 animate-spin" />
              <p className="text-xs text-slate-400">{t.claudeUsage.loadingDesc}</p>
            </div>
          )}

          {/* TAB 1: LIMITS & FACTORS */}
          {activeTab === 'limits' && usageData && (
            <div className="space-y-5">
              {/* Top Row: Limit Cards (Session + Weekly + Fable) */}
              <div className={`grid grid-cols-1 ${hasFable ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-4`}>
                {/* Session Limit Card */}
                <div className="p-4 rounded-lg bg-ph-panel border border-ph-line space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-indigo-400" />
                      {t.claudeUsage.sessionLimit}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-mono font-bold border ${
                        usageData.sessionLimit ? getBadgeColor(sessionPercent) : unknownBadgeColor
                      }`}
                    >
                      {usageData.sessionLimit ? `${sessionPercent}% used` : t.claudeUsage.limitUnknown}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-slate-800/80 rounded-full h-2.5 overflow-hidden p-0.5">
                    <div
                      className={`h-full rounded-full ${getProgressColor(sessionPercent)} transition-all duration-500`}
                      style={{ width: usageData.sessionLimit ? `${Math.min(100, Math.max(2, sessionPercent))}%` : '0%' }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>{t.claudeUsage.sessionResetLabel}</span>
                    <span className="font-medium text-slate-300">
                      {usageData.sessionLimit ? usageData.sessionLimit.resetsAt || t.claudeUsage.resetsInHours : '—'}
                    </span>
                  </div>
                </div>

                {/* Weekly Limit Card */}
                <div className="p-4 rounded-lg bg-ph-panel border border-ph-line space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-amber-400" />
                      {t.claudeUsage.weeklyLimit}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-mono font-bold border ${
                        usageData.weeklyLimit ? getBadgeColor(weeklyPercent) : unknownBadgeColor
                      }`}
                    >
                      {usageData.weeklyLimit ? `${weeklyPercent}% used` : t.claudeUsage.limitUnknown}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-slate-800/80 rounded-full h-2.5 overflow-hidden p-0.5">
                    <div
                      className={`h-full rounded-full ${getProgressColor(weeklyPercent)} transition-all duration-500`}
                      style={{ width: usageData.weeklyLimit ? `${Math.min(100, Math.max(2, weeklyPercent))}%` : '0%' }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>{t.claudeUsage.weeklyResetLabel}</span>
                    <span className="font-medium text-slate-300">
                      {usageData.weeklyLimit ? usageData.weeklyLimit.resetsAt || t.claudeUsage.resetsInWeek : '—'}
                    </span>
                  </div>
                </div>

                {/* Fable Limit Card */}
                {hasFable && (
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-purple-500/30 space-y-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl pointer-events-none" />
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-purple-200 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        {t.claudeUsage.fableLimit}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-mono font-bold border ${getBadgeColor(
                          fablePercent
                        )}`}
                      >
                        {fablePercent}% used
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-slate-800/80 rounded-full h-2.5 overflow-hidden p-0.5">
                      <div
                        className={`h-full rounded-full ${getProgressColor(fablePercent)} transition-all duration-500`}
                        style={{ width: `${Math.min(100, Math.max(2, fablePercent))}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>{t.claudeUsage.fableResetLabel}</span>
                      <span className="font-medium text-purple-300">
                        {usageData.fableLimit?.resetsAt || t.claudeUsage.resetsInWeek}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Contributing Factors Section */}
              <div className="p-4 rounded-lg bg-ph-panel border border-ph-line space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                  <div>
                    <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      {t.claudeUsage.factorsTitle}
                    </h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {t.claudeUsage.factorsDesc}
                    </p>
                  </div>

                  {/* Period Switcher */}
                  <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[11px]">
                    <button
                      onClick={() => setBreakdownPeriod('24h')}
                      className={`px-2.5 py-1 rounded font-medium transition ${
                        breakdownPeriod === '24h'
                          ? 'bg-amber-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t.claudeUsage.period24h}
                    </button>
                    <button
                      onClick={() => setBreakdownPeriod('7d')}
                      className={`px-2.5 py-1 rounded font-medium transition ${
                        breakdownPeriod === '7d'
                          ? 'bg-amber-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t.claudeUsage.period7d}
                    </button>
                  </div>
                </div>

                {/* Key Metrics Grid */}
                {currentBreakdown ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/60">
                      <div className="text-lg font-bold text-white font-mono">
                        {currentBreakdown.requests ?? '—'}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t.claudeUsage.requests}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/60">
                      <div className="text-lg font-bold text-white font-mono">
                        {currentBreakdown.sessions ?? '—'}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t.claudeUsage.sessions}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/60">
                      <div className="text-lg font-bold text-amber-300 font-mono">
                        {currentBreakdown.contextAbove150kPercent ? `${currentBreakdown.contextAbove150kPercent}%` : '—'}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t.claudeUsage.context150k}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/60">
                      <div className="text-lg font-bold text-indigo-300 font-mono">
                        {currentBreakdown.subagentHeavyPercent ? `${currentBreakdown.subagentHeavyPercent}%` : '—'}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t.claudeUsage.subagents}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 py-3 text-center">
                    {t.claudeUsage.noPeriodData}
                  </div>
                )}

                {/* Top Skills, MCP Servers, Subagents */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                  {/* Top Skills */}
                  <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/60 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                      <FileCode2 className="w-3 h-3 text-indigo-400" />
                      {t.claudeUsage.topSkills}
                    </div>
                    {currentBreakdown?.topSkills && currentBreakdown.topSkills.length > 0 ? (
                      <div className="space-y-1.5">
                        {currentBreakdown.topSkills.map((s, idx) => (
                          <div key={idx} className="flex items-center justify-between text-xs">
                            <span className="font-mono text-[11px] text-slate-300 truncate">{s.name}</span>
                            <span className="font-mono font-bold text-indigo-400">{s.percent}%</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500">{t.claudeUsage.noActivity}</div>
                    )}
                  </div>

                  {/* Top MCP Servers */}
                  <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/60 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                      <Server className="w-3 h-3 text-emerald-400" />
                      {t.claudeUsage.topMcp}
                    </div>
                    {currentBreakdown?.topMcpServers && currentBreakdown.topMcpServers.length > 0 ? (
                      <div className="space-y-1.5">
                        {currentBreakdown.topMcpServers.map((m, idx) => (
                          <div key={idx} className="flex items-center justify-between text-xs">
                            <span className="font-mono text-[11px] text-slate-300 truncate">{m.name}</span>
                            <span className="font-mono font-bold text-emerald-400">{m.percent}%</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500">{t.claudeUsage.noActivity}</div>
                    )}
                  </div>

                  {/* Top Subagents */}
                  <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/60 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                      <Bot className="w-3 h-3 text-amber-400" />
                      {t.claudeUsage.topSubagents}
                    </div>
                    {currentBreakdown?.topSubagents && currentBreakdown.topSubagents.length > 0 ? (
                      <div className="space-y-1.5">
                        {currentBreakdown.topSubagents.map((sub, idx) => (
                          <div key={idx} className="flex items-center justify-between text-xs">
                            <span className="font-mono text-[11px] text-slate-300 truncate">{sub.name}</span>
                            <span className="font-mono font-bold text-amber-400">{sub.percent}%</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500">{t.claudeUsage.noActivity}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: MODELS & TOKENS FROM STATS CACHE */}
          {activeTab === 'models' && (
            <div className="space-y-4">
              {/* Summary Stats Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-ph-panel border border-ph-line">
                  <div className="text-xs text-slate-400">{t.claudeUsage.totalSessions}</div>
                  <div className="text-lg font-bold text-white font-mono mt-0.5">
                    {usageData?.totalSessions ?? '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-ph-panel border border-ph-line">
                  <div className="text-xs text-slate-400">{t.claudeUsage.totalMessages}</div>
                  <div className="text-lg font-bold text-white font-mono mt-0.5">
                    {usageData?.totalMessages?.toLocaleString() ?? '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-ph-panel border border-ph-line col-span-2">
                  <div className="text-xs text-slate-400">{t.claudeUsage.updated}</div>
                  <div className="text-xs font-mono text-slate-300 mt-1">
                    {usageData?.updatedAt ? new Date(usageData.updatedAt).toLocaleString() : '—'}
                  </div>
                </div>
              </div>

              {/* Models Breakdown */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" />
                  {t.claudeUsage.modelsBreakdown}
                </h4>

                {usageData?.modelUsage && Object.keys(usageData.modelUsage).length > 0 ? (
                  <div className="space-y-2.5">
                    {Object.entries(usageData.modelUsage).map(([modelName, stats]) => (
                      <div
                        key={modelName}
                        className="p-3.5 rounded-lg bg-ph-panel border border-ph-line space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs font-bold text-white">{modelName}</span>
                          <span className="text-[11px] font-mono text-amber-300">
                            {t.claudeUsage.outputTokens.replace('{count}', formatTokens(stats.outputTokens))}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                          <div className="p-2 rounded bg-slate-950/70 border border-slate-800/50">
                            <span className="text-slate-400 block text-[11px]">{t.claudeUsage.inputTokens}</span>
                            <span className="text-slate-200">{formatTokens(stats.inputTokens)}</span>
                          </div>
                          <div className="p-2 rounded bg-slate-950/70 border border-slate-800/50">
                            <span className="text-slate-400 block text-[11px]">{t.claudeUsage.cacheRead}</span>
                            <span className="text-emerald-300">{formatTokens(stats.cacheReadInputTokens)}</span>
                          </div>
                          <div className="p-2 rounded bg-slate-950/70 border border-slate-800/50">
                            <span className="text-slate-400 block text-[11px]">{t.claudeUsage.cacheCreate}</span>
                            <span className="text-indigo-300">{formatTokens(stats.cacheCreationInputTokens)}</span>
                          </div>
                          <div className="p-2 rounded bg-slate-950/70 border border-slate-800/50">
                            <span className="text-slate-400 block text-[11px]">{t.claudeUsage.cacheSavings}</span>
                            <span className="text-teal-300">
                              {stats.cacheReadInputTokens > 0 ? '90%+' : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 py-4 text-center">
                    {t.claudeUsage.noStatsCache}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: RAW CLI TEXT */}
          {activeTab === 'raw' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{t.claudeUsage.rawOutputDesc}</span>
              </div>
              <pre className="p-4 rounded-xl bg-black/90 border border-slate-800 text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-[50vh]">
                {usageData?.rawText || (usageData?.sources ? sourcesText(usageData.sources) : t.claudeUsage.noData)}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800/80 bg-ph-raised flex items-center justify-between text-xs">
          <div className="text-slate-500 text-[11px] flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${cliError ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            {cliError ? t.claudeUsage.notSynced : t.claudeUsage.syncedWithCli}
          </div>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold transition"
          >
            {t.claudeUsage.close}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
