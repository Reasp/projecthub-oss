/** Раздел словаря «store» (TASK-140.15): тосты стора, пул хостов и ошибки соединения клиента. */
export const en = {
  // ── стор: HITL ──
  biometricNotSetUp: 'Biometrics aren’t set up for this computer: approve on the PC',
  biometricTitle: 'Approve agent action',
  approved: 'Approved',
  rejected: 'Rejected',
  // ── стор: задачи агентов, задачи, процессы, агенты ──
  // число подтверждённых задач и «уже подтверждены» — в разделе inbox
  agentTaskApproved: (id: string) => `${id} confirmed`,
  taskCreated: 'Task created',
  actionStarted: 'Started',
  stopped: 'Stopped',
  agentStarted: 'Agent started',
  // ── стор: Agents Studio ──
  newChat: 'New chat',
  sessionCleared: 'Session cleared',
  voiceNotRecognized: 'Couldn’t catch that — please try again',
  voiceFailed: (error: string) => `Voice not recognized: ${error}`,
  attachmentFailed: (name: string, error: string) => `Couldn’t upload “${name}”: ${error}`,
  answerStopped: 'Response stopped',
  agentError: 'Agent error',
  // ── стор: push ──
  allowNotifications: 'Allow notifications for ProjectHub in your phone settings',
  pushEnabled: (label: string) => `Notifications from “${label}” are on`,
  pushTestSent: 'Test notification sent',
  // ── пул хостов ──
  hostOffline: 'No connection to this computer',
  // ── клиент: путь связи ──
  route: { lan: 'local network', vpn: 'VPN', tunnel: 'tunnel', relay: 'relay' },
  // ── клиент: ошибки соединения ──
  v2Required: 'This computer only accepts the secure v2 protocol. Pair your phone with it again using the QR code.',
  connectTimeout:
    'The computer isn’t responding on the local network. Check that Remote Control is on in ProjectHub and the phone is on the same Wi-Fi. '
    + 'Away from home you need an internet address: turn on a tunnel (Remote → “Start tunnel”) or a relay on the PC — the phone gets the address '
    + 'automatically once it connects to the PC (for example, at home over Wi-Fi), or scan the QR code again.',
  noSecureEndpoint:
    'This HTTPS page has no address to connect to: the browser won’t open local network addresses here. '
    + 'Turn on a tunnel in ProjectHub and open its link, or use the app.',
  unreachable: (failures: string) => `The computer isn’t reachable at any address: ${failures}.`,
  unreachableCheck: 'Check that ProjectHub is running and Remote Control is on.',
  unreachableTunnel: 'A quick tunnel address changes when ProjectHub restarts: the phone gets the new one once it connects to the PC another way.',
  unreachableVpn: 'For a VPN address, the same VPN (Tailscale) must be on on the phone.',
  wrongKey: 'The key doesn’t match this computer. Scan the QR code again.',
  staleKey: 'The encryption key is outdated: the host responds without encryption. Pair the device again.',
  hostKey:
    'The computer didn’t verify its key — the connection may have been tampered with on the way (untrusted network, relay). Connection stopped. '
    + 'If ProjectHub was reinstalled on the PC, scan its QR code again.',
  v2Unsupported: 'This computer only accepts the v2 protocol, and this browser doesn’t support X25519. Update the browser or use the app.',
  hostTooOld: 'ProjectHub on the computer doesn’t support the v2 protocol — update it. For now you can scan this PC’s QR code again.',
  handshakeFailed: (error: string) => `v2 handshake failed: ${error}`,
  profileIncomplete: (problems: string) => `Incomplete profile: ${problems}`,
  notConnected: 'Not connected to ProjectHub',
  rpcTimeout: (method: string) => `The host didn’t respond to ${method}`,
  noEncryptionKey: 'No encryption key',
  connectionLost: 'Connection lost',
  connectionClosed: 'Connection closed',
  deviceRevoked: 'This device was disconnected on the PC. Pair it again.',
  // причины отказа адреса в перечне «адрес — причина»
  notResponding: 'not responding',
  unavailable: 'unavailable',
  hostLeftRelay: 'the PC disconnected from the relay',
  hostNotOnRelay: 'the PC isn’t connected to the relay',
  hostError: 'Host error'
};

export const ru: typeof en = {
  biometricNotSetUp: 'Биометрия для этого компьютера не настроена: одобрите на ПК',
  biometricTitle: 'Одобрить действие агента',
  approved: 'Одобрено',
  rejected: 'Отклонено',
  agentTaskApproved: (id) => `Подтверждена ${id}`,
  taskCreated: 'Задача создана',
  actionStarted: 'Запущено',
  stopped: 'Остановлено',
  agentStarted: 'Агент запущен',
  newChat: 'Новый диалог',
  sessionCleared: 'Сессия очищена',
  voiceNotRecognized: 'Речь не распознана — скажите ещё раз',
  voiceFailed: (error) => `Голос не распознан: ${error}`,
  attachmentFailed: (name, error) => `Вложение «${name}» не загружено: ${error}`,
  answerStopped: 'Ответ остановлен',
  agentError: 'Ошибка агента',
  allowNotifications: 'Разрешите уведомления для ProjectHub в настройках телефона',
  pushEnabled: (label) => `Уведомления с «${label}» включены`,
  pushTestSent: 'Проверочное уведомление отправлено',
  hostOffline: 'Нет связи с этим компьютером',
  route: { lan: 'локальная сеть', vpn: 'VPN', tunnel: 'туннель', relay: 'релей' },
  v2Required: 'Этот компьютер принимает только защищённый протокол v2. Сопрягите телефон с ним заново по QR-коду.',
  connectTimeout:
    'Компьютер не отвечает в локальной сети. Проверьте, что в ProjectHub включён Remote Control и телефон в той же сети Wi-Fi. '
    + 'Вне дома нужен адрес через интернет: включите на ПК туннель (Remote → «Запустить туннель») или релей — телефон получит адрес сам, '
    + 'как только подключится к ПК (например, дома по Wi-Fi), или отсканируйте QR заново.',
  noSecureEndpoint:
    'На этой HTTPS-странице нет адреса, по которому можно подключиться: адреса локальной сети браузер здесь не откроет. '
    + 'Включите в ProjectHub туннель и откройте его ссылку или используйте приложение.',
  unreachable: (failures) => `Компьютер недоступен ни по одному адресу: ${failures}.`,
  unreachableCheck: 'Проверьте, что ProjectHub запущен и Remote Control включён.',
  unreachableTunnel: 'Адрес быстрого туннеля меняется при перезапуске ProjectHub: новый телефон получит, когда подключится к ПК другим путём.',
  unreachableVpn: 'Для адреса VPN на телефоне должен быть включён тот же VPN (Tailscale).',
  wrongKey: 'Ключ не подходит к этому компьютеру. Отсканируйте QR-код заново.',
  staleKey: 'Ключ шифрования устарел: хост отвечает без шифрования. Сопрягите устройство заново.',
  hostKey:
    'Компьютер не подтвердил свой ключ — возможна подмена по дороге (чужая сеть, релей). Подключение остановлено. '
    + 'Если ProjectHub на ПК переустанавливали, отсканируйте его QR-код заново.',
  v2Unsupported: 'К этому компьютеру можно подключиться только по протоколу v2, а этот браузер не умеет X25519. Обновите браузер или используйте приложение.',
  hostTooOld: 'ProjectHub на компьютере не знает протокол v2 — обновите его. Пока можно отсканировать QR этого ПК заново.',
  handshakeFailed: (error) => `Рукопожатие v2 не удалось: ${error}`,
  profileIncomplete: (problems) => `Профиль неполный: ${problems}`,
  notConnected: 'Нет подключения к ProjectHub',
  rpcTimeout: (method) => `Хост не ответил на ${method}`,
  noEncryptionKey: 'Нет ключа шифрования',
  connectionLost: 'Соединение разорвано',
  connectionClosed: 'Соединение закрыто',
  deviceRevoked: 'Устройство отключено на ПК. Сопрягите его заново.',
  notResponding: 'не отвечает',
  unavailable: 'недоступен',
  hostLeftRelay: 'ПК отключился от релея',
  hostNotOnRelay: 'ПК не подключён к релею',
  hostError: 'Ошибка хоста'
};
