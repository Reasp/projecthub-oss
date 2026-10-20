/**
 * Графы проекта для вкладок «Граф кода» и «Граф документации» (TASK-167, decision-118).
 *
 * Чистые функции без Electron: ответ `gitnexus serve` (`GET /api/graph`) и GraphML, который LightRAG
 * пишет в `.lightrag-index/graph_chunk_entity_relation.graphml`, приводятся к одному компактному виду.
 * Рендерер получает его через IPC и рисует sigma.js — свой разбор форматов в рендерере не нужен.
 */

export interface ProjectGraphNode {
  id: string;
  /** Подпись на холсте. */
  label: string;
  /** Метка GitNexus (`Function`, `File`…) или `entity_type` LightRAG. */
  type: string;
  /** Свойства для панели узла — только строки и числа. */
  props: Record<string, string | number>;
  /** Сообщество GitNexus: по нему рендерер раскладывает узлы до ForceAtlas2. */
  cluster?: string;
}

export interface ProjectGraphEdge {
  source: string;
  target: string;
  type: string;
  weight?: number;
  description?: string;
}

export interface ProjectGraph {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

/** Узлы GitNexus, которые не рисуются: сообщества и процессы — производные сущности, а не код. */
const GITNEXUS_HIDDEN_LABELS = new Set(['Community', 'Process']);

/**
 * Связи, которые рисует web UI GitNexus 1.6. MEMBER_OF, STEP_IN_PROCESS и ACCESSES он не рисует:
 * первые две ведут в скрытые узлы, ACCESSES — тысячи обращений к полям, которые превращают граф в шум.
 */
export const GITNEXUS_DRAWN_EDGES = new Set([
  'CONTAINS',
  'DEFINES',
  'IMPORTS',
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY'
]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function scalarProps(raw: unknown, skip: Set<string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (skip.has(key)) continue;
    if (typeof value === 'string' && value !== '') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Ключ пары концов: граф в рендерере простой, вторая связь между теми же узлами не рисуется. */
const pairKey = (source: string, target: string) => `${source}\u0000${target}`;

/**
 * Ответ `GET /api/graph` → граф для отрисовки. Сообщества становятся `cluster` узлов-участников
 * (связь MEMBER_OF), процессы отбрасываются. `content` (исходный код при `includeContent`) не берётся.
 */
export function fromGitNexusGraph(raw: unknown): ProjectGraph {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) throw new Error('GitNexus вернул граф без списка узлов');
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];

  const communityName = new Map<string, string>();
  for (const n of raw.nodes) {
    if (!isRecord(n) || n.label !== 'Community' || typeof n.id !== 'string') continue;
    const p = isRecord(n.properties) ? n.properties : {};
    const name = typeof p.heuristicLabel === 'string' ? p.heuristicLabel : typeof p.name === 'string' ? p.name : n.id;
    communityName.set(n.id, name);
  }

  const clusterOf = new Map<string, string>();
  for (const r of relationships) {
    if (!isRecord(r) || r.type !== 'MEMBER_OF') continue;
    if (typeof r.sourceId === 'string' && typeof r.targetId === 'string' && communityName.has(r.targetId)) {
      clusterOf.set(r.sourceId, r.targetId);
    }
  }

  const skip = new Set(['content', 'name']);
  const nodes: ProjectGraphNode[] = [];
  const ids = new Set<string>();
  for (const n of raw.nodes) {
    if (!isRecord(n) || typeof n.id !== 'string' || typeof n.label !== 'string') continue;
    if (GITNEXUS_HIDDEN_LABELS.has(n.label) || ids.has(n.id)) continue;
    const p = isRecord(n.properties) ? n.properties : {};
    const props = scalarProps(p, skip);
    const cluster = clusterOf.get(n.id);
    if (cluster) props.community = communityName.get(cluster) ?? cluster;
    ids.add(n.id);
    nodes.push({
      id: n.id,
      label: typeof p.name === 'string' && p.name ? p.name : n.id,
      type: n.label,
      props,
      ...(cluster ? { cluster } : {})
    });
  }

  const edges: ProjectGraphEdge[] = [];
  const seen = new Set<string>();
  for (const r of relationships) {
    if (!isRecord(r) || typeof r.type !== 'string' || !GITNEXUS_DRAWN_EDGES.has(r.type)) continue;
    const source = r.sourceId;
    const target = r.targetId;
    if (typeof source !== 'string' || typeof target !== 'string' || source === target) continue;
    if (!ids.has(source) || !ids.has(target)) continue;
    const key = pairKey(source, target);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source, target, type: r.type });
  }

  return { nodes, edges };
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

function readAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeXmlText(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** `<data key="dN">…</data>` элемента → значения по имени атрибута из таблицы `<key>`. */
function readData(body: string, keyNames: Map<string, { name: string; type: string }>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const m of body.matchAll(/<data\b([^>]*?)(?:\/>|>([\s\S]*?)<\/data>)/g)) {
    const key = readAttrs(m[1]).key;
    const def = key ? keyNames.get(key) : undefined;
    if (!def) continue;
    const text = decodeXmlText(m[2] ?? '').trim();
    if (!text) continue;
    if (def.type === 'double' || def.type === 'float' || def.type === 'int' || def.type === 'long') {
      const num = Number(text);
      if (Number.isFinite(num)) out[def.name] = num;
    } else {
      out[def.name] = text;
    }
  }
  return out;
}

/** LightRAG склеивает несколько источников одной сущности через `<SEP>` — для показа нужна строка на источник. */
const splitSep = (v: string | number | undefined) => (typeof v === 'string' ? v.split('<SEP>').map((s) => s.trim()).filter(Boolean).join('\n') : v);

/**
 * GraphML, который пишет NetworkX-хранилище LightRAG. Имена атрибутов берутся из таблицы `<key>`, а не по
 * номерам `d0…dN`: номера зависят от версии LightRAG. Тип узла — `entity_type`, подпись — `entity_id`.
 */
export function parseLightRagGraphml(xml: string): ProjectGraph {
  if (typeof xml !== 'string' || !/<graphml\b/.test(xml)) throw new Error('Файл не похож на GraphML');

  const keyNames = new Map<string, { name: string; type: string }>();
  for (const m of xml.matchAll(/<key\b([^>]*?)\/?>/g)) {
    const a = readAttrs(m[1]);
    if (a.id && a['attr.name']) keyNames.set(a.id, { name: a['attr.name'], type: a['attr.type'] ?? 'string' });
  }

  const nodes: ProjectGraphNode[] = [];
  const ids = new Set<string>();
  for (const m of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = readAttrs(m[1]).id;
    if (!id || ids.has(id)) continue;
    const data = readData(m[2] ?? '', keyNames);
    const { entity_id, entity_type, ...rest } = data;
    delete rest.truncate;
    const props: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(rest)) {
      const value = splitSep(v);
      if (value !== undefined && value !== '') props[k] = value;
    }
    ids.add(id);
    nodes.push({
      id,
      label: typeof entity_id === 'string' && entity_id ? entity_id : id,
      type: typeof entity_type === 'string' && entity_type ? entity_type.toLowerCase() : 'unknown',
      props
    });
  }

  const edges: ProjectGraphEdge[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<edge\b([^>]*?)(?:\/>|>([\s\S]*?)<\/edge>)/g)) {
    const a = readAttrs(m[1]);
    const source = a.source;
    const target = a.target;
    if (!source || !target || source === target || !ids.has(source) || !ids.has(target)) continue;
    // Граф LightRAG неориентированный: A–B и B–A — одна связь.
    const key = source < target ? pairKey(source, target) : pairKey(target, source);
    if (seen.has(key)) continue;
    seen.add(key);
    const data = readData(m[2] ?? '', keyNames);
    const keywords = splitSep(data.keywords);
    const description = splitSep(data.description);
    edges.push({
      source,
      target,
      type: typeof keywords === 'string' && keywords ? keywords.split(/[,\n]/)[0].trim() : 'related',
      ...(typeof data.weight === 'number' ? { weight: data.weight } : {}),
      ...(typeof description === 'string' && description ? { description } : {})
    });
  }

  return { nodes, edges };
}

/** Запись реестра `GET /api/repos`, принадлежащая проекту: сравнение путей без учёта регистра на Windows. */
export function findGitNexusRepo(
  repos: unknown,
  projectRoot: string,
  platform: NodeJS.Platform = process.platform
): { name: string; indexedAt?: string } | null {
  if (!Array.isArray(repos)) return null;
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  const want = norm(projectRoot);
  for (const r of repos) {
    if (!isRecord(r) || typeof r.name !== 'string' || typeof r.path !== 'string') continue;
    if (norm(r.path) === want) return { name: r.name, ...(typeof r.indexedAt === 'string' ? { indexedAt: r.indexedAt } : {}) };
  }
  return null;
}
