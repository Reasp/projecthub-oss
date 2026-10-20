import React, { useEffect, useRef, useState } from 'react';
import {
  GitPullRequest,
  ExternalLink,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  GitBranch,
  ArrowRight,
  ShieldCheck,
  FileCode,
  Check,
  AlertTriangle,
  KeyRound,
  GitMerge
} from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useConnectionsStore } from '../../store/useConnectionsStore';
import { CreatePRModal } from './CreatePRModal';
import { PrReviewPanel } from './PrReviewPanel';
import type { PullRequest, PRProviderInfo } from '../../types/electron';

const HOSTING_LABELS: Record<PRProviderInfo['provider'], string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  bitbucket: 'Bitbucket',
  none: ''
};

function cleanIpcError(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

export const PullRequestView: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProject,
    prs,
    selectedPR,
    prDiffContent,
    prFilter,
    isLoadingPRs,
    prProviderInfo,
    prError,
    backlogConfig,
    fetchPRs,
    selectPR,
    setPRFilter
  } = useProjectStore();
  const openConnections = useConnectionsStore((s) => s.open);
  const connectionsOpen = useConnectionsStore((s) => s.isOpen);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'diff' | 'review'>('overview');
  const [importBusy, setImportBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const wasConnectionsOpen = useRef(connectionsOpen);

  useEffect(() => {
    if (selectedProject) {
      fetchPRs(selectedProject.path);
    }
  }, [selectedProject, fetchPRs]);

  // Закрыли окно «Подключения» — подключение могли добавить, переподключить или удалить (TASK-138.2).
  useEffect(() => {
    if (wasConnectionsOpen.current && !connectionsOpen && selectedProject) fetchPRs(selectedProject.path);
    wasConnectionsOpen.current = connectionsOpen;
  }, [connectionsOpen, selectedProject, fetchPRs]);

  const hostingLabel = HOSTING_LABELS[prProviderInfo?.provider ?? 'none'] || 'Git';
  const accessMessage = (() => {
    if (!prProviderInfo) return null;
    const { via, connections, remoteUrl, authenticated } = prProviderInfo;
    // Подключение к хосту есть, но требует входа заново: «добавьте подключение» тут ввело бы в заблуждение.
    if (via === 'none' && connections.some((c) => c.status === 'needsReauth')) return t.prs.needsReauth;
    if (via === 'none' && remoteUrl) return t.prs.noBackend;
    if (via === 'connection' && !authenticated) return t.prs.needsReauth;
    return prError ? t.prs.loadError.replace('{error}', prError) : null;
  })();

  const handleSelectConnection = async (connectionId: string) => {
    if (!selectedProject) return;
    try {
      await window.api.setPRConnection(selectedProject.path, connectionId || null);
    } catch (err) {
      setNotice({ kind: 'error', text: cleanIpcError(err) });
    }
    fetchPRs(selectedProject.path, prFilter);
  };

  // Слияние PR переводит задачу из Review (TASK-138.5): кроме самого Review, любой статус проекта.
  const mergeStatuses = backlogConfig.statuses.filter((s) => s.toLowerCase() !== 'review');
  const handleMergeStatus = async (status: string) => {
    if (!selectedProject) return;
    try {
      await window.api.setPRMergeStatus(selectedProject.path, status || null);
    } catch (err) {
      setNotice({ kind: 'error', text: cleanIpcError(err) });
    }
    fetchPRs(selectedProject.path, prFilter);
  };

  const handleImportCli = async () => {
    if (!selectedProject) return;
    setImportBusy(true);
    setNotice(null);
    try {
      const created = await window.api.importPRCliLogin(selectedProject.path);
      setNotice({ kind: 'ok', text: t.prs.importDone.replace('{label}', created.label) });
      fetchPRs(selectedProject.path, prFilter);
    } catch (err) {
      setNotice({ kind: 'error', text: t.prs.importFailed.replace('{error}', cleanIpcError(err)) });
    } finally {
      setImportBusy(false);
    }
  };

  const handleRefresh = () => {
    if (selectedProject) {
      fetchPRs(selectedProject.path, prFilter);
    }
  };

  const getStatusBadge = (state: PullRequest['state']) => {
    switch (state) {
      case 'OPEN':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <GitPullRequest className="w-3 h-3" />
            Open
          </span>
        );
      case 'MERGED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20">
            <Check className="w-3 h-3" />
            Merged
          </span>
        );
      case 'CLOSED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
            <XCircle className="w-3 h-3" />
            Closed
          </span>
        );
    }
  };

  const getCheckBadge = (status?: PullRequest['checksStatus']) => {
    if (!status || status === 'NONE') return null;
    switch (status) {
      case 'SUCCESS':
        return (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400" title={t.pr.allChecksPassed}>
            <CheckCircle2 className="w-3 h-3" />
            CI Passed
          </span>
        );
      case 'FAILURE':
        return (
          <span className="flex items-center gap-1 text-[11px] text-rose-400" title={t.pr.checksFailed}>
            <XCircle className="w-3 h-3" />
            CI Failed
          </span>
        );
      case 'PENDING':
        return (
          <span className="flex items-center gap-1 text-[11px] text-amber-400" title={t.pr.checksRunning}>
            <Clock className="w-3 h-3 animate-spin" />
            CI Running
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-ph-panel">
      {/* Top Header Controls */}
      <div className="h-14 px-6 border-b border-slate-800/80 bg-ph-elevated/60 flex items-center justify-between gap-4 shrink-0 flex-nowrap overflow-hidden">
        <div className="flex items-center gap-4 min-w-0 flex-1 overflow-hidden">
          {/* Provider / Repo status */}
          <div className="flex items-center gap-2 text-xs shrink-0 whitespace-nowrap">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/80 border border-slate-700/60 text-slate-300 font-mono text-[11px] shrink-0" title={t.prs.repoTooltip.replace('{repo}', prProviderInfo?.repo || t.prs.local)}>
              <GitPullRequest className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="truncate max-w-[160px]">{prProviderInfo?.repo || t.prs.localRepo}</span>
            </div>
            {prProviderInfo && prProviderInfo.connections.length > 0 ? (
              <label className="flex items-center gap-1 text-[11px] text-slate-400 shrink-0" title={t.prs.connectionSelectTitle}>
                <KeyRound className="w-3 h-3 shrink-0 text-emerald-400" />
                <select
                  value={prProviderInfo.pinnedConnectionId ?? ''}
                  onChange={(e) => void handleSelectConnection(e.target.value)}
                  aria-label={t.prs.viaConnection}
                  className="max-w-[200px] bg-slate-800/80 border border-slate-700/60 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
                >
                  <option value="">
                    {prProviderInfo.via === 'connection' && !prProviderInfo.pinnedConnectionId
                      ? `${t.prs.connectionAuto}: ${prProviderInfo.connectionLabel ?? ''}`
                      : t.prs.connectionAuto}
                  </option>
                  {prProviderInfo.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : prProviderInfo?.via === 'cli' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium shrink-0 whitespace-nowrap" title={t.prs.ghCliAvailable}>
                <ShieldCheck className="w-3 h-3 shrink-0" />
                {t.prs.viaCli}
              </span>
            ) : null}
            {prProviderInfo && prProviderInfo.via !== 'none' && (
              <label className="flex items-center gap-1 text-[11px] text-slate-400 shrink-0" title={t.prs.mergeStatusTitle}>
                <GitMerge className="w-3 h-3 shrink-0 text-purple-400" />
                {/* Подпись только на широком окне: иначе шапка обрезает фильтры PR; смысл объясняет подсказка. */}
                <span className="hidden 2xl:inline">{t.prs.mergeStatusLabel}:</span>
                <select
                  value={prProviderInfo.mergeStatus ?? ''}
                  onChange={(e) => void handleMergeStatus(e.target.value)}
                  aria-label={t.prs.mergeStatusLabel}
                  data-testid="pr-merge-status"
                  className="max-w-[140px] bg-slate-800/80 border border-slate-700/60 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
                >
                  <option value="">{t.prs.mergeStatusOff}</option>
                  {prProviderInfo.mergeStatus && !mergeStatuses.includes(prProviderInfo.mergeStatus) && (
                    <option value={prProviderInfo.mergeStatus}>{prProviderInfo.mergeStatus}</option>
                  )}
                  {mergeStatuses.map((s) => (
                    <option key={s} value={s}>
                      → {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1 bg-ph-base p-1 rounded-lg border border-slate-800 text-xs shrink-0 flex-nowrap">
            {(['all', 'open', 'merged', 'closed'] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setPRFilter(filter)}
                title={`PR Filter: ${filter}`}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition capitalize whitespace-nowrap shrink-0 ${
                  prFilter === filter
                    ? 'bg-ph-hover text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                {filter === 'all' ? t.pr.allFilter : filter === 'open' ? t.pr.openFilter : filter === 'merged' ? t.pr.mergedFilter : t.pr.closedFilter}
              </button>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 shrink-0 flex-nowrap">
          <button
            onClick={handleRefresh}
            disabled={isLoadingPRs}
            title={t.pr.refresh}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700/60 transition disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingPRs ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            title={t.pr.newPR}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs shadow-lg transition shrink-0 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{t.pr.newPR}</span>
          </button>
        </div>
      </div>

      {/* Доступ к хостингу (TASK-138.2): нет подключения, нужен вход, ошибка списка, перенос входа CLI */}
      {(accessMessage || notice) && (
        <div className="px-6 py-2 border-b border-slate-800/80 flex flex-col gap-1.5 text-xs shrink-0">
          {accessMessage && (
            <div className="flex items-center gap-2 text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 min-w-0">{accessMessage}</span>
              {prProviderInfo?.importableCli && (
                <button
                  type="button"
                  onClick={() => void handleImportCli()}
                  disabled={importBusy}
                  title={t.prs.importCliTitle.replace('{cli}', prProviderInfo.importableCli)}
                  className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 shrink-0"
                >
                  {t.prs.importCli.replace('{cli}', prProviderInfo.importableCli)}
                </button>
              )}
              <button
                type="button"
                onClick={openConnections}
                className="px-2.5 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white shrink-0"
              >
                {t.prs.openConnections}
              </button>
            </div>
          )}
          {notice && <div className={notice.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}>{notice.text}</div>}
        </div>
      )}

      {/* Main PR Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: PR List */}
        <div className="w-80 border-r border-slate-800/80 flex flex-col bg-ph-elevated shrink-0">
          <div className="px-4 py-2 border-b border-slate-800 text-[11px] font-medium text-slate-400 flex items-center justify-between">
            <span>{t.pr.title} ({prs.length})</span>
            {isLoadingPRs && <span className="text-indigo-400 animate-pulse">{t.common.loading}</span>}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
            {prs.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                <GitPullRequest className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                <p>{t.pr.noPRs}</p>
              </div>
            ) : (
              prs.map((pr) => {
                const isSelected = selectedPR?.number === pr.number;
                return (
                  <div
                    key={pr.id}
                    onClick={() => selectPR(pr)}
                    className={`p-3.5 cursor-pointer transition flex flex-col gap-2 ${
                      isSelected
                        ? 'bg-indigo-600/10 border-l-2 border-indigo-500'
                        : 'hover:bg-slate-800/30 border-l-2 border-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        {getStatusBadge(pr.state)}
                        {pr.state === 'OPEN' && pr.draft && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] border border-slate-600 text-slate-400">{t.prs.draftBadge}</span>
                        )}
                        <span className="text-[11px] font-mono text-slate-400">#{pr.number}</span>
                      </div>
                      {getCheckBadge(pr.checksStatus)}
                    </div>

                    <h4 className="text-xs font-medium text-slate-200 line-clamp-2 leading-snug">
                      {pr.title}
                    </h4>

                    {/* Branch pills */}
                    <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
                      <span className="truncate max-w-[90px] px-1.5 py-0.5 rounded bg-slate-800/80 text-indigo-300">
                        {pr.sourceBranch}
                      </span>
                      <ArrowRight className="w-2.5 h-2.5 text-slate-600 shrink-0" />
                      <span className="truncate max-w-[90px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400">
                        {pr.targetBranch}
                      </span>
                    </div>

                    {/* Footer metadata */}
                    <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                      <span>{pr.author}</span>
                      {pr.commentsCount !== undefined && pr.commentsCount > 0 && (
                        <span className="flex items-center gap-1 text-slate-400">
                          <MessageSquare className="w-2.5 h-2.5" />
                          {pr.commentsCount}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Selected PR Details */}
        <div className="flex-1 flex flex-col overflow-hidden bg-ph-panel">
          {selectedPR ? (
            <>
              {/* PR Detail Header */}
              <div className="p-6 border-b border-slate-800 bg-ph-elevated/40 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      {getStatusBadge(selectedPR.state)}
                      <span className="text-sm font-mono text-slate-400">#{selectedPR.number}</span>
                      {getCheckBadge(selectedPR.checksStatus)}
                    </div>
                    <h2 className="text-base font-semibold text-white leading-snug">
                      {selectedPR.title}
                    </h2>
                  </div>

                  {selectedPR.url && (
                    <button
                      onClick={() => window.open(selectedPR.url, '_blank')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 font-medium text-xs transition shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      {t.prs.openOnHosting.replace('{hosting}', hostingLabel)}
                    </button>
                  )}
                </div>

                {/* Branches and Author info */}
                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <div className="flex items-center gap-1.5 font-mono">
                    <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-medium">
                      {selectedPR.sourceBranch}
                    </span>
                    <ArrowRight className="w-3 h-3 text-slate-600" />
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                      {selectedPR.targetBranch}
                    </span>
                  </div>
                  <span>•</span>
                  <span>{t.pr.author}: <b className="text-slate-300 font-medium">{selectedPR.author}</b></span>
                  <span>•</span>
                  <span>{t.pr.created}: {new Date(selectedPR.createdAt).toLocaleDateString()}</span>
                </div>

                {/* Sub-tabs: Overview / Diff */}
                <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                  <button
                    onClick={() => setActiveSubTab('overview')}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                      activeSubTab === 'overview'
                        ? 'bg-ph-hover text-slate-100'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    {t.pr.overviewTab}
                  </button>
                  <button
                    onClick={() => setActiveSubTab('diff')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition ${
                      activeSubTab === 'diff'
                        ? 'bg-ph-hover text-slate-100'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <FileCode className="w-3.5 h-3.5" />
                    {t.pr.diffTab}
                  </button>
                  <button
                    onClick={() => setActiveSubTab('review')}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition ${
                      activeSubTab === 'review'
                        ? 'bg-ph-hover text-slate-100'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {t.prReview.tab}
                  </button>
                </div>
              </div>

              {/* PR Detail Body */}
              <div className="flex-1 overflow-y-auto p-6">
                {activeSubTab === 'review' && selectedProject ? (
                  <PrReviewPanel
                    projectPath={selectedProject.path}
                    prNumber={selectedPR.number}
                    prOpen={selectedPR.state === 'OPEN'}
                    hasCli={Boolean(prProviderInfo?.authenticated)}
                  />
                ) : activeSubTab === 'overview' ? (
                  <div className="max-w-3xl space-y-6">
                    {/* Description Box */}
                    <div className="bg-ph-raised border border-slate-800 rounded-xl p-5 shadow-inner">
                      <h3 className="text-xs font-medium text-slate-300 mb-3">
                        {t.pr.description}
                      </h3>
                      {selectedPR.body ? (
                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono bg-ph-base p-4 rounded-lg border border-slate-800/80">
                          {selectedPR.body}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500 italic">{t.docs.noDocsFound}</p>
                      )}
                    </div>

                    {/* Labels */}
                    {selectedPR.labels && selectedPR.labels.length > 0 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-400">{t.kanban.labels}:</span>
                        {selectedPR.labels.map((label) => (
                          <span
                            key={label}
                            className="px-2.5 py-0.5 rounded-full text-[11px] bg-slate-800 border border-slate-700 text-slate-300"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  /* Diff View */
                  <div className="flex flex-col h-full">
                    {prDiffContent ? (
                      <div className="bg-ph-base border border-slate-800 rounded-lg p-4 font-mono text-xs overflow-x-auto leading-relaxed text-slate-300">
                        <pre className="whitespace-pre">
                          {prDiffContent.split('\n').map((line, idx) => {
                            const isAdded = line.startsWith('+') && !line.startsWith('+++');
                            const isRemoved = line.startsWith('-') && !line.startsWith('---');
                            const isHeader = line.startsWith('diff --git') || line.startsWith('@@');

                            return (
                              <div
                                key={idx}
                                className={`${
                                  isAdded
                                    ? 'bg-emerald-500/10 text-emerald-300 px-1 -mx-1'
                                    : isRemoved
                                    ? 'bg-rose-500/10 text-rose-300 px-1 -mx-1'
                                    : isHeader
                                    ? 'text-indigo-400 font-semibold mt-2'
                                    : 'text-slate-400'
                                }`}
                              >
                                {line}
                              </div>
                            );
                          })}
                        </pre>
                      </div>
                    ) : (
                      <div className="p-8 text-center text-xs text-slate-500">
                        <FileCode className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                        {t.git.noChanges}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-slate-500">
              <GitPullRequest className="w-12 h-12 text-slate-700 mb-3" />
              <h3 className="text-sm font-semibold text-slate-300 mb-1">{t.pr.noPRSelected}</h3>
              <p className="text-xs text-slate-500 max-w-sm">
                {t.pr.noPRSelected}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create PR Modal */}
      <CreatePRModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </div>
  );
};
