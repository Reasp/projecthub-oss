#!/usr/bin/env node
/**
 * ProjectHub Telegram Bot & Mini App Server
 *
 * Автономный бот на чистом Node.js (без внешних зависимостей, нативный fetch). Две задачи:
 * запуск Telegram Mini App и применение решений HITL, принятых нажатием inline-кнопки в push-е
 * (TASK-63, decision-13 п.5). Сам push отправляет main-процесс — бот его не дублирует.
 *
 * Живёт в `electron/workers/`, а не в `scripts/`: только оттуда файл попадает в упакованное
 * приложение (`dist-electron/workers`, см. `scripts/pack-win.mjs`) и может быть запущен
 * `telegramService` через `processManager`. `npm run telegram-bot` запускает этот же файл
 * через тонкую обёртку `scripts/telegram-bot.mjs`.
 *
 * Конфигурация приходит окружением. При `PROJECTHUB_BOT_ENV_ONLY=1` (так бот стартует из
 * приложения) файл `.projecthub-telegram.json` не читается вовсе — секреты живут в safeStorage,
 * а не в рабочем каталоге.
 *
 * Ответ на команду или нажатие — на языке того, кто написал или нажал (`from.language_code`), без кода — на языке
 * интерфейса хоста (TASK-206, decision-161 п. 5, decision-164). Тексты — `telegramBotText.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isTelegramUserAllowed } from './telegramAccess.mjs';
import { botText, escapeMarkdown, pickBotLanguage } from './telegramBotText.mjs';

const CONFIG_FILE = path.join(process.cwd(), '.projecthub-telegram.json');

function loadConfig() {
  const fileCfg = {};
  if (process.env.PROJECTHUB_BOT_ENV_ONLY !== '1' && fs.existsSync(CONFIG_FILE)) {
    try {
      Object.assign(fileCfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
      console.warn('[TelegramBot] Ошибка чтения .projecthub-telegram.json:', e.message);
    }
  }

  // Переменные окружения приоритетнее файла: приложение передаёт актуальные значения при старте.
  const pick = (envName, fileKey, fallback = '') =>
    process.env[envName] || fileCfg[fileKey] || fallback;

  return {
    botToken: pick('TELEGRAM_BOT_TOKEN', 'botToken'),
    allowedUsers: pick('TELEGRAM_ALLOWED_USERS', 'allowedUsers'),
    chatId: pick('TELEGRAM_CHAT_ID', 'chatId'),
    miniAppUrl: pick('PROJECTHUB_MINIAPP_URL', 'miniAppUrl'),
    hubPort: Number(pick('PROJECTHUB_PORT', 'hubPort', 42050)),
    hubHost: pick('PROJECTHUB_HOST', 'hubHost', '127.0.0.1'),
    // Мастер-ключ Remote Control этого хоста (тот же `secretToken` из бейджа Remote Control) —
    // требуется для /api/federation/* и /api/hitl/* (decision-5 п.5: аутентификация на каждом
    // сетевом эндпоинте). Без него доступен только урезанный публичный /api/status.
    hostToken: pick('PROJECTHUB_HOST_TOKEN', 'hostToken'),
    // Язык интерфейса хоста на момент запуска и файл, где main хранит его выбор (decision-164): смена языка в окне
    // доходит до бота без перезапуска.
    hostLanguage: pick('PROJECTHUB_HOST_LANGUAGE', 'hostLanguage', 'en'),
    hostLanguageFile: process.env.PROJECTHUB_HOST_LANGUAGE_FILE || ''
  };
}

const config = loadConfig();

/** Язык интерфейса хоста: сохранённый выбор окна, иначе язык на момент запуска бота. */
function hostLanguage() {
  if (config.hostLanguageFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(config.hostLanguageFile, 'utf8')).language;
      if (stored === 'en' || stored === 'ru') return stored;
    } catch {
      // Файла нет, пока язык в окне не меняли.
    }
  }
  return config.hostLanguage;
}

/** Тексты на языке того, кто написал или нажал (decision-161 п. 5). */
function textFor(from) {
  return botText(pickBotLanguage(from?.language_code, hostLanguage()));
}

if (!config.botToken) {
  console.log(`
[TelegramBot] ⚠️ Токен бота не указан.
Укажите TELEGRAM_BOT_TOKEN в переменных окружения или в файле .projecthub-telegram.json:
{
  "botToken": "123456789:ABC...",
  "allowedUsers": "username1,12345678",
  "miniAppUrl": "https://your-public-url.com/telegram",
  "hostToken": "<secretToken из бейджа Remote Control ProjectHub>"
}
`);
}

let isRunning = false;
let lastUpdateId = 0;

async function tgApi(method, body = {}) {
  const token = config.botToken;
  if (!token) return null;
  // TELEGRAM_API_BASE — только для теста процесса с поддельным Bot API (TASK-138.4).
  const url = `${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error in ${method}`);
  }
  return data.result;
}

/** GET на локальный хаб ProjectHub с Bearer-токеном, если он настроен (TASK-65, decision-5 п.5). */
function fetchHub(pathname, init) {
  const headers = { ...(init?.headers || {}) };
  if (config.hostToken) headers.Authorization = `Bearer ${config.hostToken}`;
  return fetch(`http://${config.hubHost}:${config.hubPort}${pathname}`, { ...init, headers });
}

/** Без списка разрешённых — только владелец, чей личный чат в настройках (TASK-138.4): см. telegramAccess.mjs. */
function isUserAllowed(from) {
  return isTelegramUserAllowed(from, config);
}

async function sendHitlQueue(chatId, tx) {
  try {
    // Заголовки запросов — на языке читателя: хаб собирает их по коду запроса (decision-161).
    const res = await fetchHub(`/api/hitl/pending?lang=${tx.lang}`);
    if (!res.ok) throw new Error(`hitl/pending HTTP ${res.status}`);
    const { pending } = await res.json();
    if (!pending?.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: tx.queue.empty });
      return;
    }
    for (const request of pending.slice(0, 10)) {
      const what = request.command
        ? tx.queue.command(request.command.slice(0, 160))
        : request.filePath
          ? tx.queue.file(request.filePath.slice(0, 160))
          : (request.details || '').slice(0, 160);
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🚨 *${request.title}*\n${request.agentName || tx.queue.agent}${request.role ? ` (${request.role})` : ''}\n${what}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: tx.queue.allow, callback_data: `hitl:allow:${request.id}` },
              { text: tx.queue.deny, callback_data: `hitl:deny:${request.id}` }
            ]
          ]
        }
      });
    }
  } catch {
    await tgApi('sendMessage', { chat_id: chatId, text: tx.queue.failed }).catch(() => {});
  }
}

/** Краткий статус этого хоста: запасной ответ `/status`, когда федерация недоступна. */
function formatHostStatus(status, tx) {
  const st = tx.status;
  return `${st.hostTitle}\n\n- ${st.host}: \`${status.machineName || status.hostId}\`\n- ${st.status}: ${status.status === 'ok' ? st.ok : st.error}\n- ${st.mode}: \`${status.mode}\`\n- ${st.tunnel}: \`${status.tunnelUrl || st.local}\``;
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  const from = msg.from || {};
  const tx = textFor(from);

  if (!chatId) return;

  if (!isUserAllowed(from)) {
    await tgApi('sendMessage', { chat_id: chatId, text: tx.accessDenied }).catch(() => {});
    return;
  }

  if (text.startsWith('/start')) {
    const webAppUrl = config.miniAppUrl || `http://${config.hubHost}:${config.hubPort}/telegram`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: tx.start.greeting(from.first_name ? escapeMarkdown(from.first_name) : tx.start.anonymous),
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tx.start.openMiniApp,
              web_app: { url: webAppUrl }
            }
          ],
          [
            { text: tx.start.hostStatus, callback_data: 'status' },
            { text: tx.start.queue, callback_data: 'hitl:list' }
          ]
        ]
      }
    });
    return;
  }

  if (text.startsWith('/hitl') || text.startsWith('/approve')) {
    await sendHitlQueue(chatId, tx);
    return;
  }

  if (text.startsWith('/status') || text.startsWith('/help')) {
    const st = tx.status;
    try {
      const res = await fetchHub('/api/federation/hosts');
      if (!res.ok) throw new Error(`federation/hosts HTTP ${res.status}`);
      const fed = await res.json();
      const hosts = fed.hosts || [];
      const onlineHosts = hosts.filter((h) => h.isOnline);

      let statusMsg = `${st.federationTitle}\n\n`;
      statusMsg += `${st.online(onlineHosts.length, hosts.length)}\n\n`;

      for (const h of hosts) {
        const icon = h.platform === 'darwin' ? '🍏' : h.platform === 'linux' ? '🐧' : '💻';
        statusMsg += `${icon} *${escapeMarkdown(h.machineName)}* (${h.isOnline ? st.hostOnline : st.hostOffline})\n`;
        statusMsg += `   • ${st.counts(h.projectsCount || 0, h.activeProcessesCount || 0)}\n`;
        if (h.tunnelUrl) {
          statusMsg += `   • ${st.tunnel}: \`${h.tunnelUrl}\`\n`;
        }
      }

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: statusMsg,
        parse_mode: 'Markdown'
      });
    } catch {
      try {
        const res = await fetchHub('/api/status');
        const status = await res.json();
        await tgApi('sendMessage', { chat_id: chatId, text: formatHostStatus(status, tx), parse_mode: 'Markdown' });
      } catch {
        await tgApi('sendMessage', { chat_id: chatId, text: st.failed });
      }
    }
  }
}

/**
 * Решение HITL по нажатию inline-кнопки. Применяется строго по `requestId` через тот же
 * `hitlService.decide`, что и окно приложения: первый ответ выигрывает, повтор получает 409
 * и «уже решено» (decision-10 п.5).
 */
async function applyHitlDecision(query, decision, requestId, tx) {
  const approved = decision === 'allow';
  const dx = tx.decision;
  try {
    const res = await fetchHub('/api/hitl/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, approved, deviceName: `Telegram (${query.from?.username || query.from?.id || '?'})` })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: approved ? dx.allowed : dx.denied
      });
      await editDecidedMessage(query, approved ? dx.allowedSuffix : dx.deniedSuffix);
    } else if (res.status === 409 && data.reason === 'confirmation_required') {
      // Высокий риск (decision-112): запрос по-прежнему ждёт — сообщение не закрываем, его можно отклонить здесь.
      await tgApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: dx.highRisk,
        show_alert: true
      });
    } else if (res.status === 409) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: data.reason === 'already_decided' ? dx.alreadyDecided : dx.notFound,
        show_alert: true
      });
      await editDecidedMessage(query, dx.closedElsewhere);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    await tgApi('answerCallbackQuery', {
      callback_query_id: query.id,
      text: dx.unavailable,
      show_alert: true
    }).catch(() => {});
    console.warn('[TelegramBot] Не удалось применить решение HITL:', e.message);
  }
}

/**
 * Подтверждение задач агента кнопкой из уведомления `agentTask` (TASK-155, decision-89 п. 11). Билет
 * подтверждает ровно задачи этой пачки; уже подтверждённые в окне или с телефона считаются отдельно.
 */
async function applyAgentTaskApproval(query, ticket, tx) {
  const kx = tx.tasks;
  try {
    const res = await fetchHub('/api/agent-tasks/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, deviceName: `Telegram (${query.from?.username || query.from?.id || '?'})` })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const approved = Array.isArray(data.approved) ? data.approved : [];
      const notPending = Array.isArray(data.notPending) ? data.notPending : [];
      const text = approved.length > 0 ? kx.confirmed(approved.length) : kx.alreadyConfirmed;
      await tgApi('answerCallbackQuery', { callback_query_id: query.id, text });
      const parts = [];
      if (approved.length > 0) parts.push(kx.confirmedSuffix(approved.join(', ')));
      if (notPending.length > 0) parts.push(kx.notPendingSuffix(notPending.join(', ')));
      await editDecidedMessage(query, parts.join('\n'));
    } else if (res.status === 409) {
      await tgApi('answerCallbackQuery', {
        callback_query_id: query.id,
        text: kx.stale,
        show_alert: true
      });
      await editDecidedMessage(query, kx.staleSuffix);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    await tgApi('answerCallbackQuery', { callback_query_id: query.id, text: tx.decision.unavailable, show_alert: true }).catch(() => {});
    console.warn('[TelegramBot] Не удалось подтвердить задачи агента:', e.message);
  }
}

/** Снять кнопки с карточки решения, чтобы по ней нельзя было ответить дважды. */
async function editDecidedMessage(query, suffix) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;
  const original = query.message.text || '';
  await tgApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: `${original}\n\n${suffix}`,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const data = query.data || '';
  const tx = textFor(query.from);
  if (!chatId) return;

  if (!isUserAllowed(query.from || {})) {
    await tgApi('answerCallbackQuery', { callback_query_id: query.id, text: tx.accessDeniedShort, show_alert: true }).catch(() => {});
    return;
  }

  if (data === 'hitl:list') {
    await tgApi('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    await sendHitlQueue(chatId, tx);
    return;
  }

  const hitlMatch = data.match(/^hitl:(allow|deny):(.+)$/);
  if (hitlMatch) {
    await applyHitlDecision(query, hitlMatch[1], hitlMatch[2], tx);
    return;
  }

  const agentTaskMatch = data.match(/^atask:([A-Za-z0-9_-]{8,32})$/);
  if (agentTaskMatch) {
    await applyAgentTaskApproval(query, agentTaskMatch[1], tx);
    return;
  }

  if (data === 'status') {
    const st = tx.status;
    try {
      const res = await fetchHub('/api/status');
      const status = await res.json();
      await tgApi('answerCallbackQuery', { callback_query_id: query.id, text: st.refreshed });
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `${st.hostTitle}\n\n- ${st.status}: ${status.status === 'ok' ? st.ok : st.error}\n- ${st.mode}: \`${status.mode}\`\n- ${st.port}: \`${status.port}\``,
        parse_mode: 'Markdown'
      });
    } catch {
      await tgApi('answerCallbackQuery', { callback_query_id: query.id, text: st.hostUnavailable, show_alert: true });
    }
  }
}

async function pollUpdates() {
  while (isRunning) {
    try {
      const updates = await tgApi('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 25
      });

      if (Array.isArray(updates)) {
        for (const update of updates) {
          lastUpdateId = update.update_id;
          if (update.message) {
            await handleMessage(update.message);
          } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
        }
      }
    } catch {
      if (isRunning) {
        // Задержка перед повторной попыткой при ошибке сети
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
}

async function main() {
  if (!config.botToken) {
    process.exit(0);
  }

  isRunning = true;
  try {
    const me = await tgApi('getMe');
    console.log(`[TelegramBot] ✅ Бот @${me.username} успешно запущен! Ожидание сообщений...`);
    await pollUpdates();
  } catch (err) {
    console.error('[TelegramBot] ❌ Ошибка запуска бота:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  isRunning = false;
  process.exit(0);
});

process.on('SIGTERM', () => {
  isRunning = false;
  process.exit(0);
});

main();
