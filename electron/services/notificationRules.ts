import path from 'node:path';
import type { AppBusEvent } from './hitlTypes.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type AppNotification,
  type NotificationChannel,
  type NotificationKind,
  type NotificationSettings,
  type QuietHoursSettings,
  type TrayState
} from './notificationTypes.js';

/**
 * Правила доставки уведомлений (TASK-63, decision-13 п.3, п.6).
 *
 * Чистый модуль без Electron и без сервисов: превращает событие шины в уведомление, выбирает
 * каналы по матрице «событие × канал», применяет тихие часы и дедупликацию. Всё, что здесь
 * есть, покрыто unit-тестами (`tests/unit/notificationRules.test.ts`); `notificationService`
 * отвечает только за побочные эффекты (трей, Notification, звук, Telegram).
 */

export const DEFAULT_DEDUP_WINDOW_MS = 60_000;

/** Уведомление ОС о запросе одобрения устройства — по нему его закрывают после решения (TASK-173). */
export function deviceApprovalNotificationId(deviceId: string): string {
  return `device-approval-${deviceId}`;
}

export function deviceApprovalDedupKey(deviceId: string): string {
  return `device:approval:${deviceId}`;
}

/**
 * Матрица по умолчанию. Принцип: решения человека (HITL) и аварии идут во все каналы,
 * рутинные завершения — только в трей и звук/ОС, подключение устройства — тихо в трей,
 * а запрос его одобрения — громко: телефон ждёт человека у ПК.
 */
export function defaultChannelMatrix(): Record<NotificationKind, NotificationChannel[]> {
  return {
    hitl: ['tray', 'os', 'sound', 'telegram', 'remote'],
    agentFinished: ['tray', 'os', 'remote'],
    agentFailed: ['tray', 'os', 'sound', 'telegram', 'remote'],
    swarmFinished: ['tray', 'os', 'telegram', 'remote'],
    processCrashed: ['tray', 'os', 'sound', 'telegram'],
    prCreated: ['tray', 'os', 'telegram'],
    prChecksFailed: ['tray', 'os', 'telegram'],
    prMerged: ['tray', 'os'],
    deviceConnected: ['tray'],
    // Телефон ждёт кнопки на ПК: без уведомления ОС и звука человек его не заметит (TASK-173).
    deviceApproval: ['tray', 'os', 'sound'],
    // Переключение модели не требует действий, но объясняет рост стоимости или смену качества.
    modelFallback: ['tray', 'os', 'remote'],
    // Автоматизация работает без человека: пауза по лимиту и сбой запуска должны до него дойти.
    automation: ['tray', 'os', 'telegram', 'remote'],
    // Итог ревью PR: чаще всего за ним следует решение о публикации — оно приходит отдельным HITL.
    prReview: ['tray', 'os', 'remote'],
    // Находки безопасности приходят без человека у экрана (аудит по cron, дифф агента) — до него должны дойти.
    securityFinding: ['tray', 'os', 'telegram', 'remote'],
    // Задачи агента не исполнятся, пока человек их не подтвердит (decision-89): ему нужно узнать о них вне окна.
    agentTask: ['tray', 'os', 'telegram', 'remote'],
    // Деньги: остановка запусков по лимиту случается без человека у экрана, предупреждение заранее — тоже.
    spendLimit: ['tray', 'os', 'telegram', 'remote'],
    // Очередь слияния: участникам события уходят адресно на их устройства, канал «remote» здесь разослал бы всем.
    mergeQueue: ['tray', 'os', 'telegram']
  };
}

export function defaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    channels: defaultChannelMatrix(),
    quietHours: { enabled: false, from: '23:00', to: '08:00', allowCritical: true },
    soundVolume: 0.5,
    dedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
    minimizeToTray: true,
    telegramBotAutoStart: true
  };
}

/** `HH:MM` → минуты от полуночи; `null`, если формат неверный. */
export function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Попадает ли момент в тихие часы. Интервал `from >= to` считается переходящим через полночь
 * (`23:00`–`08:00`). Равные границы — интервал пустой (тихих часов нет).
 */
export function isQuietTime(quiet: QuietHoursSettings, at: Date): boolean {
  if (!quiet.enabled) return false;
  const from = parseTimeOfDay(quiet.from);
  const to = parseTimeOfDay(quiet.to);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Каналы, которые молчат в тихие часы (трей меняет иконку и потому разрешён всегда). */
const NOISY_CHANNELS: NotificationChannel[] = ['os', 'sound', 'telegram'];

/**
 * Итоговый список каналов доставки для уведомления.
 *
 * Порядок сужения: общий выключатель → матрица типа события → тихие часы. Трей не отключается
 * тихими часами: иконка состояния не шумит, а `needs-attention` должен быть виден утром.
 */
export function resolveChannels(
  settings: NotificationSettings,
  notification: Pick<AppNotification, 'kind' | 'severity'>,
  at: Date = new Date()
): NotificationChannel[] {
  const configured = settings.channels[notification.kind] ?? [];
  let channels = NOTIFICATION_CHANNELS.filter((c) => configured.includes(c));
  if (!settings.enabled) {
    channels = channels.filter((c) => c === 'tray');
  }
  if (isQuietTime(settings.quietHours, at)) {
    const allowCritical = settings.quietHours.allowCritical && notification.severity === 'critical';
    if (!allowCritical) channels = channels.filter((c) => !NOISY_CHANNELS.includes(c));
  }
  return channels;
}

/**
 * Дедупликация: один `dedupKey` не доставляется в один канал чаще, чем раз в `windowMs`.
 * Состояние — только карта «ключ+канал → время», поэтому класс тестируется без таймеров.
 */
export class NotificationDeduper {
  private readonly last = new Map<string, number>();

  constructor(private readonly maxEntries = 500) {}

  public shouldDeliver(dedupKey: string, channel: NotificationChannel, now: number, windowMs: number): boolean {
    const key = `${channel}\u0000${dedupKey}`;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < windowMs) return false;
    this.last.set(key, now);
    this.evict();
    return true;
  }

  /** Забыть ключ: решение по запросу принято, повторное уведомление о нём допустимо. */
  public forget(dedupKey: string): void {
    for (const key of [...this.last.keys()]) {
      if (key.endsWith(`\u0000${dedupKey}`)) this.last.delete(key);
    }
  }

  public clear(): void {
    this.last.clear();
  }

  public get size(): number {
    return this.last.size;
  }

  private evict(): void {
    if (this.last.size <= this.maxEntries) return;
    const excess = this.last.size - this.maxEntries;
    let removed = 0;
    for (const key of this.last.keys()) {
      this.last.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/** Состояние иконки трея: внимание важнее работы (decision-13 п.2). */
export function computeTrayState(pendingHitl: number, activeAgents: number): TrayState {
  if (pendingHitl > 0) return 'attention';
  if (activeAgents > 0) return 'working';
  return 'idle';
}

function projectName(projectPath?: string): string {
  if (!projectPath) return '';
  // win32 basename splits on both separators: a Windows path (remote device) is named correctly on macOS/Linux too.
  return path.win32.basename(projectPath.replace(/[\\/]+$/, '')) || projectPath;
}

function agentLabel(event: { agentName?: string; role?: string }): string {
  if (event.agentName && event.role) return `${event.agentName} (${event.role})`;
  return event.agentName || event.role || 'Агент';
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} мин ${rest} с` : `${min} мин`;
}

function trim(text: string, limit = 180): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Событие шины → уведомление. `null` означает «этот тип не уведомляет» (старт агента,
 * решения и отмены HITL — они только снимают уже показанное уведомление).
 *
 * Тексты на русском (правило 11 infra-dev): main-процесс не знает языка рендерера, а канал
 * доставки (ОС, Telegram) живёт вне окна приложения.
 */
export function describeBusEvent(event: AppBusEvent): AppNotification | null {
  switch (event.type) {
    case 'hitl:requested': {
      const r = event.request;
      const what = r.command
        ? `Команда: ${trim(r.command, 120)}`
        : r.filePath
          ? `Файл: ${trim(r.filePath, 120)}`
          : trim(r.details || r.title, 160);
      return {
        id: `hitl-${r.id}`,
        kind: 'hitl',
        severity: 'critical',
        title: `Нужно решение: ${trim(r.title, 80)}`,
        body: [projectName(r.projectPath), agentLabel(r), what].filter(Boolean).join(' · '),
        at: r.createdAt || Date.now(),
        dedupKey: `hitl:${r.id}`,
        projectPath: r.projectPath,
        projectName: projectName(r.projectPath),
        hostId: r.hostId,
        requestId: r.id,
        ...(r.risk ? { risk: r.risk } : {}),
        sessionId: r.sessionId,
        action: { type: 'openHitl', requestId: r.id }
      };
    }
    case 'agent:finished': {
      const duration = formatDuration(event.durationMs);
      return {
        id: `agent-finished-${event.sessionId}-${event.at}`,
        kind: 'agentFinished',
        severity: event.outcome === 'done' ? 'success' : 'warning',
        title: event.outcome === 'done' ? 'Агент завершил работу' : 'Агент прерван',
        body: [projectName(event.projectPath), agentLabel(event), duration].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `agent:finished:${event.sessionId}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        sessionId: event.sessionId,
        action: { type: 'openSwarm', projectPath: event.projectPath, sessionId: event.sessionId }
      };
    }
    case 'agent:failed':
      return {
        id: `agent-failed-${event.sessionId}-${event.at}`,
        kind: 'agentFailed',
        severity: 'critical',
        title: 'Агент завершился с ошибкой',
        body: [projectName(event.projectPath), agentLabel(event), trim(event.error, 140)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `agent:failed:${event.sessionId}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        sessionId: event.sessionId,
        action: { type: 'openSwarm', projectPath: event.projectPath, sessionId: event.sessionId }
      };
    case 'agent:modelFallback':
      return {
        id: `agent-model-fallback-${event.sessionId}-${event.at}`,
        kind: 'modelFallback',
        severity: 'warning',
        title: 'Агент переключил модель',
        body: [projectName(event.projectPath), agentLabel(event), trim(`${event.fromModel} → ${event.toModel} (${event.errorKind}${event.errorReason ? `/${event.errorReason}` : ''})`, 160)]
          .filter(Boolean)
          .join(' · '),
        at: event.at,
        dedupKey: `agent:modelFallback:${event.sessionId}:${event.toModel}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        sessionId: event.sessionId,
        action: { type: 'openSwarm', projectPath: event.projectPath, sessionId: event.sessionId }
      };
    case 'swarm:finished': {
      const failed = event.agentsFailed > 0;
      const parts = [
        projectName(event.projectPath),
        `${event.agentsTotal - event.agentsFailed}/${event.agentsTotal} агентов успешно`,
        formatDuration(event.durationMs)
      ].filter(Boolean);
      return {
        id: `swarm-${event.swarmId}-${event.at}`,
        kind: 'swarmFinished',
        severity: failed || event.outcome !== 'completed' ? 'warning' : 'success',
        title: `${event.mode === 'handoff' ? 'Handoff' : 'Swarm'} «${trim(event.name, 60)}»: ${
          event.outcome === 'completed' ? 'завершён' : event.outcome === 'failed' ? 'с ошибками' : 'остановлен'
        }`,
        body: parts.join(' · '),
        at: event.at,
        dedupKey: `swarm:${event.swarmId}:${event.outcome}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        sessionId: event.swarmId,
        action: { type: 'openSwarm', projectPath: event.projectPath, sessionId: event.swarmId }
      };
    }
    case 'process:crashed':
      return {
        id: `process-${event.processId}-${event.at}`,
        kind: 'processCrashed',
        severity: 'critical',
        title: `Процесс «${trim(event.name, 60)}» аварийно завершился`,
        body: [projectName(event.projectPath), `код выхода ${event.exitCode ?? '?'}`].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `process:${event.processId}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        action: { type: 'openProcesses', projectPath: event.projectPath }
      };
    case 'pr:created':
      return {
        id: `pr-created-${event.projectPath}-${event.number}`,
        kind: 'prCreated',
        severity: 'success',
        title: `Pull Request #${event.number} создан`,
        body: [projectName(event.projectPath), trim(event.title, 120)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `pr:created:${event.projectPath}:${event.number}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        action: { type: 'openPrs', projectPath: event.projectPath, url: event.url }
      };
    case 'pr:merged': {
      const moved = event.movedTasks.map((m) => `${m.taskId}: ${m.from} → ${m.to}`).join(', ');
      return {
        id: `pr-merged-${event.projectPath}-${event.number}`,
        kind: 'prMerged',
        severity: 'success',
        title: `Pull Request #${event.number} слит`,
        body: [projectName(event.projectPath), trim(event.title, 120), moved].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `pr:merged:${event.projectPath}:${event.number}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        action: event.movedTasks[0]
          ? { type: 'openTask', projectPath: event.projectPath, taskId: event.movedTasks[0].taskId }
          : { type: 'openPrs', projectPath: event.projectPath, url: event.url }
      };
    }
    case 'pr:checksFailed':
      return {
        id: `pr-checks-${event.projectPath}-${event.number}`,
        kind: 'prChecksFailed',
        severity: 'warning',
        title: `Проверки Pull Request #${event.number} упали`,
        body: [projectName(event.projectPath), trim(event.title, 120)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `pr:checks:${event.projectPath}:${event.number}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        hostId: event.hostId,
        action: { type: 'openPrs', projectPath: event.projectPath, url: event.url }
      };
    case 'remote:deviceConnected':
      return {
        id: `device-${event.deviceId}-${event.at}`,
        kind: 'deviceConnected',
        severity: 'info',
        title: 'Подключено устройство',
        body: [trim(event.deviceName, 60), event.mode, event.isApproved ? 'одобрено' : 'ожидает одобрения']
          .filter(Boolean)
          .join(' · '),
        at: event.at,
        dedupKey: `device:${event.deviceId}`,
        hostId: event.hostId,
        action: { type: 'openRemote' }
      };
    // Ключ дедупликации — по устройству: переподключения ждущего телефона не множат уведомления,
    // а решение по нему (`remote:deviceApprovalResolved`) снимает и уведомление, и ключ (TASK-173).
    case 'remote:deviceApprovalRequested':
      return {
        id: deviceApprovalNotificationId(event.deviceId),
        kind: 'deviceApproval',
        severity: 'warning',
        title: 'Устройство ждёт подтверждения',
        body: [trim(event.deviceName, 60), event.mode, 'разрешите доступ в Remote Control → Устройства'].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: deviceApprovalDedupKey(event.deviceId),
        hostId: event.hostId,
        action: { type: 'openRemote', tab: 'devices' }
      };
    // ── Ограничения расходов (decision-124): текст готовит модуль-источник ──
    case 'limits:notice':
      return {
        id: `limits-${event.limitId}-${event.at}`,
        kind: 'spendLimit',
        severity: event.level === 'block' ? 'critical' : 'warning',
        title: trim(event.title, 120),
        body: [trim(event.body, 200), projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `limits:${event.dedupKey}`,
        ...(event.projectPath ? { projectPath: event.projectPath, projectName: projectName(event.projectPath) } : {}),
        action: { type: 'openApp' }
      };
    // ── Очередь слияния общего хоста (TASK-142.4): текст готовит модуль-источник ──
    case 'queue:notice':
      return {
        id: `queue-${event.itemId}-${event.at}`,
        kind: 'mergeQueue',
        severity: event.level === 'warn' ? 'warning' : 'info',
        title: trim(event.title, 120),
        body: [trim(event.body, 200), projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `queue:${event.dedupKey}`,
        ...(event.projectPath ? { projectPath: event.projectPath, projectName: projectName(event.projectPath) } : {}),
        action: { type: 'openApp' }
      };
    // ── Automations (TASK-74, decision-52 п. 6) ──
    case 'automation:suspended': {
      const why =
        event.reason === 'budget'
          ? `исчерпан дневной бюджет${event.limitUsd ? ` ($${(event.spentUsd ?? event.limitUsd).toFixed(2)} из $${event.limitUsd.toFixed(2)})` : ''}`
          : 'исчерпано число запусков за день';
      return {
        id: `automation-suspended-${event.ruleId}-${event.until}`,
        kind: 'automation',
        severity: 'warning',
        title: 'Автоматизация приостановлена до полуночи',
        body: [trim(event.ruleName, 80), why, projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `automation:suspended:${event.ruleId}:${event.until}`,
        ...(event.projectPath ? { projectPath: event.projectPath, projectName: projectName(event.projectPath) } : {}),
        action: { type: 'openAutomations', ...(event.projectPath ? { projectPath: event.projectPath } : {}) }
      };
    }
    case 'automation:runFinished':
      // Успешный запуск — штатная работа, о нём говорит журнал; уведомляем только о сбое.
      if (event.outcome !== 'failed') return null;
      return {
        id: `automation-failed-${event.runId}`,
        kind: 'automation',
        severity: 'warning',
        title: `Автоматизация «${trim(event.ruleName, 60)}» не выполнена`,
        body: [trim(event.detail || event.action, 160), projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `automation:failed:${event.runId}`,
        ...(event.projectPath ? { projectPath: event.projectPath, projectName: projectName(event.projectPath) } : {}),
        action: event.swarmId
          ? { type: 'openSwarm', ...(event.projectPath ? { projectPath: event.projectPath } : {}), sessionId: event.swarmId }
          : { type: 'openAutomations', ...(event.projectPath ? { projectPath: event.projectPath } : {}) }
      };
    case 'pr:reviewFinished': {
      const body =
        event.status === 'failed'
          ? `не выполнено: ${trim(event.error || 'ошибка', 140)}`
          : `подтверждено ${event.confirmed}, отброшено ${event.refuted}${event.unverified ? `, не проверено ${event.unverified}` : ''}${event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(2)}` : ''}`;
      return {
        id: `pr-review-${event.reviewId}`,
        kind: 'prReview',
        severity: event.status === 'failed' ? 'warning' : event.confirmed > 0 ? 'warning' : 'success',
        title: `Ревью PR #${event.number} «${trim(event.title, 60)}»`,
        body: [body, event.publish === 'pending' ? 'публикация ждёт решения' : '', projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `pr:review:${event.reviewId}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        action: { type: 'openPrs', projectPath: event.projectPath, ...(event.url ? { url: event.url } : {}) }
      };
    }
    // ── Security Health (TASK-73, decision-56 п. 10) ──
    case 'security:finding': {
      const severity: AppNotification['severity'] =
        event.source === 'secrets' || event.severity === 'critical' ? 'critical' : event.severity === 'high' || event.severity === 'unknown' ? 'warning' : 'info';
      return {
        id: `security-${event.source}-${event.at}`,
        kind: 'securityFinding',
        severity,
        title: trim(event.title, 120),
        body: [trim(event.summary, 200), projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `security:${event.source}:${event.projectPath}:${event.key}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        ...(event.swarmId ? { sessionId: event.swarmId } : {}),
        action: event.swarmId
          ? { type: 'openSwarm', projectPath: event.projectPath, sessionId: event.swarmId }
          : { type: 'openSecurity', projectPath: event.projectPath }
      };
    }
    // ── Задачи, заведённые агентом (TASK-153, decision-89) ──
    case 'task:agentCreated': {
      const ids = event.tasks.map((t) => t.id);
      const single = event.tasks.length === 1 ? event.tasks[0] : null;
      return {
        id: `agent-task-${ids.join('-')}-${event.at}`,
        kind: 'agentTask',
        severity: 'warning',
        title: single
          ? trim(`Агент завёл задачу: ${single.id} «${single.title}»`, 120)
          : `Агент завёл задачи (${event.tasks.length}), ждут подтверждения`,
        body: [
          projectName(event.projectPath),
          event.reporter,
          single ? 'ждёт подтверждения' : trim(event.tasks.map((t) => `${t.id} ${t.title}`).join(', '), 200)
        ]
          .filter(Boolean)
          .join(' · '),
        at: event.at,
        dedupKey: `agentTask:${event.projectPath}:${ids.join(',')}`,
        projectPath: event.projectPath,
        projectName: projectName(event.projectPath),
        action: { type: 'openTask', projectPath: event.projectPath, ...(single ? { taskId: single.id } : {}) },
        // Кнопка «Подтвердить» в Telegram (TASK-155): билет подтверждает ровно задачи этой пачки.
        ...(event.approvalTicket ? { agentTaskApproval: { ticket: event.approvalTicket, count: ids.length } } : {})
      };
    }
    case 'automation:notify':
      return {
        id: `automation-notify-${event.ruleId}-${event.at}`,
        kind: 'automation',
        severity: 'info',
        title: trim(event.title, 120),
        body: [trim(event.body || event.ruleName, 200), projectName(event.projectPath)].filter(Boolean).join(' · '),
        at: event.at,
        dedupKey: `automation:notify:${event.ruleId}:${event.at}`,
        ...(event.projectPath ? { projectPath: event.projectPath, projectName: projectName(event.projectPath) } : {}),
        action: { type: 'openAutomations', ...(event.projectPath ? { projectPath: event.projectPath } : {}) }
      };
    default:
      return null;
  }
}

/** Значение из `unknown` с валидацией: настройки читаются из файла и приходят из рендерера. */
export function normalizeSettings(raw: unknown, base: NotificationSettings = defaultNotificationSettings()): NotificationSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationSettings>;
  const channels = { ...base.channels };
  const rawChannels = (src.channels && typeof src.channels === 'object' ? src.channels : {}) as Record<string, unknown>;
  for (const kind of NOTIFICATION_KINDS) {
    const value = rawChannels[kind];
    if (Array.isArray(value)) {
      channels[kind] = NOTIFICATION_CHANNELS.filter((c) => value.includes(c));
    }
  }

  const rawQuiet = (src.quietHours && typeof src.quietHours === 'object' ? src.quietHours : {}) as Partial<QuietHoursSettings>;
  const quietHours: QuietHoursSettings = {
    enabled: typeof rawQuiet.enabled === 'boolean' ? rawQuiet.enabled : base.quietHours.enabled,
    from: parseTimeOfDay(rawQuiet.from) !== null ? (rawQuiet.from as string) : base.quietHours.from,
    to: parseTimeOfDay(rawQuiet.to) !== null ? (rawQuiet.to as string) : base.quietHours.to,
    allowCritical: typeof rawQuiet.allowCritical === 'boolean' ? rawQuiet.allowCritical : base.quietHours.allowCritical
  };

  const volume = typeof src.soundVolume === 'number' && Number.isFinite(src.soundVolume)
    ? Math.min(1, Math.max(0, src.soundVolume))
    : base.soundVolume;

  const dedup = typeof src.dedupWindowMs === 'number' && Number.isFinite(src.dedupWindowMs)
    ? Math.min(3_600_000, Math.max(0, Math.round(src.dedupWindowMs)))
    : base.dedupWindowMs;

  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : base.enabled,
    channels,
    quietHours,
    soundVolume: volume,
    dedupWindowMs: dedup,
    minimizeToTray: typeof src.minimizeToTray === 'boolean' ? src.minimizeToTray : base.minimizeToTray,
    telegramBotAutoStart:
      typeof src.telegramBotAutoStart === 'boolean' ? src.telegramBotAutoStart : base.telegramBotAutoStart
  };
}

/** Текст Telegram-сообщения (Markdown): заголовок жирным, тело обычным, служебные символы экранированы. */
export function formatTelegramMessage(n: AppNotification): string {
  const icon: Record<AppNotification['severity'], string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    critical: '🚨'
  };
  const escape = (s: string) => s.replace(/([*_`[\]])/g, '\\$1');
  const lines = [`${icon[n.severity]} *${escape(n.title)}*`];
  if (n.body) lines.push(escape(n.body));
  return lines.join('\n');
}
