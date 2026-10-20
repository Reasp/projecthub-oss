import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { findChatAdapter, type ChatMessage, type ChatMessageRef, type ChatTarget } from './chatAdapters.js';
import { chatMessageFor, matchesSubscription, normalizeSubscription, type ChatKind, type ChatSubscription } from './chatSubscriptions.js';
import { stateFields, withVersion } from './stateFiles.js';
import type { AppNotification } from './notificationTypes.js';
import type { ConnectionUsage } from './connectionTypes.js';

/**
 * Рабочие чаты (TASK-138.4, decision-110): уведомления ProjectHub в каналы команды по подпискам «события × проекты ×
 * канал». Slack и Mattermost — через слой подключений (decision-102), Telegram — через бота Remote Control: только у
 * него есть кнопки решения HITL без входящего адреса (бот опрашивает Telegram сам). Подписки — `<userData>/chat.json`.
 */

export interface ChatConnectionInfo {
  id: string;
  serviceId: string;
  label: string;
}

export interface ChatServiceDeps {
  statePath?: () => string;
  connections: {
    list(): Promise<ChatConnectionInfo[]>;
    authorizedFetch(connectionId: string, target: string, init?: RequestInit): Promise<Response>;
  };
  /** Бот Telegram: отправка в чат команды с кнопками HITL. Нет бота — `false`. */
  telegram?: {
    configured(): boolean;
    send(notification: AppNotification, chatId: string, text: string): Promise<boolean>;
  };
  mask(text: string): string;
  now(): number;
  log(level: 'info' | 'warn', message: string): void;
}

export const CHAT_STATE_VERSION = 1;
/** Одно событие не уходит в одну подписку дважды за это окно (повтор публикации, гонка источников). */
export const CHAT_DEDUP_WINDOW_MS = 60_000;
const TRACKED_LIMIT = 200;

export interface ChatTestResult {
  ok: boolean;
  error?: string;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
}

/** Текст для Telegram: Markdown бота, поэтому без разметки — только экранирование символов Markdown. */
function telegramText(message: ChatMessage): string {
  const esc = (s: string) => s.replace(/([_*`[\]])/g, '\\$1');
  const link = message.url ? `\n[${esc(message.urlLabel || 'Открыть')}](${message.url})` : '';
  return [`*${esc(message.title)}*`, ...message.lines.map(esc)].join('\n') + link;
}

export class ChatService {
  private subscriptions: ChatSubscription[] | null = null;
  private readonly sent = new Map<string, number>();
  /** Запрос HITL → сообщения в Slack и Mattermost, куда дописать исход. */
  private readonly hitlMessages = new Map<string, Array<{ sub: ChatSubscription; ref: ChatMessageRef; message: ChatMessage }>>();

  constructor(private readonly deps: ChatServiceDeps) {}

  private async load(): Promise<ChatSubscription[]> {
    if (this.subscriptions) return this.subscriptions;
    let list: ChatSubscription[] = [];
    const file = this.deps.statePath?.();
    if (file) {
      try {
        const raw = stateFields(JSON.parse(await fs.readFile(file, 'utf-8')), CHAT_STATE_VERSION).subscriptions;
        list = (Array.isArray(raw) ? raw : []).map(normalizeSubscription).filter((s): s is ChatSubscription => Boolean(s));
      } catch {
        list = [];
      }
    }
    this.subscriptions = list;
    return list;
  }

  private async persist(): Promise<void> {
    const file = this.deps.statePath?.();
    if (!file) return;
    const text = `${JSON.stringify(withVersion(CHAT_STATE_VERSION, { subscriptions: this.subscriptions ?? [] }), null, 2)}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, file).catch(async () => {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      await fs.writeFile(file, text, 'utf-8');
    });
  }

  async init(): Promise<void> {
    await this.load();
  }

  async list(): Promise<ChatSubscription[]> {
    return (await this.load()).map((s) => ({ ...s, kinds: [...s.kinds], projects: [...s.projects] }));
  }

  /** Добавить или изменить подписку. Подключение должно быть подключением этого чата. */
  async save(raw: unknown): Promise<ChatSubscription> {
    const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const sub = normalizeSubscription({ ...input, id: typeof input.id === 'string' && input.id ? input.id : `chat_${randomUUID().slice(0, 12)}` });
    if (!sub) throw new Error('Подписка: укажите чат, подключение и канал (у Telegram — числовой id чата)');
    if (sub.kind !== 'telegram') {
      const connection = (await this.deps.connections.list()).find((c) => c.id === sub.connectionId);
      if (!connection || connection.serviceId !== sub.kind) throw new Error(`Выберите подключение к ${findChatAdapter(sub.kind)?.label ?? sub.kind}`);
    }
    const list = await this.load();
    const at = list.findIndex((s) => s.id === sub.id);
    if (at >= 0) list[at] = sub;
    else list.push(sub);
    await this.persist();
    return sub;
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.load();
    const at = list.findIndex((s) => s.id === id);
    if (at < 0) return false;
    list.splice(at, 1);
    await this.persist();
    return true;
  }

  /** Каналы чата для выбора в окне. */
  async listTargets(kind: ChatKind, connectionId: string): Promise<ChatTarget[]> {
    const adapter = findChatAdapter(kind);
    if (!adapter) throw new Error('У Telegram списка чатов нет: укажите id чата');
    return adapter.listTargets((target, init) => this.deps.connections.authorizedFetch(connectionId, target, init));
  }

  /** Использования подключений — для окна «Подключения» (decision-102 п. 7). */
  usages(): ConnectionUsage[] {
    return (this.subscriptions ?? [])
      .filter((s) => s.connectionId)
      .map((s) => ({ connectionId: s.connectionId!, label: `Чат: ${s.channelLabel || s.channel}` }));
  }

  private async sendTo(sub: ChatSubscription, notification: AppNotification): Promise<void> {
    const message = chatMessageFor(notification, sub.details, this.deps.mask);
    if (sub.kind === 'telegram') {
      if (!this.deps.telegram?.configured()) throw new Error('Бот Telegram не настроен: токен бота — в настройках Remote Control');
      const ok = await this.deps.telegram.send(notification, sub.channel, telegramText(message));
      if (!ok) throw new Error('Telegram не принял сообщение: проверьте id чата и что бот добавлен в группу');
      return;
    }
    const adapter = findChatAdapter(sub.kind)!;
    const connectionId = sub.connectionId!;
    const ref = await adapter.send((target, init) => this.deps.connections.authorizedFetch(connectionId, target, init), sub.channel, message);
    if (notification.requestId && ref.id) {
      const tracked = this.hitlMessages.get(notification.requestId) ?? [];
      tracked.push({ sub, ref, message });
      this.hitlMessages.set(notification.requestId, tracked);
      while (this.hitlMessages.size > TRACKED_LIMIT) {
        const oldest = this.hitlMessages.keys().next();
        if (oldest.done) break;
        this.hitlMessages.delete(oldest.value);
      }
    }
  }

  /** Разослать уведомление по подходящим подпискам. Ошибка одного чата — запись в лог, остальные получают. */
  async deliver(notification: AppNotification): Promise<number> {
    const now = this.deps.now();
    for (const [key, at] of this.sent) if (now - at > CHAT_DEDUP_WINDOW_MS) this.sent.delete(key);
    let delivered = 0;
    for (const sub of await this.load()) {
      if (!matchesSubscription(sub, notification)) continue;
      const key = `${sub.id}\n${notification.dedupKey}`;
      if (this.sent.has(key)) continue;
      this.sent.set(key, now);
      try {
        await this.sendTo(sub, notification);
        delivered += 1;
      } catch (err) {
        this.deps.log('warn', `[Chat] ${sub.kind} ${sub.channelLabel || sub.channel}: ${notification.kind} не доставлено (${errorText(err)})`);
      }
    }
    return delivered;
  }

  /** Запрос HITL решён: дописать исход в сообщения Slack и Mattermost (Telegram дописывает сам бот-сервис). */
  async resolveHitl(requestId: string, outcome: string): Promise<void> {
    const tracked = this.hitlMessages.get(requestId);
    if (!tracked) return;
    this.hitlMessages.delete(requestId);
    for (const { sub, ref, message } of tracked) {
      try {
        const adapter = findChatAdapter(sub.kind)!;
        const connectionId = sub.connectionId!;
        await adapter.append((target, init) => this.deps.connections.authorizedFetch(connectionId, target, init), ref, message, `— ${outcome}`);
      } catch (err) {
        this.deps.log('warn', `[Chat] ${sub.kind}: исход решения не дописан (${errorText(err)})`);
      }
    }
  }

  /** Пробное сообщение в канал подписки — из окна настроек. */
  async sendTest(id: string): Promise<ChatTestResult> {
    const sub = (await this.load()).find((s) => s.id === id);
    if (!sub) return { ok: false, error: 'Подписка не найдена' };
    const notification: AppNotification = {
      id: `chat-test-${this.deps.now()}`,
      kind: sub.kinds[0] ?? 'automation',
      severity: 'info',
      title: 'Проверка канала ProjectHub',
      body: 'Если вы это видите, уведомления в этот канал доставляются',
      at: this.deps.now(),
      dedupKey: `chat-test:${this.deps.now()}`
    };
    try {
      await this.sendTo({ ...sub, details: true }, notification);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
}
