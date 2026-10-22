/**
 * Тексты бота-воркера Telegram (TASK-206, decision-161 п. 5, decision-164). Ответ на команду или нажатие пишется на
 * языке того, кто написал или нажал: `from.language_code` из обновления Telegram. Без кода — на языке интерфейса
 * хоста. Английский — базовый язык (правило 25), русский обязан покрывать те же ключи — это проверяет unit-тест.
 *
 * Чистый модуль без Electron и без зависимостей: воркер — отдельный процесс `.mjs`, словари TypeScript ему недоступны.
 */

/** Языки бота. Совпадают с языками интерфейса ProjectHub. */
export const BOT_LANGUAGES = ['en', 'ru'];

function asBotLanguage(value) {
  const base = String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return BOT_LANGUAGES.includes(base) ? base : null;
}

/**
 * Язык ответа: код языка пользователя Telegram (`ru`, `ru-RU` → русский, любой другой → английский), без кода — язык
 * хоста, без него — английский.
 */
export function pickBotLanguage(languageCode, hostLanguage) {
  if (typeof languageCode === 'string' && languageCode.trim()) return asBotLanguage(languageCode) === 'ru' ? 'ru' : 'en';
  return asBotLanguage(hostLanguage) ?? 'en';
}

/** Экранирование для `parse_mode: Markdown` (устаревший Markdown Bot API): имя с `_` или `*` иначе ломает разметку. */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([_*`[])/g, '\\$1');
}

function pluralRu(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const en = {
  lang: 'en',
  accessDenied: '⛔ Access denied. Your ID or username is not in the list of allowed ProjectHub users.',
  accessDeniedShort: 'Access denied',
  start: {
    greeting: (name) =>
      `👋 Hi, ${name}!\n\nWelcome to the *ProjectHub* control panel.\nTap the button below to open the Mini App right in Telegram.`,
    anonymous: 'there',
    openMiniApp: '🚀 Open ProjectHub Mini App',
    hostStatus: '📊 Host status',
    queue: '🚨 Decision queue'
  },
  queue: {
    empty: '✅ No requests awaiting decision.',
    command: (command) => `Command: \`${command}\``,
    file: (file) => `File: \`${file}\``,
    agent: 'Agent',
    allow: '✅ Allow',
    deny: '⛔ Deny',
    failed: '⚠️ Could not get the decision queue. Make sure ProjectHub is running and the host token is set.'
  },
  status: {
    federationTitle: '🖥 *ProjectHub Federation — Single Hub*',
    online: (online, total) => `Online: *${online}* of ${total} ${total === 1 ? 'computer' : 'computers'}`,
    hostOnline: '🟢 Online',
    hostOffline: '⚪ Offline',
    counts: (projects, processes) => `Projects: ${projects} • Processes: ${processes}`,
    tunnel: 'Tunnel',
    hostTitle: '🖥 *ProjectHub Host Status*',
    host: 'Host',
    status: 'Status',
    ok: '🟢 Online',
    error: '🔴 Error',
    mode: 'Mode',
    port: 'Port',
    local: 'local',
    refreshed: 'Status refreshed',
    failed: '⚠️ Could not get the ProjectHub host status. Make sure the app is running.',
    hostUnavailable: 'Host unavailable'
  },
  decision: {
    allowed: 'Allowed',
    denied: 'Denied',
    allowedSuffix: '✅ Allowed from Telegram',
    deniedSuffix: '⛔ Denied from Telegram',
    highRisk: 'High risk: this can only be approved in ProjectHub on the PC or in the app with biometrics. You can deny it here.',
    alreadyDecided: 'The request has already been decided',
    notFound: 'Request not found',
    closedElsewhere: '— the request was already closed in another channel',
    unavailable: 'ProjectHub is unavailable'
  },
  tasks: {
    confirmed: (n) => `Confirmed: ${n}`,
    alreadyConfirmed: 'The tasks are already confirmed',
    confirmedSuffix: (ids) => `✅ Confirmed from Telegram: ${ids}`,
    notPendingSuffix: (ids) => `— no longer awaiting confirmation: ${ids}`,
    stale: 'The button is out of date (ProjectHub was restarted). Confirm the tasks in the window or on the phone.',
    staleSuffix: '— the button is out of date, confirm the tasks in ProjectHub'
  }
};

const ru = {
  lang: 'ru',
  accessDenied: '⛔ Доступ запрещён. Вашего ID или логина нет в списке разрешённых пользователей ProjectHub.',
  accessDeniedShort: 'Доступ запрещён',
  start: {
    greeting: (name) =>
      `👋 Привет, ${name}!\n\nДобро пожаловать в панель управления *ProjectHub*.\nНажмите кнопку ниже, чтобы открыть Mini App прямо в Telegram.`,
    anonymous: 'пользователь',
    openMiniApp: '🚀 Открыть ProjectHub Mini App',
    hostStatus: '📊 Статус хоста',
    queue: '🚨 Очередь решений'
  },
  queue: {
    empty: '✅ Запросов, ожидающих решения, нет.',
    command: (command) => `Команда: \`${command}\``,
    file: (file) => `Файл: \`${file}\``,
    agent: 'Агент',
    allow: '✅ Разрешить',
    deny: '⛔ Отклонить',
    failed: '⚠️ Не удалось получить очередь решений. Убедитесь, что ProjectHub запущен и задан токен хоста.'
  },
  status: {
    federationTitle: '🖥 *ProjectHub Federation — Единый Hub*',
    online: (online, total) => `В сети: *${online}* из ${total} ${pluralRu(total, 'компьютера', 'компьютеров', 'компьютеров')}`,
    hostOnline: '🟢 Онлайн',
    hostOffline: '⚪ Офлайн',
    counts: (projects, processes) => `Проектов: ${projects} • Процессов: ${processes}`,
    tunnel: 'Туннель',
    hostTitle: '🖥 *Статус хоста ProjectHub*',
    host: 'Хост',
    status: 'Статус',
    ok: '🟢 Онлайн',
    error: '🔴 Ошибка',
    mode: 'Режим',
    port: 'Порт',
    local: 'локальный',
    refreshed: 'Статус обновлён',
    failed: '⚠️ Не удалось получить статус хоста ProjectHub. Убедитесь, что приложение запущено.',
    hostUnavailable: 'Хост недоступен'
  },
  decision: {
    allowed: 'Разрешено',
    denied: 'Отклонено',
    allowedSuffix: '✅ Разрешено из Telegram',
    deniedSuffix: '⛔ Отклонено из Telegram',
    highRisk: 'Высокий риск: одобрить можно только в ProjectHub на ПК или в приложении с биометрией. Отклонить можно здесь.',
    alreadyDecided: 'Запрос уже решён',
    notFound: 'Запрос не найден',
    closedElsewhere: '— запрос уже закрыт другим каналом',
    unavailable: 'ProjectHub недоступен'
  },
  tasks: {
    confirmed: (n) => `Подтверждено: ${n}`,
    alreadyConfirmed: 'Задачи уже подтверждены',
    confirmedSuffix: (ids) => `✅ Подтверждено из Telegram: ${ids}`,
    notPendingSuffix: (ids) => `— уже не ждали подтверждения: ${ids}`,
    stale: 'Кнопка устарела (ProjectHub перезапускался). Подтвердите задачи в окне или с телефона.',
    staleSuffix: '— кнопка устарела, подтвердите задачи в ProjectHub'
  }
};

const TEXTS = { en, ru };

export function botText(lang) {
  return TEXTS[lang] ?? en;
}
