import { useState } from 'react';
import { DesktopIcon, FolderIcon, GitBranchIcon, GlobeIcon, SignOutIcon, WifiHighIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { rightsLabel } from '../protocol/models';
import { Badge, Button, Confirm, SectionTitle, Sheet } from './ui';

function platformIcon(platform?: string) {
  return platform === 'darwin' ? '🍏' : platform === 'linux' ? '🐧' : '💻';
}

/** Хост, проект и соединение: выбор проекта, каталог федерации, права устройства, «забыть». */
export function HostSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, forget, platform } = useServices();
  const status = useAppState((s) => s.status);
  const projects = useAppState((s) => s.projects);
  const projectPath = useAppState((s) => s.projectPath);
  const hosts = useAppState((s) => s.hosts);
  const branch = useAppState((s) => s.gitBranch);
  const conn = useAppState((s) => s.conn);
  const [confirmForget, setConfirmForget] = useState(false);
  const others = hosts.filter((h) => h.hostId !== status?.hostId);

  return (
    <Sheet open={open} onClose={onClose} title={status?.machineName || 'Компьютер'}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
        <Badge tone={conn.state === 'ready' ? 'success' : 'warning'}>{conn.state === 'ready' ? 'на связи' : 'нет связи'}</Badge>
        <Badge>
          {conn.viaRelay ? <GlobeIcon size={12} className="mr-1" /> : <WifiHighIcon size={12} className="mr-1" />}
          {conn.viaRelay ? 'релей' : 'локальная сеть'} · E2EE
        </Badge>
        <Badge tone="accent">{rightsLabel(conn.rights, conn.readOnly)}</Badge>
        {branch && (
          <Badge>
            <GitBranchIcon size={12} className="mr-1" />
            {branch}
          </Badge>
        )}
      </div>

      <SectionTitle>Проект</SectionTitle>
      {projects.length === 0 ? (
        <div className="text-[13px] text-slate-400">На этом компьютере нет проектов.</div>
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

      {others.length > 0 && (
        <>
          <SectionTitle>Другие компьютеры</SectionTitle>
          <ul className="space-y-1">
            {others.map((h) => (
              <li key={h.hostId} className="flex items-center gap-2 rounded-xl px-3 py-2.5">
                <span>{platformIcon(h.platform)}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{h.machineName || h.hostId}</span>
                <span className={clsx('h-2 w-2 rounded-full', h.isOnline ? 'bg-emerald-400' : 'bg-slate-600')} />
              </li>
            ))}
          </ul>
          <div className="mt-1 px-1 text-[12px] text-slate-500">Подключение к нескольким компьютерам из одного телефона появится вместе с протоколом v2.</div>
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
        body="Ключ и токен устройства удалятся с телефона. Чтобы подключиться снова, понадобится QR-код. На ПК устройство остаётся в списке — отзовите его там."
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
