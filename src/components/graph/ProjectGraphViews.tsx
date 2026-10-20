import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Network, RefreshCw, ShareNetwork } from '../common/icons';
import { useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { ProjectGraphResult } from '../../types/electron';
import { GITNEXUS_EDGE_COLORS, GITNEXUS_NODE_COLORS, type GraphKind } from '../../lib/graphView';
import { GraphExplorer } from './GraphExplorer';

type LoadState = { status: 'loading' } | { status: 'done'; result: ProjectGraphResult; loadId: number };

/**
 * Вкладки «Граф кода» и «Граф документации» (TASK-167, decision-118). Загрузка идёт через main: граф кода —
 * из `gitnexus serve`, граф документации — из GraphML LightRAG. Пока данных нет, показываем понятную причину
 * и команду, которая её устраняет; LightRAG при выключенной фиче не предлагается (правило 7 infra-dev).
 */
const ProjectGraphTab: React.FC<{ kind: GraphKind }> = ({ kind }) => {
  const { t, language } = useTranslation();
  const g = t.graph;
  const projectPath = useProjectStore((s) => s.selectedProject?.path ?? '');
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(
    async (force: boolean) => {
      if (!projectPath || !window.api) return;
      setState({ status: 'loading' });
      const result = kind === 'code' ? await window.api.getCodeGraph(projectPath, force) : await window.api.getDocsGraph(projectPath);
      setState({ status: 'done', result, loadId: Date.now() });
    },
    [kind, projectPath]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const title = kind === 'code' ? g.codeTitle : g.docsTitle;
  const Icon = kind === 'code' ? Network : ShareNetwork;

  if (state.status === 'loading') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-ph-panel" data-testid="graph-loading">
        <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
        <p className="text-xs text-slate-400">{kind === 'code' ? g.loadingCode : g.loadingDocs}</p>
      </div>
    );
  }

  const { result } = state;
  if (!result.ok || result.graph.nodes.length === 0) {
    let message: string = g.emptyGraph;
    let hint: string | undefined;
    if (!result.ok) {
      switch (result.reason) {
        case 'no-index':
          message = kind === 'code' ? g.codeNoIndex : g.docsNoIndex;
          hint = kind === 'code' ? g.codeNoIndexHint : g.docsNoIndexHint;
          break;
        case 'no-cli':
          message = g.codeNoCli;
          hint = g.codeNoCliHint;
          break;
        case 'not-registered':
          message = g.codeNotRegistered;
          hint = g.codeNotRegisteredHint;
          break;
        case 'disabled':
          message = g.docsDisabled;
          break;
        default:
          message = g.loadError;
          hint = result.error;
      }
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-ph-panel px-6 text-center" data-testid="graph-empty">
        {result.ok || result.reason !== 'error' ? (
          <Icon className="w-10 h-10 text-slate-600 mb-1" />
        ) : (
          <AlertCircle className="w-8 h-8 text-rose-400 mb-1" />
        )}
        <p className="text-sm text-slate-300">{message}</p>
        {hint && <p className="text-[11px] text-slate-500 font-mono max-w-xl break-words">{hint}</p>}
        <button
          type="button"
          onClick={() => void load(true)}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {g.retry}
        </button>
      </div>
    );
  }

  const stats = g.stats.replace('{nodes}', String(result.graph.nodes.length)).replace('{edges}', String(result.graph.edges.length));
  const at = result.indexedAt ? new Date(result.indexedAt) : null;
  const subtitle =
    at && !Number.isNaN(at.getTime())
      ? `${stats} · ${g.indexedAt.replace('{at}', at.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }))}`
      : stats;

  return (
    <GraphExplorer
      key={state.loadId}
      kind={kind}
      graph={result.graph}
      projectPath={projectPath}
      nodeColors={kind === 'code' ? GITNEXUS_NODE_COLORS : undefined}
      edgeColors={kind === 'code' ? GITNEXUS_EDGE_COLORS : undefined}
      title={title}
      subtitle={subtitle}
      icon={Icon}
      onReload={() => void load(true)}
    />
  );
};

export const CodeGraphView: React.FC = () => <ProjectGraphTab kind="code" />;
export const DocsGraphView: React.FC = () => <ProjectGraphTab kind="docs" />;
