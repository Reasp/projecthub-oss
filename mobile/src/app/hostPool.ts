import type { RemotePendingApproval, RemoteHostStatus, RemoteProjectSummary } from '../../../src/types/remote';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { loadInbox, type InboxRpc, type InboxSnapshot } from '../protocol/inbox';
import { profileProblems, type HostProfile } from '../protocol/pairing';
import type { ClientSnapshot, ConnectionState, RpcMethod } from '../protocol/remoteClient';
import type { RemoteOverview } from '../../../src/utils/fleetOverview';
import type { PrefsPort } from './appStore';
import { t } from '../i18n';

/**
 * Фоновые соединения к остальным хостам телефона (TASK-140.2, [[decision-111]]): переключатель показывает статус,
 * путь связи и число ожидающих решений HITL каждого хоста, а не только открытого. Соединения держатся, только пока
 * интерфейс на экране (`pause`/`resume` по видимости страницы): в фоне WebView всё равно засыпает, а о новых
 * решениях скажет push ([[TASK-140.3]]). Не больше `MAX_BACKGROUND_HOSTS` соединений сразу.
 *
 * Для «Входящих» ([[TASK-140.5]], [[decision-117]] п. 7) пул держит снимок ленты каждого ПК. Последний снимок
 * остаётся и после разрыва — запись видна с пометкой «нет связи», пока профиль не забыт.
 *
 * Для экрана «Компьютеры» ([[TASK-174]], [[decision-129]] п. 11) пул держит снимок `get_overview` каждого ПК и время
 * последней связи. Время хранится между запусками; снимок офлайн-ПК экран не показывает — только «был в сети».
 */

export const MAX_BACKGROUND_HOSTS = 8;
/** Пауза перед перечитыванием ленты после события: пачка событий — один запрос. */
export const INBOX_REFRESH_MS = 600;

/** Время последней связи пишется не чаще, чем раз в это время. */
const SEEN_WRITE_MS = 30_000;
const SEEN_PREF = 'fleet:lastSeen';

/** Снимок дерева ПК: сводка или признак старого хоста без `get_overview`. */
export interface OverviewSnapshot {
  overview: RemoteOverview | null;
  unsupported?: boolean;
  /** Проекты старого хоста без `get_overview` (`get_projects`). */
  projects?: Array<{ path: string; name: string }>;
  at: number;
}

/** События хоста, после которых лента устарела. */
const INBOX_EVENTS = new Set(['ai:hitl', 'ai:hitlDecided', 'backlog:changed', 'inbox:changed', 'notification', 'projects:changed']);

/** То, что пулу нужно от `RemoteClient`. */
export interface PoolClient {
  connect(profile: HostProfile): void;
  disconnect(): void;
  rpc<T = unknown>(method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  subscribe(listener: (snapshot: ClientSnapshot) => void): () => void;
  getSnapshot(): ClientSnapshot;
}

export interface HostSummary {
  state: ConnectionState;
  route: EndpointKind | null;
  /** Ожидающие решения HITL. */
  pending: number;
  error: string | null;
}

interface Entry {
  client: PoolClient;
  profile: HostProfile;
  connKey: string;
  pending: Set<string>;
  unsubscribe: Array<() => void>;
  inboxTimer: unknown;
  overviewTimer: unknown;
}

/** Поля, смена которых требует нового подключения; смена адресов и прав — нет. */
function connectionKey(p: HostProfile): string {
  return [p.id, p.deviceId, p.key, p.deviceToken ?? ''].join('|');
}

export class HostPool {
  private entries = new Map<string, Entry>();
  private summaries: Record<string, HostSummary> = {};
  /** Последний снимок ленты по `id` профиля — живёт дольше соединения. */
  private inboxes: Record<string, InboxSnapshot> = {};
  /** Последний снимок дерева по `id` профиля. */
  private overviews: Record<string, OverviewSnapshot> = {};
  /** Время последней связи по `id` профиля, включая открытый ПК. */
  private lastSeen: Record<string, number>;
  private seenWrittenAt = 0;
  private listeners = new Set<() => void>();
  /** События фоновых ПК для тех, кому мало сводок: голосовой режим ждёт ответа агента на любом ПК (TASK-179.3). */
  private hostEventListeners = new Set<(id: string, event: string, data: unknown) => void>();
  private paused = false;
  private wanted: HostProfile[] = [];

  constructor(
    private readonly createClient: (onProfileChange: (profile: HostProfile) => void) => PoolClient,
    private readonly onProfileChange: (profile: HostProfile) => void,
    // Стрелки, а не сами функции: вызов `this.timers.setTimeout` с чужим `this` в браузере — «Illegal invocation».
    private readonly timers: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void } = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
    },
    private readonly prefs: PrefsPort | null = null,
    private readonly now: () => number = () => Date.now()
  ) {
    let seen: Record<string, number> = {};
    try {
      const raw = prefs?.get(SEEN_PREF);
      if (raw) seen = JSON.parse(raw) as Record<string, number>;
    } catch {
      // испорченная запись — начинаем заново
    }
    this.lastSeen = seen && typeof seen === 'object' ? seen : {};
  }

  getSummaries = (): Record<string, HostSummary> => this.summaries;

  getInboxes = (): Record<string, InboxSnapshot> => this.inboxes;

  getOverviews = (): Record<string, OverviewSnapshot> => this.overviews;

  getLastSeen = (): Record<string, number> => this.lastSeen;

  /** Связь с ПК есть прямо сейчас (событие, ответ): время запоминается, на диск — не чаще раза в 30 с. */
  markSeen(id: string): void {
    const now = this.now();
    const prev = this.lastSeen[id] ?? 0;
    if (now - prev < 1000) return;
    this.lastSeen = { ...this.lastSeen, [id]: now };
    if (now - this.seenWrittenAt >= SEEN_WRITE_MS || now - prev > SEEN_WRITE_MS) {
      this.seenWrittenAt = now;
      try {
        this.prefs?.set(SEEN_PREF, JSON.stringify(this.lastSeen));
      } catch {
        // хранилище недоступно — время живёт до перезапуска
      }
    }
    this.emit();
  }

  /** Перечитать дерево фонового ПК. Старый хост без метода — признак `unsupported`, без повторов. */
  async refreshOverview(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.summaries[id]?.state !== 'ready') return;
    try {
      const overview = await entry.client.rpc<RemoteOverview>('get_overview');
      if (this.entries.get(id) !== entry) return;
      this.overviews = { ...this.overviews, [id]: { overview, at: this.now() } };
      this.markSeen(id);
      this.emit();
    } catch (err) {
      if (/Unknown RPC method/i.test(err instanceof Error ? err.message : String(err))) {
        // Старый хост (TASK-181): дерево и область строятся по списку проектов, сессий у него не будет.
        let projects: OverviewSnapshot['projects'];
        try {
          const list = await entry.client.rpc<RemoteProjectSummary[]>('get_projects');
          if (Array.isArray(list)) projects = list.map((p) => ({ path: p.path, name: p.name }));
        } catch {
          // нет прав или связи — компьютер без проектов
        }
        if (this.entries.get(id) !== entry) return;
        this.overviews = { ...this.overviews, [id]: { overview: null, unsupported: true, at: this.now(), ...(projects ? { projects } : {}) } };
        this.emit();
      }
    }
  }

  private scheduleOverview(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.overviewTimer) this.timers.clearTimeout(entry.overviewTimer);
    entry.overviewTimer = this.timers.setTimeout(() => {
      entry.overviewTimer = null;
      void this.refreshOverview(id);
    }, INBOX_REFRESH_MS);
  }

  /** Есть ли живое соединение с ПК: действие над его записью уйдёт только так. */
  isReady(id: string): boolean {
    return this.entries.has(id) && this.summaries[id]?.state === 'ready';
  }

  onHostEvent(listener: (id: string, event: string, data: unknown) => void): () => void {
    this.hostEventListeners.add(listener);
    return () => this.hostEventListeners.delete(listener);
  }

  /** RPC к фоновому ПК его соединением и токеном его сопряжения — решение не уйдёт другому ПК. */
  rpc<T = unknown>(id: string, method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    const entry = this.entries.get(id);
    if (!entry || this.summaries[id]?.state !== 'ready') return Promise.reject(new Error(t().store.hostOffline));
    return entry.client.rpc<T>(method, params);
  }

  /** Перечитать ленту ПК сейчас (после действия или «потянуть для обновления»). */
  async refreshInbox(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.summaries[id]?.state !== 'ready') return;
    try {
      const snap = await loadInbox(((method, params) => entry.client.rpc(method, params)) as InboxRpc);
      if (this.entries.get(id) !== entry) return;
      this.inboxes = { ...this.inboxes, [id]: snap };
      entry.pending = new Set(snap.hitl.map((r) => r.requestId));
      this.setSummary(id, { pending: entry.pending.size });
      this.emit();
    } catch {
      // нет прав или связи — остаётся прежний снимок
    }
  }

  async refreshAllInboxes(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.refreshInbox(id)));
  }

  private scheduleInbox(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.inboxTimer) this.timers.clearTimeout(entry.inboxTimer);
    entry.inboxTimer = this.timers.setTimeout(() => {
      entry.inboxTimer = null;
      void this.refreshInbox(id);
    }, INBOX_REFRESH_MS);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Список профилей изменился: соединения ко всем полным профилям, кроме открытого (у него свой клиент). */
  sync(profiles: HostProfile[], activeId: string | null): void {
    this.wanted = profiles.filter((p) => p.id && p.id !== activeId && profileProblems(p).length === 0).slice(0, MAX_BACKGROUND_HOSTS);
    // Снимок забытого ПК и открытого (его лента — в сторе) больше не нужен.
    const keep = new Set(this.wanted.map((p) => p.id!));
    if (Object.keys(this.inboxes).some((id) => !keep.has(id))) {
      this.inboxes = Object.fromEntries(Object.entries(this.inboxes).filter(([id]) => keep.has(id)));
      this.emit();
    }
    if (Object.keys(this.overviews).some((id) => !keep.has(id))) {
      this.overviews = Object.fromEntries(Object.entries(this.overviews).filter(([id]) => keep.has(id)));
      this.emit();
    }
    if (this.paused) return;
    this.apply();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.apply();
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
    this.listeners.clear();
  }

  private apply(): void {
    const wantedIds = new Set(this.wanted.map((p) => p.id!));
    for (const id of [...this.entries.keys()]) if (!wantedIds.has(id)) this.drop(id);
    for (const profile of this.wanted) {
      const entry = this.entries.get(profile.id!);
      if (entry && entry.connKey === connectionKey(profile)) {
        entry.profile = profile;
        continue;
      }
      if (entry) this.drop(profile.id!);
      this.open(profile);
    }
  }

  private open(profile: HostProfile): void {
    const id = profile.id!;
    const client = this.createClient((p) => {
      const entry = this.entries.get(id);
      if (entry) entry.profile = { ...p, id };
      this.onProfileChange({ ...p, id });
    });
    const entry: Entry = { client, profile, connKey: connectionKey(profile), pending: new Set(), unsubscribe: [], inboxTimer: null, overviewTimer: null };
    this.entries.set(id, entry);
    entry.unsubscribe.push(
      client.subscribe((snap) => this.setSummary(id, { state: snap.state, route: snap.route, error: snap.error })),
      client.onEvent((event, data) => this.handleEvent(id, event, data))
    );
    this.setSummary(id, { state: 'connecting', route: null, error: null, pending: 0 });
    client.connect(profile);
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.inboxTimer) this.timers.clearTimeout(entry.inboxTimer);
    if (entry.overviewTimer) this.timers.clearTimeout(entry.overviewTimer);
    for (const u of entry.unsubscribe) u();
    entry.client.disconnect();
    const { [id]: _gone, ...rest } = this.summaries;
    this.summaries = rest;
    this.emit();
  }

  private handleEvent(id: string, event: string, data: unknown): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const d = (data || {}) as { requestId?: unknown };
    this.markSeen(id);
    for (const l of this.hostEventListeners) l(id, event, data);
    if (event === 'overview:changed') {
      this.scheduleOverview(id);
      return;
    }
    if (event === 'client:ready') {
      void this.refresh(id);
      return;
    }
    if (event === 'ai:hitl' && typeof d.requestId === 'string') {
      entry.pending.add(d.requestId);
      this.setSummary(id, { pending: entry.pending.size });
    } else if (event === 'ai:hitlDecided' && typeof d.requestId === 'string') {
      entry.pending.delete(d.requestId);
      this.setSummary(id, { pending: entry.pending.size });
    }
    if (INBOX_EVENTS.has(event) || event === 'agent:finished' || event === 'agent:failed') this.scheduleInbox(id);
  }

  /** После подключения: лента (с ней — очередь HITL) и имя компьютера (оно нужно переключателю). */
  private async refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await Promise.all([this.refreshInbox(id), this.refreshOverview(id)]);
    if (this.entries.get(id) !== entry) return;
    if (!this.inboxes[id]) {
      try {
        const list = await entry.client.rpc<RemotePendingApproval[]>('get_pending_approvals');
        if (this.entries.get(id) !== entry || !Array.isArray(list)) return;
        entry.pending = new Set(list.map((r) => r.requestId));
        this.setSummary(id, { pending: entry.pending.size });
      } catch {
        // нет прав или связи — счётчик останется прежним
      }
    }
    try {
      const status = await entry.client.rpc<RemoteHostStatus>('get_status');
      if (this.entries.get(id) !== entry || !status?.machineName || status.machineName === entry.profile.machineName) return;
      entry.profile = { ...entry.profile, machineName: status.machineName };
      this.onProfileChange(entry.profile);
    } catch {
      // не критично
    }
  }

  private setSummary(id: string, patch: Partial<HostSummary>): void {
    if (!this.entries.has(id)) return;
    const prev = this.summaries[id] ?? { state: 'idle' as const, route: null, pending: 0, error: null };
    this.summaries = { ...this.summaries, [id]: { ...prev, ...patch } };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
