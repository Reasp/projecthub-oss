import { useState } from 'react';
import { DesktopIcon, FolderIcon, GitBranchIcon, LockKeyIcon, PlusIcon, SignOutIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useHostSummaries, useServices } from '../app/context';
import { rightsLabel } from '../protocol/models';
import { activeProfile, catalogEntries } from '../protocol/profiles';
import { routeLabel, type ConnectionState } from '../protocol/remoteClient';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { RouteBadge } from './RouteBadge';
import { Badge, Button, Confirm, SectionTitle, Sheet } from './ui';

function platformIcon(platform?: string) {
  return platform === 'darwin' ? '🍏' : platform === 'linux' ? '🐧' : '💻';
}

function stateDot(state: ConnectionState | undefined): string {
  return state === 'ready' ? 'bg-emerald-400' : state === 'failed' || state === 'idle' || !state ? 'bg-slate-600' : 'bg-amber-400';
}

function stateText(state: ConnectionState | undefined): string {
  if (state === 'ready') return 'в сети';
  if (state === 'awaiting_approval') return 'ждёт одобрения';
  if (state === 'connecting' || state === 'pairing' || state === 'reconnecting') return 'подключение…';
  return 'не в сети';
}

interface HostRow {
  id: string;
  name: string;
  via?: string;
  state: ConnectionState | undefined;
  route: EndpointKind | null;
  pending: number;
  active: boolean;
}

/**
 * Хост, проект и соединение: переключатель компьютеров телефона (TASK-140.2) с путём связи, статусом и числом
 * ожидающих решений каждого, выбор проекта, каталог федерации открытого хоста, права устройства, «забыть».
 */
export function HostSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, forget, platform, profiles, switchHost, addHost, enrollHost } = useServices();
  const status = useAppState((s) => s.status);
  const projects = useAppState((s) => s.projects);
  const projectPath = useAppState((s) => s.projectPath);
  const hosts = useAppState((s) => s.hosts);
  const branch = useAppState((s) => s.gitBranch);
  const conn = useAppState((s) => s.conn);
  const activeHitl = useAppState((s) => s.hitl.length);
  const summaries = useHostSummaries();
  const [confirmForget, setConfirmForget] = useState(false);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const active = activeProfile(profiles);
  const nameOf = (hostId: string | undefined) => profiles.profiles.find((p) => p.hostId === hostId)?.machineName || hostId || '';

  const rows: HostRow[] = profiles.profiles.map((p) => {
    const isActive = p.id === active?.id;
    const summary = summaries[p.id!];
    return {
      id: p.id!,
      name: (isActive && status?.machineName) || p.machineName || p.hostId || 'Компьютер',
      via: p.viaHostId ? nameOf(p.viaHostId) : undefined,
      state: isActive ? conn.state : summary?.state,
      route: isActive ? conn.route : (summary?.route ?? null),
      pending: isActive ? activeHitl : (summary?.pending ?? 0),
      active: isActive
    };
  });
  const catalog = catalogEntries(profiles, active, hosts);

  const enroll = async (hostId: string) => {
    setEnrolling(hostId);
    try {
      if (await enrollHost(hostId)) {
        platform.haptic('success');
        onClose();
      }
    } finally {
      setEnrolling(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={status?.machineName || 'Компьютер'}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
        <Badge tone={conn.state === 'ready' ? 'success' : 'warning'}>{conn.state === 'ready' ? 'на связи' : 'нет связи'}</Badge>
        <RouteBadge route={conn.route} />
        <Badge tone="accent">{rightsLabel(conn.rights, conn.readOnly)}</Badge>
        {conn.protocol === 2 && (
          <Badge tone="success">
            <LockKeyIcon size={12} className="mr-1" />
            v2
          </Badge>
        )}
        {conn.protocol === 1 && <Badge tone="warning">v1</Badge>}
        {branch && (
          <Badge>
            <GitBranchIcon size={12} className="mr-1" />
            {branch}
          </Badge>
        )}
      </div>
      {conn.endpoint && <div className="mt-1.5 truncate text-[12px] text-slate-500">Адрес: {conn.endpoint}</div>}

      <SectionTitle>Компьютеры</SectionTitle>
      <ul className="space-y-1" data-testid="host-switcher">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              data-testid={`host-${r.id}`}
              onClick={() => {
                if (r.active) return;
                platform.haptic('selection');
                switchHost(r.id);
                onClose();
              }}
              className={clsx('flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left', r.active ? 'bg-indigo-950 text-indigo-200' : 'active:bg-ph-hover')}
            >
              <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', stateDot(r.state))} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{r.name}</span>
                <span className="block truncate text-[12px] text-slate-400">
                  {stateText(r.state)}
                  {r.state === 'ready' && r.route ? ` · ${routeLabel(r.route)}` : ''}
                  {r.via ? ` · через ${r.via}` : ''}
                </span>
              </span>
              {r.pending > 0 && (
                <span className="min-w-[22px] shrink-0 rounded-full bg-amber-500 px-1.5 text-center text-[12px] font-semibold leading-[22px] text-black" title="Ждут решения">
                  {r.pending}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        className="mt-1 w-full"
        onClick={() => {
          onClose();
          addHost();
        }}
      >
        <PlusIcon size={18} /> Добавить компьютер
      </Button>

      <SectionTitle>Проект</SectionTitle>
      {projects.length === 0 ? (
        <div className="text-[13px] text-slate-400">
          {conn.state === 'ready' ? 'В ProjectHub на этом компьютере нет проектов.' : 'Нет связи с компьютером — список проектов появится после подключения.'}
        </div>
      ) : (
        <ul className="space-y-1">
          {projects.map((p) => (
            <li key={p.path}>
              <button
                type="button"
                onClick={() => {
                  platform.haptic('selection');
                  void store.selectProject(p.path);
                  onClose();
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left',
                  p.path === projectPath ? 'bg-indigo-950 text-indigo-200' : 'active:bg-ph-hover'
                )}
              >
                <FolderIcon size={18} className="shrink-0" weight={p.path === projectPath ? 'fill' : 'regular'} />
                <span className="min-w-0 flex-1 truncate text-[15px]">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {catalog.length > 0 && (
        <>
          <SectionTitle>Федерация этого компьютера</SectionTitle>
          <ul className="space-y-1">
            {catalog.map(({ host: h, state, profileId }) => (
              <li key={h.hostId} className="flex items-center gap-2 rounded-xl px-3 py-2">
                <span>{platformIcon(h.platform)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{h.machineName || h.hostId}</span>
                  {state === 'unpaired' && <span className="block text-[12px] text-slate-500">Не сопряжён с этим ПК — отсканируйте его QR</span>}
                </span>
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', h.isOnline ? 'bg-emerald-400' : 'bg-slate-600')} />
                {state === 'connected' && profileId && (
                  <Button
                    size="sm"
                    onClick={() => {
                      switchHost(profileId);
                      onClose();
                    }}
                  >
                    Открыть
                  </Button>
                )}
                {state === 'enrollable' && (
                  <Button size="sm" variant="primary" disabled={enrolling !== null} onClick={() => void enroll(h.hostId)}>
                    {enrolling === h.hostId ? '…' : 'Подключить'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1 px-1 text-[12px] text-slate-500">
            Доступ к соседнему ПК выдаётся отдельным токеном через этот компьютер. Компьютеры других сопряжений сюда не попадают.
          </div>
        </>
      )}

      <SectionTitle>Устройство</SectionTitle>
      <div className="flex items-center gap-2 px-1 text-[13px] text-slate-400">
        <DesktopIcon size={16} /> {platform.deviceName}
        {platform.store.kind === 'memory' && <Badge tone="warning">ключ не сохраняется</Badge>}
      </div>
      <Button variant="ghost" className="mt-3 w-full text-red-300" onClick={() => setConfirmForget(true)}>
        <SignOutIcon size={18} /> Забыть этот компьютер
      </Button>

      <Confirm
        open={confirmForget}
        title="Забыть компьютер?"
        body="Ключ и токен устройства для этого компьютера удалятся с телефона, остальные компьютеры останутся. Чтобы подключиться снова, понадобится QR-код. На ПК устройство остаётся в списке — отзовите его там."
        confirmText="Забыть"
        danger
        onCancel={() => setConfirmForget(false)}
        onConfirm={() => {
          setConfirmForget(false);
          onClose();
          void forget();
        }}
      />
    </Sheet>
  );
}
