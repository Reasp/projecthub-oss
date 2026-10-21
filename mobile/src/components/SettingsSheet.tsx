import { useEffect, useState } from 'react';
import { BellRingingIcon, CaretRightIcon, DesktopIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { LANGUAGE_NAMES, LANGUAGES } from '../i18n';
import { useLanguage, useT } from '../i18n/react';
import { activeProfile } from '../protocol/profiles';
import { ComputerSheet, HostRowContent, useHostRows } from './ComputerSheet';
import { Badge, Button, SectionTitle, Sheet } from './ui';

/**
 * Настройки телефона (TASK-140.16): язык, сопряжённые компьютеры (карточка с «Открыть» и «Забыть»), push открытого
 * компьютера, устройство.
 */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const services = useServices();
  const { store, platform, profiles, addHost } = services;
  const tr = useT();
  const language = useLanguage();
  const rows = useHostRows();
  const status = useAppState((s) => s.status);
  const conn = useAppState((s) => s.conn);
  const push = useAppState((s) => s.push);
  const [distributors, setDistributors] = useState<string[] | null>(null);
  const [computer, setComputer] = useState<string | null>(null);
  const active = activeProfile(profiles);
  const activeName = status?.machineName || active?.machineName || tr.common.computer;

  // Push — своё у каждого ПК (TASK-140.3): состояние спрашиваем у открытого ПК при показе листа.
  useEffect(() => {
    if (!open || !platform.push || conn.state !== 'ready') return;
    void store.refreshPush();
    void platform.push.distributors().then(setDistributors);
  }, [open, platform, store, conn.state]);

  return (
    <Sheet open={open} onClose={onClose} title={tr.shell.settings}>
      <SectionTitle>{tr.shell.language}</SectionTitle>
      <div className="flex gap-1 rounded-xl bg-ph-raised p-1" role="radiogroup" aria-label={tr.shell.language}>
        {LANGUAGES.map((lang) => (
          <button
            key={lang}
            type="button"
            role="radio"
            aria-checked={lang === language}
            data-testid={`lang-${lang}`}
            lang={lang}
            onClick={() => {
              if (lang === language) return;
              platform.haptic('selection');
              services.setLanguage(lang);
            }}
            className={clsx('flex-1 rounded-lg py-2 text-[14px]', lang === language ? 'bg-indigo-600 font-medium text-white' : 'text-slate-300 active:bg-ph-hover')}
          >
            {LANGUAGE_NAMES[lang]}
          </button>
        ))}
      </div>

      <SectionTitle>{tr.shell.computers}</SectionTitle>
      <ul className="space-y-1" data-testid="settings-computers">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              data-testid={`settings-host-${r.id}`}
              onClick={() => {
                platform.haptic('selection');
                setComputer(r.id);
              }}
              className={clsx('flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left', r.active ? 'bg-indigo-950 text-indigo-200' : 'active:bg-ph-hover')}
            >
              <HostRowContent row={r} />
              <CaretRightIcon size={16} className="shrink-0 text-slate-500" />
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

      {platform.push && active?.id && (
        <>
          <SectionTitle>{tr.shell.notifications}</SectionTitle>
          <div className="flex items-center gap-2 px-1">
            <BellRingingIcon size={18} className="shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate text-[14px]">{tr.shell.pushFrom(activeName)}</span>
            <Button
              size="sm"
              variant={push?.enabled ? 'secondary' : 'primary'}
              disabled={!push || push.busy || conn.state !== 'ready'}
              onClick={() => {
                platform.haptic('selection');
                void (push?.enabled ? store.disablePush(active.id!) : store.enablePush(active.id!, activeName));
              }}
            >
              <span data-testid="push-toggle">{push?.busy ? '…' : push?.enabled ? tr.shell.pushOff : tr.shell.pushOn}</span>
            </Button>
            {push?.enabled && (
              <Button size="sm" variant="ghost" onClick={() => void store.testPush()}>
                {tr.shell.pushTest}
              </Button>
            )}
          </div>
          <div className="mt-1 px-1 text-[12px] leading-snug text-slate-500">
            {conn.state !== 'ready'
              ? tr.shell.pushOffline
              : distributors && distributors.length === 0
                ? tr.shell.pushNeedsDistributor
                : tr.shell.pushNote}
          </div>
        </>
      )}

      <SectionTitle>{tr.shell.device}</SectionTitle>
      <div className="flex items-center gap-2 px-1 text-[13px] text-slate-400">
        <DesktopIcon size={16} /> {platform.deviceName}
        {platform.store.kind === 'memory' && <Badge tone="warning">{tr.shell.keyNotSaved}</Badge>}
      </div>

      <ComputerSheet profileId={computer} onClose={() => setComputer(null)} onDone={onClose} />
    </Sheet>
  );
}
