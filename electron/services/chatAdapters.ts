import { PrHostingError, describeHttpError, type PrHttp } from './prHosting.js';

/**
 * Адаптеры рабочих чатов (TASK-138.4, decision-110): отправка уведомления в канал, правка сообщения после решения,
 * список каналов для выбора. Чистый модуль без Electron: сеть — только через `http` подключения (decision-102 п. 10).
 * Формы — по документации Slack Web API (`chat.postMessage`, `chat.update`, `conversations.list`) и Mattermost API v4
 * (`POST /posts`, `PUT /posts/{id}/patch`, `/users/me/teams/{team}/channels`).
 */

export type ChatAdapterId = 'slack' | 'mattermost';

/** Сообщение без разметки конкретного чата: заголовок, строки текста и ссылка. */
export interface ChatMessage {
  title: string;
  lines: string[];
  url?: string;
  urlLabel?: string;
}

/** Отправленное сообщение: по нему потом дописывается исход решения. */
export interface ChatMessageRef {
  channel: string;
  id: string;
}

export interface ChatTarget {
  id: string;
  name: string;
}

export interface ChatAdapter {
  id: ChatAdapterId;
  label: string;
  /** Сервис слоя подключений. */
  serviceId: ChatAdapterId;
  send(http: PrHttp, channel: string, message: ChatMessage): Promise<ChatMessageRef>;
  /** Дописать в сообщение строку (исход решения HITL). */
  append(http: PrHttp, ref: ChatMessageRef, message: ChatMessage, line: string): Promise<void>;
  listTargets(http: PrHttp): Promise<ChatTarget[]>;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body)
});

async function callJson(http: PrHttp, target: string, init?: RequestInit): Promise<unknown> {
  const res = await http(target, init);
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new PrHostingError(res.status, describeHttpError(res.status, body));
  return body ? JSON.parse(body) : null;
}

// ─────────────────────────── Slack ───────────────────────────

/** Экранирование mrkdwn Slack: `&`, `<`, `>` — иначе текст события превратится в ссылку или упоминание. */
export function slackEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function slackText(message: ChatMessage, extra?: string): string {
  const link = message.url && /^https?:\/\//.test(message.url) ? `\n<${message.url}|${slackEscape(message.urlLabel || 'Открыть')}>` : '';
  return [`*${slackEscape(message.title)}*`, ...message.lines.map(slackEscape), ...(extra ? [slackEscape(extra)] : [])].join('\n') + link;
}

/** Slack отвечает 200 и `{ ok: false, error }` — ошибка с кодом Slack. */
async function slackCall(http: PrHttp, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const json = obj(await callJson(http, `/${method}`, body ? jsonInit('POST', body) : undefined));
  if (json.ok !== true) throw new PrHostingError(200, `Slack: ${text(json.error) || 'ошибка'}${json.error === 'not_in_channel' ? ' — пригласите бота в канал' : ''}`);
  return json;
}

export const slackChatAdapter: ChatAdapter = {
  id: 'slack',
  label: 'Slack',
  serviceId: 'slack',
  async send(http, channel, message) {
    const json = await slackCall(http, 'chat.postMessage', { channel, text: slackText(message), unfurl_links: false, unfurl_media: false });
    return { channel: text(json.channel) || channel, id: text(json.ts) };
  },
  async append(http, ref, message, line) {
    await slackCall(http, 'chat.update', { channel: ref.channel, ts: ref.id, text: slackText(message, line) });
  },
  async listTargets(http) {
    const json = await slackCall(http, 'conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200');
    return arr(json.channels)
      .map(obj)
      .filter((c) => text(c.id))
      .map((c) => ({ id: text(c.id), name: `#${text(c.name) || text(c.id)}${c.is_member === false ? ' (бот не в канале)' : ''}` }));
  }
};

// ─────────────────────────── Mattermost ───────────────────────────

export function mattermostText(message: ChatMessage, extra?: string): string {
  const link = message.url && /^https?:\/\//.test(message.url) ? `\n[${message.urlLabel || 'Открыть'}](${message.url})` : '';
  return [`**${message.title}**`, ...message.lines, ...(extra ? [extra] : [])].join('\n') + link;
}

export const mattermostChatAdapter: ChatAdapter = {
  id: 'mattermost',
  label: 'Mattermost',
  serviceId: 'mattermost',
  async send(http, channel, message) {
    const json = obj(await callJson(http, '/posts', jsonInit('POST', { channel_id: channel, message: mattermostText(message) })));
    return { channel, id: text(json.id) };
  },
  async append(http, ref, message, line) {
    await callJson(http, `/posts/${encodeURIComponent(ref.id)}/patch`, jsonInit('PUT', { message: mattermostText(message, line) }));
  },
  async listTargets(http) {
    const teams = arr(await callJson(http, '/users/me/teams')).map(obj);
    const out: ChatTarget[] = [];
    for (const team of teams.slice(0, 10)) {
      const channels = arr(await callJson(http, `/users/me/teams/${encodeURIComponent(text(team.id))}/channels`)).map(obj);
      for (const c of channels) {
        // D — личные сообщения, G — групповые: в списке только каналы команды.
        if (!text(c.id) || c.type === 'D' || c.type === 'G') continue;
        out.push({ id: text(c.id), name: `${text(team.display_name) || text(team.name)} / ${text(c.display_name) || text(c.name)}` });
      }
    }
    return out;
  }
};

export const CHAT_ADAPTERS: readonly ChatAdapter[] = [slackChatAdapter, mattermostChatAdapter];

export function findChatAdapter(id: string): ChatAdapter | undefined {
  return CHAT_ADAPTERS.find((a) => a.id === id);
}
