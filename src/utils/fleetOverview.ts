/**
 * Флот: сводка «компьютер → проекты → сессии» (TASK-174, decision-129). Чистые функции без Electron и React: хост
 * собирает из них ответ `get_overview`, окно ProjectHub и телефон — порядок и сводку внимания по нескольким ПК.
 *
 * Сессия — чат Agents Studio, запуск агента или роя, терминал с CLI-агентом (по хукам). Её состояние: ждёт человека,
 * ошибка, работает, простаивает, завершена. Узел выше показывает худшее состояние детей («внимание поднимается вверх»)
 * и счётчики «ждёт» и «работает».
 */

import type { DeviceRights, RemoteHitlRisk } from '../types/remote';
import type { HitlTextKey } from '../types/electron';
import { describeHitlRequest, type HitlTextLabels } from '../lib/agentStatusText';
import { accessActions, owningProject, type ProjectAccess } from './projectAccess';

export type OverviewSessionKind = 'studio' | 'swarm' | 'terminal';

export type OverviewSessionState = 'waiting' | 'failed' | 'running' | 'idle' | 'done';

/** Внимание узла: ждёт человека → ошибка → работает → тихий. */
export type OverviewAttention = 'waiting' | 'failed' | 'running' | 'quiet';

/** Что устройство может делать из дерева: `none` — только смотреть (`readOnly` или хост «только чтение»). */
export type OverviewActions = 'none' | 'hitl' | 'full';

/** Ожидающий решения запрос HITL в строке сессии: одобряется прямо из дерева. */
export interface OverviewPendingRequest {
  requestId: string;
  title: string;
  /** Заголовок кодом (TASK-205): клиент собирает его на своём языке, `title` — запасной текст. */
  textKey?: HitlTextKey;
  risk?: RemoteHitlRisk;
  tool?: string;
  createdAt?: number;
}

export interface OverviewSession {
  kind: OverviewSessionKind;
  /** id сессии Studio, id роя или ключ терминальной сессии `terminal-<движок>-<id>`. */
  id: string;
  title: string;
  state: OverviewSessionState;
  updatedAt: number;
  /** Вторая строка: вопрос агента, ошибка, последняя строка вывода или начало промпта. */
  detail?: string;
  engine?: string;
  agentName?: string;
  role?: string;
  taskId?: string;
  /** Агент роя, чей вывод открывается по клику (первый ждущий, работающий или упавший). */
  agentId?: string;
  agentsCount?: number;
  /** Участник общего хоста, чья это сессия (TASK-142.3). Пусто — владелец хоста. */
  ownerMemberId?: string;
  pending?: OverviewPendingRequest[];
}

export interface OverviewSessionCounts {
  waiting: number;
  failed: number;
  running: number;
}

export interface OverviewProject {
  path: string;
  name: string;
  attention: OverviewAttention;
  counts: OverviewSessionCounts;
  lastActivityAt: number;
  sessions: OverviewSession[];
  /** Сессий за окном снимка (старые тихие сверх лимита). */
  moreSessions: number;
  processes: { running: number; failed: number; failedNames?: string[] };
  tasks: { inProgress: number; review: number };
  /** Действия в этом проекте, если права устройства по проектам уже прав на хост (TASK-180). */
  actions?: OverviewActions;
}

/** Ответ `get_overview`: все проекты хоста одним снимком, без `select_project`. */
export interface RemoteOverview {
  hostId: string;
  machineName: string;
  platform: string;
  generatedAt: number;
  actions: OverviewActions;
  attention: OverviewAttention;
  counts: OverviewSessionCounts;
  projects: OverviewProject[];
}

// ─────────────────────────── Сырые данные хоста ───────────────────────────

export interface OverviewStudioInput {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  archived: boolean;
  /** Последний ответ — ошибка провайдера. */
  error?: string;
  /** Начало последнего промпта. */
  preview?: string;
  /** Последняя строка последнего ответа агента. */
  lastLine?: string;
  modelLabel?: string;
  ownerMemberId?: string;
}

export interface OverviewSwarmAgentInput {
  id: string;
  name: string;
  roleSlug?: string;
  engine?: string;
  status: string;
  error?: string;
  /** Последняя строка вывода. */
  lastLine?: string;
}

export interface OverviewSwarmInput {
  id: string;
  mode: string;
  status: string;
  taskId?: string;
  taskTitle?: string;
  origin?: string;
  createdAt?: number;
  completedAt?: number;
  error?: string;
  agents: OverviewSwarmAgentInput[];
  ownerMemberId?: string;
}

export interface OverviewTerminalInput {
  /** Ключ сессии, как в HITL: `terminal-<движок>-<id>`. */
  id: string;
  engine: string;
  agentName: string;
  role?: string;
  state: 'running' | 'idle' | 'failed';
  updatedAt: number;
  /** Последний инструмент или причина сбоя проверок. */
  detail?: string;
}

export interface OverviewPendingInput {
  requestId: string;
  sessionId: string;
  projectPath: string;
  title: string;
  textKey?: HitlTextKey;
  risk?: RemoteHitlRisk;
  tool?: string;
  origin?: string;
  agentName?: string;
  role?: string;
  createdAt?: number;
}

export interface OverviewProjectInput {
  path: string;
  name: string;
  studio: OverviewStudioInput[];
  swarms: OverviewSwarmInput[];
  terminals: OverviewTerminalInput[];
  processes: Array<{ name: string; status: string }>;
  tasks: Array<{ status: string }>;
}

export interface OverviewInput {
  now: number;
  hostId: string;
  machineName: string;
  platform: string;
  actions: OverviewActions;
  projects: OverviewProjectInput[];
  pending: OverviewPendingInput[];
}

// ─────────────────────────── Правила ───────────────────────────

export const OVERVIEW_LIMITS = {
  /** Тихие сессии (простаивает, завершена) старше этого окна в снимок не попадают. */
  quietWindowMs: 24 * 60 * 60 * 1000,
  /** Сессий в проекте в снимке; ждущие, упавшие и работающие не отрезаются. */
  sessionsPerProject: 8,
  detail: 140,
  title: 80
} as const;

const STATE_RANK: Record<OverviewSessionState, number> = { waiting: 0, failed: 1, running: 2, idle: 3, done: 4 };
const ATTENTION_RANK: Record<OverviewAttention, number> = { waiting: 0, failed: 1, running: 2, quiet: 3 };

export function attentionRank(a: OverviewAttention): number {
  return ATTENTION_RANK[a];
}

export function stateAttention(state: OverviewSessionState): OverviewAttention {
  return state === 'waiting' || state === 'failed' || state === 'running' ? state : 'quiet';
}

/** Худшее из состояний: внимание поднимается вверх. */
export function maxAttention(items: Iterable<OverviewAttention>): OverviewAttention {
  let best: OverviewAttention = 'quiet';
  for (const a of items) if (ATTENTION_RANK[a] < ATTENTION_RANK[best]) best = a;
  return best;
}

export function compareSessions(a: OverviewSession, b: OverviewSession): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
}

export function compareProjects(a: OverviewProject, b: OverviewProject): number {
  return ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] || b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name);
}

/** Тихий проект сворачивается в «ещё N»: нет ни ждущих, ни упавших, ни работающих, нет задач на проверке. */
export function isQuietProject(p: Pick<OverviewProject, 'attention' | 'tasks'>): boolean {
  return p.attention === 'quiet' && p.tasks.review === 0;
}

export function emptyCounts(): OverviewSessionCounts {
  return { waiting: 0, failed: 0, running: 0 };
}

export function addCounts(into: OverviewSessionCounts, from: OverviewSessionCounts): OverviewSessionCounts {
  into.waiting += from.waiting;
  into.failed += from.failed;
  into.running += from.running;
  return into;
}

/** Права устройства и режим хоста → что можно делать из дерева. */
export function overviewActions(rights: DeviceRights, hostReadOnly: boolean): OverviewActions {
  if (hostReadOnly || rights === 'readOnly') return 'none';
  return rights;
}

/** Заголовок запроса в дереве на языке клиента (TASK-205); без кода — `title` хоста. */
export function overviewRequestTitle(req: Pick<OverviewPendingRequest, 'title' | 'textKey'>, labels: HitlTextLabels): string {
  return req.textKey ? oneLine(describeHitlRequest(req, labels).title, OVERVIEW_LIMITS.detail) : req.title;
}

/** Вторая строка сессии: у ждущей — заголовок последнего запроса на языке клиента, иначе `detail` хоста. */
export function overviewSessionDetail(s: Pick<OverviewSession, 'state' | 'detail' | 'pending'>, labels: HitlTextLabels): string | undefined {
  const last = s.state === 'waiting' ? s.pending?.[s.pending.length - 1] : undefined;
  return last ? overviewRequestTitle(last, labels) : s.detail;
}

/** Цель в коде запроса — одной строкой той же длины, что заголовок: дерево не несёт команд целиком. */
/** Дерево показывает только заголовок: строки пояснения не передаются, цель и параметры обрезаются (TASK-202.8). */
function overviewTextKey(key: HitlTextKey): HitlTextKey {
  const params = key.params
    ? Object.fromEntries(Object.entries(key.params).map(([name, value]) => [name, oneLine(value, OVERVIEW_LIMITS.title)]))
    : undefined;
  return {
    code: key.code,
    ...(key.target ? { target: oneLine(key.target, OVERVIEW_LIMITS.title) } : {}),
    ...(key.agent ? { agent: key.agent } : {}),
    ...(params ? { params } : {})
  };
}

export function oneLine(text: string, limit: number = OVERVIEW_LIMITS.detail): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

/** Последняя непустая строка вывода — то, что агент пишет прямо сейчас. */
export function lastOutputLine(text: string | undefined, limit: number = OVERVIEW_LIMITS.detail): string | undefined {
  if (!text) return undefined;
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    // eslint-disable-next-line no-control-regex -- escape-последовательности терминала в выводе агента
    const line = lines[i].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (line) return oneLine(line, limit);
  }
  return undefined;
}

/**
 * Сессия, которой принадлежит запрос HITL. Studio — id сессии; агент роя — `swarm-<agentId>`; слияние и судья роя —
 * `merge-<swarmId>`, `judge-<swarmId>`; терминал — ключ сессии как есть.
 */
export function pendingSessionKey(sessionId: string, swarms: OverviewSwarmInput[]): { kind: OverviewSessionKind; id: string; agentId?: string } | null {
  if (sessionId.startsWith('terminal-')) return { kind: 'terminal', id: sessionId };
  for (const prefix of ['merge-', 'judge-']) {
    if (sessionId.startsWith(prefix)) {
      const swarmId = sessionId.slice(prefix.length);
      if (swarms.some((s) => s.id === swarmId)) return { kind: 'swarm', id: swarmId };
    }
  }
  if (sessionId.startsWith('swarm-')) {
    const agentId = sessionId.slice('swarm-'.length);
    const swarm = swarms.find((s) => s.agents.some((a) => a.id === agentId));
    if (swarm) return { kind: 'swarm', id: swarm.id, agentId };
  }
  return null;
}

const ACTIVE_SWARM = new Set(['preparing', 'running', 'idle']);
const ACTIVE_AGENT = new Set(['pending', 'preparing', 'running']);
const FAILED_AGENT = new Set(['failed', 'budget_exceeded', 'interrupted']);

function studioSession(s: OverviewStudioInput): OverviewSession {
  const state: OverviewSessionState = s.running ? 'running' : s.error ? 'failed' : s.archived ? 'done' : 'idle';
  const detail = state === 'failed' ? s.error : s.lastLine || s.preview;
  return {
    kind: 'studio',
    id: s.id,
    title: oneLine(s.title || 'Agents Studio', OVERVIEW_LIMITS.title),
    state,
    updatedAt: s.updatedAt,
    ...(detail ? { detail: oneLine(detail) } : {}),
    ...(s.modelLabel ? { engine: s.modelLabel } : {}),
    ...(s.ownerMemberId ? { ownerMemberId: s.ownerMemberId } : {})
  };
}

function swarmSession(s: OverviewSwarmInput): OverviewSession {
  const running = ACTIVE_SWARM.has(s.status) && s.agents.some((a) => ACTIVE_AGENT.has(a.status));
  const failedAgent = s.agents.find((a) => FAILED_AGENT.has(a.status));
  const state: OverviewSessionState = running ? 'running' : s.status === 'failed' || s.status === 'interrupted' || failedAgent ? 'failed' : 'done';
  const focus =
    (state === 'running' ? s.agents.find((a) => ACTIVE_AGENT.has(a.status)) : undefined) ?? (state === 'failed' ? failedAgent : undefined) ?? s.agents[0];
  const detail = state === 'failed' ? failedAgent?.error || s.error || focus?.lastLine : focus?.lastLine;
  const first = s.agents[0];
  const title = s.taskId ? `${s.taskId}${s.taskTitle ? ` · ${s.taskTitle}` : ''}` : first?.name || s.mode;
  return {
    kind: 'swarm',
    id: s.id,
    title: oneLine(title, OVERVIEW_LIMITS.title),
    state,
    updatedAt: Math.max(s.completedAt ?? 0, s.createdAt ?? 0),
    ...(detail ? { detail: oneLine(detail) } : {}),
    ...(focus?.engine ? { engine: focus.engine } : {}),
    ...(focus ? { agentName: focus.name, agentId: focus.id } : {}),
    ...(focus?.roleSlug ? { role: focus.roleSlug } : {}),
    ...(s.taskId ? { taskId: s.taskId } : {}),
    ...(s.agents.length > 1 ? { agentsCount: s.agents.length } : {}),
    ...(s.ownerMemberId ? { ownerMemberId: s.ownerMemberId } : {})
  };
}

function terminalSession(t: OverviewTerminalInput): OverviewSession {
  return {
    kind: 'terminal',
    id: t.id,
    title: oneLine(t.agentName, OVERVIEW_LIMITS.title),
    state: t.state,
    updatedAt: t.updatedAt,
    ...(t.detail ? { detail: oneLine(t.detail) } : {}),
    engine: t.engine,
    agentName: t.agentName,
    ...(t.role ? { role: t.role } : {})
  };
}

/** Запрос HITL без найденной сессии всё равно виден: «ждёт» не теряется, даже если сессия ушла из окна снимка. */
function orphanSession(p: OverviewPendingInput, kind: OverviewSessionKind): OverviewSession {
  return {
    kind,
    id: p.sessionId,
    title: oneLine(p.agentName || p.origin || 'Агент', OVERVIEW_LIMITS.title),
    state: 'waiting',
    updatedAt: p.createdAt ?? 0,
    ...(p.agentName ? { agentName: p.agentName } : {}),
    ...(p.role ? { role: p.role } : {})
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function buildProjectOverview(p: OverviewProjectInput, pending: OverviewPendingInput[], now: number): OverviewProject {
  const sessions = new Map<string, OverviewSession>();
  const key = (kind: OverviewSessionKind, id: string) => `${kind}:${id}`;
  for (const s of p.studio) sessions.set(key('studio', s.id), studioSession(s));
  for (const s of p.swarms) sessions.set(key('swarm', s.id), swarmSession(s));
  for (const t of p.terminals) sessions.set(key('terminal', t.id), terminalSession(t));

  for (const req of pending.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const target = pendingSessionKey(req.sessionId, p.swarms) ?? { kind: (p.studio.some((s) => s.id === req.sessionId) ? 'studio' : req.origin === 'terminal' ? 'terminal' : 'studio') as OverviewSessionKind, id: req.sessionId };
    const k = key(target.kind, target.id);
    const session = sessions.get(k) ?? orphanSession(req, target.kind);
    session.state = 'waiting';
    session.detail = oneLine(req.title);
    session.updatedAt = Math.max(session.updatedAt, req.createdAt ?? 0);
    if ('agentId' in target && target.agentId && session.kind === 'swarm') {
      session.agentId = target.agentId;
    }
    session.pending = [
      ...(session.pending ?? []),
      { requestId: req.requestId, title: oneLine(req.title), ...(req.textKey ? { textKey: overviewTextKey(req.textKey) } : {}), ...(req.risk ? { risk: req.risk } : {}), ...(req.tool ? { tool: req.tool } : {}), ...(req.createdAt ? { createdAt: req.createdAt } : {}) }
    ];
    sessions.set(k, session);
  }

  const all = [...sessions.values()].sort(compareSessions);
  const loud = all.filter((s) => s.state === 'waiting' || s.state === 'failed' || s.state === 'running');
  const quiet = all.filter((s) => (s.state === 'idle' || s.state === 'done') && now - s.updatedAt <= OVERVIEW_LIMITS.quietWindowMs);
  const room = Math.max(0, OVERVIEW_LIMITS.sessionsPerProject - loud.length);
  const shown = [...loud, ...quiet.slice(0, room)];

  const counts = emptyCounts();
  for (const s of all) {
    if (s.state === 'waiting') counts.waiting += 1;
    else if (s.state === 'failed') counts.failed += 1;
    else if (s.state === 'running') counts.running += 1;
  }
  const failedProcesses = p.processes.filter((x) => x.status === 'failed');
  const processes = {
    running: p.processes.filter((x) => x.status === 'running').length,
    failed: failedProcesses.length,
    ...(failedProcesses.length ? { failedNames: failedProcesses.map((x) => x.name).slice(0, 5) } : {})
  };
  const status = (s: string) => s.trim().toLowerCase();
  const tasks = {
    inProgress: p.tasks.filter((t) => status(t.status) === 'in progress').length,
    review: p.tasks.filter((t) => status(t.status) === 'review').length
  };
  const attention = maxAttention([...all.map((s) => stateAttention(s.state)), ...(processes.failed ? ['failed' as const] : [])]);
  return {
    path: p.path,
    name: p.name,
    attention,
    counts,
    lastActivityAt: all.reduce((m, s) => Math.max(m, s.updatedAt), 0),
    sessions: shown,
    moreSessions: all.length - shown.length,
    processes,
    tasks
  };
}

export function buildOverview(input: OverviewInput): RemoteOverview {
  // Запрос агента из worktree проекта (`.worktrees/…`) — запрос этого проекта (TASK-187); вложенный проект — свой.
  const roots = input.projects.map((p) => p.path);
  const projects = input.projects
    .map((p) =>
      buildProjectOverview(
        p,
        input.pending.filter((r) => {
          const owner = owningProject(r.projectPath, roots);
          return owner !== null && samePath(owner, p.path);
        }),
        input.now
      )
    )
    .sort(compareProjects);
  const counts = projects.reduce((acc, p) => addCounts(acc, p.counts), emptyCounts());
  return {
    hostId: input.hostId,
    machineName: input.machineName,
    platform: input.platform,
    generatedAt: input.now,
    actions: input.actions,
    attention: maxAttention(projects.map((p) => p.attention)),
    counts,
    projects
  };
}

/**
 * Сводка глазами устройства с правами по проектам (TASK-180): проектов без доступа нет вовсе — ни имени, ни пути, ни
 * счётчиков; счётчики и внимание хоста пересчитаны по оставшимся; у проекта с правами уже, чем у устройства, —
 * свои `actions`.
 */
export function scopeOverview(overview: RemoteOverview, accessOf: (projectPath: string) => ProjectAccess, hostReadOnly: boolean): RemoteOverview {
  const projects: OverviewProject[] = [];
  for (const p of overview.projects) {
    const access = accessOf(p.path);
    if (access === 'none') continue;
    const actions = accessActions(access, hostReadOnly);
    projects.push(actions === overview.actions ? p : { ...p, actions });
  }
  if (projects.length === overview.projects.length && projects.every((p, i) => p === overview.projects[i])) return overview;
  return {
    ...overview,
    attention: maxAttention(projects.map((p) => p.attention)),
    counts: projects.reduce((acc, p) => addCounts(acc, p.counts), emptyCounts()),
    projects
  };
}

// ─────────────────────────── Несколько компьютеров ───────────────────────────

/** Компьютер в дереве клиента: снимок, если есть связь, или время последней связи. */
export interface FleetHostEntry {
  hostId: string;
  machineName: string;
  /** Этот ПК (окно) или открытый ПК телефона — всегда первым. */
  self?: boolean;
  online: boolean;
  /** Последняя успешная связь: снимок или событие. */
  lastSeenAt?: number;
  overview?: RemoteOverview;
  error?: string;
}

export function hostAttention(h: FleetHostEntry): OverviewAttention {
  return h.online && h.overview ? h.overview.attention : 'quiet';
}

/** Свой ПК первым, затем в сети по вниманию и имени, офлайн — внизу. */
export function compareHosts(a: FleetHostEntry, b: FleetHostEntry): number {
  if (Boolean(a.self) !== Boolean(b.self)) return a.self ? -1 : 1;
  if (a.online !== b.online) return a.online ? -1 : 1;
  return ATTENTION_RANK[hostAttention(a)] - ATTENTION_RANK[hostAttention(b)] || a.machineName.localeCompare(b.machineName);
}

/** Сводка над деревом: сколько ждёт и работает на всех ПК, сколько ПК в сети. */
export function fleetTotals(hosts: FleetHostEntry[]): OverviewSessionCounts & { online: number; total: number } {
  const counts = emptyCounts();
  let online = 0;
  for (const h of hosts) {
    if (!h.online) continue;
    online += 1;
    if (h.overview) addCounts(counts, h.overview.counts);
  }
  return { ...counts, online, total: hosts.length };
}

/** Проекты, которые видны сразу, и тихие, свёрнутые в «ещё N». Выбранный проект не сворачивается. */
export function splitQuietProjects(projects: OverviewProject[], keepPath?: string | null): { visible: OverviewProject[]; quiet: OverviewProject[] } {
  const visible: OverviewProject[] = [];
  const quiet: OverviewProject[] = [];
  for (const p of projects) {
    if (isQuietProject(p) && !(keepPath && samePath(p.path, keepPath))) quiet.push(p);
    else visible.push(p);
  }
  return { visible, quiet };
}
