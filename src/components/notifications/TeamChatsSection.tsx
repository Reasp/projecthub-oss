import React, { useCallback, useEffect, useState } from 'react';
import { Play, Trash2, Plus } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { useProjectStore } from '../../store/useProjectStore';
import type { ChatKind, ChatSubscription, ConnectionView, NotificationKind } from '../../types/electron';

const CHAT_LABELS: Record<ChatKind, string> = { slack: 'Slack', mattermost: 'Mattermost', telegram: 'Telegram' };
const DEFAULT_KINDS: NotificationKind[] = ['hitl', 'prMerged', 'prChecksFailed', 'agentFailed', 'swarmFinished'];

function cleanIpcError(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

type Draft = Omit<ChatSubscription, 'id'> & { id?: string };

const emptyDraft = (): Draft => ({ enabled: true, kind: 'slack', channel: '', kinds: [...DEFAULT_KINDS], projects: [], details: false });

/**
 * Подписки чатов команды (TASK-138.4, decision-110): Slack и Mattermost через подключения, группа Telegram через бота.
 * События — те же виды, что в матрице уведомлений; проекты — из каталога, пусто — все.
 */
export const TeamChatsSection: React.FC<{ kinds: NotificationKind[] }> = ({ kinds }) => {
  const { t } = useTranslation();
  const tc = t.notifications.teamChats;
  const projects = useProjectStore((s) => s.projects);
  const [subs, setSubs] = useState<ChatSubscription[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    const [list, conns] = await Promise.all([window.api.chat.list(), window.api.connections.list()]);
    setSubs(list);
    setConnections(conns.filter((c) => c.serviceId === 'slack' || c.serviceId === 'mattermost'));
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const connectionsOf = (kind: ChatKind) => connections.filter((c) => c.serviceId === kind);

  const setKind = (kind: ChatKind) => {
    setTargets([]);
    setDraft((d) => (d ? { ...d, kind, channel: '', channelLabel: undefined, connectionId: kind === 'telegram' ? undefined : connectionsOf(kind)[0]?.id } : d));
  };

  const loadTargets = async () => {
    if (!draft?.connectionId) return;
    try {
      setTargets(await window.api.chat.targets(draft.kind, draft.connectionId));
    } catch (err) {
      setMessage({ ok: false, text: cleanIpcError(err) });
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      await window.api.chat.save(draft);
      setDraft(null);
      setTargets([]);
      setMessage({ ok: true, text: tc.saved });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: cleanIpcError(err) });
    }
  };

  const update = async (sub: ChatSubscription, patch: Partial<ChatSubscription>) => {
    try {
      await window.api.chat.save({ ...sub, ...patch });
      await reload();
    } catch (err) {
      setMessage({ ok: false, text: cleanIpcError(err) });
    }
  };

  const test = async (id: string) => {
    const res = await window.api.chat.test(id);
    setMessage(res.ok ? { ok: true, text: tc.testOk } : { ok: false, text: res.error ?? '' });
  };

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const projectName = (p: string) => projects.find((x) => x.path === p)?.name ?? p;

  return (
    <section className="space-y-2" data-testid="team-chats">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">{tc.title}</h3>
        {!draft && (
          <button
            type="button"
            onClick={() => {
              const d = emptyDraft();
              d.connectionId = connectionsOf('slack')[0]?.id;
              setDraft(d);
              setMessage(null);
            }}
            data-testid="team-chats-add"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-border hover:bg-secondary"
          >
            <Plus className="w-3.5 h-3.5" /> {tc.add}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{tc.desc}</p>

      {subs.length === 0 && !draft && <p className="text-[11px] text-muted-foreground">{tc.empty}</p>}
      <ul className="space-y-1.5">
        {subs.map((sub) => (
          <li key={sub.id} className="px-3 py-2 rounded-lg border border-border bg-secondary/20 text-xs flex items-center gap-2" data-testid="team-chat-sub">
            <input type="checkbox" checked={sub.enabled} onChange={(e) => void update(sub, { enabled: e.target.checked })} aria-label={tc.enabled} />
            <span className="font-medium">{CHAT_LABELS[sub.kind]}</span>
            <span className="font-mono text-[11px]">{sub.channelLabel || sub.channel}</span>
            <span className="text-[11px] text-muted-foreground truncate">
              {tc.eventsCount.replace('{n}', String(sub.kinds.length))} · {sub.projects.length ? sub.projects.map(projectName).join(', ') : tc.allProjects}
            </span>
            <span className="ml-auto flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => void test(sub.id)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:bg-secondary text-[11px]" data-testid="team-chat-test">
                <Play className="w-3 h-3" /> {tc.test}
              </button>
              <button type="button" onClick={() => void window.api.chat.remove(sub.id).then(reload)} className="p-1 rounded hover:bg-secondary" aria-label={tc.remove}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ul>

      {draft && (
        <div className="p-3 rounded-lg border border-border space-y-2 text-xs" data-testid="team-chat-form">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              {tc.chat}
              <select value={draft.kind} onChange={(e) => setKind(e.target.value as ChatKind)} className="bg-secondary border border-border rounded px-1.5 py-0.5" data-testid="team-chat-kind">
                {(Object.keys(CHAT_LABELS) as ChatKind[]).map((k) => (
                  <option key={k} value={k}>
                    {CHAT_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            {draft.kind !== 'telegram' &&
              (connectionsOf(draft.kind).length ? (
                <>
                  <label className="flex items-center gap-1">
                    {tc.connection}
                    <select
                      value={draft.connectionId ?? ''}
                      onChange={(e) => setDraft({ ...draft, connectionId: e.target.value })}
                      className="bg-secondary border border-border rounded px-1.5 py-0.5"
                    >
                      {connectionsOf(draft.kind).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => void loadTargets()} className="px-2 py-0.5 rounded border border-border hover:bg-secondary" data-testid="team-chat-load">
                    {tc.loadChannels}
                  </button>
                </>
              ) : (
                <span className="text-amber-400 text-[11px]">{tc.noConnection.replace('{chat}', CHAT_LABELS[draft.kind])}</span>
              ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {targets.length > 0 && draft.kind !== 'telegram' ? (
              <label className="flex items-center gap-1">
                {tc.channel}
                <select
                  value={draft.channel}
                  onChange={(e) => setDraft({ ...draft, channel: e.target.value, channelLabel: targets.find((x) => x.id === e.target.value)?.name })}
                  className="bg-secondary border border-border rounded px-1.5 py-0.5"
                  data-testid="team-chat-channel"
                >
                  <option value="">—</option>
                  {targets.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <input
                value={draft.channel}
                onChange={(e) => setDraft({ ...draft, channel: e.target.value.trim(), channelLabel: undefined })}
                placeholder={draft.kind === 'telegram' ? tc.telegramChatId : tc.channelId}
                className="flex-1 min-w-[200px] bg-secondary border border-border rounded px-2 py-0.5 font-mono"
                data-testid="team-chat-channel-id"
              />
            )}
          </div>
          {draft.kind === 'telegram' && <p className="text-[11px] text-muted-foreground">{tc.telegramHint}</p>}

          <div>
            <div className="text-[11px] text-muted-foreground mb-1">{tc.events}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {kinds.map((k) => (
                <label key={k} className="flex items-center gap-1 text-[11px]">
                  <input type="checkbox" checked={draft.kinds.includes(k)} onChange={() => setDraft({ ...draft, kinds: toggle(draft.kinds, k) })} />
                  {t.notifications.kind[k]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[11px] text-muted-foreground mb-1">
              {tc.projects}: {draft.projects.length ? '' : tc.allProjects}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {projects.map((p) => (
                <label key={p.path} className="flex items-center gap-1 text-[11px]">
                  <input type="checkbox" checked={draft.projects.includes(p.path)} onChange={() => setDraft({ ...draft, projects: toggle(draft.projects, p.path) })} />
                  {p.name}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={draft.details} onChange={(e) => setDraft({ ...draft, details: e.target.checked })} />
            {tc.details}
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!draft.channel || !draft.kinds.length || (draft.kind !== 'telegram' && !draft.connectionId)}
              className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
              data-testid="team-chat-save"
            >
              {tc.save}
            </button>
            <button type="button" onClick={() => setDraft(null)} className="px-2.5 py-1 rounded-md border border-border hover:bg-secondary">
              {tc.cancel}
            </button>
          </div>
        </div>
      )}
      {message && <p className={`text-[11px] ${message.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{message.text}</p>}
    </section>
  );
};
