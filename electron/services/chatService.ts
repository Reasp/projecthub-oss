import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { findChatAdapter, type ChatMessage, type ChatMessageRef, type ChatTarget } from './chatAdapters.js';
import { canDecide, parseMattermostEvent, parseSlackEnvelope, slackSocketUrl, socketBackoffMs, type ChatDecision } from './chatButtons.js';
import { chatMessageFor, hasDecisionButtons, matchesSubscription, normalizeSubscription, type ChatKind, type ChatSubscription } from './chatSubscriptions.js';
import { stateFields, withVersion } from './stateFiles.js';
import type { AppNotification } from './notificationTypes.js';
import type { Language } from '../../src/i18n/types.js';
import { hostText } from '../i18n/hostText.js';
import type { ConnectionUsage } from './connectionTypes.js';

/**
 * Рабочие чаты (TASK-138.4, decision-110): уведомления ProjectHub в каналы команды по подпискам «события × проекты ×
 * канал». Slack, Mattermost и Teams — через слой подключений (decision-102), Telegram — через бота Remote Control.
 * Подписки — `<userData>/chat.json`.
 *
 * Кнопки решений HITL без входящего адреса (TASK-138.6, decision-113): Slack — исходящий WebSocket Socket Mode,
 * Mattermost — реакции через WebSocket API. Сокет открыт, только пока есть подписка с кнопками и списком решающих.
 */

export interface ChatConnectionInfo {
  id: string;
  serviceId: string;
  label: string;
  /** Id аккаунта подключения: у Mattermost — бот, от имени которого ставятся реакции. */
  accountId?: string;
}

/** Сокет подключения: открывает слой подключений (`connectionService.openWebSocket`). */
export interface ChatSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

/** Кто нажал: имя идёт в аудит HITL. */
export interface ChatDecider {
  chat: 'Slack' | 'Mattermost';
  userId: string;
  userName: string;
}

export type ChatDecideResult = { ok: true } | { ok: false; reason: string; risk?: string };

/** Итог нажатия — для журнала и тестов. */
export type ChatDecisionOutcome = 'applied' | 'not_allowed' | 'rejected' | 'unknown_message';

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
  /** Сокеты для кнопок; без них кнопок нет. */
  sockets?: { open(connectionId: string, target: string): Promise<ChatSocket> };
  /** Решение HITL по нажатию: `hitlService.decide` с источником `remote` и способом `chat`. */
  decide?(requestId: string, approved: boolean, who: ChatDecider): ChatDecideResult;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Язык сообщений и кнопок — язык интерфейса хоста (TASK-205); без него — английский. */
  language?(): Language;
}

interface SocketEntry {
  key: string;
  kind: 'slack' | 'mattermost';
  /** Подключение сокета: у Slack — приложение (`xapp-…`), у Mattermost — бот. */
  connectionId: string;
  socket: ChatSocket | null;
  attempt: number;
  timer: unknown;
  stopped: boolean;
}

/** Причина отказа хоста — человеку в чате. */
function decisionRejectText(reason: string, lang: Language): string {
  const tx = hostText(lang).decision;
  if (reason === 'confirmation_required') return tx.rejectHighRisk;
  if (reason === 'already_decided') return tx.rejectAlreadyDecided;
  if (reason === 'not_found') return tx.rejectNotFound;
  return tx.rejectOther(reason);
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
  const link = message.url ? `\n[${esc(message.urlLabel || 'Open')}](${message.url})` : '';
  return [`*${esc(message.title)}*`, ...message.lines.map(esc)].join('\n') + link;
}

export class ChatService {
  private subscriptions: ChatSubscription[] | null = null;
  private readonly sent = new Map<string, number>();
  /** Запрос HITL → сообщения в Slack и Mattermost, куда дописать исход. */
  private readonly hitlMessages = new Map<string, Array<{ sub: ChatSubscription; ref: ChatMessageRef; message: ChatMessage }>>();
  private readonly sockets = new Map<string, SocketEntry>();

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
    this.syncSockets();
  }

  /** Закрыть сокеты кнопок (выход из приложения, тесты). */
  dispose(): void {
    for (const entry of this.sockets.values()) this.stopSocket(entry);
    this.sockets.clear();
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
      const connections = await this.deps.connections.list();
      const connection = connections.find((c) => c.id === sub.connectionId);
      if (!connection || connection.serviceId !== sub.kind) throw new Error(`Выберите подключение к ${findChatAdapter(sub.kind)?.label ?? sub.kind}`);
      if (sub.appConnectionId && connections.find((c) => c.id === sub.appConnectionId)?.serviceId !== 'slack-app') {
        throw new Error('Кнопки Slack: выберите подключение «Slack: кнопки (Socket Mode)» с токеном приложения xapp-…');
      }
    }
    const list = await this.load();
    const at = list.findIndex((s) => s.id === sub.id);
    if (at >= 0) list[at] = sub;
    else list.push(sub);
    await this.persist();
    this.syncSockets();
    return sub;
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.load();
    const at = list.findIndex((s) => s.id === id);
    if (at < 0) return false;
    list.splice(at, 1);
    await this.persist();
    this.syncSockets();
    return true;
  }

  // ─────────────────────────── кнопки решений (TASK-138.6) ───────────────────────────

  /** Какие сокеты нужны сейчас: по одному на приложение Slack и на подключение Mattermost с кнопками. */
  private wantedSockets(): Map<string, { kind: 'slack' | 'mattermost'; connectionId: string }> {
    const wanted = new Map<string, { kind: 'slack' | 'mattermost'; connectionId: string }>();
    if (!this.deps.sockets || !this.deps.decide) return wanted;
    for (const sub of this.subscriptions ?? []) {
      if (!sub.enabled || !hasDecisionButtons(sub)) continue;
      if (sub.kind === 'slack' && sub.appConnectionId) wanted.set(`slack:${sub.appConnectionId}`, { kind: 'slack', connectionId: sub.appConnectionId });
      if (sub.kind === 'mattermost' && sub.connectionId) wanted.set(`mattermost:${sub.connectionId}`, { kind: 'mattermost', connectionId: sub.connectionId });
    }
    return wanted;
  }

  /** Открыть недостающие сокеты и закрыть лишние: сеть только пока есть подписка с кнопками. */
  syncSockets(): void {
    const wanted = this.wantedSockets();
    for (const [key, entry] of this.sockets) {
      if (!wanted.has(key)) {
        this.stopSocket(entry);
        this.sockets.delete(key);
      }
    }
    for (const [key, w] of wanted) {
      if (this.sockets.has(key)) continue;
      const entry: SocketEntry = { key, ...w, socket: null, attempt: 0, timer: null, stopped: false };
      this.sockets.set(key, entry);
      void this.openSocket(entry);
    }
  }

  private stopSocket(entry: SocketEntry): void {
    entry.stopped = true;
    if (entry.timer !== null) this.deps.clearTimer?.(entry.timer);
    entry.timer = null;
    try {
      entry.socket?.close();
    } catch {
      // уже закрыт
    }
    entry.socket = null;
  }

  private scheduleReconnect(entry: SocketEntry, immediate = false): void {
    if (entry.stopped || !this.deps.setTimer) return;
    const delay = immediate ? 0 : socketBackoffMs(entry.attempt);
    entry.attempt += 1;
    entry.timer = this.deps.setTimer(() => {
      entry.timer = null;
      void this.openSocket(entry);
    }, delay);
  }

  private async openSocket(entry: SocketEntry): Promise<void> {
    if (entry.stopped || !this.deps.sockets) return;
    try {
      let target = '/websocket';
      if (entry.kind === 'slack') {
        // Socket Mode: адрес с одноразовым билетом выдаёт API по токену приложения.
        const res = await this.deps.connections.authorizedFetch(entry.connectionId, '/apps.connections.open', { method: 'POST' });
        target = slackSocketUrl(await res.json().catch(() => null));
      }
      const socket = await this.deps.sockets.open(entry.connectionId, target);
      if (entry.stopped) {
        socket.close();
        return;
      }
      entry.socket = socket;
      const botId = entry.kind === 'mattermost' ? (await this.deps.connections.list()).find((c) => c.id === entry.connectionId)?.accountId ?? '' : '';
      socket.onMessage((text) => void this.onSocketMessage(entry, socket, text, botId));
      socket.onClose(() => {
        if (entry.socket !== socket) return;
        entry.socket = null;
        this.scheduleReconnect(entry);
      });
    } catch (err) {
      this.deps.log('warn', `[Chat] ${entry.kind}: сокет кнопок не открыт (${errorText(err)})`);
      this.scheduleReconnect(entry);
    }
  }

  private async onSocketMessage(entry: SocketEntry, socket: ChatSocket, text: string, botId: string): Promise<void> {
    if (entry.kind === 'slack') {
      const env = parseSlackEnvelope(text);
      if (!env) return;
      // Подтверждение — сразу: Slack ждёт его 3 секунды, иначе повторит конверт.
      if ('envelopeId' in env && env.envelopeId) socket.send(JSON.stringify({ envelope_id: env.envelopeId }));
      if (env.kind === 'hello') entry.attempt = 0;
      else if (env.kind === 'disconnect') {
        // Slack просит переподключиться (обновление билета): новый сокет сразу, без паузы.
        entry.socket = null;
        socket.close();
        this.scheduleReconnect(entry, true);
      } else if (env.kind === 'decision') await this.applyDecision('slack', entry.connectionId, env.decision);
      return;
    }
    const parsed = parseMattermostEvent(text, botId);
    entry.attempt = 0;
    if (parsed) await this.applyDecision('mattermost', entry.connectionId, { ...parsed, channel: parsed.channel ?? '', userName: parsed.userId });
  }

  /**
   * Нажатие в чате → решение HITL. Сообщение должно быть отправлено этой подпиской, человек — из её списка решающих;
   * иначе решение не применяется, а человек получает объяснение только для себя.
   */
  private lang(): Language {
    return this.deps.language?.() ?? 'en';
  }

  async applyDecision(kind: 'slack' | 'mattermost', socketConnectionId: string, d: ChatDecision): Promise<ChatDecisionOutcome> {
    let found: { requestId: string; sub: ChatSubscription; ref: ChatMessageRef } | null = null;
    for (const [requestId, list] of this.hitlMessages) {
      const hit = list.find(
        (m) =>
          m.sub.kind === kind &&
          (kind === 'slack' ? m.sub.appConnectionId === socketConnectionId : m.sub.connectionId === socketConnectionId) &&
          m.ref.id === d.messageId &&
          (!d.channel || m.ref.channel === d.channel)
      );
      if (hit) {
        found = { requestId, sub: hit.sub, ref: hit.ref };
        break;
      }
    }
    if (!found || (d.requestId && d.requestId !== found.requestId)) return 'unknown_message';
    const chat = kind === 'slack' ? 'Slack' : 'Mattermost';
    if (!canDecide(found.sub.deciders, d.userId)) {
      this.deps.log('warn', `[Chat] ${chat}: нажатие ${d.userId} не применено — нет в списке решающих подписки`);
      await this.notifyUser(found.sub, found.ref.channel, d.userId, hostText(this.lang()).decision.notInList);
      return 'not_allowed';
    }
    const res = this.deps.decide!(found.requestId, d.approved, { chat, userId: d.userId, userName: d.userName });
    if (!res.ok) {
      await this.notifyUser(found.sub, found.ref.channel, d.userId, decisionRejectText(res.reason, this.lang()));
      return 'rejected';
    }
    this.deps.log('info', `[Chat] ${chat}: запрос ${found.requestId} ${d.approved ? 'одобрен' : 'отклонён'} (${d.userName})`);
    return 'applied';
  }

  private async notifyUser(sub: ChatSubscription, channel: string, userId: string, note: string): Promise<void> {
    const adapter = findChatAdapter(sub.kind);
    if (!adapter?.notifyUser || !sub.connectionId) return;
    const connectionId = sub.connectionId;
    await adapter.notifyUser((target, init) => this.deps.connections.authorizedFetch(connectionId, target, init), channel, userId, note).catch((err) => {
      this.deps.log('warn', `[Chat] ${sub.kind}: объяснение не отправлено (${errorText(err)})`);
    });
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
    const buttons = Boolean(notification.kind === 'hitl' && notification.requestId && hasDecisionButtons(sub) && this.deps.decide && this.deps.sockets);
    const message = chatMessageFor(notification, sub.details, this.deps.mask, buttons, this.lang());
    if (sub.kind === 'telegram') {
      if (!this.deps.telegram?.configured()) throw new Error('Бот Telegram не настроен: токен бота — в настройках Remote Control');
      const ok = await this.deps.telegram.send(notification, sub.channel, telegramText(message));
      if (!ok) throw new Error('Telegram не принял сообщение: проверьте id чата и что бот добавлен в группу');
      return;
    }
    const adapter = findChatAdapter(sub.kind)!;
    const connectionId = sub.connectionId!;
    const botUserId = buttons && sub.kind === 'mattermost' ? (await this.deps.connections.list()).find((c) => c.id === connectionId)?.accountId : undefined;
    const ref = await adapter.send((target, init) => this.deps.connections.authorizedFetch(connectionId, target, init), sub.channel, message, {
      ...(buttons ? { hitlRequestId: notification.requestId, hitlDenyOnly: notification.risk === 'high', lang: this.lang() } : {}),
      ...(botUserId ? { botUserId } : {})
    });
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
