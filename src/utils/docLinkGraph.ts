/**
 * Граф связей документации (TASK-175, decision-134): узлы — решения, документы, задачи и факты памяти, рёбра —
 * ссылки между ними. Ссылки разбирает тот же `collectRefs`, что и обратные ссылки (decision-69), поэтому граф
 * и блок «На этот документ ссылаются» не расходятся. Чистый модуль без React/Electron — покрыт unit-тестами.
 */
import { collectRefs, type DocLinkSource } from './docBacklinks';
import { docRefKind } from './docRefs';
import { normalizeSection } from './docTree';
import type { ProjectGraph, ProjectGraphEdge, ProjectGraphNode } from '../types/electron';

/** Вид узла графа: вид объекта Backlog.md либо цель вики-ссылки, которой нет в проекте. */
export type DocGraphNodeType = DocLinkSource['kind'] | 'missing';

/** Вид связи по убыванию силы: на одну пару узлов рисуется одна связь — самая сильная. */
export type DocGraphEdgeType = 'subtask' | 'dependency' | 'link' | 'mention';

const EDGE_STRENGTH: Record<DocGraphEdgeType, number> = { subtask: 3, dependency: 2, link: 1, mention: 0 };

/** Цвета видов — общие для графа ProjectHub и цветовых групп графа Obsidian (decision-133). */
export const DOC_KIND_COLORS: Record<DocGraphNodeType, string> = {
  decision: '#a78bfa',
  doc: '#38bdf8',
  task: '#fbbf24',
  mem: '#34d399',
  missing: '#64748b'
};

export const DOC_EDGE_COLORS: Record<DocGraphEdgeType, string> = {
  subtask: '#fbbf24',
  dependency: '#f87171',
  link: '#94a3b8',
  mention: '#475569'
};

export interface DocGraphSource extends DocLinkSource {
  /** Раздел дерева документации (decision-68) — группирует узлы при раскладке. */
  section?: string;
  /** Путь файла относительно корня проекта. */
  filePath?: string;
  /** Зависимости задачи из frontmatter (`dependencies`). */
  dependencies?: string[];
}

const TITLE_LIMIT = 60;

function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
}

/** Родитель подзадачи: `task-174.2` → `task-174`. */
function parentTaskId(id: string): string | null {
  const match = /^(task-\d+(?:\.\d+)*)\.\d+$/.exec(id);
  return match ? match[1] : null;
}

/**
 * Граф по источникам. Рёбра ведут от ссылающегося к цели. Упоминание идентификатора без скобок
 * несуществующего объекта ссылкой не считается (как в `MarkdownViewer`), а вики-ссылка на него даёт узел
 * `missing` — как неразрешённая ссылка в графе Obsidian.
 */
export function buildDocLinkGraph(sources: DocGraphSource[]): ProjectGraph {
  const nodes = new Map<string, ProjectGraphNode>();
  for (const source of sources) {
    const id = source.id.toLowerCase();
    if (nodes.has(id)) continue;
    const props: Record<string, string> = { id: source.id, title: source.title };
    if (source.status) props.status = source.status;
    const section = normalizeSection(source.section) ?? '';
    if (section) props.section = section;
    if (source.filePath) props.filePath = source.filePath;
    const node: ProjectGraphNode = { id, label: `${source.id} ${shortTitle(source.title)}`, type: source.kind, props };
    const top = section.split('/')[0];
    if (top) node.cluster = `${source.kind}:${top}`;
    nodes.set(id, node);
  }

  const edges = new Map<string, ProjectGraphEdge>();
  const addEdge = (from: string, to: string, type: DocGraphEdgeType) => {
    if (from === to) return;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, { source: from, target: to, type, weight: 1 });
      return;
    }
    existing.weight = (existing.weight ?? 1) + 1;
    if (EDGE_STRENGTH[type] > EDGE_STRENGTH[existing.type as DocGraphEdgeType]) {
      existing.type = type;
      existing.source = from;
      existing.target = to;
    }
  };
  const ensureMissing = (id: string) => {
    if (nodes.has(id)) return;
    nodes.set(id, { id, label: id, type: 'missing', props: { id } });
  };

  for (const source of sources) {
    const from = source.id.toLowerCase();
    for (const [target, kind] of collectRefs(source.content)) {
      if (!nodes.has(target)) {
        if (kind === 'mention') continue;
        ensureMissing(target);
      }
      addEdge(from, target, kind);
    }
    for (const dep of source.dependencies ?? []) {
      const target = dep.trim().toLowerCase();
      if (!docRefKind(target)) continue;
      ensureMissing(target);
      addEdge(from, target, 'dependency');
    }
    const parent = parentTaskId(from);
    if (parent && nodes.has(parent)) addEdge(from, parent, 'subtask');
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
