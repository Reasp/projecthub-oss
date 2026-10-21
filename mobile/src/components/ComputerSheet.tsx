import { useCallback, useState } from 'react';
import { ArrowClockwiseIcon, ArrowRightIcon, SignOutIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useHostSummaries, useLastSeen, useServices } from '../app/context';
import type { Dict } from '../i18n';
import { useT } from '../i18n/react';
import { timeAgo } from '../protocol/inbox';
import { activeProfile } from '../protocol/profiles';
import { routeLabel, type ConnectionState } from '../protocol/remoteClient';
import type { EndpointKind } from '../../../src/utils/remoteEndpoints';
import { RouteBadge } from './RouteBadge';
import { Badge, Button, Confirm, Sheet } from './ui';

export function stateDot(state: ConnectionState | undefined): string {
  return state === 'ready' ? 'bg-emerald-400' : state === 'failed' || state === 'idle' || !state ? 'bg-slate-600' : 'bg-amber-400';
}

function stateText(tr: Dict, state: ConnectionState | undefined): string {
  if (state === 'ready') return tr.shell.hostState.online;
  if (state === 'awaiting_approval') return tr.shell.hostState.awaiting;
  // Переподключение — это ожидание следующей попытки: как на «Обзоре», «не в сети» (TASK-191).
  if (state === 'connecting' || state === 'pairing') return tr.shell.hostState.connecting;
  return tr.shell.hostState.offline;
}

export interface HostRow {
  id: string;
  name: string;
  via?: string;
  state: ConnectionState | undefined;
  route: EndpointKind | null;
  pending: number;
  active: boolean;
  /** Почему нет связи — текст клиента; показывается только в карточке компьютера (TASK-191). */
  error: string | null;
  /** Через сколько следующая попытка — известно только у открытого ПК. */
  retryInMs: number | null;
}

/** Сопряжённые компьютеры телефона со статусом: открытый — по своему соединению, остальные — по фоновым (TASK-140.2). */
export function useHostRows(): HostRow[] {
  const { profiles } = useServices();
  const tr = useT();
  const status = useAppState((s) => s.status);
  const conn = useAppState((s) => s.conn);
  const activeHitl = useAppState((s) => s.hitl.length);
  const summaries = useHostSummaries();
  const active = activeProfile(profiles);
  const nameOf = (hostId: string | undefined) => profiles.profiles.find((p) => p.hostId === hostId)?.machineName || hostId || '';
  return profiles.profiles.map((p) => {
    const isActive = p.id === active?.id;
    const summary = summaries[p.id!];
    return {
      id: p.id!,
      name: (isActive && status?.machineName) || p.machineName || p.hostId || tr.common.computer,
      via: p.viaHostId ? nameOf(p.viaHostId) : undefined,
      state: isActive ? conn.state : summary?.state,
      route: isActive ? conn.route : (summary?.route ?? null),
      pending: isActive ? activeHitl : (summary?.pending ?? 0),
      active: isActive,
      error: (isActive ? conn.error : summary?.error) ?? null,
      retryInMs: isActive ? conn.retryInMs : null
    };
  });
}

/** Переподключить компьютер сейчас: открытый — его соединением, фоновый — через пул. */
export function useRetryHost(): (profileId: string) => void {
  const { client, pool, profiles, platform } = useServices();
  const activeId = profiles.activeId;
  return useCallback(
    (profileId: string) => {
      platform.haptic('selection');
      if (profileId === activeId) client.retryNow();
      else pool.retryNow(profileId);
    },
    [client, pool, platform, activeId]
  );
}

/** Строка компьютера: точка состояния, имя, состояние и путь связи, счётчик ожидающих решений. */
export function HostRowContent({ row }: { row: HostRow }) {
  const tr = useT();
  return (
    <>
      <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', stateDot(row.state))} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{row.name}</span>
        <span className="block truncate text-[12px] text-slate-400">
          {stateText(tr, row.state)}
          {row.state === 'ready' && row.route ? ` · ${routeLabel(row.route)}` : ''}
          {row.via ? ` · ${tr.shell.via(row.via)}` : ''}
        </span>
      </span>
      {row.pending > 0 && (
        <span className="min-w-[22px] shrink-0 rounded-full bg-amber-500 px-1.5 text-center text-[12px] font-semibold leading-[22px] text-black" title={tr.shell.pendingTitle}>
          {row.pending}
        </span>
      )}
    </>
  );
}

/**
 * Карточка одного сопряжённого компьютера: состояние, путь связи, «Открыть» и «Забыть». Забыть можно любой компьютер,
 * не переключаясь на него (TASK-140.16).
 */
export function ComputerSheet({ profileId, onClose, onDone }: { profileId: string | null; onClose: () => void; onDone?: () => void }) {
  const { platform, profiles, switchHost, forget } = useServices();
  const tr = useT();
  const rows = useHostRows();
  const conn = useAppState((s) => s.conn);
  const lastSeen = useLastSeen();
  const retry = useRetryHost();
  const [confirm, setConfirm] = useState(false);
  const row = rows.find((r) => r.id === profileId) ?? null;
  const profile = profiles.profiles.find((p) => p.id === profileId);
  const endpoint = row?.active ? conn.endpoint : undefined;
  const seenAt = row ? lastSeen[row.id] : undefined;
  // Фоновый ПК сверх лимита пула соединения не имеет — повторять нечем.
  const canRetry = Boolean(row && row.state !== 'ready' && row.state !== 'awaiting_approval' && (row.active || row.state));

  return (
    <Sheet open={Boolean(row)} onClose={onClose} title={row?.name}>
      {row && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            <Badge tone={row.state === 'ready' ? 'success' : 'warning'}>{stateText(tr, row.state)}</Badge>
            {row.state === 'ready' && <RouteBadge route={row.route} />}
            {row.active && <Badge tone="accent">{tr.shell.openNow}</Badge>}
            {row.pending > 0 && <Badge tone="warning">{tr.shell.pending(row.pending)}</Badge>}
          </div>
          {row.state !== 'ready' && (
            <div data-testid="computer-conn-details" className="mt-3 space-y-1 rounded-xl border border-ph-line bg-ph-raised p-3 text-[13px] text-slate-300">
              {row.retryInMs ? <div className="text-slate-400">{tr.shell.nextRetry(Math.round(row.retryInMs / 1000))}</div> : null}
              {!row.active && <div className="text-slate-400">{seenAt ? tr.fleet.lastSeen(timeAgo(seenAt)) : tr.fleet.neverSeen}</div>}
              {row.error && <div className="select-text break-words text-red-300">{row.error}</div>}
              {canRetry && (
                <Button size="sm" className="mt-1" data-testid="computer-retry" onClick={() => retry(row.id)}>
                  <ArrowClockwiseIcon size={16} /> {tr.shell.reconnect}
                </Button>
              )}
            </div>
          )}
          {row.via && <div className="mt-2 text-[13px] text-slate-400">{tr.shell.via(row.via)}</div>}
          {endpoint && <div className="mt-1 truncate text-[12px] text-slate-500">{tr.shell.address(endpoint)}</div>}
          {profile?.hostId && <div className="mt-1 truncate font-mono text-[11px] text-slate-600">{profile.hostId}</div>}

          {!row.active && (
            <Button
              variant="primary"
              className="mt-4 w-full"
              onClick={() => {
                platform.haptic('selection');
                switchHost(row.id);
                onClose();
                onDone?.();
              }}
            >
              <ArrowRightIcon size={18} /> {tr.shell.openComputer}
            </Button>
          )}
          <Button variant="ghost" className="mt-2 w-full text-red-300" onClick={() => setConfirm(true)}>
            <SignOutIcon size={18} /> {tr.shell.forget}
          </Button>
        </>
      )}
      <Confirm
        open={confirm && Boolean(row)}
        title={tr.shell.forgetTitle}
        body={row ? tr.shell.forgetBody(row.name) : undefined}
        confirmText={tr.shell.forgetConfirm}
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          const id = row?.id;
          setConfirm(false);
          onClose();
          if (row?.active) onDone?.();
          if (id) void forget(id);
        }}
      />
    </Sheet>
  );
}
