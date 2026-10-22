import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, Notification } from 'electron';
import { appEventBus } from './eventBus.js';
import { hitlService } from './hitlService.js';
import { trayService } from './trayService.js';
import { telegramService } from './telegramService.js';
import { getUserDataDir } from './appPaths.js';
import { logger } from './logger.js';
import { getHostLanguage } from './hostLanguage.js';
import { hostText } from '../i18n/hostText.js';
import { stateFields, withVersion } from './stateFiles.js';
import {
  NotificationDeduper,
  computeTrayState,
  defaultNotificationSettings,
  describeBusEvent,
  deviceApprovalDedupKey,
  deviceApprovalNotificationId,
  normalizeSettings,
  resolveChannels
} from './notificationRules.js';
import type { AppBusEvent } from './hitlTypes.js';
import type {
  AppNotification,
  NotificationChannel,
  NotificationDelivery,
  NotificationSettings
} from './notificationTypes.js';

/**
 * Доставка уведомлений по каналам (TASK-63, decision-13).
 *
 * Единственный подписчик шины, который решает «кому и куда»: чистые правила берутся из
 * {@link ./notificationRules.js}, здесь остаются только побочные эффекты — иконка и меню трея,
 * системное уведомление, звук в окне, Telegram-push и рассылка доверенным устройствам.
 *
 * Решение HITL с любого канала снимает уведомление на остальных: системное закрывается,
 * у Telegram-сообщения убираются кнопки, ключ дедупликации забывается.
 */

export const NOTIFICATION_SETTINGS_FILE = 'notifications.json';
/** Версия формата файла (decision-104). */
export const NOTIFICATION_SETTINGS_VERSION = 1;

/** Кнопки решения в системном уведомлении поддерживает только macOS. */
export const OS_ACTIONS_SUPPORTED = process.platform === 'darwin';

/**
 * Чаты команды (TASK-138.4, decision-110): свои подписки «события × проекты × канал», не зависят от личной матрицы
 * каналов, общего выключателя и тихих часов владельца.
 */
export interface TeamChatDelivery {
  deliver(notification: AppNotification): Promise<unknown>;
  resolve(requestId: string, outcome: string): Promise<void>;
}

export interface NotificationCapabilities {
  osNotifications: boolean;
  osActions: boolean;
  tray: boolean;
  telegram: boolean;
}

class NotificationService {
  private settings: NotificationSettings = defaultNotificationSettings();
  private settingsPath: string | null = null;
  private readonly deduper = new NotificationDeduper();
  private unsubscribe: (() => void) | null = null;
  private readonly osNotifications = new Map<string, Notification>();
  /** Сессии агентов, работающие прямо сейчас: считаем по шине, без обращения к сервисам агентов. */
  private readonly activeAgentSessions = new Set<string>();
  private getWindow: (() => BrowserWindow | null) | null = null;
  private remoteBroadcast: ((notification: AppNotification) => void) | null = null;
  private teamChats: TeamChatDelivery | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  public configure(options: {
    getWindow: () => BrowserWindow | null;
    remoteBroadcast?: (notification: AppNotification) => void;
    teamChats?: TeamChatDelivery;
  }): void {
    this.getWindow = options.getWindow;
    this.remoteBroadcast = options.remoteBroadcast ?? null;
    this.teamChats = options.teamChats ?? null;
  }

  public async init(): Promise<NotificationSettings> {
    this.settingsPath = path.join(getUserDataDir(), NOTIFICATION_SETTINGS_FILE);
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf-8');
      this.settings = normalizeSettings(stateFields(JSON.parse(raw), NOTIFICATION_SETTINGS_VERSION));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn(`[Notifications] Failed to read settings: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.settings = defaultNotificationSettings();
    }
    if (!this.unsubscribe) {
      this.unsubscribe = appEventBus.subscribe((event) => this.handleBusEvent(event));
    }
    this.refreshTray();
    return this.settings;
  }

  public getSettings(): NotificationSettings {
    return this.settings;
  }

  public getCapabilities(): NotificationCapabilities {
    return {
      osNotifications: Notification.isSupported(),
      osActions: OS_ACTIONS_SUPPORTED,
      tray: trayService.isAvailable,
      telegram: telegramService.isConfigured
    };
  }

  public async updateSettings(patch: unknown): Promise<NotificationSettings> {
    this.settings = normalizeSettings(patch, this.settings);
    this.deduper.clear();
    await this.persist();
    this.refreshTray();
    void telegramService.sync(this.settings.telegramBotAutoStart);
    return this.settings;
  }

  /** Отправить пробное уведомление во все настроенные для этого типа каналы. */
  public async sendTest(): Promise<NotificationDelivery> {
    const tx = hostText(getHostLanguage());
    const notification: AppNotification = {
      id: `test-${Date.now()}`,
      kind: 'hitl',
      severity: 'critical',
      title: tx.notify.testTitle,
      body: tx.notify.testBody,
      at: Date.now(),
      dedupKey: `test:${Date.now()}`,
      action: { type: 'openApp' }
    };
    const channels = resolveChannels(this.settings, notification);
    await this.deliver(notification, channels);
    return { notification, channels };
  }

  private handleBusEvent(event: AppBusEvent): void {
    this.trackAgentState(event);

    // Решение принято где угодно — снимаем уведомление во всех каналах (decision-13 п.6).
    if (event.type === 'hitl:decided' || event.type === 'hitl:expired' || event.type === 'hitl:cancelled') {
      const requestId = event.request.id;
      this.deduper.forget(`hitl:${requestId}`);
      this.closeOsNotification(`hitl-${requestId}`);
      const tx = hostText(getHostLanguage()).decision;
      const outcome =
        event.type === 'hitl:decided'
          ? event.approved
            ? tx.allowed(event.source.kind)
            : tx.denied(event.source.kind)
          : event.type === 'hitl:expired'
            ? tx.expired
            : tx.cancelled;
      void telegramService.resolveRequest(requestId, outcome);
      void this.teamChats?.resolve(requestId, outcome).catch(() => undefined);
      this.refreshTray();
      return;
    }

    // Устройство одобрено, отклонено или ушло — висящее «ждёт подтверждения» больше не нужно (TASK-173).
    if (event.type === 'remote:deviceApprovalResolved') {
      this.deduper.forget(deviceApprovalDedupKey(event.deviceId));
      this.closeOsNotification(deviceApprovalNotificationId(event.deviceId));
      return;
    }

    const notification = describeBusEvent(event, getHostLanguage());
    this.refreshTray();
    if (!notification) return;
    void this.teamChats?.deliver(notification).catch(() => undefined);

    const channels = resolveChannels(this.settings, notification);
    void this.deliver(notification, channels);
  }

  /** Счётчик активных агентов для состояния трея и подтверждения выхода. */
  private trackAgentState(event: AppBusEvent): void {
    if (event.type === 'agent:started') {
      this.activeAgentSessions.add(event.sessionId);
    } else if (event.type === 'agent:finished' || event.type === 'agent:failed') {
      this.activeAgentSessions.delete(event.sessionId);
    }
  }

  public get activeAgentCount(): number {
    return this.activeAgentSessions.size;
  }

  private async deliver(notification: AppNotification, channels: NotificationChannel[]): Promise<void> {
    const now = Date.now();
    const delivered: NotificationChannel[] = [];
    for (const channel of channels) {
      if (!this.deduper.shouldDeliver(notification.dedupKey, channel, now, this.settings.dedupWindowMs)) continue;
      delivered.push(channel);
      try {
        switch (channel) {
          case 'tray':
            this.refreshTray();
            break;
          case 'os':
            this.showOsNotification(notification);
            break;
          case 'sound':
            this.sendToRenderer('notify:sound', {
              severity: notification.severity,
              volume: this.settings.soundVolume
            });
            break;
          case 'telegram':
            await telegramService.sendNotification(notification);
            break;
          case 'remote':
            this.remoteBroadcast?.(notification);
            break;
        }
      } catch (err) {
        logger.warn(
          `[Notifications] Channel "${channel}" failed for ${notification.kind}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Рендерер получает каждое уведомление независимо от каналов: журнал в UI и всплывающий тост.
    this.sendToRenderer('notify:delivered', { notification, channels: delivered } satisfies NotificationDelivery);
  }

  private showOsNotification(notification: AppNotification): void {
    if (!Notification.isSupported()) return;
    const actionable = Boolean(notification.requestId) && OS_ACTIONS_SUPPORTED;
    const os = new Notification({
      title: notification.title,
      body: notification.body,
      urgency: notification.severity === 'critical' ? 'critical' : 'normal',
      // Звук ОС не используем: свой сигнал управляется каналом `sound` и «тихими часами».
      silent: true,
      ...(actionable
        ? { actions: [{ type: 'button' as const, text: hostText(getHostLanguage()).decision.allow }, { type: 'button' as const, text: hostText(getHostLanguage()).decision.deny }] }
        : {})
    });

    os.on('click', () => {
      if (notification.action) this.sendNavigate(notification.action);
      else this.sendNavigate({ type: 'openApp' });
    });

    if (actionable && notification.requestId) {
      os.on('action', (_event, index) => {
        const approved = index === 0;
        hitlService.decide(
          notification.requestId!,
          { approved },
          { kind: 'local', deviceName: 'System notification' }
        );
      });
    }

    os.on('close', () => this.osNotifications.delete(notification.id));
    this.osNotifications.set(notification.id, os);
    os.show();
  }

  private closeOsNotification(id: string): void {
    const os = this.osNotifications.get(id);
    if (!os) return;
    this.osNotifications.delete(id);
    try {
      os.close();
    } catch {
      // ignore
    }
  }

  /** Открыть окно и передать рендереру, куда перейти (клик по уведомлению или пункту трея). */
  public sendNavigate(action: AppNotification['action']): void {
    const win = this.getWindow?.() ?? null;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
    this.sendToRenderer('notify:navigate', action ?? { type: 'openApp' });
  }

  public refreshTray(): void {
    const pending = hitlService.pendingCount();
    trayService.setState(computeTrayState(pending, this.activeAgentSessions.size));
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    const win = this.getWindow?.() ?? null;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  private persist(): Promise<void> {
    if (!this.settingsPath) return Promise.resolve();
    const target = this.settingsPath;
    const data = JSON.stringify(withVersion(NOTIFICATION_SETTINGS_VERSION, this.settings), null, 2);
    this.saveQueue = this.saveQueue
      .then(() => fs.writeFile(target, data, 'utf-8'))
      .catch((err) => {
        logger.warn(`[Notifications] Failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
      });
    return this.saveQueue;
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const id of [...this.osNotifications.keys()]) this.closeOsNotification(id);
  }
}

export const notificationService = new NotificationService();
