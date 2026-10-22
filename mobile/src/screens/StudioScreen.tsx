import { useEffect, useRef, useState } from 'react';
import {
  CameraIcon,
  CaretDownIcon,
  ChartBarIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  LightningIcon,
  DesktopIcon,
  DeviceMobileIcon,
  FileIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SparkleIcon,
  StopIcon,
  WrenchIcon,
  XIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteStudioSessionSummary, StudioMode } from '../../../src/types/remote';
import { useAppState, useServices } from '../app/context';
import { useT } from '../i18n/react';
import {
  formatTokens,
  groupStudioSessions,
  matchStudioCommands,
  MODE_LABEL,
  relativeTime,
  selectionTitle,
  STUDIO_COMMANDS,
  type StudioCommandId
} from '../app/studioState';
import { Markdown } from '../components/Markdown';
import { Button, EmptyState, SectionTitle, Sheet, Spinner } from '../components/ui';
import { copyText } from '../platform/clipboard';
import { capabilitiesFor } from '../protocol/models';
import { ATTACH_MAX_PER_PROMPT, formatBytes } from '../protocol/attachments';
import { prepareAttachment } from '../components/attachmentFile';
import { appendTranscript } from '../protocol/voice';
import { VoiceButton } from './VoiceButton';
import { fieldProps } from '../components/FieldEditor';

/** Вложение в поле ввода: грузится сразу после выбора, в промпт уходит путь в проекте на хосте. */
interface Attachment {
  id: number;
  name: string;
  size: number;
  progress: number;
  path?: string;
}

let attachmentSeq = 0;

/**
 * Agents Studio на ПК с телефона (TASK-140.10, decision-83): те же сессии, что во вкладках ProjectHub. Можно
 * открыть вкладку ПК или старую сессию из истории, начать новую с выбором модели и режима, остановить ответ.
 */
export function StudioScreen() {
  const { store, platform } = useServices();
  const tr = useT();
  const studio = useAppState((s) => s.studio);
  const projectPath = useAppState((s) => s.projectPath);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [text, setText] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachMenu, setAttachMenu] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const suggestions = matchStudioCommands(text);
  const uploading = attachments.some((a) => !a.path);
  const ready = attachments.filter((a) => a.path).map((a) => a.path!);

  // Фото и файлы в промпт (TASK-140.6): загружаются сразу, к отправке промпта уже лежат в проекте на хосте.
  const addFiles = async (files: FileList | null) => {
    setAttachMenu(false);
    const picked = Array.from(files ?? []).slice(0, Math.max(0, ATTACH_MAX_PER_PROMPT - attachments.length));
    for (const file of picked) {
      const id = ++attachmentSeq;
      setAttachments((prev) => [...prev, { id, name: file.name || tr.studio.fileFallback, size: file.size, progress: 0 }]);
      const prepared = await prepareAttachment(file).catch(() => null);
      if (!prepared) {
        store.showToast(tr.studio.readFailed(file.name), 'error');
        setAttachments((prev) => prev.filter((a) => a.id !== id));
        continue;
      }
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, name: prepared.name, size: prepared.bytes.length } : a)));
      const path = await store.uploadAttachment(prepared, (sent, total) =>
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, progress: sent / total } : a)))
      );
      setAttachments((prev) => (path ? prev.map((a) => (a.id === id ? { ...a, path, progress: 1 } : a)) : prev.filter((a) => a.id !== id)));
    }
  };

  // Лимиты для бейджа на кнопке Usage — из кэша хоста, без запуска `claude -p /usage` при каждом заходе.
  useEffect(() => {
    if (!studio.usage && !studio.usageLoading) void store.loadUsage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при первом показе экрана
  }, []);

  const runCommand = async (id: StudioCommandId) => {
    platform.haptic('selection');
    setText('');
    setCommandsOpen(false);
    if (id === 'clear') await store.clearStudioSession();
    else if (id === 'new') store.newStudioSession();
    else if (id === 'usage') {
      setUsageOpen(true);
      void store.loadUsage(false);
    } else if (id === 'model') {
      setModelOpen(true);
      if (!studio.options) void store.loadStudioOptions();
    } else if (id === 'sessions') {
      setSessionsOpen(true);
      void store.refreshStudioSessions();
    } else if (id === 'stop') await store.abortStudio();
  };

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [studio.messages, studio.sessionId]);

  /** `value` — текст из редактора поля (TASK-177): `text` к этому моменту ещё не обновился. */
  const send = async (value = text) => {
    // «/clear» и другие команды, набранные целиком, выполняются, а не уходят агенту текстом.
    const exact = STUDIO_COMMANDS.find((c) => c.command === value.trim().toLowerCase());
    if (exact) {
      await runCommand(exact.id);
      return;
    }
    const sent = attachments;
    setText('');
    setAttachments([]);
    const ok = await store.sendPrompt(value, ready);
    if (!ok) {
      setText(value);
      setAttachments(sent);
    }
  };

  if (!projectPath) return <EmptyState icon={<SparkleIcon size={40} />} title={tr.common.noProject} />;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-ph-line px-3 pb-1.5 pt-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              platform.haptic('selection');
              setSessionsOpen(true);
              void store.refreshStudioSessions();
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left active:bg-ph-hover"
            aria-label={tr.studio.sessionsAndHistory}
          >
            <ClockCounterClockwiseIcon size={18} className="shrink-0 text-slate-400" />
            <span className="truncate text-[15px] font-medium">{studio.sessionId ? studio.title || tr.studio.session : tr.studio.newSession}</span>
            <CaretDownIcon size={14} className="shrink-0 text-slate-500" />
          </button>
          <button
            type="button"
            onClick={() => void runCommand('usage')}
            className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-1 text-[12px] text-slate-300 active:bg-ph-hover"
            aria-label={tr.studio.usage}
          >
            <ChartBarIcon size={18} />
            {studio.usage?.sessionLimit && (
              <span className={clsx(studio.usage.sessionLimit.percent >= 85 ? 'text-red-300' : studio.usage.sessionLimit.percent >= 60 ? 'text-amber-300' : 'text-slate-400')}>
                {studio.usage.sessionLimit.percent}%
              </span>
            )}
          </button>
          {canWrite && studio.sessionId && (
            <button type="button" aria-label={tr.studio.newSession} onClick={() => store.newStudioSession()} className="shrink-0 rounded-full p-1.5 text-slate-300 active:bg-ph-hover">
              <PlusIcon size={20} />
            </button>
          )}
        </div>
        {/* Модель — второй строкой: в одной строке с ней название сессии сжималось до одной буквы. */}
        {canWrite && (
          <button
            type="button"
            onClick={() => {
              platform.haptic('selection');
              setModelOpen(true);
              if (!studio.options) void store.loadStudioOptions();
            }}
            className="mt-1 max-w-full truncate rounded-full border border-ph-line bg-ph-raised px-2.5 py-1 text-[12px] text-slate-300 active:bg-ph-hover"
            aria-label={tr.studio.modelAndMode}
          >
            {selectionTitle(studio.selection, studio.options)} · {MODE_LABEL[studio.mode]}
          </button>
        )}
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        {studio.loading ? (
          <div className="flex justify-center pt-10">
            <Spinner />
          </div>
        ) : studio.messages.length === 0 ? (
          <EmptyState
            icon={<SparkleIcon size={40} />}
            title={tr.studio.emptyTitle}
            hint={tr.studio.emptyHint}
          />
        ) : (
          <>
            {studio.olderOmitted > 0 && (
              <div className="mb-2 text-center text-[12px] text-slate-500">{tr.studio.olderOmitted(studio.olderOmitted)}</div>
            )}
            {studio.messages.map((m) => (
              <div key={m.id} className={clsx('mb-2 flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={clsx(
                    'selectable max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[14px] leading-relaxed',
                    m.role === 'user' && 'rounded-br-md bg-indigo-500 text-white',
                    m.role === 'assistant' && 'rounded-bl-md bg-ph-elevated text-slate-100',
                    m.role === 'error' && 'bg-red-950/70 text-red-200'
                  )}
                >
                  {m.tools && m.tools.length > 0 && (
                    <div className={clsx('space-y-0.5', m.text && 'mb-1.5')}>
                      {m.tools.map((t) => (
                        <div key={t.id} className="flex items-center gap-1.5 text-[12px] text-slate-400">
                          <WrenchIcon size={12} className="shrink-0" />
                          <span className="shrink-0 font-medium text-slate-300">{t.name}</span>
                          {t.summary && <span className="truncate font-mono">{t.summary}</span>}
                          {t.status && t.status !== 'done' && <span className="shrink-0 text-amber-300">· {t.status}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
                  {m.truncated && <span className="text-slate-500">{tr.studio.truncated}</span>}
                  {m.role === 'assistant' && m.text && <CopyMessage text={m.text} />}
                </div>
              </div>
            ))}
          </>
        )}
        {studio.busy && (
          <div className="mb-3 flex items-center gap-2 px-1 text-[13px] text-slate-400">
            <Spinner className="h-3 w-3" /> {tr.studio.agentWorking}
          </div>
        )}
      </div>

      {canWrite && suggestions.length > 0 && (
        <div className="border-t border-ph-line bg-ph-panel px-2 py-1">
          {suggestions.map((c) => (
            <button key={c.id} type="button" onClick={() => void runCommand(c.id)} className="flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left active:bg-ph-hover">
              <span className="font-mono text-[14px] text-indigo-300">{c.command}</span>
              <span className="truncate text-[12px] text-slate-400">{c.title}</span>
            </button>
          ))}
        </div>
      )}
      {canWrite && (attachments.length > 0 || attachMenu) && (
        <div className="border-t border-ph-line bg-ph-panel px-3 py-2">
          {attachMenu && (
            <div className="mb-2 flex gap-2">
              <Button variant="secondary" size="sm" className="flex-1" onClick={() => cameraInput.current?.click()}>
                <CameraIcon size={16} /> {tr.studio.camera}
              </Button>
              <Button variant="secondary" size="sm" className="flex-1" onClick={() => galleryInput.current?.click()}>
                <ImageIcon size={16} /> {tr.studio.photo}
              </Button>
              <Button variant="secondary" size="sm" className="flex-1" onClick={() => fileInput.current?.click()}>
                <FileIcon size={16} /> {tr.studio.file}
              </Button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="studio-attachments">
              {attachments.map((a) => (
                <span key={a.id} className="flex max-w-full items-center gap-1 rounded-full border border-ph-line bg-ph-raised py-1 pl-2.5 pr-1 text-[12px]">
                  <PaperclipIcon size={12} className="shrink-0 text-slate-400" />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-slate-500">{a.path ? formatBytes(a.size) : `${Math.round(a.progress * 100)}%`}</span>
                  <button
                    type="button"
                    aria-label={tr.studio.removeAttachment(a.name)}
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    className="shrink-0 rounded-full p-1 text-slate-400 active:bg-ph-hover"
                  >
                    <XIcon size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {canWrite && (
        <>
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))} />
          <input ref={galleryInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))} />
          <input ref={fileInput} type="file" multiple hidden data-testid="studio-file-input" onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))} />
        </>
      )}
      {canWrite ? (
        <div className="flex items-end gap-2 border-t border-ph-line bg-ph-chrome px-3 py-2">
          <button
            type="button"
            aria-label={tr.studio.quickCommands}
            onClick={() => {
              platform.haptic('selection');
              setCommandsOpen(true);
              if (!studio.options) void store.loadStudioOptions();
            }}
            className="mb-1 shrink-0 rounded-full p-2 text-slate-300 active:bg-ph-hover"
          >
            <LightningIcon size={22} />
          </button>
          <button
            type="button"
            aria-label={tr.studio.attach}
            onClick={() => {
              platform.haptic('selection');
              setAttachMenu((v) => !v);
            }}
            className={clsx('-ml-2 mb-1 shrink-0 rounded-full p-2 active:bg-ph-hover', attachMenu ? 'text-indigo-300' : 'text-slate-300')}
          >
            <PaperclipIcon size={22} />
          </button>
          <VoiceButton disabled={studio.busy} onText={(spoken) => setText((prev) => appendTranscript(prev, spoken))} />
          <textarea
            {...fieldProps({
              value: text,
              onChange: setText,
              multiline: true,
              placeholder: studio.sessionId ? tr.studio.continuePlaceholder : tr.studio.newPlaceholder,
              ...(!studio.busy && !uploading ? { onSubmit: (value: string) => void send(value), submitLabel: tr.studio.send } : {})
            })}
            rows={1}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-ph-line bg-ph-raised px-3 py-2.5 text-[15px] outline-none focus:border-indigo-500"
          />
          {studio.busy ? (
            <Button className="h-11 w-11 shrink-0 rounded-full !px-0" haptic="medium" aria-label={tr.studio.stopResponse} onClick={() => void store.abortStudio()}>
              <StopIcon size={20} weight="fill" />
            </Button>
          ) : (
            <Button
              variant="primary"
              className="h-11 w-11 shrink-0 rounded-full !px-0"
              disabled={uploading || (!text.trim() && ready.length === 0)}
              haptic="medium"
              aria-label={tr.studio.send}
              onClick={() => void send()}
            >
              <PaperPlaneRightIcon size={20} weight="fill" />
            </Button>
          )}
        </div>
      ) : (
        <div className="border-t border-ph-line px-3 py-3 text-center text-[13px] text-slate-400">{tr.studio.cannotSend}</div>
      )}

      <SessionsSheet open={sessionsOpen} onClose={() => setSessionsOpen(false)} />
      <ModelSheet open={modelOpen} onClose={() => setModelOpen(false)} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} />
      <CommandsSheet
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        onCommand={(id) => void runCommand(id)}
        onPrompt={(prompt) => {
          setCommandsOpen(false);
          setText(prompt);
        }}
      />
    </div>
  );
}

/** Копировать весь ответ агента (сырой Markdown). */
function CopyMessage({ text }: { text: string }) {
  const tr = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="mt-1 flex justify-end">
      <button
        type="button"
        onClick={async () => setCopied(await copyText(text))}
        className="-mb-1 -mr-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-slate-500 active:bg-ph-hover"
        aria-label={tr.studio.copyResponse}
      >
        {copied ? <CheckIcon size={13} className="text-emerald-400" /> : <CopyIcon size={13} />}
        {copied ? tr.common.copied : tr.common.copy}
      </button>
    </div>
  );
}

function LimitBar({ label, w }: { label: string; w?: { percent: number; resetsAt?: string } }) {
  const tr = useT();
  if (!w) return null;
  const tone = w.percent >= 85 ? 'bg-red-500' : w.percent >= 60 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between text-[13px]">
        <span>{label}</span>
        <span className="font-semibold">{w.percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ph-raised">
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${w.percent}%` }} />
      </div>
      {w.resetsAt && <div className="mt-0.5 text-[11px] text-slate-500">{tr.studio.resets(w.resetsAt)}</div>}
    </div>
  );
}

/** Окно Usage: лимиты Claude Code с ПК, запросы, токены по моделям и расход открытой сессии. */
function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useServices();
  const tr = useT();
  const studio = useAppState((s) => s.studio);
  const u = studio.usage;
  const su = studio.sessionUsage;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`${tr.studio.usage}${u?.planType ? ` · ${u.planType}` : ''}`}
      footer={
        <Button className="w-full" disabled={studio.usageLoading} onClick={() => void store.loadUsage(true)}>
          {studio.usageLoading ? <Spinner className="h-4 w-4" /> : null} {tr.studio.refreshFromPc}
        </Button>
      }
    >
      {!u ? (
        <div className="flex justify-center py-6">{studio.usageLoading ? <Spinner /> : <span className="text-[13px] text-slate-400">{tr.studio.noData}</span>}</div>
      ) : (
        <>
          {u.error && <div className="mb-3 rounded-xl bg-amber-950/60 p-3 text-[13px] text-amber-100">{u.error.message}</div>}
          <LimitBar label={tr.studio.currentSession} w={u.sessionLimit} />
          <LimitBar label={tr.studio.week} w={u.weeklyLimit} />
          <LimitBar label="Fable" w={u.fableLimit} />
          {!u.sessionLimit && !u.weeklyLimit && !u.error && <div className="mb-3 text-[13px] text-slate-400">{tr.studio.noLimits}</div>}
          {(u.last24h || u.last7d) && (
            <div className="mb-3 grid grid-cols-2 gap-2 text-[13px]">
              {u.last24h && (
                <div className="rounded-xl bg-ph-raised p-2.5">
                  <div className="text-[11px] text-slate-500">{tr.studio.last24h}</div>
                  {u.last24h.requests !== undefined && <div>{tr.studio.requests(u.last24h.requests)}</div>}
                  {u.last24h.sessions !== undefined && <div>{tr.studio.sessions(u.last24h.sessions)}</div>}
                </div>
              )}
              {u.last7d && (
                <div className="rounded-xl bg-ph-raised p-2.5">
                  <div className="text-[11px] text-slate-500">{tr.studio.last7d}</div>
                  {u.last7d.requests !== undefined && <div>{tr.studio.requests(u.last7d.requests)}</div>}
                  {u.last7d.sessions !== undefined && <div>{tr.studio.sessions(u.last7d.sessions)}</div>}
                </div>
              )}
            </div>
          )}
          {su && (
            <>
              <SectionTitle>{tr.studio.thisSession}</SectionTitle>
              <div className="text-[13px] text-slate-300">
                {tr.studio.sessionTokens(formatTokens(su.inputTokens), formatTokens(su.outputTokens))}
                {su.costUsd ? ` · $${su.costUsd.toFixed(4)}` : ''}
                {su.estimated ? tr.studio.estimated : ''}
              </div>
            </>
          )}
          {u.models.length > 0 && (
            <>
              <SectionTitle>{tr.studio.models}</SectionTitle>
              <div className="space-y-1">
                {u.models.map((m) => (
                  <div key={m.model} className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate font-mono text-[12px]">{m.model}</span>
                    <span className="shrink-0 text-slate-400">
                      {formatTokens(m.inputTokens)} / {formatTokens(m.outputTokens)}
                      {/* У подписки стоимость 0 — не показываем «$0.00». */}
                      {m.costUSD ? ` · $${m.costUSD.toFixed(2)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-3 text-[11px] text-slate-500">
            {tr.studio.updated(relativeTime(u.updatedAt))}
            {u.totalSessions !== undefined ? tr.studio.totalSessions(u.totalSessions) : ''}
            {u.isFallback ? tr.studio.fromStats : ''}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Быстрые команды и быстрые промпты Agents Studio (те же, что кнопки на ПК). */
function CommandsSheet({
  open,
  onClose,
  onCommand,
  onPrompt
}: {
  open: boolean;
  onClose: () => void;
  onCommand: (id: StudioCommandId) => void;
  onPrompt: (prompt: string) => void;
}) {
  const tr = useT();
  const studio = useAppState((s) => s.studio);
  const commands = STUDIO_COMMANDS.filter((c) => (c.id === 'stop' ? studio.busy : true));
  return (
    <Sheet open={open} onClose={onClose} title={tr.studio.quickCommands}>
      <div className="space-y-0.5">
        {commands.map((c) => (
          <button key={c.id} type="button" onClick={() => onCommand(c.id)} className="flex w-full flex-col rounded-xl px-3 py-2 text-left active:bg-ph-hover">
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-[14px] text-indigo-300">{c.command}</span>
              <span className="text-[14px]">{c.title}</span>
            </span>
            <span className="text-[12px] text-slate-400">{c.hint}</span>
          </button>
        ))}
      </div>
      {studio.options?.quickPrompts && studio.options.quickPrompts.length > 0 && (
        <>
          <SectionTitle>{tr.studio.quickPrompts}</SectionTitle>
          <div className="space-y-0.5">
            {studio.options.quickPrompts.map((p) => (
              <button key={p.id} type="button" onClick={() => onPrompt(p.prompt)} className="flex w-full flex-col rounded-xl px-3 py-2 text-left active:bg-ph-hover">
                <span className="text-[14px]">{p.label}</span>
                <span className="line-clamp-2 text-[12px] text-slate-400">{p.prompt}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 text-[12px] text-slate-500">{tr.studio.quickPromptsHint}</div>
        </>
      )}
    </Sheet>
  );
}


function SessionRow({ s, active, onOpen }: { s: RemoteStudioSessionSummary; active: boolean; onOpen: () => void }) {
  const tr = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx('flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left', active ? 'bg-indigo-950' : 'active:bg-ph-hover')}
    >
      <span className="mt-0.5 shrink-0 text-slate-400">{s.origin === 'phone' ? <DeviceMobileIcon size={16} /> : <DesktopIcon size={16} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium">{s.title || tr.studio.session}</span>
          {s.running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" aria-label={tr.studio.responding} />}
        </span>
        {s.preview && <span className="block truncate text-[12px] text-slate-400">{s.preview}</span>}
        <span className="block truncate text-[11px] text-slate-500">
          {relativeTime(s.updatedAt)}
          {s.modelLabel ? ` · ${s.modelLabel}` : ''}
          {` · ${tr.studio.messageCount(s.messageCount)}`}
        </span>
      </span>
    </button>
  );
}

/** Вкладки ПК и история сессий проекта: прокрутка, поиск, новые сверху. */
function SessionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, platform } = useServices();
  const tr = useT();
  const studio = useAppState((s) => s.studio);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [query, setQuery] = useState('');
  const groups = groupStudioSessions(studio.sessions, query);

  const openSession = async (id: string) => {
    platform.haptic('selection');
    onClose();
    await store.openStudioSession(id);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={tr.studio.sessionsTitle}
      footer={
        canWrite ? (
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              store.newStudioSession();
              onClose();
            }}
          >
            <PlusIcon size={18} /> {tr.studio.newSession}
          </Button>
        ) : undefined
      }
    >
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-ph-line bg-ph-raised px-3">
        <MagnifyingGlassIcon size={16} className="text-slate-500" />
        <input {...fieldProps({ value: query, onChange: setQuery, placeholder: tr.studio.searchPlaceholder })} className="w-full bg-transparent py-2.5 text-[14px] outline-none" />
      </div>
      {!studio.sessionsLoaded ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : groups.open.length + groups.history.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-slate-400">{query ? tr.studio.nothingFound : tr.studio.noSessions}</div>
      ) : (
        <>
          {groups.open.length > 0 && (
            <>
              <SectionTitle>{tr.studio.openOnPc}</SectionTitle>
              <div className="space-y-0.5">
                {groups.open.map((s) => (
                  <SessionRow key={s.id} s={s} active={s.id === studio.sessionId} onOpen={() => void openSession(s.id)} />
                ))}
              </div>
            </>
          )}
          {groups.history.length > 0 && (
            <>
              <SectionTitle>{tr.studio.history}</SectionTitle>
              <div className="space-y-0.5">
                {groups.history.map((s) => (
                  <SessionRow key={s.id} s={s} active={s.id === studio.sessionId} onOpen={() => void openSession(s.id)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Модель (Claude Code и профили LLM с ПК) и режим следующего промпта. */
function ModelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, platform } = useServices();
  const tr = useT();
  const studio = useAppState((s) => s.studio);
  const options = studio.options;
  const sel = studio.selection;
  const isSel = (provider: string, model: string, profileId?: string) =>
    sel?.provider === provider && sel.model === model && (provider !== 'openai-compatible' || sel.profileId === profileId);

  const pick = (provider: string, model: string, profileId?: string) => {
    platform.haptic('selection');
    store.setStudioSelection({ provider, model, ...(profileId ? { profileId } : {}) });
    onClose();
  };

  const row = (key: string, label: string, hint: string | undefined, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={clsx('flex w-full flex-col rounded-xl px-3 py-2 text-left', active ? 'bg-indigo-950 text-indigo-100' : 'active:bg-ph-hover')}
    >
      <span className="text-[14px]">{label}</span>
      {hint && <span className="text-[12px] text-slate-400">{hint}</span>}
    </button>
  );

  return (
    <Sheet open={open} onClose={onClose} title={tr.studio.modelAndMode}>
      <SectionTitle>{tr.studio.mode}</SectionTitle>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-ph-raised p-1">
        {(options?.modes ?? (['agent', 'chat', 'architect'] as StudioMode[])).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => store.setStudioMode(m)}
            className={clsx('rounded-lg py-2 text-[14px]', studio.mode === m ? 'bg-indigo-500 text-white' : 'text-slate-300')}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="mt-1 text-[12px] text-slate-500">{tr.studio.modeHint}</div>

      {!options ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <>
          <SectionTitle>Claude Code</SectionTitle>
          <div className="space-y-0.5">{options.claudeModels.map((m) => row(`c:${m.id}`, m.name, m.description, isSel('anthropic', m.id), () => pick('anthropic', m.id)))}</div>
          {options.profiles.map((p) => (
            <div key={p.id}>
              <SectionTitle>
                {p.name}
                {p.local ? tr.studio.local : ''}
              </SectionTitle>
              {p.models.length === 0 ? (
                <div className="px-3 text-[12px] text-slate-500">{p.modelsError || tr.studio.noModels}</div>
              ) : (
                <div className="space-y-0.5">{p.models.map((m) => row(`p:${p.id}:${m}`, m, undefined, isSel('openai-compatible', m, p.id), () => pick('openai-compatible', m, p.id)))}</div>
              )}
            </div>
          ))}
          <div className="mt-3 text-[12px] text-slate-500">{tr.studio.modelScope(options.currentLabel)}</div>
        </>
      )}
    </Sheet>
  );
}
