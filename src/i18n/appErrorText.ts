/**
 * Тексты ошибок main-процесса для человека по коду (TASK-202, [[decision-165]]). Один словарь на три клиента: окно
 * ProjectHub (`appErrors`), мобильный клиент (`models.appErrors`) и main — английский запасной `message` у `AppError`.
 *
 * Код — `<область>.<причина>`, шаблон — с подстановкой `{param}`. Английский — базовый язык (правило 25), русский
 * типизирован английским и обязан покрывать те же коды с теми же подстановками — это проверяет unit-тест.
 *
 * Чистый модуль без React и Electron.
 */

const EN = {
  // Аккаунты CLI (TASK-152, decision-87, decision-163).
  'accounts.dirNotFound': 'Directory not found: {path}',
  'accounts.dirNotAbsolute': 'Specify an absolute path to the CLI configuration directory.',
  'accounts.dirAlreadyConnected': 'This directory is already connected as profile “{name}”.',
  'accounts.profileNotFound': 'Account profile not found.',
  'accounts.listEmpty': 'The account list is empty: there is not even a default profile.',
  'accounts.noFreeId': 'Could not pick a free account profile id.',
  'accounts.invalidId': 'Invalid profile id: {id}',
  'accounts.nameEmpty': 'Profile name is not set.',
  'accounts.nameTaken': 'A profile named “{name}” already exists.',
  'accounts.defaultNotRemovable': 'The default profile cannot be removed.',
  'accounts.roleEmpty': 'Role is not set.',
  'accounts.statusTimeout': '{cli}: sign-in status was not received in time.',
  'accounts.statusExitCode': '{command}: exit code {code}',
  'accounts.cliStartFailed': 'Could not start {cli}: {detail}',
  'accounts.geminiLogoutUnsupported': 'Gemini CLI cannot sign out from the command line: sign out with /auth in the profile terminal.',
  'accounts.processEnvClaudeOnly': 'Only a Claude Code directory can be connected from the process variable.',
  'accounts.processEnvMissing': 'ProjectHub was started without the CLAUDE_CONFIG_DIR variable.',
  // Подключения к сервисам (decision-102).
  'connections.notFound': 'Connection {id} not found',
  'connections.unknownService': 'Unknown service: {service}',
  'connections.methodUnsupported': '{service} does not support this sign-in method',
  'connections.invalidMethod': 'Invalid sign-in method',
  'connections.urlRequired': 'Enter the service address',
  'connections.urlInvalid': 'Invalid service address',
  'connections.httpLocalOnly': 'http addresses are allowed only on the local network; use https://',
  'connections.httpOnly': 'Only http(s) addresses are allowed',
  'connections.cloudOnly': '{service} works only in the cloud',
  'connections.tokenRequired': 'Enter the token',
  'connections.usernameRequired': 'Enter the user name',
  'connections.webhookRequired': '{service}: paste the https://… webhook address from Workflows',
  'connections.webhookInvalid': '{service}: the webhook address failed validation — reconnect',
  'connections.webhookPathNotAllowed': 'A webhook has a single address: the request path is not specified',
  'connections.tokenRejected': 'The service rejected the token: check the value and its permissions',
  'connections.issuedTokenRejected': 'The service issued a token but rejected it during verification',
  'connections.oauthUnsupported': '{service} does not support OAuth',
  'connections.deviceCodeUnsupported': 'The service does not support sign-in with a device code',
  'connections.clientIdRequired': 'Enter the client_id of the OAuth app',
  'connections.clientSecretRequired': '{service} requires the client_secret of your own app',
  'connections.nameEmpty': 'The name cannot be empty',
  'connections.authExpired': 'Access has expired, sign in again',
  'connections.authRevoked': 'The service revoked access, sign in again',
  'connections.authRejected': 'The service rejected the token, sign in again',
  'connections.tokenMissing': 'Connection token not found, sign in again',
  'connections.needsReauth': 'The connection needs a new sign-in',
  'connections.tokenRefreshFailed': 'Could not refresh the token: {detail}',
  'connections.apiOriginOnly': 'A connection request is allowed only to the API of its service',
  'connections.socketUnavailable': 'WebSocket is unavailable',
  'connections.socketOriginOnly': 'A connection socket is allowed only to the addresses of its service',
  // Профили LLM-провайдеров (TASK-70).
  'llm.baseUrlInvalid': 'Invalid server address: “{url}”. An http(s) address like https://api.example.com/v1 is required.',
  'llm.baseUrlScheme': 'Invalid server address: “{url}”. Only http and https are supported.',
  'llm.profileIdInvalid': 'Invalid profile id.',
  'llm.apiKeyMissing': 'No API key in profile “{name}”.',
  'llm.endpointNotChatCompletions':
    'The custom provider address “{url}” does not end with /chat/completions: the profile would add this path itself and requests would go to a different address. Create the profile manually.',
  'llm.providerNotMigratable': 'Provider “{provider}” cannot be moved to an OpenAI-compatible provider profile.',
  'llm.modelListFailed': 'Could not get the model list of profile “{name}” ({url})'
} as const;

export type AppErrorCode = keyof typeof EN;
export type AppErrorLabels = Record<AppErrorCode, string>;

/** Значения — строки, а не литералы: словари клиентов типизируются английским (`Dict` телефона, `TranslationDictionary`). */
export const appErrorTextEn: AppErrorLabels = EN;

export const appErrorTextRu: AppErrorLabels = {
  'accounts.dirNotFound': 'Каталог не найден: {path}',
  'accounts.dirNotAbsolute': 'Укажите абсолютный путь к каталогу конфигурации CLI.',
  'accounts.dirAlreadyConnected': 'Этот каталог уже подключён как профиль «{name}».',
  'accounts.profileNotFound': 'Профиль аккаунта не найден.',
  'accounts.listEmpty': 'Список аккаунтов пуст: нет даже профиля по умолчанию.',
  'accounts.noFreeId': 'Не удалось подобрать свободный id профиля аккаунта.',
  'accounts.invalidId': 'Некорректный id профиля: {id}',
  'accounts.nameEmpty': 'Имя профиля не задано.',
  'accounts.nameTaken': 'Профиль с именем «{name}» уже есть.',
  'accounts.defaultNotRemovable': 'Профиль по умолчанию удалить нельзя.',
  'accounts.roleEmpty': 'Роль не задана.',
  'accounts.statusTimeout': '{cli}: статус входа не получен вовремя.',
  'accounts.statusExitCode': '{command}: код выхода {code}',
  'accounts.cliStartFailed': 'Не удалось запустить {cli}: {detail}',
  'accounts.geminiLogoutUnsupported': 'Gemini CLI не умеет выходить из командной строки: выйдите командой /auth в терминале профиля.',
  'accounts.processEnvClaudeOnly': 'Из переменной процесса подключается только каталог Claude Code.',
  'accounts.processEnvMissing': 'ProjectHub запущен без переменной CLAUDE_CONFIG_DIR.',
  'connections.notFound': 'Подключение {id} не найдено',
  'connections.unknownService': 'Неизвестный сервис: {service}',
  'connections.methodUnsupported': '{service} не поддерживает этот способ входа',
  'connections.invalidMethod': 'Неверный способ входа',
  'connections.urlRequired': 'Укажите адрес сервиса',
  'connections.urlInvalid': 'Неверный адрес сервиса',
  'connections.httpLocalOnly': 'Адрес по http разрешён только для локальной сети; укажите https://',
  'connections.httpOnly': 'Разрешены только адреса http(s)',
  'connections.cloudOnly': '{service} работает только в облаке',
  'connections.tokenRequired': 'Укажите токен',
  'connections.usernameRequired': 'Укажите имя пользователя',
  'connections.webhookRequired': '{service}: вставьте адрес вебхука https://… из Workflows',
  'connections.webhookInvalid': '{service}: адрес вебхука не прошёл проверку — переподключите',
  'connections.webhookPathNotAllowed': 'У вебхука один адрес: путь запроса не указывается',
  'connections.tokenRejected': 'Сервис отклонил токен: проверьте значение и права',
  'connections.issuedTokenRejected': 'Сервис выдал токен, но отклонил его при проверке',
  'connections.oauthUnsupported': '{service} не поддерживает OAuth',
  'connections.deviceCodeUnsupported': 'Сервис не поддерживает вход по коду устройства',
  'connections.clientIdRequired': 'Укажите client_id OAuth-приложения',
  'connections.clientSecretRequired': '{service} требует client_secret своего приложения',
  'connections.nameEmpty': 'Название не может быть пустым',
  'connections.authExpired': 'Срок действия доступа истёк, нужно войти заново',
  'connections.authRevoked': 'Сервис отозвал доступ, нужно войти заново',
  'connections.authRejected': 'Сервис отклонил токен, нужно войти заново',
  'connections.tokenMissing': 'Токен подключения не найден, нужно войти заново',
  'connections.needsReauth': 'Подключение требует повторного входа',
  'connections.tokenRefreshFailed': 'Не удалось обновить токен: {detail}',
  'connections.apiOriginOnly': 'Запрос подключения разрешён только к API его сервиса',
  'connections.socketUnavailable': 'WebSocket недоступен',
  'connections.socketOriginOnly': 'Сокет подключения разрешён только к адресам его сервиса',
  'llm.baseUrlInvalid': 'Некорректный адрес сервера: «{url}». Нужен http(s)-адрес вида https://api.example.com/v1.',
  'llm.baseUrlScheme': 'Некорректный адрес сервера: «{url}». Поддерживаются только http и https.',
  'llm.profileIdInvalid': 'Некорректный идентификатор профиля.',
  'llm.apiKeyMissing': 'API ключ не указан в профиле «{name}».',
  'llm.endpointNotChatCompletions':
    'Адрес custom-провайдера «{url}» не оканчивается на /chat/completions: профиль добавил бы этот путь сам и запросы ушли бы по другому адресу. Создайте профиль вручную.',
  'llm.providerNotMigratable': 'Провайдер «{provider}» не переносится в профиль OpenAI-совместимого провайдера.',
  'llm.modelListFailed': 'Не удалось получить список моделей профиля «{name}» ({url})'
};
