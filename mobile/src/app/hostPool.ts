import type { RemotePendingApproval, RemoteHostStatus } from '../../../src/types/remote';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { loadInbox, type InboxRpc, type InboxSnapshot } from '../protocol/inbox';
import { profileProblems, type HostProfile } from '../protocol/pairing';
import type { ClientSnapshot, ConnectionState, RpcMethod } from '../protocol/remoteClient';
import { t } from '../i18n';

/**
 * Фоновые соединения к остальным хостам телефона (TASK-140.2, [[decision-111]]): переключатель показывает статус,
 * путь связи и число ожидающих решений HITL каждого хоста, а не только открытого. Соединения держатся, только пока
 * интерфейс на экране (`pause`/`resume` по видимости страницы): в фоне WebView всё равно засыпает, а о новых
 * решениях скажет push ([[TASK-140.3]]). Не больше `MAX_BACKGROUND_HOSTS` соединений сразу.
 *
 * Для «Входящих» ([[TASK-140.5]], [[decision-117]] п. 7) пул держит снимок ленты каждого ПК. Последний снимок
 * остаётся и после разрыва — запись видна с пометкой «нет связи», пока профиль не забыт.
 */

export const MAX_BACKGROUND_HOSTS = 8;
/** Пауза перед перечитыванием ленты после события: пачка событий — один запрос. */
export const INBOX_REFRESH_MS = 600;

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
  private listeners = new Set<() => void>();
  private paused = false;
  private wanted: HostProfile[] = [];

  constructor(
    private readonly createClient: (onProfileChange: (profile: HostProfile) => void) => PoolClient,
    private readonly onProfileChange: (profile: HostProfile) => void,
    // Стрелки, а не сами функции: вызов `this.timers.setTimeout` с чужим `this` в браузере — «Illegal invocation».
    private readonly timers: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void } = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
    }
  ) {}

  getSummaries = (): Record<string, HostSummary> => this.summaries;

  getInboxes = (): Record<string, InboxSnapshot> => this.inboxes;

  /** Есть ли живое соединение с ПК: действие над его записью уйдёт только так. */
  isReady(id: string): boolean {
    return this.entries.has(id) && this.summaries[id]?.state === 'ready';
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
    const entry: Entry = { client, profile, connKey: connectionKey(profile), pending: new Set(), unsubscribe: [], inboxTimer: null };
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
    await this.refreshInbox(id);
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
