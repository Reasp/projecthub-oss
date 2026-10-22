import { ChatService } from './chatService';
import { connectionService } from './connectionServiceInstance';
import { hitlService } from './hitlService';
import { telegramService } from './telegramService';
import { getStatePath } from './appPaths';
import { redactSecrets } from './hitlAudit';
import { maskDetectedSecrets } from './secretPatterns';
import { logger } from './logger';
import { getHostLanguage } from './hostLanguage';

/** Боевой экземпляр рабочих чатов (TASK-138.4, decision-110): подключения Slack и Mattermost, бот Telegram. */
export const chatService = new ChatService({
  statePath: () => getStatePath('chat.json'),
  connections: {
    list: async () => (await connectionService.list()).map((c) => ({ id: c.id, serviceId: c.serviceId, label: c.label, accountId: c.account?.id })),
    authorizedFetch: (connectionId, target, init) => connectionService.authorizedFetch(connectionId, target, init)
  },
  // Кнопки решений HITL (TASK-138.6, decision-113): сокет — через слой подключений, решение — через единый контур.
  sockets: { open: (connectionId, target) => connectionService.openWebSocket(connectionId, target) },
  decide: (requestId, approved, who) => {
    const res = hitlService.decide(
      requestId,
      { approved },
      { kind: 'remote', deviceId: `${who.chat.toLowerCase()}:${who.userId}`, deviceName: `${who.chat} (${who.userName})`, confirm: 'chat' }
    );
    return res.ok ? { ok: true } : { ok: false, reason: res.reason, ...(res.risk ? { risk: res.risk } : {}) };
  },
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  telegram: {
    configured: () => telegramService.isBotTokenConfigured,
    send: (notification, chatId, text) => telegramService.sendNotification(notification, { chatId, text })
  },
  mask: (text) => maskDetectedSecrets(redactSecrets(text)),
  now: () => Date.now(),
  language: () => getHostLanguage(),
  log: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message))
});

void chatService.init().catch(() => undefined);
// Окно «Подключения» показывает, в какие каналы шлёт уведомления подключение.
connectionService.registerUsageProvider(() => chatService.usages());
