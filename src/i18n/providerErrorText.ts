/**
 * Ошибки провайдеров моделей (TASK-70.6, decision-43): заголовок по виду и причине, совет, подписи подробностей. Один
 * словарь на трёх клиентов (TASK-202.6): окно ProjectHub (`providerErrors`), мобильный клиент (`models.providerErrors`)
 * и main — английский текст `ProviderError.message` для журнала, экспорта и старых клиентов.
 *
 * Чистый модуль без React и Electron.
 */

export interface ProviderErrorLabels {
  heading: string;
  kinds: {
    auth: string;
    quota: string;
    model_not_found: string;
    rate_limit: string;
    unavailable: string;
    bad_request: string;
    config: string;
    unknown: string;
  };
  reasons: {
    forbidden: string;
    tools: string;
    reasoning: string;
    context: string;
    unsupported: string;
    moderation: string;
    refused: string;
    dns: string;
    timeout: string;
    tls: string;
    network: string;
    overloaded: string;
    endpoint: string;
  };
  advice: {
    auth: string;
    authProfile: string;
    authForbidden: string;
    quota: string;
    modelNotFoundLocal: string;
    modelNotFound: string;
    rateLimit: string;
    rateLimitWait: string;
    refusedLocal: string;
    refused: string;
    dns: string;
    timeoutLocal: string;
    timeout: string;
    tls: string;
    unavailable: string;
    tools: string;
    reasoning: string;
    context: string;
    unsupported: string;
    moderation: string;
    badRequest: string;
    endpoint: string;
  };
  provider: string;
  model: string;
  endpoint: string;
  status: string;
  serverResponse: string;
  details: string;
  retry: string;
  retryable: string;
  notRetryable: string;
  agentFailed: string;
  reviewerFailed: string;
}

export const providerErrorTextEn: ProviderErrorLabels = {
  heading: 'Provider error',
  kinds: {
    auth: 'Access denied: key rejected',
    quota: 'Balance or quota exhausted',
    model_not_found: 'Model not found',
    rate_limit: 'Rate limit exceeded',
    unavailable: 'Server unavailable',
    bad_request: 'Request rejected by server',
    config: 'Configuration error',
    unknown: 'Request error'
  },
  reasons: {
    forbidden: 'Access forbidden',
    tools: 'Model does not support tool calling',
    reasoning: 'Model rejected the reasoning effort',
    context: 'Request does not fit the model context',
    unsupported: 'Model does not support this mode',
    moderation: 'Request rejected by moderation',
    refused: 'Server refuses connections',
    dns: 'Server address not found',
    timeout: 'Server did not respond in time',
    tls: 'TLS certificate error',
    network: 'Network connection dropped',
    overloaded: 'Service overloaded',
    endpoint: 'API address not found'
  },
  advice: {
    auth: 'Check the API key of provider {provider} in Agents Studio settings.',
    authProfile: 'Check the API key of profile {provider} in Agents Studio settings → “Provider profiles”.',
    authForbidden: 'The key has no access to this model or service: check key permissions and region with the provider.',
    quota: 'Top up the balance or check plan limits with the provider. Another model of the same provider will most likely not help.',
    modelNotFoundLocal: 'Pull the model (`ollama pull {model}`) or pick an installed one; refresh the profile model catalog.',
    modelNotFound: 'Refresh the profile model catalog and pick a model from the list; check the model id.',
    rateLimit: 'Wait and retry; if it keeps happening, run fewer parallel slots or choose another model.',
    rateLimitWait: 'Wait {seconds} s and retry; if it keeps happening, run fewer parallel slots or choose another model.',
    refusedLocal: 'Start the local server (Ollama, LM Studio…) and check the port in the profile address.',
    refused: 'Check the address and port in the profile: the server refuses connections.',
    dns: 'Check the profile address and your network connection.',
    timeoutLocal: 'Make sure the server is running; a large model may take a while to load into memory — retry.',
    timeout: 'Check your network connection and retry.',
    tls: 'Check the address scheme (http/https) and the server certificate.',
    unavailable: 'The service is temporarily unavailable — retry later or choose another model.',
    tools: 'For agent mode choose a model with tool calling or turn off the tools flag in the profile.',
    reasoning: 'Choose another effort level or “model default” in Agents Studio or slot settings, or change the effort format in the provider profile.',
    context: 'Start a new chat, reduce the task context or choose a model with a larger context window.',
    unsupported: 'Choose a chat model (for example, not an embedding model).',
    moderation: 'Rephrase the request or choose another model.',
    badRequest: 'Check the request parameters and the profile compatibility flags.',
    endpoint: 'Check the profile address: OpenAI-compatible servers usually end with /v1.'
  },
  provider: 'Provider',
  model: 'Model',
  endpoint: 'Address',
  status: 'Code',
  serverResponse: 'Server response',
  details: 'Details',
  retry: 'Retry',
  retryable: 'Retrying may help',
  notRetryable: 'Retrying without changing settings will not help',
  agentFailed: 'Agent stopped: {kind}',
  reviewerFailed: 'Reviewer: {kind}'
};

export const providerErrorTextRu: ProviderErrorLabels = {
  heading: 'Ошибка провайдера',
  kinds: {
    auth: 'Нет доступа: ключ не принят',
    quota: 'Исчерпан баланс или квота',
    model_not_found: 'Модель не найдена',
    rate_limit: 'Превышен лимит запросов',
    unavailable: 'Сервер недоступен',
    bad_request: 'Сервер отклонил запрос',
    config: 'Ошибка настройки',
    unknown: 'Ошибка запроса'
  },
  reasons: {
    forbidden: 'Доступ запрещён',
    tools: 'Модель не поддерживает вызов инструментов',
    reasoning: 'Модель не приняла усилие рассуждений',
    context: 'Запрос не помещается в контекст модели',
    unsupported: 'Модель не поддерживает этот режим',
    moderation: 'Запрос отклонён модерацией',
    refused: 'Сервер не принимает подключения',
    dns: 'Адрес сервера не найден',
    timeout: 'Сервер не ответил вовремя',
    tls: 'Ошибка TLS-сертификата',
    network: 'Обрыв сетевого соединения',
    overloaded: 'Сервис перегружен',
    endpoint: 'Адрес API не найден'
  },
  advice: {
    auth: 'Проверьте API-ключ провайдера {provider} в настройках Agents Studio.',
    authProfile: 'Проверьте API-ключ профиля {provider} в настройках Agents Studio → «Профили провайдеров».',
    authForbidden: 'У ключа нет доступа к этой модели или сервису: проверьте права ключа и регион у провайдера.',
    quota: 'Пополните баланс или проверьте лимиты тарифа у провайдера. Другая модель того же провайдера, скорее всего, не поможет.',
    modelNotFoundLocal: 'Загрузите модель (`ollama pull {model}`) или выберите установленную; обновите каталог моделей профиля.',
    modelNotFound: 'Обновите каталог моделей профиля и выберите модель из списка; проверьте id модели.',
    rateLimit: 'Подождите и повторите; при частых отказах уменьшите число параллельных слотов или выберите другую модель.',
    rateLimitWait: 'Подождите {seconds} с и повторите; при частых отказах уменьшите число параллельных слотов или выберите другую модель.',
    refusedLocal: 'Запустите локальный сервер (Ollama, LM Studio…) и проверьте порт в адресе профиля.',
    refused: 'Проверьте адрес и порт в профиле: сервер не принимает подключения.',
    dns: 'Проверьте адрес профиля и подключение к сети.',
    timeoutLocal: 'Проверьте, что сервер запущен; большая модель может долго загружаться в память — повторите запрос.',
    timeout: 'Проверьте подключение к сети и повторите запрос.',
    tls: 'Проверьте схему адреса (http/https) и сертификат сервера.',
    unavailable: 'Сервис временно недоступен — повторите позже или выберите другую модель.',
    tools: 'Для режима агента выберите модель с tool calling или выключите флаг tools в профиле.',
    reasoning: 'Выберите другой уровень усилия или «по умолчанию модели» в настройках Agents Studio или слота, либо поменяйте формат усилия в профиле провайдера.',
    context: 'Начните новый чат, сократите контекст задачи или выберите модель с большим окном контекста.',
    unsupported: 'Выберите модель для чата (например, не эмбеддинг-модель).',
    moderation: 'Переформулируйте запрос или выберите другую модель.',
    badRequest: 'Проверьте параметры запроса и флаги совместимости профиля.',
    endpoint: 'Проверьте адрес профиля: у OpenAI-совместимых серверов он обычно заканчивается на /v1.'
  },
  provider: 'Провайдер',
  model: 'Модель',
  endpoint: 'Адрес',
  status: 'Код',
  serverResponse: 'Ответ сервера',
  details: 'Подробнее',
  retry: 'Повторить',
  retryable: 'Повтор может помочь',
  notRetryable: 'Без изменения настроек повтор не поможет',
  agentFailed: 'Агент остановлен: {kind}',
  reviewerFailed: 'Ревьюер: {kind}'
};
