import { useEffect, useRef, useState } from 'react';
import { ArrowClockwiseIcon, PlayIcon, StopIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteProcessSummary } from '../../../src/types/remote';
import { useAppState, useServices } from '../app/context';
import { Badge, Button, Card, Confirm, EmptyState, SectionTitle, Sheet } from '../components/ui';
import { Screen } from '../components/Screen';
import { capabilitiesFor } from '../protocol/models';

const STATUS: Record<RemoteProcessSummary['status'], { label: string; tone: 'success' | 'neutral' | 'danger' | 'warning' }> = {
  running: { label: 'работает', tone: 'success' },
  stopped: { label: 'остановлен', tone: 'neutral' },
  failed: { label: 'упал', tone: 'danger' },
  unknown: { label: 'неизвестно', tone: 'warning' }
};

function LogSheet({ proc, onClose }: { proc: RemoteProcessSummary | null; onClose: () => void }) {
  const { store } = useServices();
  const logs = useAppState((s) => s.logs);
  const text = proc ? (logs[proc.id] ?? '') : '';
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (proc) void store.loadLogs(proc);
  }, [proc, store]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, follow]);

  return (
    <Sheet open={Boolean(proc)} onClose={onClose} title={proc?.name}>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="selectable h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ph-base p-2 font-mono text-[11px] leading-relaxed text-sky-300"
      >
        {text || 'Логов пока нет.'}
      </pre>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => proc && void store.loadLogs(proc, 500)}>
          <ArrowClockwiseIcon size={16} /> Перечитать
        </Button>
        {!follow && (
          <Button size="sm" onClick={() => setFollow(true)}>
            К концу
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** Процессы проекта, их логи и действия `.projecthub.json` (run/test/deploy). */
export function ProcessesScreen() {
  const { store } = useServices();
  const processes = useAppState((s) => s.processes);
  const projectPath = useAppState((s) => s.projectPath);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [openProc, setOpenProc] = useState<RemoteProcessSummary | null>(null);
  const [confirmDeploy, setConfirmDeploy] = useState(false);

  if (!projectPath) return <EmptyState icon={<TerminalWindowIcon size={40} />} title="Проект не выбран" />;

  return (
    <Screen onRefresh={() => store.refreshProcesses()}>
      {canWrite && (
        <>
          <SectionTitle>Действия проекта</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            <Button size="sm" onClick={() => void store.runAction('run')}>
              <PlayIcon size={16} /> Run
            </Button>
            <Button size="sm" onClick={() => void store.runAction('test')}>
              Тесты
            </Button>
            <Button size="sm" onClick={() => setConfirmDeploy(true)}>
              Deploy
            </Button>
          </div>
        </>
      )}

      <SectionTitle>Процессы</SectionTitle>
      {processes.length === 0 ? (
        <EmptyState icon={<TerminalWindowIcon size={40} />} title="Нет процессов" hint="Запущенные dev-серверы и вотчеры появятся здесь." />
      ) : (
        processes.map((p) => {
          const st = STATUS[p.status] ?? STATUS.unknown;
          return (
            <Card key={p.id} className="mb-2">
              <button type="button" className="block w-full text-left" onClick={() => setOpenProc(p)}>
                <div className="flex items-center gap-2">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', p.status === 'running' ? 'bg-emerald-400' : p.status === 'failed' ? 'bg-red-400' : 'bg-slate-500')} />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{p.name}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-slate-400">{p.command}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {p.pid ? `PID ${p.pid}` : ''}
                  {p.port ? ` · порт ${p.port}` : ''}
                  {p.source === 'env-tools' ? ' · env-tools' : ''}
                </div>
              </button>
              {canWrite && (
                <div className="mt-2 flex gap-2">
                  {p.status === 'running' ? (
                    <Button size="sm" variant="danger" haptic="medium" onClick={() => void store.stopProcess(p.id)}>
                      <StopIcon size={16} /> Стоп
                    </Button>
                  ) : null}
                  <Button size="sm" haptic="medium" onClick={() => void store.restartProcess(p.id)}>
                    <ArrowClockwiseIcon size={16} /> {p.status === 'running' ? 'Перезапуск' : 'Запустить'}
                  </Button>
                </div>
              )}
            </Card>
          );
        })
      )}

      <LogSheet proc={openProc} onClose={() => setOpenProc(null)} />
      <Confirm
        open={confirmDeploy}
        title="Запустить deploy?"
        body="Команда deploy из .projecthub.json выполнится на ПК."
        confirmText="Запустить"
        danger
        onCancel={() => setConfirmDeploy(false)}
        onConfirm={() => {
          setConfirmDeploy(false);
          void store.runAction('deploy');
        }}
      />
    </Screen>
  );
}
