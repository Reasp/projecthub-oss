import path from 'node:path';
import { NOTIFICATION_KINDS, type AppNotification, type NotificationKind } from './notificationTypes.js';
import type { ChatMessage } from './chatAdapters.js';
import { HIGH_RISK_LINE } from './chatButtons.js';

/**
 * Подписки рабочих чатов (TASK-138.4, decision-110): какие события, в какой канал, для каких проектов. Чистый модуль:
 * разбор настроек, сопоставление уведомления с подпиской и текст сообщения без секретов.
 */

export type ChatKind = 'slack' | 'mattermost' | 'telegram' | 'teams';
export const CHAT_KINDS: readonly ChatKind[] = ['slack', 'mattermost', 'telegram', 'teams'];

export interface ChatSubscription {
  id: string;
  enabled: boolean;
  kind: ChatKind;
  /** Подключение Slack или Mattermost; у Telegram — бот из настроек Remote Control. */
  connectionId?: string;
  /** Id канала Slack или Mattermost, id чата Telegram (у группы — отрицательный). */
  channel: string;
  /** Как канал называется в чате — для списка подписок. */
  channelLabel?: string;
  /** Виды уведомлений. */
  kinds: NotificationKind[];
  /** Проекты; пусто — все. */
  projects: string[];
  /** Текст события целиком: команда HITL, путь файла. По умолчанию — только заголовок и проект. */
  details: boolean;
  /**
   * Кто может решать запросы HITL кнопками (TASK-138.6): id пользователей Slack (`U…`) или Mattermost. Пусто — никто,
   * кнопок нет: в общем канале без списка решение досталось бы любому участнику.
   */
  deciders: string[];
  /** Slack: подключение приложения (`xapp-…`) для Socket Mode. Без него кнопок в Slack нет. */
  appConnectionId?: string;
}

/** В подписке есть кнопки решений HITL. */
export function hasDecisionButtons(sub: ChatSubscription): boolean {
  if (!sub.deciders.length || !sub.kinds.includes('hitl')) return false;
  return sub.kind === 'mattermost' || (sub.kind === 'slack' && Boolean(sub.appConnectionId));
}

/** Что подписка получает по умолчанию: события, ради которых команде стоит отвлечься. */
export const CHAT_DEFAULT_KINDS: NotificationKind[] = ['hitl', 'prMerged', 'prChecksFailed', 'agentFailed', 'swarmFinished'];

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** Подписка из файла или окна: неизвестные виды и пустые проекты отбрасываются; без канала — `null`. */
export function normalizeSubscription(raw: unknown): ChatSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = str(r.kind) as ChatKind;
  const channel = str(r.channel);
  const id = str(r.id);
  if (!CHAT_KINDS.includes(kind) || !channel || !id) return null;
  if (kind === 'telegram' && !/^-?\d+$/.test(channel)) return null;
  const connectionId = str(r.connectionId);
  if (kind !== 'telegram' && !connectionId) return null;
  // Решающие — только у Slack и Mattermost: id без пробелов и запятых, не больше 50.
  const deciders =
    (kind === 'slack' || kind === 'mattermost') && Array.isArray(r.deciders)
      ? [...new Set(r.deciders.map(str).filter((d) => /^[A-Za-z0-9._-]{1,64}$/.test(d)))].slice(0, 50)
      : [];
  const appConnectionId = kind === 'slack' ? str(r.appConnectionId) : '';
  const kinds = Array.isArray(r.kinds) ? [...new Set(r.kinds.map(str).filter((k): k is NotificationKind => (NOTIFICATION_KINDS as string[]).includes(k)))] : [];
  const projects = Array.isArray(r.projects) ? [...new Set(r.projects.map(str).filter(Boolean))] : [];
  return {
    id,
    enabled: r.enabled !== false,
    kind,
    ...(kind !== 'telegram' ? { connectionId } : {}),
    channel,
    ...(str(r.channelLabel) ? { channelLabel: str(r.channelLabel).slice(0, 120) } : {}),
    kinds: kinds.length ? kinds : [...CHAT_DEFAULT_KINDS],
    projects,
    details: r.details === true,
    deciders,
    ...(appConnectionId ? { appConnectionId } : {})
  };
}

/** Подписка получает уведомление: включена, вид в списке, проект в списке (пустой — любой, без проекта — только пустой). */
export function matchesSubscription(sub: ChatSubscription, notification: AppNotification): boolean {
  if (!sub.enabled || !sub.kinds.includes(notification.kind)) return false;
  if (!sub.projects.length) return true;
  if (!notification.projectPath) return false;
  const key = pathKey(notification.projectPath);
  return sub.projects.some((p) => pathKey(p) === key);
}

/**
 * Текст сообщения для чата команды. Тело уведомления HITL несёт команду или путь файла — без `details` вместо него
 * строка «решение — в ProjectHub». Остальные тела (заголовок PR, задачи, итог роя) идут как есть. Всё — через
 * маскировку секретов.
 */
export function chatMessageFor(notification: AppNotification, details: boolean, mask: (text: string) => string, buttons = false): ChatMessage {
  const lines: string[] = [];
  // С кнопками решения команда видит, что решает: тело запроса (команда, путь) идёт всегда, через маскировку секретов.
  if (notification.kind === 'hitl' && !details && !buttons) {
    if (notification.projectName) lines.push(`Проект: ${notification.projectName}`);
    lines.push('Решение — в ProjectHub, на телефоне или кнопками Telegram.');
  } else if (notification.body) {
    if (notification.kind === 'hitl' && buttons && notification.projectName) lines.push(`Проект: ${notification.projectName}`);
    lines.push(mask(notification.body));
    if (notification.kind === 'hitl' && buttons && notification.risk === 'high') lines.push(HIGH_RISK_LINE);
  }
  const url = notification.action && 'url' in notification.action ? notification.action.url : undefined;
  return {
    title: mask(notification.title),
    lines,
    ...(url && /^https?:\/\//.test(url) ? { url, urlLabel: 'Открыть' } : {})
  };
}
