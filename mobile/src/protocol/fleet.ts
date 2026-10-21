import { compareHosts, type FleetHostEntry, type RemoteOverview } from '../../../src/utils/fleetOverview';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import type { HostProfile } from './pairing';
import type { ConnectionState } from './remoteClient';

/**
 * Компьютеры экрана «Компьютеры» телефона (TASK-174, decision-129 п. 11): открытый ПК — по своему соединению и сводке
 * стора, остальные — по фоновым соединениям пула. Без React: порядок и состояния проверяются unit-тестами.
 */

export interface PhoneFleetHost extends FleetHostEntry {
  profileId: string;
  /** Открыт сейчас: вкладки показывают его. */
  active: boolean;
  connection?: ConnectionState;
  route: EndpointKind | null;
  /** Связь устанавливается — строка не «нет связи», а «подключение». */
  connecting: boolean;
  unsupported?: boolean;
  via?: string;
}

export interface PhoneFleetInput {
  profiles: HostProfile[];
  activeId: string | null;
  active: {
    overview: RemoteOverview | null;
    unsupported: boolean;
    connection: ConnectionState;
    route: EndpointKind | null;
    machineName?: string;
    /** Список проектов открытого ПК (`get_projects`): дерево старого хоста строится из него. */
    projects?: ReadonlyArray<{ path: string; name: string }>;
  };
  summaries: Record<string, { state: ConnectionState; route: EndpointKind | null; error: string | null }>;
  overviews: Record<string, { overview: RemoteOverview | null; unsupported?: boolean; projects?: ReadonlyArray<{ path: string; name: string }> }>;
  lastSeen: Record<string, number>;
}

/**
 * Хост старше `get_overview` (TASK-181): проекты без сессий и счётчиков, чтобы дерево и область работали и с ним.
 * Признак `unsupported` остаётся — экран подсказывает обновить ProjectHub ради сессий.
 */
export function legacyOverview(hostId: string, machineName: string, projects: ReadonlyArray<{ path: string; name: string }>): RemoteOverview {
  const zero = { waiting: 0, failed: 0, running: 0 };
  return {
    hostId,
    machineName,
    platform: '',
    generatedAt: 0,
    actions: 'none',
    attention: 'quiet',
    counts: zero,
    projects: projects.map((p) => ({
      path: p.path,
      name: p.name || p.path.split(/[\\/]/).filter(Boolean).pop() || p.path,
      attention: 'quiet',
      counts: zero,
      lastActivityAt: 0,
      sessions: [],
      moreSessions: 0,
      processes: { running: 0, failed: 0 },
      tasks: { inProgress: 0, review: 0 }
    }))
  };
}

/**
 * «Подключение» — только первая попытка. Переподключение к выключенному ПК идёт с паузами бесконечно: такая строка —
 * «нет связи · был в сети …», иначе выключенный ПК выглядел бы почти готовым.
 */
const CONNECTING: ReadonlySet<ConnectionState> = new Set(['connecting', 'pairing']);

export function phoneFleetHosts(input: PhoneFleetInput): PhoneFleetHost[] {
  const nameOf = (hostId?: string) => input.profiles.find((p) => p.hostId === hostId)?.machineName || hostId || '';
  return input.profiles
    .filter((p) => p.id)
    .map((p): PhoneFleetHost => {
      const id = p.id!;
      const isActive = id === input.activeId;
      const connection = isActive ? input.active.connection : input.summaries[id]?.state;
      const online = connection === 'ready';
      const snap = isActive ? { overview: input.active.overview, unsupported: input.active.unsupported, projects: input.active.projects } : input.overviews[id];
      const machineName = (isActive && input.active.machineName) || snap?.overview?.machineName || p.machineName || p.hostId;
      const legacy = snap?.unsupported && snap.projects ? legacyOverview(p.hostId, machineName, snap.projects) : undefined;
      const overview = online ? (snap?.overview ?? legacy) : undefined;
      const lastSeenAt = input.lastSeen[id];
      const error = isActive ? undefined : input.summaries[id]?.error ?? undefined;
      return {
        hostId: p.hostId,
        profileId: id,
        machineName,
        self: isActive,
        active: isActive,
        online,
        ...(lastSeenAt ? { lastSeenAt } : {}),
        ...(overview ? { overview } : {}),
        ...(error ? { error } : {}),
        ...(connection ? { connection } : {}),
        route: isActive ? input.active.route : (input.summaries[id]?.route ?? null),
        connecting: Boolean(connection && CONNECTING.has(connection)),
        ...(online && snap?.unsupported ? { unsupported: true } : {}),
        ...(p.viaHostId ? { via: nameOf(p.viaHostId) } : {})
      };
    })
    .sort(compareHosts);
}

/** Ключ раскрытого проекта: на телефоне раскрыт один проект на весь экран. */
export function projectKey(profileId: string, projectPath: string): string {
  return `${profileId}|${projectPath}`;
}
