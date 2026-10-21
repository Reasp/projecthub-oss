import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { drawDiscNodeLabel, type NodeHoverDrawingFunction } from 'sigma/rendering';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { ExternalLink, Loader2, Maximize2, Pause, Play, RefreshCw, Search, X, ZoomIn, ZoomOut } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import type { ProjectGraph, ProjectGraphNode } from '../../types/electron';
import {
  colorForType,
  cooledSlowDown,
  countTypes,
  defaultHiddenTypes,
  fa2Settings,
  initialPositions,
  layoutMovement,
  labelVisibleAtZoom,
  NODE_SCALE,
  nodeSize,
  orderedProps,
  graphLayoutKey,
  PRESETTLE_FULL_ITERATIONS,
  presettleIterations,
  searchNodes,
  SETTLE_SAMPLE_MS,
  SETTLED_MOVEMENT,
  snapshotPositions,
  type Fa2Settings,
  type GraphKind
} from '../../lib/graphView';

interface NodeAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeType: string;
}

interface EdgeAttrs {
  size: number;
  color: string;
  edgeType: string;
}

export interface GraphExplorerProps {
  kind: GraphKind;
  graph: ProjectGraph;
  /** Корень проекта — для «Открыть в VS Code» по `filePath` узла кода. */
  projectPath: string;
  nodeColors?: Record<string, string>;
  edgeColors?: Record<string, string>;
  /** Подпись под заголовком: размер графа, дата индекса. */
  subtitle: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  onReload: () => void;
  /** Дополнительные кнопки в шапке — переиндексация и настройка индексации графа кода (TASK-176). */
  actions?: React.ReactNode;
  /** Подписи типов узлов и связей в легенде, поиске и панели (граф связей документации, TASK-175). */
  typeLabels?: Record<string, string>;
  /** Связи направленные — в списке связей стрелки «→/←». У графа кода всегда так. */
  directed?: boolean;
  /** Открыть объект узла в ProjectHub: кнопка в панели и двойной клик по узлу. */
  onOpenNode?: (node: ProjectGraphNode) => void;
  /** Можно ли открыть узел (у неразрешённой ссылки открывать нечего). */
  canOpenNode?: (node: ProjectGraphNode) => boolean;
  /** Узел, выделенный при открытии, — «Показать на графе» из документа. */
  initialFocus?: string | null;
  /** Переключатель «Скрыть узлы без связей» в легенде, как в графе Obsidian. */
  orphanToggle?: boolean;
  /** Заголовок над вкладкой режимов (связи / сущности LightRAG). */
  modeSwitch?: React.ReactNode;
}

/** Общая пустая таблица цветов: новый `{}` на каждый рендер пересоздавал бы граф и рендерер. */
const NO_COLORS: Record<string, string> = {};
const DIM_NODE = '#334155';
const FOCUS_EDGE = 'rgba(226, 232, 240, 0.75)';
/** Верхний предел раскладки в воркере: крупный граф кода сходится дольше. Обычно она останавливается раньше, когда граф улёгся. */
const LAYOUT_MS = { code: 20_000, docs: 5_000, links: 8_000 } as const;

/**
 * Параметры воркера ForceAtlas2. Супервизор отправляет `settings` в воркер с каждым запросом итераций, поэтому
 * охлаждение меняет `slowDown` на ходу, не перезапуская раскладку. Поля нет в типах пакета — версия закреплена.
 */
function workerSettings(layout: FA2Layout<NodeAttrs, EdgeAttrs>): Fa2Settings | undefined {
  return (layout as unknown as { settings?: Fa2Settings }).settings;
}

/** Координаты разложенных графов на время сессии: повторное открытие вкладки — сразу готовый граф. */
const layoutCache = new Map<string, Map<string, { x: number; y: number }>>();
const LAYOUT_CACHE_SIZE = 8;

function rememberLayout(key: string, graph: Graph<NodeAttrs, EdgeAttrs>) {
  const positions = new Map<string, { x: number; y: number }>();
  graph.forEachNode((node, attrs) => positions.set(node, { x: attrs.x, y: attrs.y }));
  layoutCache.delete(key);
  layoutCache.set(key, positions);
  if (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value as string);
}
const MAX_LISTED_NEIGHBORS = 80;

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = Number.parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Подсказка при наведении в тёмной теме: стандартная рисует белую плашку, на которой не видно светлый текст. */
const drawDarkHover: NodeHoverDrawingFunction<NodeAttrs, EdgeAttrs> = (ctx, data, settings) => {
  const size = settings.labelSize;
  ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e2e8f0';
  ctx.stroke();
  const label = data.label ?? '';
  if (!label) return;
  const pad = 4;
  const x = data.x + data.size + 6;
  const width = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
  ctx.beginPath();
  ctx.roundRect(x - pad, data.y - size / 2 - pad, width + pad * 2, size + pad * 2, 4);
  ctx.fill();
  ctx.fillStyle = '#f1f5f9';
  ctx.fillText(label, x, data.y + size / 3);
};

/**
 * Интерактивный граф проекта (TASK-167, decision-118): sigma.js на WebGL и ForceAtlas2 в воркере — тот же
 * стек, что у web UI GitNexus и LightRAG. Легенда скрывает типы узлов и связей, поиск ведёт камеру к узлу,
 * наведение и выбор подсвечивают соседей, панель справа показывает свойства и связи выбранного узла.
 */
export const GraphExplorer: React.FC<GraphExplorerProps> = ({
  kind,
  graph,
  projectPath,
  nodeColors = NO_COLORS,
  edgeColors = NO_COLORS,
  subtitle,
  title,
  icon: Icon,
  onReload,
  actions,
  typeLabels,
  directed = kind === 'code',
  onOpenNode,
  canOpenNode,
  initialFocus,
  orphanToggle = false,
  modeSwitch
}) => {
  const { t } = useTranslation();
  const g = t.graph;
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const graphRef = useRef<Graph<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutRef = useRef<FA2Layout<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutTimer = useRef<number | null>(null);

  const nodeTypes = useMemo(() => countTypes(graph.nodes), [graph]);
  const edgeTypes = useMemo(() => countTypes(graph.edges), [graph]);
  const initialHidden = useMemo(() => defaultHiddenTypes(kind, nodeTypes.map((s) => s.type)), [kind, nodeTypes]);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(initialHidden);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(() => (initialFocus && graph.nodes.some((n) => n.id === initialFocus) ? initialFocus : null));
  const [hideOrphans, setHideOrphans] = useState(false);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [settling, setSettling] = useState(false);
  const typeLabel = useCallback((type: string) => typeLabels?.[type] ?? type, [typeLabels]);
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;
  const canOpenNodeRef = useRef(canOpenNode);
  canOpenNodeRef.current = canOpenNode;
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  // Редьюсеры sigma читают состояние из ref: перерисовка без пересоздания рендерера.
  const hiddenTypesRef = useRef(hiddenTypes);
  const hiddenEdgeTypesRef = useRef(hiddenEdgeTypes);
  const hideOrphansRef = useRef(hideOrphans);
  const focusRef = useRef<{ node: string | null; neighbors: Set<string> }>({ node: null, neighbors: new Set() });
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const nodeColor = useCallback((type: string) => colorForType(type, nodeColors), [nodeColors]);
  const edgeColor = useCallback(
    (type: string) => (edgeColors !== NO_COLORS ? colorForType(type, edgeColors) : '#94a3b8'),
    [edgeColors]
  );

  const refreshFocus = useCallback(() => {
    const focus = hoveredRef.current ?? selectedRef.current;
    const gr = graphRef.current;
    focusRef.current = {
      node: focus,
      neighbors: focus && gr?.hasNode(focus) ? new Set(gr.neighbors(focus)) : new Set()
    };
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, []);

  const stopLayout = useCallback(() => {
    if (layoutTimer.current !== null) window.clearInterval(layoutTimer.current);
    layoutTimer.current = null;
    layoutRef.current?.stop();
    setLayoutRunning(false);
  }, []);

  // Раскладка в воркере охлаждается к концу отведённого времени и останавливается, как только узлы перестали
  // заметно двигаться (TASK-182): у ForceAtlas2 нет своей остановки, без этого узлы дрожат до таймера.
  const startLayout = useCallback(
    (ms: number) => {
      const layout = layoutRef.current;
      const gr = graphRef.current;
      if (!layout || !gr) return;
      const settings = workerSettings(layout);
      const base = settings?.slowDown ?? 1;
      if (settings) settings.slowDown = base;
      layout.start();
      setLayoutRunning(true);
      if (layoutTimer.current !== null) window.clearInterval(layoutTimer.current);
      const startedAt = performance.now();
      let prev = snapshotPositions(gr);
      layoutTimer.current = window.setInterval(() => {
        const progress = (performance.now() - startedAt) / ms;
        const next = snapshotPositions(gr);
        const settled = layoutMovement(prev, next) < SETTLED_MOVEMENT;
        prev = next;
        if (progress >= 1 || settled) {
          if (settings) settings.slowDown = base;
          stopLayout();
          return;
        }
        if (settings) settings.slowDown = cooledSlowDown(base, progress);
      }, SETTLE_SAMPLE_MS);
    },
    [stopLayout]
  );

  // Построение графа и рендерера — один раз на загруженный граф.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const gr = new Graph<NodeAttrs, EdgeAttrs>({ type: directed ? 'directed' : 'undirected', multi: false, allowSelfLoops: false });
    const positions = initialPositions(graph);
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    for (const n of graph.nodes) {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      gr.addNode(n.id, {
        x: pos.x,
        y: pos.y,
        size: nodeSize(kind, n.type, degree.get(n.id) ?? 0),
        color: nodeColor(n.type),
        label: n.label,
        nodeType: n.type
      });
    }
    const maxWeight = graph.edges.reduce((m, e) => Math.max(m, e.weight ?? 1), 1);
    for (const e of graph.edges) {
      if (!gr.hasNode(e.source) || !gr.hasNode(e.target) || gr.hasEdge(e.source, e.target)) continue;
      gr.addEdge(e.source, e.target, {
        size: NODE_SCALE * (kind === 'code' ? 0.6 : kind === 'links' ? 0.5 + 1.5 * ((e.weight ?? 1) / maxWeight) : 1 + 2 * ((e.weight ?? 1) / maxWeight)),
        color: withAlpha(edgeColor(e.type), kind === 'code' ? 0.35 : kind === 'links' ? 0.4 : 0.55),
        edgeType: e.type
      });
    }
    graphRef.current = gr;

    const settings = fa2Settings(gr.order, kind);
    const layout = new FA2Layout(gr, { settings: { ...settings } });
    layoutRef.current = layout;
    const cacheKey = graphLayoutKey(kind, graph);
    const cached = layoutCache.get(cacheKey);
    if (cached) gr.updateEachNodeAttributes((node, attrs) => ({ ...attrs, ...(cached.get(node) ?? {}) }));
    const presettle = cached ? 0 : presettleIterations(gr.order);
    let renderer: Sigma<NodeAttrs, EdgeAttrs> | null = null;

    const mount = (settled: boolean) => {
      const big = gr.order > 2000;
      const labelThreshold = NODE_SCALE * (kind === 'code' ? 9 : kind === 'links' ? 8 : 5);
      const r = new Sigma<NodeAttrs, EdgeAttrs>(gr, container, {
        allowInvalidContainer: true,
        zIndex: true,
        hideEdgesOnMove: big,
        labelColor: { color: '#cbd5e1' },
        labelSize: 11,
        labelFont: 'Inter, "Segoe UI", system-ui, sans-serif',
        // Порог подписи проверяет `drawLabel` с учётом зума: размер узла на экране постоянен.
        labelRenderedSizeThreshold: 0,
        labelDensity: kind === 'code' ? 0.5 : kind === 'links' ? 0.7 : 1,
        defaultDrawNodeHover: drawDarkHover,
        defaultDrawNodeLabel: (ctx, data, settings) => {
          // sigma рисует первый кадр ещё в конструкторе, до присваивания рендерера: тогда зум исходный, 1.
          const ratio = sigmaRef.current?.getCamera().getState().ratio ?? 1;
          if (!data.forceLabel && !labelVisibleAtZoom(data.size, labelThreshold, ratio)) return;
          drawDiscNodeLabel(ctx, data, settings);
        },
        // Размер узлов и связей на экране не зависит от зума (TASK-183): приближение раздвигает узлы,
        // а не раздувает их вместе с расстояниями.
        zoomToSizeRatioFunction: () => 1,
        minCameraRatio: 0.02,
        maxCameraRatio: 20,
        nodeReducer: (node, data) => {
          if (hiddenTypesRef.current.has(data.nodeType)) return { ...data, hidden: true };
          if (hideOrphansRef.current && gr.degree(node) === 0) return { ...data, hidden: true };
          const { node: focus, neighbors } = focusRef.current;
          if (!focus) return data;
          if (node === focus) return { ...data, highlighted: true, forceLabel: true, zIndex: 2 };
          if (neighbors.has(node)) return { ...data, forceLabel: neighbors.size <= 40, zIndex: 1 };
          return { ...data, color: DIM_NODE, label: '', zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          if (hiddenEdgeTypesRef.current.has(data.edgeType)) return { ...data, hidden: true };
          const [source, target] = gr.extremities(edge);
          const hidden = hiddenTypesRef.current;
          if (hidden.has(gr.getNodeAttribute(source, 'nodeType')) || hidden.has(gr.getNodeAttribute(target, 'nodeType'))) {
            return { ...data, hidden: true };
          }
          const focus = focusRef.current.node;
          if (!focus) return data;
          // В фокусе остаются только связи выбранного узла: на крупном графе остальное — шум.
          if (source === focus || target === focus) return { ...data, color: FOCUS_EDGE, size: Math.max(1.2, data.size), zIndex: 1 };
          return { ...data, hidden: true };
        }
      });
      renderer = r;
      sigmaRef.current = r;
      // Рамка разложенного графа фиксируется: иначе sigma на каждом кадре раскладки заново вписывает граф
      // в экран, и он «дышит» масштабом. Недоразложенный граф ещё расходится — ему рамка не нужна.
      if (settled) r.setCustomBBox(r.getBBox());

      r.on('enterNode', ({ node }) => {
        hoveredRef.current = node;
        container.style.cursor = 'pointer';
        refreshFocus();
      });
      r.on('leaveNode', () => {
        hoveredRef.current = null;
        container.style.cursor = '';
        refreshFocus();
      });
      r.on('clickNode', ({ node }) => setSelected(node));
      r.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
        const open = onOpenNodeRef.current;
        const target = graph.nodes.find((n) => n.id === node);
        if (!open || !target || canOpenNodeRef.current?.(target) === false) return;
        preventSigmaDefault();
        open(target);
      });
      r.on('clickStage', () => setSelected(null));
      setSettling(false);
      if (!settled) startLayout(LAYOUT_MS[kind]);
    };

    // Граф раскладывается в воркере до показа (TASK-182): пользователь видит индикатор, а потом неподвижный граф,
    // а не распутывание на глазах. Охлаждение идёт по номеру итерации — воркер присылает узлы после каждой.
    let onIteration: (() => void) | null = null;
    if (presettle > 0) {
      setSettling(true);
      const live = workerSettings(layout);
      let done = 0;
      const iterationHandler = () => {
        done++;
        if (live) live.slowDown = cooledSlowDown(settings.slowDown, done / presettle);
        if (done < presettle) return;
        gr.removeListener('eachNodeAttributesUpdated', iterationHandler);
        onIteration = null;
        layout.stop();
        if (live) live.slowDown = settings.slowDown;
        const full = presettle >= PRESETTLE_FULL_ITERATIONS;
        if (full) rememberLayout(cacheKey, gr);
        mount(full);
      };
      onIteration = iterationHandler;
      gr.on('eachNodeAttributesUpdated', iterationHandler);
      layout.start();
    } else {
      mount(Boolean(cached));
    }

    return () => {
      if (onIteration) gr.removeListener('eachNodeAttributesUpdated', onIteration);
      if (layoutTimer.current !== null) window.clearInterval(layoutTimer.current);
      layoutTimer.current = null;
      layout.kill();
      layoutRef.current = null;
      renderer?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [graph, kind, directed, nodeColor, edgeColor, refreshFocus, startLayout]);

  useEffect(() => {
    hiddenTypesRef.current = hiddenTypes;
    hiddenEdgeTypesRef.current = hiddenEdgeTypes;
    hideOrphansRef.current = hideOrphans;
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [hiddenTypes, hiddenEdgeTypes, hideOrphans]);

  useEffect(() => {
    selectedRef.current = selected;
    refreshFocus();
  }, [selected, refreshFocus]);

  const focusNode = useCallback(
    (id: string) => {
      const gr = graphRef.current;
      const renderer = sigmaRef.current;
      if (!gr?.hasNode(id) || !renderer) return;
      const type = gr.getNodeAttribute(id, 'nodeType');
      if (hiddenTypesRef.current.has(type)) {
        setHiddenTypes((prev) => {
          const next = new Set(prev);
          next.delete(type);
          return next;
        });
      }
      setSelected(id);
      const display = renderer.getNodeDisplayData(id);
      // Масштаб по размеру графа: в клубке из тысяч узлов нужен крупный план, в графе из десятков — обзор соседей.
      const target = gr.order > 2000 ? 0.12 : gr.order > 300 ? 0.35 : 0.7;
      const camera = renderer.getCamera();
      if (display) void camera.animate({ x: display.x, y: display.y, ratio: Math.min(camera.getState().ratio, target) }, { duration: 500 });
    },
    []
  );

  // «Показать на графе»: камера едет к узлу, как только граф показан, и ещё раз после остановки раскладки
  // на экране — за это время узел успевает сместиться.
  useEffect(() => {
    if (!initialFocus || settling) return;
    const timers = [300, LAYOUT_MS[kind] + 300].map((ms) => window.setTimeout(() => focusNode(initialFocus), ms));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [initialFocus, focusNode, kind, settling]);

  const results = useMemo(() => (searchOpen ? searchNodes(graph.nodes, query, 20) : []), [graph, query, searchOpen]);

  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const zoom = (factor: number) => {
    const camera = sigmaRef.current?.getCamera();
    if (camera) void camera.animate({ ratio: camera.getState().ratio * factor }, { duration: 250 });
  };

  const selectedNode = useMemo(() => (selected ? graph.nodes.find((n) => n.id === selected) ?? null : null), [graph, selected]);

  // Связи считаются по данным, а не по экземпляру graphology: узел, выделенный при открытии
  // («Показать на графе»), выбран раньше, чем построен граф рендерера.
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const connections = useMemo(() => {
    if (!selected || !nodeById.has(selected)) return [];
    const list: { id: string; label: string; type: string; edgeType: string; outgoing: boolean }[] = [];
    const seen = new Set<string>();
    for (const e of graph.edges) {
      if (e.source !== selected && e.target !== selected) continue;
      const other: string = e.source === selected ? e.target : e.source;
      const node = nodeById.get(other);
      // Дубли пар и петли рендерер отбрасывает — список повторяет то, что нарисовано.
      const key = directed ? `${e.source}|${e.target}` : [e.source, e.target].sort().join('|');
      if (!node || other === selected || seen.has(key)) continue;
      seen.add(key);
      list.push({ id: other, label: node.label, type: node.type, edgeType: e.type, outgoing: e.source === selected });
    }
    return list.sort((a, b) => a.edgeType.localeCompare(b.edgeType) || a.label.localeCompare(b.label));
  }, [graph, nodeById, selected, directed]);

  const selectedEdges = useMemo(
    () => (selected && kind === 'docs' ? graph.edges.filter((e) => e.source === selected || e.target === selected) : []),
    [graph, kind, selected]
  );

  const filePath = selectedNode ? selectedNode.props.filePath : undefined;
  const iconButton = 'ph-icon-button';

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-ph-panel">
      <div className="px-4 py-2.5 border-b border-slate-800/80 flex items-center gap-3 shrink-0">
        <Icon className="w-4 h-4 text-indigo-400 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white leading-tight">{title}</h2>
          <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>
        </div>

        {modeSwitch}

        <div className="relative ml-auto w-72 max-w-[40%]">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                focusNode(results[0].id);
                setSearchOpen(false);
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
              }
            }}
            placeholder={g.searchPlaceholder}
            className="w-full pl-8 pr-2 py-1.5 rounded-md bg-slate-900/80 border border-slate-700/70 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
            data-testid="graph-search"
          />
          {searchOpen && query.trim() && (
            <div className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto custom-scrollbar rounded-md border border-slate-700 bg-slate-900 shadow-xl">
              {results.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">{g.noResults}</div>}
              {results.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    focusNode(n.id);
                    setSearchOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-ph-hover"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: nodeColor(n.type) }} />
                  <span className="text-xs text-slate-200 truncate">{n.label}</span>
                  <span className="text-[10px] text-slate-500 shrink-0 ml-auto">{typeLabel(n.type)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {actions}
          <button type="button" className={iconButton} onClick={() => zoom(1 / 1.5)} title={g.zoomIn}>
            <ZoomIn className="w-4 h-4" />
          </button>
          <button type="button" className={iconButton} onClick={() => zoom(1.5)} title={g.zoomOut}>
            <ZoomOut className="w-4 h-4" />
          </button>
          <button type="button" className={iconButton} onClick={() => void sigmaRef.current?.getCamera().animatedReset({ duration: 300 })} title={g.fit}>
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            className={iconButton}
            onClick={() => (layoutRunning ? stopLayout() : startLayout(LAYOUT_MS[kind]))}
            disabled={settling}
            title={layoutRunning ? g.layoutStop : g.layoutRun}
            data-testid="graph-layout-toggle"
          >
            {layoutRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button type="button" className={iconButton} onClick={onReload} title={g.refresh}>
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative overflow-hidden bg-[#0b1120]">
          <div ref={containerRef} className="absolute inset-0" data-testid="graph-canvas" />
          {settling && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" data-testid="graph-settling">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
              <p className="text-xs text-slate-400">{g.layingOut}</p>
            </div>
          )}
        </div>

        <aside className="w-72 shrink-0 border-l border-slate-800/80 overflow-y-auto custom-scrollbar bg-ph-panel">
          {selectedNode ? (
            <div className="p-3 space-y-3" data-testid="graph-node-details">
              <div className="flex items-start gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={{ background: nodeColor(selectedNode.type) }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-100 break-words">{selectedNode.label}</div>
                  <div className="text-[11px] text-slate-500">{typeLabel(selectedNode.type)}</div>
                </div>
                <button type="button" className={iconButton} onClick={() => setSelected(null)} title={t.common.close}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              {onOpenNode && canOpenNode?.(selectedNode) !== false && (
                <button
                  type="button"
                  onClick={() => onOpenNode(selectedNode)}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs text-white"
                  data-testid="graph-open-node"
                >
                  {g.openNode}
                </button>
              )}

              {typeof filePath === 'string' && (
                <button
                  type="button"
                  onClick={() => void window.api?.openInCode?.(`${projectPath}/${filePath}`)}
                  className="flex items-center gap-1.5 text-[11px] text-indigo-300 hover:text-indigo-200"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {g.openFile}
                </button>
              )}

              <dl className="space-y-1.5">
                {orderedProps(selectedNode.props).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500">{key}</dt>
                    <dd className="text-xs text-slate-300 break-words whitespace-pre-wrap font-mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>

              {selectedEdges.some((e) => e.description) && (
                <div className="space-y-1.5">
                  {selectedEdges
                    .filter((e) => e.description)
                    .slice(0, 20)
                    .map((e) => (
                      <p key={`${e.source}|${e.target}`} className="text-[11px] text-slate-400 leading-snug">
                        <span className="text-slate-300">{e.source === selected ? e.target : e.source}:</span> {e.description}
                      </p>
                    ))}
                </div>
              )}

              <div>
                <h3 className="ph-section-title mb-1">
                  {g.connections} <span className="text-slate-600">{connections.length}</span>
                </h3>
                <div className="space-y-px">
                  {connections.slice(0, MAX_LISTED_NEIGHBORS).map((c) => (
                    <button
                      key={`${c.id}|${c.edgeType}|${c.outgoing}`}
                      type="button"
                      onClick={() => focusNode(c.id)}
                      className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-ph-hover text-left"
                    >
                      <span className="text-[10px] text-slate-500 w-4 shrink-0">{directed ? (c.outgoing ? '→' : '←') : '–'}</span>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: nodeColor(c.type) }} />
                      <span className="text-xs text-slate-300 truncate">{c.label}</span>
                      <span className="text-[10px] text-slate-600 shrink-0 ml-auto truncate max-w-[40%]">{typeLabel(c.edgeType)}</span>
                    </button>
                  ))}
                  {connections.length > MAX_LISTED_NEIGHBORS && (
                    <p className="text-[11px] text-slate-500 px-1.5 pt-1">
                      {g.moreConnections.replace('{n}', String(connections.length - MAX_LISTED_NEIGHBORS))}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 space-y-4" data-testid="graph-legend">
              <section>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="ph-section-title">{g.nodeTypes}</h3>
                  <div className="flex gap-2 text-[11px]">
                    <button type="button" className="text-indigo-300 hover:text-indigo-200" onClick={() => setHiddenTypes(new Set())}>
                      {g.showAll}
                    </button>
                    {kind === 'code' && (
                      <button type="button" className="text-indigo-300 hover:text-indigo-200" onClick={() => setHiddenTypes(initialHidden)}>
                        {g.defaults}
                      </button>
                    )}
                  </div>
                </div>
                <div className="space-y-px">
                  {nodeTypes.map(({ type, count }) => {
                    const off = hiddenTypes.has(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setHiddenTypes((prev) => toggle(prev, type))}
                        className={`w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-ph-hover text-left ${off ? 'opacity-40' : ''}`}
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: nodeColor(type) }} />
                        <span className="text-xs text-slate-300 truncate">{typeLabel(type)}</span>
                        <span className="text-[11px] text-slate-500 ml-auto tabular-nums">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {orphanToggle && (
                <label className="flex items-center gap-2 px-1.5 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={hideOrphans}
                    onChange={(e) => setHideOrphans(e.target.checked)}
                    className="rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0 focus:ring-offset-0"
                    data-testid="graph-hide-orphans"
                  />
                  {g.hideOrphans}
                </label>
              )}

              {edgeTypes.length > 1 && (
                <section>
                  <h3 className="ph-section-title mb-1">{g.edgeTypes}</h3>
                  <div className="space-y-px">
                    {edgeTypes.slice(0, 30).map(({ type, count }) => {
                      const off = hiddenEdgeTypes.has(type);
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setHiddenEdgeTypes((prev) => toggle(prev, type))}
                          className={`w-full flex items-center gap-2 px-1.5 py-1 rounded hover:bg-ph-hover text-left ${off ? 'opacity-40' : ''}`}
                        >
                          <span className="w-3 h-0.5 rounded shrink-0" style={{ background: edgeColor(type) }} />
                          <span className="text-xs text-slate-300 truncate">{typeLabel(type)}</span>
                          <span className="text-[11px] text-slate-500 ml-auto tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
