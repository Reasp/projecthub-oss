import { useEffect, useRef, useState } from 'react';
import {
  CaretDownIcon,
  ChartBarIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  LightningIcon,
  DesktopIcon,
  DeviceMobileIcon,
  MagnifyingGlassIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  SparkleIcon,
  StopIcon,
  WrenchIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteStudioSessionSummary, StudioMode } from '../../../src/types/remote';
import { useAppState, useServices } from '../app/context';
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

/**
 * AI Studio на ПК с телефона (TASK-140.10, decision-83): те же сессии, что во вкладках ProjectHub. Можно
 * открыть вкладку ПК или старую сессию из истории, начать новую с выбором модели и режима, остановить ответ.
 */
export function StudioScreen() {
  const { store, platform } = useServices();
  const studio = useAppState((s) => s.studio);
  const projectPath = useAppState((s) => s.projectPath);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [text, setText] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const suggestions = matchStudioCommands(text);

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

  const send = async () => {
    // «/clear» и другие команды, набранные целиком, выполняются, а не уходят агенту текстом.
    const exact = STUDIO_COMMANDS.find((c) => c.command === text.trim().toLowerCase());
    if (exact) {
      await runCommand(exact.id);
      return;
    }
    const value = text;
    setText('');
    const ok = await store.sendPrompt(value);
    if (!ok) setText(value);
  };

  if (!projectPath) return <EmptyState icon={<SparkleIcon size={40} />} title="Проект не выбран" />;

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
            aria-label="Сессии и история"
          >
            <ClockCounterClockwiseIcon size={18} className="shrink-0 text-slate-400" />
            <span className="truncate text-[15px] font-medium">{studio.sessionId ? studio.title || 'Сессия' : 'Новая сессия'}</span>
            <CaretDownIcon size={14} className="shrink-0 text-slate-500" />
          </button>
          <button
            type="button"
            onClick={() => void runCommand('usage')}
            className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-1 text-[12px] text-slate-300 active:bg-ph-hover"
            aria-label="Usage"
          >
            <ChartBarIcon size={18} />
            {studio.usage?.sessionLimit && (
              <span className={clsx(studio.usage.sessionLimit.percent >= 85 ? 'text-red-300' : studio.usage.sessionLimit.percent >= 60 ? 'text-amber-300' : 'text-slate-400')}>
                {studio.usage.sessionLimit.percent}%
              </span>
            )}
          </button>
          {canWrite && studio.sessionId && (
            <button type="button" aria-label="Новая сессия" onClick={() => store.newStudioSession()} className="shrink-0 rounded-full p-1.5 text-slate-300 active:bg-ph-hover">
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
            aria-label="Модель и режим"
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
            title="Промпт агенту на ПК"
            hint="Сессия появится во вкладках AI Studio на компьютере. Старые сессии и вкладки ПК — по кнопке слева вверху."
          />
        ) : (
          <>
            {studio.olderOmitted > 0 && (
              <div className="mb-2 text-center text-[12px] text-slate-500">Ещё {studio.olderOmitted} ранних сообщений — на ПК</div>
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
                  {m.truncated && <span className="text-slate-500"> (сокращено, целиком — на ПК)</span>}
                  {m.role === 'assistant' && m.text && <CopyMessage text={m.text} />}
                </div>
              </div>
            ))}
          </>
        )}
        {studio.busy && (
          <div className="mb-3 flex items-center gap-2 px-1 text-[13px] text-slate-400">
            <Spinner className="h-3 w-3" /> Агент работает…
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
      {canWrite ? (
        <div className="flex items-end gap-2 border-t border-ph-line bg-ph-chrome px-3 py-2">
          <button
            type="button"
            aria-label="Быстрые команды"
            onClick={() => {
              platform.haptic('selection');
              setCommandsOpen(true);
              if (!studio.options) void store.loadStudioOptions();
            }}
            className="mb-1 shrink-0 rounded-full p-2 text-slate-300 active:bg-ph-hover"
          >
            <LightningIcon size={22} />
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder={studio.sessionId ? 'Продолжить сессию…' : 'Что сделать?'}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-ph-line bg-ph-raised px-3 py-2.5 text-[15px] outline-none focus:border-indigo-500"
          />
          {studio.busy ? (
            <Button className="h-11 w-11 shrink-0 rounded-full !px-0" haptic="medium" aria-label="Остановить ответ" onClick={() => void store.abortStudio()}>
              <StopIcon size={20} weight="fill" />
            </Button>
          ) : (
            <Button variant="primary" className="h-11 w-11 shrink-0 rounded-full !px-0" disabled={!text.trim()} haptic="medium" aria-label="Отправить" onClick={send}>
              <PaperPlaneRightIcon size={20} weight="fill" />
            </Button>
          )}
        </div>
      ) : (
        <div className="border-t border-ph-line px-3 py-3 text-center text-[13px] text-slate-400">Отправлять промпты с этого устройства нельзя.</div>
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
        aria-label="Копировать ответ"
      >
        {copied ? <CheckIcon size={13} className="text-emerald-400" /> : <CopyIcon size={13} />}
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
    </div>
  );
}

function LimitBar({ label, w }: { label: string; w?: { percent: number; resetsAt?: string } }) {
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
      {w.resetsAt && <div className="mt-0.5 text-[11px] text-slate-500">Сброс: {w.resetsAt}</div>}
    </div>
  );
}

/** Окно Usage: лимиты Claude Code с ПК, запросы, токены по моделям и расход открытой сессии. */
function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store } = useServices();
  const studio = useAppState((s) => s.studio);
  const u = studio.usage;
  const su = studio.sessionUsage;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Usage${u?.planType ? ` · ${u.planType}` : ''}`}
      footer={
        <Button className="w-full" disabled={studio.usageLoading} onClick={() => void store.loadUsage(true)}>
          {studio.usageLoading ? <Spinner className="h-4 w-4" /> : null} Обновить с ПК
        </Button>
      }
    >
      {!u ? (
        <div className="flex justify-center py-6">{studio.usageLoading ? <Spinner /> : <span className="text-[13px] text-slate-400">Нет данных</span>}</div>
      ) : (
        <>
          {u.error && <div className="mb-3 rounded-xl bg-amber-950/60 p-3 text-[13px] text-amber-100">{u.error.message}</div>}
          <LimitBar label="Текущая сессия" w={u.sessionLimit} />
          <LimitBar label="Неделя" w={u.weeklyLimit} />
          <LimitBar label="Fable" w={u.fableLimit} />
          {!u.sessionLimit && !u.weeklyLimit && !u.error && <div className="mb-3 text-[13px] text-slate-400">Лимиты Claude Code не получены.</div>}
          {(u.last24h || u.last7d) && (
            <div className="mb-3 grid grid-cols-2 gap-2 text-[13px]">
              {u.last24h && (
                <div className="rounded-xl bg-ph-raised p-2.5">
                  <div className="text-[11px] text-slate-500">24 часа</div>
                  {u.last24h.requests !== undefined && <div>{u.last24h.requests} запросов</div>}
                  {u.last24h.sessions !== undefined && <div>{u.last24h.sessions} сессий</div>}
                </div>
              )}
              {u.last7d && (
                <div className="rounded-xl bg-ph-raised p-2.5">
                  <div className="text-[11px] text-slate-500">7 дней</div>
                  {u.last7d.requests !== undefined && <div>{u.last7d.requests} запросов</div>}
                  {u.last7d.sessions !== undefined && <div>{u.last7d.sessions} сессий</div>}
                </div>
              )}
            </div>
          )}
          {su && (
            <>
              <SectionTitle>Эта сессия</SectionTitle>
              <div className="text-[13px] text-slate-300">
                Вход {formatTokens(su.inputTokens)} · выход {formatTokens(su.outputTokens)}
                {su.costUsd ? ` · $${su.costUsd.toFixed(4)}` : ''}
                {su.estimated ? ' (оценка)' : ''}
              </div>
            </>
          )}
          {u.models.length > 0 && (
            <>
              <SectionTitle>Модели</SectionTitle>
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
            Обновлено {relativeTime(u.updatedAt)}
            {u.totalSessions !== undefined ? ` · всего сессий ${u.totalSessions}` : ''}
            {u.isFallback ? ' · из статистики' : ''}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Быстрые команды и быстрые промпты AI Studio (те же, что кнопки на ПК). */
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
  const studio = useAppState((s) => s.studio);
  const commands = STUDIO_COMMANDS.filter((c) => (c.id === 'stop' ? studio.busy : true));
  return (
    <Sheet open={open} onClose={onClose} title="Быстрые команды">
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
          <SectionTitle>Быстрые промпты</SectionTitle>
          <div className="space-y-0.5">
            {studio.options.quickPrompts.map((p) => (
              <button key={p.id} type="button" onClick={() => onPrompt(p.prompt)} className="flex w-full flex-col rounded-xl px-3 py-2 text-left active:bg-ph-hover">
                <span className="text-[14px]">{p.label}</span>
                <span className="line-clamp-2 text-[12px] text-slate-400">{p.prompt}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 text-[12px] text-slate-500">Промпт подставится в поле ввода — его можно поправить перед отправкой.</div>
        </>
      )}
    </Sheet>
  );
}


function SessionRow({ s, active, onOpen }: { s: RemoteStudioSessionSummary; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx('flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left', active ? 'bg-indigo-950' : 'active:bg-ph-hover')}
    >
      <span className="mt-0.5 shrink-0 text-slate-400">{s.origin === 'phone' ? <DeviceMobileIcon size={16} /> : <DesktopIcon size={16} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium">{s.title}</span>
          {s.running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" aria-label="Отвечает" />}
        </span>
        {s.preview && <span className="block truncate text-[12px] text-slate-400">{s.preview}</span>}
        <span className="block truncate text-[11px] text-slate-500">
          {relativeTime(s.updatedAt)}
          {s.modelLabel ? ` · ${s.modelLabel}` : ''}
          {` · ${s.messageCount} сообщ.`}
        </span>
      </span>
    </button>
  );
}

/** Вкладки ПК и история сессий проекта: прокрутка, поиск, новые сверху. */
function SessionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { store, platform } = useServices();
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
      title="Сессии AI Studio"
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
            <PlusIcon size={18} /> Новая сессия
          </Button>
        ) : undefined
      }
    >
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-ph-line bg-ph-raised px-3">
        <MagnifyingGlassIcon size={16} className="text-slate-500" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию и промптам" className="w-full bg-transparent py-2.5 text-[14px] outline-none" />
      </div>
      {!studio.sessionsLoaded ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : groups.open.length + groups.history.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-slate-400">{query ? 'Ничего не найдено' : 'В этом проекте ещё нет сессий AI Studio.'}</div>
      ) : (
        <>
          {groups.open.length > 0 && (
            <>
              <SectionTitle>Открыты на ПК</SectionTitle>
              <div className="space-y-0.5">
                {groups.open.map((s) => (
                  <SessionRow key={s.id} s={s} active={s.id === studio.sessionId} onOpen={() => void openSession(s.id)} />
                ))}
              </div>
            </>
          )}
          {groups.history.length > 0 && (
            <>
              <SectionTitle>История</SectionTitle>
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
    <Sheet open={open} onClose={onClose} title="Модель и режим">
      <SectionTitle>Режим</SectionTitle>
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
      <div className="mt-1 text-[12px] text-slate-500">Агент — с инструментами в проекте; чат и архитектор — только ответ.</div>

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
                {p.local ? ' · локальная' : ''}
              </SectionTitle>
              {p.models.length === 0 ? (
                <div className="px-3 text-[12px] text-slate-500">{p.modelsError || 'Список моделей пуст — выберите модель профиля на ПК.'}</div>
              ) : (
                <div className="space-y-0.5">{p.models.map((m) => row(`p:${p.id}:${m}`, m, undefined, isSel('openai-compatible', m, p.id), () => pick('openai-compatible', m, p.id)))}</div>
              )}
            </div>
          ))}
          <div className="mt-3 text-[12px] text-slate-500">Модель действует на эту сессию; выбор AI Studio на ПК не меняется. Сейчас на ПК: {options.currentLabel}.</div>
        </>
      )}
    </Sheet>
  );
}
