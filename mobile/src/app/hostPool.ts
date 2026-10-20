import type { RemotePendingApproval, RemoteHostStatus } from '../../../src/types/remote';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { profileProblems, type HostProfile } from '../protocol/pairing';
import type { ClientSnapshot, ConnectionState, RpcMethod } from '../protocol/remoteClient';

/**
 * Фоновые соединения к остальным хостам телефона (TASK-140.2, [[decision-111]]): переключатель показывает статус,
 * путь связи и число ожидающих решений HITL каждого хоста, а не только открытого. Соединения держатся, только пока
 * интерфейс на экране (`pause`/`resume` по видимости страницы): в фоне WebView всё равно засыпает, а о новых
 * решениях скажет push ([[TASK-140.3]]). Не больше `MAX_BACKGROUND_HOSTS` соединений сразу.
 */

export const MAX_BACKGROUND_HOSTS = 8;

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
}

/** Поля, смена которых требует нового подключения; смена адресов и прав — нет. */
function connectionKey(p: HostProfile): string {
  return [p.id, p.deviceId, p.key, p.deviceToken ?? ''].join('|');
}

export class HostPool {
  private entries = new Map<string, Entry>();
  private summaries: Record<string, HostSummary> = {};
  private listeners = new Set<() => void>();
  private paused = false;
  private wanted: HostProfile[] = [];

  constructor(
    private readonly createClient: (onProfileChange: (profile: HostProfile) => void) => PoolClient,
    private readonly onProfileChange: (profile: HostProfile) => void
  ) {}

  getSummaries = (): Record<string, HostSummary> => this.summaries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Список профилей изменился: соединения ко всем полным профилям, кроме открытого (у него свой клиент). */
  sync(profiles: HostProfile[], activeId: string | null): void {
    this.wanted = profiles.filter((p) => p.id && p.id !== activeId && profileProblems(p).length === 0).slice(0, MAX_BACKGROUND_HOSTS);
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
    const entry: Entry = { client, profile, connKey: connectionKey(profile), pending: new Set(), unsubscribe: [] };
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
  }

  /** После подключения: очередь HITL целиком и имя компьютера (оно нужно переключателю). */
  private async refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      const list = await entry.client.rpc<RemotePendingApproval[]>('get_pending_approvals');
      if (this.entries.get(id) !== entry || !Array.isArray(list)) return;
      entry.pending = new Set(list.map((r) => r.requestId));
      this.setSummary(id, { pending: entry.pending.size });
    } catch {
      // нет прав или связи — счётчик останется прежним
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
