/**
 * Чистая логика вкладок графов (TASK-167, decision-118): цвета и размеры узлов, фильтры по умолчанию,
 * поиск и начальная раскладка. Без React и sigma — покрыто unit-тестами.
 */
import type { ProjectGraph, ProjectGraphNode } from '../types/electron';

/** Палитра узлов web UI GitNexus 1.6 — граф кода выглядит так же, как в его интерфейсе. */
export const GITNEXUS_NODE_COLORS: Record<string, string> = {
  Project: '#a855f7',
  Package: '#8b5cf6',
  Module: '#7c3aed',
  Folder: '#6366f1',
  File: '#3b82f6',
  Class: '#f59e0b',
  Function: '#10b981',
  Method: '#14b8a6',
  Variable: '#64748b',
  Interface: '#ec4899',
  Enum: '#f97316',
  Decorator: '#eab308',
  Import: '#475569',
  Type: '#a78bfa',
  CodeElement: '#64748b',
  Section: '#60a5fa',
  Struct: '#f59e0b',
  Trait: '#ec4899',
  Impl: '#14b8a6',
  TypeAlias: '#a78bfa',
  Const: '#64748b',
  Static: '#64748b',
  Namespace: '#7c3aed',
  Union: '#f97316',
  Typedef: '#a78bfa',
  Macro: '#eab308',
  Property: '#64748b',
  Record: '#f59e0b',
  Delegate: '#14b8a6',
  Annotation: '#eab308',
  Constructor: '#10b981',
  Template: '#a78bfa',
  Route: '#f43f5e',
  Tool: '#a855f7'
};

/** Базовые размеры узлов GitNexus: структура крупнее символов. */
const GITNEXUS_NODE_SIZES: Record<string, number> = {
  Project: 20,
  Package: 16,
  Module: 13,
  Namespace: 13,
  Folder: 10,
  Section: 8,
  Class: 8,
  Struct: 8,
  Record: 8,
  Interface: 7,
  Trait: 7,
  File: 6,
  Enum: 5,
  Route: 5,
  Tool: 5,
  Function: 4,
  Constructor: 4
};

/** Цвета связей GitNexus; остальные типы — нейтральные. */
export const GITNEXUS_EDGE_COLORS: Record<string, string> = {
  CONTAINS: '#2d5a3d',
  DEFINES: '#0e7490',
  IMPORTS: '#1d4ed8',
  CALLS: '#7c3aed',
  EXTENDS: '#c2410c',
  IMPLEMENTS: '#be185d',
  HAS_METHOD: '#0e7490',
  HAS_PROPERTY: '#2d5a3d'
};

/** Типы, которые web UI GitNexus показывает при открытии; Section, Variable и прочее мелкое скрыто. */
export const GITNEXUS_DEFAULT_VISIBLE = new Set([
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Property',
  'Const',
  'Interface',
  'Enum',
  'Type'
]);

/** Палитра для типов, которых нет в таблице (сущности LightRAG, новые метки GitNexus). */
const FALLBACK_PALETTE = [
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#f87171',
  '#2dd4bf',
  '#fb923c',
  '#a3e635',
  '#38bdf8',
  '#e879f9',
  '#facc15'
];

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Цвет типа: из таблицы, иначе стабильный цвет палитры по имени типа — одинаковый между запусками. */
export function colorForType(type: string, table: Record<string, string> = {}): string {
  return table[type] ?? FALLBACK_PALETTE[hashString(type) % FALLBACK_PALETTE.length];
}

/** `docs` — граф сущностей LightRAG, `links` — граф ссылок документации (TASK-175, decision-134). */
export type GraphKind = 'code' | 'docs' | 'links';

/** Размер узла: базовый по типу (для кода) плюс логарифм степени — хабы заметнее, но не заслоняют граф. */
export function nodeSize(kind: GraphKind, type: string, degree: number): number {
  // Граф ссылок плотный (сотни узлов, тысячи связей): узлы мельче, иначе хабы слипаются в один клубок.
  if (kind === 'links') return Math.min(14, 3 + Math.log2(1 + Math.max(0, degree)) * 1.1);
  const base = kind === 'code' ? (GITNEXUS_NODE_SIZES[type] ?? 3) : 5;
  const bump = Math.log2(1 + Math.max(0, degree));
  return Math.min(kind === 'code' ? 24 : 28, base + bump * (kind === 'code' ? 0.8 : 2));
}

export interface TypeStat {
  type: string;
  count: number;
}

/** Типы по убыванию числа узлов (при равенстве — по имени), для легенды и фильтров. */
export function countTypes(items: { type: string }[]): TypeStat[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Скрытые при открытии типы: для кода — всё вне набора GitNexus по умолчанию, для документации — ничего. */
export function defaultHiddenTypes(kind: GraphKind, types: string[]): Set<string> {
  if (kind !== 'code') return new Set();
  const hidden = new Set(types.filter((t) => !GITNEXUS_DEFAULT_VISIBLE.has(t)));
  // Если ни одного типа из набора по умолчанию нет (другой язык, новая схема) — показываем всё.
  return hidden.size === types.length ? new Set() : hidden;
}

/**
 * Поиск узла по подписи и пути файла: сначала точное совпадение, затем начало подписи, затем вхождение
 * в подпись, затем вхождение в путь. Регистр не важен.
 */
export function searchNodes(nodes: ProjectGraphNode[], query: string, limit = 20): ProjectGraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { node: ProjectGraphNode; score: number }[] = [];
  for (const node of nodes) {
    const label = node.label.toLowerCase();
    let score = -1;
    if (label === q) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (label.includes(q)) score = 2;
    else {
      const file = node.props.filePath ?? node.props.file_path;
      if (typeof file === 'string' && file.toLowerCase().includes(q)) score = 3;
    }
    if (score >= 0) scored.push({ node, score });
  }
  scored.sort((a, b) => a.score - b.score || a.node.label.length - b.node.label.length || a.node.label.localeCompare(b.node.label));
  return scored.slice(0, limit).map((s) => s.node);
}

/** Детерминированный ГПСЧ (mulberry32): одна и та же раскладка при каждом открытии вкладки. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Начальные координаты до ForceAtlas2. Узлы одного кластера (сообщество GitNexus) стартуют рядом, центры
 * кластеров — по спирали Ферма; так ForceAtlas2 сходится за секунды, а не распутывает случайное облако.
 * Узлы без кластера (файлы, папки, сущности LightRAG) раскладываются по той же спирали в общем облаке.
 */
export function initialPositions(graph: ProjectGraph, seed = 1): Map<string, { x: number; y: number }> {
  const rand = seededRandom(seed);
  const members = new Map<string, string[]>();
  const loose: string[] = [];
  for (const n of graph.nodes) {
    if (n.cluster) {
      const list = members.get(n.cluster);
      if (list) list.push(n.id);
      else members.set(n.cluster, [n.id]);
    } else {
      loose.push(n.id);
    }
  }

  const out = new Map<string, { x: number; y: number }>();
  const clusters = [...members.entries()].sort((a, b) => b[1].length - a[1].length);
  const spread = Math.sqrt(graph.nodes.length) * 10;
  clusters.forEach(([, ids], i) => {
    const r = spread * Math.sqrt((i + 0.5) / Math.max(1, clusters.length));
    const cx = r * Math.cos(i * GOLDEN_ANGLE);
    const cy = r * Math.sin(i * GOLDEN_ANGLE);
    const radius = Math.sqrt(ids.length) * 6;
    for (const id of ids) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * radius;
      out.set(id, { x: cx + d * Math.cos(a), y: cy + d * Math.sin(a) });
    }
  });
  loose.forEach((id, i) => {
    const r = spread * Math.sqrt((i + 0.5) / Math.max(1, loose.length));
    out.set(id, { x: r * Math.cos(i * GOLDEN_ANGLE) + rand(), y: r * Math.sin(i * GOLDEN_ANGLE) + rand() });
  });
  return out;
}

/**
 * Параметры ForceAtlas2 по размеру графа — те же ступени, что у web UI GitNexus 1.6. Чем больше граф, тем слабее
 * гравитация и сильнее отталкивание: иначе десятки тысяч узлов сжимаются в один плотный клубок.
 */
export function fa2Settings(order: number, kind: GraphKind = 'code') {
  if (kind === 'links') {
    // LinLog разводит группы связанных документов, как граф Obsidian; сильная гравитация не даёт
    // документам без связей улететь на край.
    return {
      gravity: 1,
      scalingRatio: 30,
      slowDown: 2,
      barnesHutOptimize: order > 200,
      barnesHutTheta: 0.6,
      strongGravityMode: true,
      outboundAttractionDistribution: true,
      linLogMode: true,
      adjustSizes: false,
      edgeWeightInfluence: 0.5
    };
  }
  const tiny = order < 500;
  const small = order >= 500 && order < 2000;
  const medium = order >= 2000 && order < 10000;
  return {
    gravity: tiny ? 0.8 : small ? 0.5 : medium ? 0.3 : 0.15,
    scalingRatio: tiny ? 15 : small ? 30 : medium ? 60 : 100,
    slowDown: tiny ? 1 : small ? 2 : medium ? 3 : 5,
    barnesHutOptimize: order > 200,
    barnesHutTheta: medium ? 0.8 : 0.6,
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1
  };
}

/** Порядок свойств в панели узла: путь и строки сначала, длинные описания — в конце. */
const PROP_ORDER = ['filePath', 'file_path', 'startLine', 'endLine', 'community', 'description', 'source_id', 'created_at'];

export function orderedProps(props: Record<string, string | number>): [string, string | number][] {
  const rank = (k: string) => {
    const i = PROP_ORDER.indexOf(k);
    // Неизвестные свойства — после сообщества, но до описания и источников.
    return i === -1 ? PROP_ORDER.indexOf('description') - 0.5 : i;
  };
  return Object.entries(props).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}
