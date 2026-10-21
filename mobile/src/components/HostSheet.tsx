import { DotsThreeIcon, FolderIcon, GitBranchIcon, LockKeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { useT } from '../i18n/react';
import { rightsLabel } from '../protocol/models';
import { activeProfile, catalogEntries } from '../protocol/profiles';
import { ComputerSheet, HostRowContent, useHostRows } from './ComputerSheet';
import { RouteBadge } from './RouteBadge';
import { Badge, Button, SectionTitle, Sheet } from './ui';

function platformIcon(platform?: string) {
  return platform === 'darwin' ? '🍏' : platform === 'linux' ? '🐧' : '💻';
}

/**
 * Хост, проект и соединение: переключатель компьютеров телефона (TASK-140.2) с путём связи, статусом и числом
 * ожидающих решений каждого, выбор проекта, каталог федерации открытого хоста. «⋯» у компьютера — его карточка с
 * «Забыть» (TASK-140.16); push и устройство — в настройках.
 */
export function HostSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, platform, profiles, switchHost, addHost, enrollHost } = useServices();
  const tr = useT();
  const status = useAppState((s) => s.status);
  const projects = useAppState((s) => s.projects);
  const projectPath = useAppState((s) => s.projectPath);
  const hosts = useAppState((s) => s.hosts);
  const branch = useAppState((s) => s.gitBranch);
  const conn = useAppState((s) => s.conn);
  const rows = useHostRows();
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [computer, setComputer] = useState<string | null>(null);
  const active = activeProfile(profiles);
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
    <Sheet open={open} onClose={onClose} title={status?.machineName || tr.common.computer}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
        <Badge tone={conn.state === 'ready' ? 'success' : 'warning'}>{conn.state === 'ready' ? tr.shell.linked : tr.shell.notLinked}</Badge>
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
      {conn.endpoint && <div className="mt-1.5 truncate text-[12px] text-slate-500">{tr.shell.address(conn.endpoint)}</div>}

      <SectionTitle>{tr.shell.computers}</SectionTitle>
      <ul className="space-y-1" data-testid="host-switcher">
        {rows.map((r) => (
          <li key={r.id} className={clsx('flex items-center rounded-xl', r.active ? 'bg-indigo-950 text-indigo-200' : '')}>
            <button
              type="button"
              data-testid={`host-${r.id}`}
              onClick={() => {
                platform.haptic('selection');
                // Открытый компьютер переключать некуда — нажатие открывает его карточку.
                if (r.active) {
                  setComputer(r.id);
                  return;
                }
                switchHost(r.id);
                onClose();
              }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-2.5 pl-3 text-left active:bg-ph-hover"
            >
              <HostRowContent row={r} />
            </button>
            <button
              type="button"
              data-testid={`host-more-${r.id}`}
              aria-label={tr.shell.computerDetails}
              onClick={() => {
                platform.haptic('selection');
                setComputer(r.id);
              }}
              className="shrink-0 rounded-xl px-3 py-3 text-slate-400 active:bg-ph-hover"
            >
              <DotsThreeIcon size={20} weight="bold" />
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
        <PlusIcon size={18} /> {tr.shell.addComputer}
      </Button>

      <SectionTitle>{tr.shell.project}</SectionTitle>
      {projects.length === 0 ? (
        <div className="text-[13px] text-slate-400">{conn.state === 'ready' ? tr.shell.noProjects : tr.shell.noProjectsOffline}</div>
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
          <SectionTitle>{tr.shell.federation}</SectionTitle>
          <ul className="space-y-1">
            {catalog.map(({ host: h, state, profileId }) => (
              <li key={h.hostId} className="flex items-center gap-2 rounded-xl px-3 py-2">
                <span>{platformIcon(h.platform)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{h.machineName || h.hostId}</span>
                  {state === 'unpaired' && <span className="block text-[12px] text-slate-500">{tr.shell.unpaired}</span>}
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
                    {tr.common.open}
                  </Button>
                )}
                {state === 'enrollable' && (
                  <Button size="sm" variant="primary" disabled={enrolling !== null} onClick={() => void enroll(h.hostId)}>
                    {enrolling === h.hostId ? '…' : tr.shell.enroll}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1 px-1 text-[12px] text-slate-500">{tr.shell.federationHint}</div>
        </>
      )}

      <ComputerSheet profileId={computer} onClose={() => setComputer(null)} onDone={onClose} />
    </Sheet>
  );
}
