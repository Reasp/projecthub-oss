import type {
  DeviceRights,
  RemoteHostStatus,
  RemoteInbox,
  RemoteInboxEvent,
  RemotePendingAgentTask,
  RemotePendingApproval,
  RemoteReviewItem,
  RemoteScreenshotChunk
} from '../../../src/types/remote';
import { t } from '../i18n';
import { groupAgentTasks, hitlFromPending, type AgentTaskGroup, type HitlItem } from './models';
import { samePath } from './scope';

/**
 * «Входящие» со всех ПК телефона (TASK-140.5, [[decision-117]] п. 7): загрузка снимка ленты с откатом на хосты
 * до неё, сборка одной ленты из снимков разных ПК и скриншоты отчёта частями. Без React — проверяется unit-тестами.
 */

export type InboxRpc = <T>(method: 'get_inbox' | 'get_status' | 'get_pending_approvals' | 'get_pending_agent_tasks', params?: Record<string, unknown>) => Promise<T>;

/** Снимок ленты; `legacy` — хост до decision-117: только HITL и задачи агентов, без Review и журнала. */
export interface InboxSnapshot extends RemoteInbox {
  legacy?: boolean;
}

function isUnknownMethod(err: unknown): boolean {
  return /Unknown RPC method/i.test(err instanceof Error ? err.message : String(err));
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export async function loadInbox(rpc: InboxRpc, now: () => number = Date.now): Promise<InboxSnapshot> {
  try {
    const raw = (await rpc<Partial<RemoteInbox> | null>('get_inbox')) ?? {};
    // Списки — всегда массивы: кривой ответ хоста не должен ронять экран.
    return {
      hostId: String(raw.hostId ?? ''),
      machineName: String(raw.machineName ?? ''),
      generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : now(),
      hitl: list(raw.hitl),
      agentTasks: list(raw.agentTasks),
      review: list<RemoteReviewItem>(raw.review).map((r) => ({ ...r, criteria: list(r.criteria) })),
      events: list(raw.events)
    };
  } catch (err) {
    if (!isUnknownMethod(err)) throw err;
  }
  const [status, hitl, agentTasks] = await Promise.all([
    rpc<RemoteHostStatus>('get_status').catch(() => null),
    rpc<RemotePendingApproval[]>('get_pending_approvals').catch(() => []),
    rpc<RemotePendingAgentTask[]>('get_pending_agent_tasks').catch(() => [])
  ]);
  return {
    hostId: status?.hostId ?? '',
    machineName: status?.machineName ?? '',
    generatedAt: now(),
    hitl: Array.isArray(hitl) ? hitl : [],
    agentTasks: Array.isArray(agentTasks) ? agentTasks : [],
    review: [],
    events: [],
    legacy: true
  };
}

export type ScreenshotRpc = (params: Record<string, unknown>) => Promise<RemoteScreenshotChunk>;

/** Скриншот целиком по частям `get_review_screenshot` → data URL. */
export async function fetchScreenshot(rpc: ScreenshotRpc, params: { projectPath: string; taskId: string; relPath: string }): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  let mime = 'image/png';
  for (let i = 0; i < 64; i++) {
    const chunk = await rpc({ ...params, offset });
    mime = chunk.mime || mime;
    parts.push(chunk.data);
    // Части base64 по 384 КБ кратны 3 байтам — склеиваются без перекодирования.
    offset += Math.floor((chunk.data.length * 3) / 4) - (chunk.data.endsWith('==') ? 2 : chunk.data.endsWith('=') ? 1 : 0);
    if (offset >= chunk.total || chunk.data.length === 0) return `data:${mime};base64,${parts.join('')}`;
  }
  throw new Error(t().inbox.screenshotTooLarge);
}

// ── одна лента со всех ПК ──

/** Что лента знает о ПК: открытый он или фоновый, есть ли связь, его снимок. */
export interface FeedSource {
  profileId: string;
  machineName: string;
  online: boolean;
  active: boolean;
  /** Права этого телефона на этом ПК и режим хоста «только чтение» — какие кнопки показывать. */
  rights?: DeviceRights;
  hostReadOnly?: boolean;
  hitl: HitlItem[];
  agentTasks: RemotePendingAgentTask[];
  review: RemoteReviewItem[];
  events: RemoteInboxEvent[];
}

export interface Tagged<T> {
  source: FeedSource;
  item: T;
}

export interface InboxFeed {
  hitl: Array<Tagged<HitlItem>>;
  agentGroups: Array<Tagged<AgentTaskGroup>>;
  review: Array<Tagged<RemoteReviewItem>>;
  events: Array<Tagged<RemoteInboxEvent>>;
  /** То, что ждёт решения: HITL, задачи агентов и задачи в Review. События — справочно. */
  actionable: number;
  hosts: Array<{ profileId: string; machineName: string; online: boolean; count: number }>;
}

export function sourceFromSnapshot(
  base: Pick<FeedSource, 'profileId' | 'machineName' | 'online' | 'active' | 'rights' | 'hostReadOnly'>,
  snap: InboxSnapshot | null | undefined
): FeedSource {
  return {
    ...base,
    machineName: base.machineName || snap?.machineName || t().inbox.pcFallback,
    hitl: (snap?.hitl ?? []).map(hitlFromPending),
    agentTasks: snap?.agentTasks ?? [],
    review: snap?.review ?? [],
    events: snap?.events ?? []
  };
}

/**
 * Лента по фильтру ПК (`null` — все). Внутри раздела: открытый ПК первым, затем по имени; события — новые сверху.
 * Ключ записи включает `profileId`: одинаковые id задач на двух ПК не сливаются.
 */
export function buildFeed(sources: readonly FeedSource[], filter: string | null = null, projectPath: string | null = null): InboxFeed {
  const order = [...sources].sort((a, b) => Number(b.active) - Number(a.active) || a.machineName.localeCompare(b.machineName));
  // Область проекта (TASK-181): только записи этого проекта; события хоста без проекта в неё не входят.
  const ofProject = <T extends { projectPath?: string }>(list: readonly T[]) => (projectPath ? list.filter((x) => Boolean(x.projectPath) && samePath(x.projectPath!, projectPath)) : [...list]);
  const shown = (filter ? order.filter((s) => s.profileId === filter) : order).map((s) =>
    projectPath ? { ...s, hitl: ofProject(s.hitl), agentTasks: ofProject(s.agentTasks), review: ofProject(s.review), events: ofProject(s.events) } : s
  );
  const hitl = shown.flatMap((source) => source.hitl.map((item) => ({ source, item })));
  const agentGroups = shown.flatMap((source) => groupAgentTasks(source.agentTasks).map((item) => ({ source, item })));
  const review = shown.flatMap((source) => source.review.map((item) => ({ source, item })));
  const events = shown
    .flatMap((source) => source.events.map((item) => ({ source, item })))
    .sort((a, b) => b.item.at - a.item.at);
  const countOf = (s: FeedSource) => s.hitl.length + s.agentTasks.length + s.review.length;
  return {
    hitl,
    agentGroups,
    review,
    events,
    actionable: shown.reduce((n, s) => n + countOf(s), 0),
    hosts: order.map((s) => ({ profileId: s.profileId, machineName: s.machineName, online: s.online, count: countOf(s) }))
  };
}

// ── отображение ──

export function criteriaDone(item: RemoteReviewItem): { done: number; total: number; accepted: number } {
  return {
    done: item.criteria.filter((c) => c.completed).length,
    total: item.criteria.length,
    accepted: item.criteria.filter((c) => c.accepted).length
  };
}

/** Итог чеков одной строкой на текущем языке: «Проверки: 3 из 4 прошли». */
export function checksSummary(item: RemoteReviewItem): { text: string; failed: number } | null {
  const checks = item.report?.checks ?? [];
  if (checks.length === 0) return null;
  const passed = checks.filter((c) => c.status === 'passed').length;
  const failed = checks.filter((c) => c.status === 'failed' || c.status === 'timeout' || c.status === 'error').length;
  return { text: t().inbox.checksSummary(passed, checks.length), failed };
}

/** Статус чека словами на текущем языке; незнакомый статус — как есть. */
export function checkStatusText(status: string): string {
  return t().inbox.checkStatus[status] ?? status;
}

/** Итог цикла «до готовности» словами на текущем языке; незнакомый итог — как есть. */
export function outcomeText(outcome: string): string {
  return t().inbox.outcome[outcome] ?? outcome;
}

export function projectName(path: string | undefined): string {
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Сколько прошло: «5 мин назад», «вчера в 14:05». */
export function timeAgo(at: number, now: number = Date.now()): string {
  const tr = t().inbox;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return tr.justNow;
  const min = Math.round(sec / 60);
  if (min < 60) return tr.minutesAgo(min);
  const hours = Math.round(min / 60);
  if (hours < 24) return tr.hoursAgo(hours);
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hours < 48 ? tr.yesterdayAt(hm) : tr.dateAt(d.getDate(), String(d.getMonth() + 1).padStart(2, '0'), hm);
}
