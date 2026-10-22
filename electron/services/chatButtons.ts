/**
 * Решения HITL кнопками в рабочих чатах без входящего адреса (TASK-138.6, [[decision-113]]). Чистый модуль: разбор
 * событий Slack Socket Mode и WebSocket API Mattermost, разметка кнопок, правило «кто может решать». Сокеты открывает
 * слой подключений (`connectionService.openWebSocket`), применяет решение `chatService`.
 *
 * Формы — по документации:
 * - Slack Socket Mode: `apps.connections.open` (токен приложения `xapp-…`) → WebSocket; конверты `hello`,
 *   `interactive` (`payload.type: block_actions`), `disconnect`; подтверждение — `{ envelope_id }` за 3 с.
 * - Mattermost WebSocket API v4: `/api/v4/websocket` с `Authorization: Bearer`; событие `reaction_added`, в
 *   `data.reaction` — JSON строкой `{ user_id, post_id, emoji_name }`.
 */

import type { ChatMessage } from './chatAdapters.js';
import type { Language } from '../../src/i18n/types.js';
import { hostText } from '../i18n/hostText.js';

export const SLACK_ALLOW_ACTION = 'ph_hitl_allow';
export const SLACK_DENY_ACTION = 'ph_hitl_deny';

/** Реакции Mattermost, которыми решают запрос. Бот ставит первые две сам — человеку достаточно нажать. */
export const MATTERMOST_ALLOW_EMOJI = ['white_check_mark', 'heavy_check_mark', '+1'];
export const MATTERMOST_DENY_EMOJI = ['x', 'no_entry', '-1'];

export interface ChatDecision {
  /** Сообщение в чате, на котором нажали: по нему находится запрос и подписка. */
  channel: string;
  messageId: string;
  userId: string;
  userName: string;
  approved: boolean;
  /** Slack передаёт `requestId` в значении кнопки; у реакции Mattermost его нет. */
  requestId?: string;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

// ─────────────────────────── Slack ───────────────────────────

/**
 * Блоки сообщения HITL с кнопками; `text` сообщения остаётся для уведомлений и старых клиентов. У запроса `high`
 * кнопки «Разрешить» нет: из чата его можно только отклонить (decision-112).
 */
export function slackHitlBlocks(mrkdwn: string, requestId: string, allow = true, lang: Language = 'en'): unknown[] {
  const tx = hostText(lang).decision;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } },
    {
      type: 'actions',
      block_id: 'ph_hitl',
      elements: [
        ...(allow ? [{ type: 'button', action_id: SLACK_ALLOW_ACTION, style: 'primary', value: requestId, text: { type: 'plain_text', text: tx.allow } }] : []),
        { type: 'button', action_id: SLACK_DENY_ACTION, style: 'danger', value: requestId, text: { type: 'plain_text', text: tx.deny } }
      ]
    }
  ];
}

/** После решения кнопки убираются: остаётся текст с исходом. */
export function slackResolvedBlocks(mrkdwn: string): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text: mrkdwn } }];
}

export type SlackEnvelope =
  | { kind: 'hello' }
  | { kind: 'disconnect'; reason: string }
  | { kind: 'decision'; envelopeId: string; decision: ChatDecision }
  /** Любой другой конверт с `envelope_id` — подтвердить и забыть. */
  | { kind: 'other'; envelopeId?: string };

/** Разбор кадра Socket Mode. Кнопки чужих приложений и событий здесь не решают ничего. */
export function parseSlackEnvelope(raw: string): SlackEnvelope | null {
  let frame: Record<string, unknown>;
  try {
    frame = obj(JSON.parse(raw));
  } catch {
    return null;
  }
  const type = text(frame.type);
  if (type === 'hello') return { kind: 'hello' };
  if (type === 'disconnect') return { kind: 'disconnect', reason: text(frame.reason) || 'disconnect' };
  const envelopeId = text(frame.envelope_id) || undefined;
  if (type !== 'interactive' || !envelopeId) return { kind: 'other', envelopeId };
  const payload = obj(frame.payload);
  if (payload.type !== 'block_actions') return { kind: 'other', envelopeId };
  const action = (Array.isArray(payload.actions) ? payload.actions : []).map(obj).find((a) => a.action_id === SLACK_ALLOW_ACTION || a.action_id === SLACK_DENY_ACTION);
  const user = obj(payload.user);
  const container = obj(payload.container);
  const channel = text(obj(payload.channel).id) || text(container.channel_id);
  const messageId = text(container.message_ts) || text(obj(payload.message).ts);
  if (!action || !text(user.id) || !channel || !messageId || !text(action.value)) return { kind: 'other', envelopeId };
  return {
    kind: 'decision',
    envelopeId,
    decision: {
      channel,
      messageId,
      userId: text(user.id),
      userName: text(user.username) || text(user.name) || text(user.id),
      approved: action.action_id === SLACK_ALLOW_ACTION,
      requestId: text(action.value)
    }
  };
}

/** Адрес сокета из ответа `apps.connections.open`: только `wss://` на домене Slack. */
export function slackSocketUrl(json: unknown): string {
  const o = obj(json);
  if (o.ok !== true) throw new Error(`Slack: ${text(o.error) || 'apps.connections.open не дал адрес'}${o.error === 'not_allowed_token_type' ? ' — нужен токен приложения xapp-… со scope connections:write' : ''}`);
  const url = new URL(text(o.url));
  if (url.protocol !== 'wss:' || !/(^|\.)slack\.com$/i.test(url.hostname)) throw new Error('Slack вернул адрес сокета вне slack.com');
  return url.toString();
}

// ─────────────────────────── Mattermost ───────────────────────────

/** Строка-подсказка в сообщении HITL: как решить реакцией. */
export function mattermostHitlMessage(message: ChatMessage, allow = true, lang: Language = 'en'): ChatMessage {
  const tx = hostText(lang).decision;
  return { ...message, lines: [...message.lines, allow ? tx.mattermostHint : tx.mattermostDenyHint] };
}

/** Событие WebSocket API Mattermost → решение, если это реакция-решение. Своих реакций бота не бывает решением. */
export function parseMattermostEvent(raw: string, botUserId: string): Omit<ChatDecision, 'channel' | 'userName'> & { channel?: string } | null {
  let frame: Record<string, unknown>;
  try {
    frame = obj(JSON.parse(raw));
  } catch {
    return null;
  }
  if (frame.event !== 'reaction_added') return null;
  let reaction: Record<string, unknown>;
  try {
    reaction = obj(JSON.parse(text(obj(frame.data).reaction)));
  } catch {
    return null;
  }
  const emoji = text(reaction.emoji_name);
  const userId = text(reaction.user_id);
  const postId = text(reaction.post_id);
  if (!userId || !postId || userId === botUserId) return null;
  const approved = MATTERMOST_ALLOW_EMOJI.includes(emoji) ? true : MATTERMOST_DENY_EMOJI.includes(emoji) ? false : null;
  if (approved === null) return null;
  const channel = text(obj(frame.broadcast).channel_id) || undefined;
  return { messageId: postId, userId, approved, ...(channel ? { channel } : {}) };
}

// ─────────────────────────── общее ───────────────────────────

/**
 * Кто может решать: только человек из списка подписки. Пустой список — никто (как группа Telegram без allowedUsers,
 * decision-110): кнопка в общем канале без списка дала бы решение любому участнику.
 */
export function canDecide(deciders: readonly string[], userId: string): boolean {
  return deciders.includes(userId);
}

/** Экспоненциальная пауза переподключения сокета: 2 с, 4 с … не больше 2 минут. */
export function socketBackoffMs(attempt: number): number {
  return Math.min(120_000, 2000 * 2 ** Math.max(0, attempt));
}
