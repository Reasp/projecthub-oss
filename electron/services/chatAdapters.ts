import { PrHostingError, describeHttpError, type PrHttp } from './prHosting.js';
import { MATTERMOST_ALLOW_EMOJI, MATTERMOST_DENY_EMOJI, mattermostHitlMessage, slackHitlBlocks, slackResolvedBlocks } from './chatButtons.js';
import type { Language } from '../../src/i18n/types.js';
import { hostText } from '../i18n/hostText.js';
import { getHostLanguage } from './hostLanguage.js';
import { AppError } from '../../src/lib/appError.js';

/**
 * Адаптеры рабочих чатов (TASK-138.4, decision-110): отправка уведомления в канал, правка сообщения после решения,
 * список каналов для выбора. Чистый модуль без Electron: сеть — только через `http` подключения (decision-102 п. 10).
 * Формы — по документации Slack Web API (`chat.postMessage`, `chat.update`, `chat.postEphemeral`, `conversations.list`),
 * Mattermost API v4 (`POST /posts`, `PUT /posts/{id}/patch`, `POST /reactions`, `POST /posts/ephemeral`,
 * `/users/me/teams/{team}/channels`) и Teams Workflows (POST адаптивной карточки на вебхук, TASK-138.6).
 */

export type ChatAdapterId = 'slack' | 'mattermost' | 'teams';

/** Кнопки решения HITL в сообщении (TASK-138.6): `requestId` запроса и id бота (Mattermost ставит реакции от него). */
export interface ChatSendOptions {
  hitlRequestId?: string;
  /** Запрос `high`: кнопки и реакции только «отклонить». */
  hitlDenyOnly?: boolean;
  botUserId?: string;
  /** Язык кнопок и подсказки решения — язык интерфейса хоста (TASK-205). */
  lang?: Language;
}

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
  /** Умеет ли чат принимать решения HITL без входящего адреса. */
  decisions: boolean;
  send(http: PrHttp, channel: string, message: ChatMessage, options?: ChatSendOptions): Promise<ChatMessageRef>;
  /** Дописать в сообщение строку (исход решения HITL). */
  append(http: PrHttp, ref: ChatMessageRef, message: ChatMessage, line: string): Promise<void>;
  /** Сообщение только этому человеку: почему его нажатие не применено. */
  notifyUser?(http: PrHttp, channel: string, userId: string, text: string): Promise<void>;
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
  const link = message.url && /^https?:\/\//.test(message.url) ? `\n<${message.url}|${slackEscape(message.urlLabel || 'Open')}>` : '';
  return [`*${slackEscape(message.title)}*`, ...message.lines.map(slackEscape), ...(extra ? [slackEscape(extra)] : [])].join('\n') + link;
}

/** Slack отвечает 200 и `{ ok: false, error }` — ошибка с кодом Slack. */
async function slackCall(http: PrHttp, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const json = obj(await callJson(http, `/${method}`, body ? jsonInit('POST', body) : undefined));
  if (json.ok !== true) {
    const detail = text(json.error);
    throw new PrHostingError(200, new AppError(!detail ? 'hosting.slackUnknown' : detail === 'not_in_channel' ? 'hosting.slackNotInChannel' : 'hosting.slackFailed', detail ? { detail } : undefined));
  }
  return json;
}

export const slackChatAdapter: ChatAdapter = {
  id: 'slack',
  label: 'Slack',
  serviceId: 'slack',
  decisions: true,
  async send(http, channel, message, options) {
    const mrkdwn = slackText(message);
    const json = await slackCall(http, 'chat.postMessage', {
      channel,
      text: mrkdwn,
      ...(options?.hitlRequestId ? { blocks: slackHitlBlocks(mrkdwn, options.hitlRequestId, !options.hitlDenyOnly, options.lang) } : {}),
      unfurl_links: false,
      unfurl_media: false
    });
    return { channel: text(json.channel) || channel, id: text(json.ts) };
  },
  async append(http, ref, message, line) {
    // Блоки заменяются текстом с исходом: кнопок после решения нет.
    const mrkdwn = slackText(message, line);
    await slackCall(http, 'chat.update', { channel: ref.channel, ts: ref.id, text: mrkdwn, blocks: slackResolvedBlocks(mrkdwn) });
  },
  async notifyUser(http, channel, userId, note) {
    await slackCall(http, 'chat.postEphemeral', { channel, user: userId, text: slackEscape(note) });
  },
  async listTargets(http) {
    const json = await slackCall(http, 'conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200');
    return arr(json.channels)
      .map(obj)
      .filter((c) => text(c.id))
      .map((c) => ({ id: text(c.id), name: `#${text(c.name) || text(c.id)}${c.is_member === false ? hostText(getHostLanguage()).chat.botNotInChannel : ''}` }));
  }
};

// ─────────────────────────── Mattermost ───────────────────────────

export function mattermostText(message: ChatMessage, extra?: string): string {
  const link = message.url && /^https?:\/\//.test(message.url) ? `\n[${message.urlLabel || 'Open'}](${message.url})` : '';
  return [`**${message.title}**`, ...message.lines, ...(extra ? [extra] : [])].join('\n') + link;
}

export const mattermostChatAdapter: ChatAdapter = {
  id: 'mattermost',
  label: 'Mattermost',
  serviceId: 'mattermost',
  decisions: true,
  async send(http, channel, message, options) {
    const body = options?.hitlRequestId ? mattermostHitlMessage(message, !options.hitlDenyOnly, options.lang) : message;
    const json = obj(await callJson(http, '/posts', jsonInit('POST', { channel_id: channel, message: mattermostText(body) })));
    const id = text(json.id);
    // Бот сам ставит реакции-решения: человеку остаётся нажать. Не вышло — решение реакцией всё равно работает.
    if (options?.hitlRequestId && options.botUserId && id) {
      for (const emoji of options.hitlDenyOnly ? [MATTERMOST_DENY_EMOJI[0]] : [MATTERMOST_ALLOW_EMOJI[0], MATTERMOST_DENY_EMOJI[0]]) {
        await callJson(http, '/reactions', jsonInit('POST', { user_id: options.botUserId, post_id: id, emoji_name: emoji })).catch(() => undefined);
      }
    }
    return { channel, id };
  },
  async notifyUser(http, channel, userId, note) {
    await callJson(http, '/posts/ephemeral', jsonInit('POST', { user_id: userId, post: { channel_id: channel, message: note } }));
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

// ─────────────────────────── Microsoft Teams ───────────────────────────

/** Адаптивная карточка для вебхука Workflows: заголовок, строки и ссылка. */
export function teamsCard(message: ChatMessage): Record<string, unknown> {
  const url = message.url && /^https?:\/\//.test(message.url) ? message.url : undefined;
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true },
            ...message.lines.map((line) => ({ type: 'TextBlock', text: line, wrap: true }))
          ],
          ...(url ? { actions: [{ type: 'Action.OpenUrl', title: message.urlLabel || 'Open', url }] } : {})
        }
      }
    ]
  };
}

export const teamsChatAdapter: ChatAdapter = {
  id: 'teams',
  label: 'Microsoft Teams',
  serviceId: 'teams',
  // Ответ из Teams требует бота с публичным адресом — local-first приложению принимать его некуда (decision-113).
  decisions: false,
  async send(http, _channel, message) {
    const res = await http('', jsonInit('POST', teamsCard(message)));
    if (!res.ok) throw new PrHostingError(res.status, describeHttpError(res.status, await res.text().catch(() => '')));
    // Workflows не возвращает id сообщения: дописать исход нельзя.
    return { channel: 'workflow', id: '' };
  },
  async append() {
    // нечего править: у сообщения Workflows нет id
  },
  async listTargets() {
    return [{ id: 'workflow', name: hostText(getHostLanguage()).chat.workflowChannel }];
  }
};

export const CHAT_ADAPTERS: readonly ChatAdapter[] = [slackChatAdapter, mattermostChatAdapter, teamsChatAdapter];

export function findChatAdapter(id: string): ChatAdapter | undefined {
  return CHAT_ADAPTERS.find((a) => a.id === id);
}
