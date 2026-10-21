import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Network, RefreshCw, ShareNetwork, Sliders } from '../common/icons';
import { samePath, useProjectStore } from '../../store/useProjectStore';
import { useTranslation } from '../../i18n/useTranslation';
import { useDocRefs } from '../../hooks/useDocRefs';
import { docRefKind } from '../../utils/docRefs';
import { DOC_EDGE_COLORS, DOC_KIND_COLORS } from '../../utils/docLinkGraph';
import type { ProjectGraph, ProjectGraphResult } from '../../types/electron';
import { GITNEXUS_EDGE_COLORS, GITNEXUS_NODE_COLORS, type GraphKind } from '../../lib/graphView';
import { GraphExplorer } from './GraphExplorer';
import { CodeIndexSettingsModal } from './CodeIndexSettingsModal';

type LoadState = { status: 'loading' } | { status: 'done'; result: ProjectGraphResult; loadId: number };

/** Имя процесса переиндексации в processManager (`GITNEXUS_ANALYZE_PROCESS` в codeIndexService). */
const ANALYZE_PROCESS = 'gitnexus-analyze';

/**
 * Переиндексация GitNexus из вкладки (TASK-176, decision-131): `gitnexus analyze --skip-agents-md --skip-skills`
 * через processManager. Завершение ловим по событию статуса процесса, а не по таймеру, и перечитываем граф.
 */
function useCodeReindex(projectPath: string, onDone: () => void) {
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath || !window.api?.onProcessStatusChanged) return;
    return window.api.onProcessStatusChanged((proc) => {
      if (proc.name !== ANALYZE_PROCESS || !samePath(proc.cwd, projectPath) || proc.status === 'running') return;
      setRunning(false);
      if (proc.status === 'failed') setFailed(String(proc.exitCode ?? ''));
      onDone();
    });
  }, [projectPath, onDone]);

  const start = useCallback(async () => {
    if (!projectPath || !window.api) return;
    setFailed(null);
    setRunning(true);
    const res = await window.api.codeIndexReindex(projectPath, false);
    if (!res.ok) {
      setRunning(false);
      setFailed(res.error);
      return;
    }
    // Процесс мог завершиться раньше, чем пришёл ответ: тогда события уже не будет.
    if (res.value.status !== 'running') {
      setRunning(false);
      if (res.value.status === 'failed') setFailed(String(res.value.exitCode ?? ''));
      onDone();
    }
  }, [projectPath, onDone]);

  return { running, failed, start };
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      if (!projectPath || !window.api) return;
      setState({ status: 'loading' });
      const result = kind === 'code' ? await window.api.getCodeGraph(projectPath, force) : await window.api.getDocsGraph(projectPath);
      setState({ status: 'done', result, loadId: Date.now() });
    },
    [kind, projectPath]
  );

  const reloadAfterIndex = useCallback(() => void load(true), [load]);
  const reindex = useCodeReindex(kind === 'code' ? projectPath : '', reloadAfterIndex);

  useEffect(() => {
    void load(false);
  }, [load]);

  const title = kind === 'code' ? g.codeTitle : g.docsTitle;
  const Icon = kind === 'code' ? Network : ShareNetwork;

  const settingsModal =
    kind === 'code' ? (
      <CodeIndexSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} projectPath={projectPath} onReindex={() => void reindex.start()} />
    ) : null;

  const reindexError = reindex.failed !== null ? <p className="text-[11px] text-rose-300 max-w-xl break-words">{g.reindexFailed}</p> : null;

  if (state.status === 'loading' || reindex.running) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-ph-panel" data-testid="graph-loading">
        <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
        <p className="text-xs text-slate-400">{reindex.running ? g.reindexing : kind === 'code' ? g.loadingCode : g.loadingDocs}</p>
        {settingsModal}
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
    // Индекс строится из вкладки, если GitNexus установлен: без CLI кнопка только упадёт.
    const canIndex = kind === 'code' && (result.ok || result.reason !== 'no-cli');
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-ph-panel px-6 text-center" data-testid="graph-empty">
        {result.ok || result.reason !== 'error' ? (
          <Icon className="w-10 h-10 text-slate-600 mb-1" />
        ) : (
          <AlertCircle className="w-8 h-8 text-rose-400 mb-1" />
        )}
        <p className="text-sm text-slate-300">{message}</p>
        {hint && <p className="text-[11px] text-slate-500 font-mono max-w-xl break-words">{hint}</p>}
        {reindexError}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {canIndex && (
            <>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
                data-testid="graph-index-settings"
              >
                <Sliders className="w-3.5 h-3.5" />
                {g.indexSettings}
              </button>
              <button
                type="button"
                onClick={() => void reindex.start()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs text-white"
                data-testid="graph-reindex"
              >
                <Network className="w-3.5 h-3.5" />
                {result.ok || result.reason !== 'no-index' ? g.reindex : g.buildIndex}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void load(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {g.retry}
          </button>
        </div>
        {settingsModal}
      </div>
    );
  }

  const stats = g.stats.replace('{nodes}', String(result.graph.nodes.length)).replace('{edges}', String(result.graph.edges.length));
  const at = result.indexedAt ? new Date(result.indexedAt) : null;
  const subtitle =
    at && !Number.isNaN(at.getTime())
      ? `${stats} · ${g.indexedAt.replace('{at}', at.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }))}`
      : stats;

  const iconButton = 'ph-icon-button';
  const actions =
    kind === 'code' ? (
      <>
        {reindex.failed !== null && <AlertCircle className="w-4 h-4 text-rose-400" aria-label={g.reindexFailed} />}
        <button type="button" className={iconButton} onClick={() => setSettingsOpen(true)} title={g.indexSettings} data-testid="graph-index-settings">
          <Sliders className="w-4 h-4" />
        </button>
        <button type="button" className={iconButton} onClick={() => void reindex.start()} title={g.reindex} data-testid="graph-reindex">
          <Network className="w-4 h-4" />
        </button>
      </>
    ) : undefined;

  return (
    <>
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
        actions={actions}
      />
      {settingsModal}
    </>
  );
};

export const CodeGraphView: React.FC = () => <ProjectGraphTab kind="code" />;

type DocsMode = 'links' | 'entities';

/**
 * «Граф документации» (TASK-175, decision-134): по умолчанию — граф ссылок между решениями, документами,
 * задачами и фактами памяти, без Python и LLM. Граф сущностей LightRAG — второй режим, переключатель
 * появляется, только если его индекс в проекте построен.
 */
export const DocsGraphView: React.FC = () => {
  const { t } = useTranslation();
  const g = t.graph;
  const projectPath = useProjectStore((s) => s.selectedProject?.path ?? '');
  const focusId = useProjectStore((s) => s.docsGraphFocusId);
  const nav = useDocRefs();
  const [mode, setMode] = useState<DocsMode>('links');
  const [entitiesReady, setEntitiesReady] = useState(false);
  const [links, setLinks] = useState<{ graph: ProjectGraph; loadId: number } | { error: string } | null>(null);

  const loadLinks = useCallback(async () => {
    if (!projectPath || !window.api) return;
    setLinks(null);
    try {
      setLinks({ graph: await window.api.getDocLinkGraph(projectPath), loadId: Date.now() });
    } catch (err) {
      setLinks({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [projectPath]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  // Есть ли граф LightRAG: без индекса режим не предлагаем (правило 7 infra-dev).
  useEffect(() => {
    let alive = true;
    setEntitiesReady(false);
    if (projectPath && window.api) {
      void window.api.getDocsGraph(projectPath).then((r) => {
        if (alive) setEntitiesReady(r.ok && r.graph.nodes.length > 0);
      });
    }
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // Фокус из «Показать на графе» одноразовый: при следующем открытии вкладки граф начинается с обзора.
  const [initialFocus] = useState(focusId);
  useEffect(() => {
    if (focusId) useProjectStore.getState().showOnDocsGraph(null);
  }, [focusId]);

  const typeLabels = useMemo<Record<string, string>>(() => ({ ...g.kinds }), [g.kinds]);

  const switcher = entitiesReady ? (
    <div className="flex items-center rounded-md border border-slate-700/70 overflow-hidden text-[11px] shrink-0" data-testid="docs-graph-mode">
      {(['links', 'entities'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={`px-2.5 py-1 ${mode === m ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-ph-hover'}`}
        >
          {m === 'links' ? g.modeLinks : g.modeEntities}
        </button>
      ))}
    </div>
  ) : null;

  if (mode === 'entities') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2 border-b border-slate-800/80 flex justify-end bg-ph-panel">{switcher}</div>
        <ProjectGraphTab kind="docs" />
      </div>
    );
  }

  if (!links) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-ph-panel" data-testid="graph-loading">
        <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
        <p className="text-xs text-slate-400">{g.loadingDocs}</p>
      </div>
    );
  }

  if ('error' in links || links.graph.nodes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-ph-panel px-6 text-center" data-testid="graph-empty">
        {'error' in links ? <AlertCircle className="w-8 h-8 text-rose-400 mb-1" /> : <ShareNetwork className="w-10 h-10 text-slate-600 mb-1" />}
        <p className="text-sm text-slate-300">{'error' in links ? g.loadError : g.linksEmpty}</p>
        <p className="text-[11px] text-slate-500 font-mono max-w-xl break-words">{'error' in links ? links.error : g.linksEmptyHint}</p>
        <button
          type="button"
          onClick={() => void loadLinks()}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {g.retry}
        </button>
      </div>
    );
  }

  const { graph } = links;
  const linked = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const subtitle = g.linksStats
    .replace('{nodes}', String(graph.nodes.length))
    .replace('{edges}', String(graph.edges.length))
    .replace('{orphans}', String(graph.nodes.filter((n) => !linked.has(n.id)).length));

  return (
    <GraphExplorer
      key={links.loadId}
      kind="links"
      graph={graph}
      projectPath={projectPath}
      nodeColors={DOC_KIND_COLORS}
      edgeColors={DOC_EDGE_COLORS}
      typeLabels={typeLabels}
      directed
      orphanToggle
      initialFocus={initialFocus}
      title={g.linksTitle}
      subtitle={subtitle}
      icon={ShareNetwork}
      modeSwitch={switcher}
      onReload={() => void loadLinks()}
      canOpenNode={(node) => node.type !== 'missing'}
      onOpenNode={(node) => {
        const kind = docRefKind(node.id);
        if (kind) nav.open({ kind, id: node.id, label: String(node.props.id ?? node.id), wiki: true });
      }}
    />
  );
};
