import { ChatService } from './chatService';
import { connectionService } from './connectionServiceInstance';
import { telegramService } from './telegramService';
import { getStatePath } from './appPaths';
import { redactSecrets } from './hitlAudit';
import { maskDetectedSecrets } from './secretPatterns';
import { logger } from './logger';

/** Боевой экземпляр рабочих чатов (TASK-138.4, decision-110): подключения Slack и Mattermost, бот Telegram. */
export const chatService = new ChatService({
  statePath: () => getStatePath('chat.json'),
  connections: {
    list: async () => (await connectionService.list()).map((c) => ({ id: c.id, serviceId: c.serviceId, label: c.label })),
    authorizedFetch: (connectionId, target, init) => connectionService.authorizedFetch(connectionId, target, init)
  },
  telegram: {
    configured: () => telegramService.isBotTokenConfigured,
    send: (notification, chatId, text) => telegramService.sendNotification(notification, { chatId, text })
  },
  mask: (text) => maskDetectedSecrets(redactSecrets(text)),
  now: () => Date.now(),
  log: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message))
});

void chatService.init().catch(() => undefined);
// Окно «Подключения» показывает, в какие каналы шлёт уведомления подключение.
connectionService.registerUsageProvider(() => chatService.usages());
