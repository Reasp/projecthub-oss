import path from 'node:path';
import { NOTIFICATION_KINDS, type AppNotification, type NotificationKind } from './notificationTypes.js';
import type { ChatMessage } from './chatAdapters.js';

/**
 * Подписки рабочих чатов (TASK-138.4, decision-110): какие события, в какой канал, для каких проектов. Чистый модуль:
 * разбор настроек, сопоставление уведомления с подпиской и текст сообщения без секретов.
 */

export type ChatKind = 'slack' | 'mattermost' | 'telegram';
export const CHAT_KINDS: readonly ChatKind[] = ['slack', 'mattermost', 'telegram'];

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
    details: r.details === true
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
export function chatMessageFor(notification: AppNotification, details: boolean, mask: (text: string) => string): ChatMessage {
  const lines: string[] = [];
  if (notification.kind === 'hitl' && !details) {
    if (notification.projectName) lines.push(`Проект: ${notification.projectName}`);
    lines.push('Решение — в ProjectHub, на телефоне или кнопками Telegram.');
  } else if (notification.body) {
    lines.push(mask(notification.body));
  }
  const url = notification.action && 'url' in notification.action ? notification.action.url : undefined;
  return {
    title: mask(notification.title),
    lines,
    ...(url && /^https?:\/\//.test(url) ? { url, urlLabel: 'Открыть' } : {})
  };
}
