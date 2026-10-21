/** Раздел словаря «pairing» (TASK-140.15): экран сопряжения, сканер QR, базовые элементы `components/ui` и платформа. */
export const en = {
  /** Чего не хватает профилю — по кодам `profileProblems`. */
  problems: {
    no_key: 'An encryption key from the ProjectHub QR code is required.',
    bad_key: 'The key must be 64 hexadecimal characters.',
    no_relay: 'A relay needs a server address.',
    no_host_id: 'A relay needs a Host ID.',
    no_lan_address: 'Enter the computer’s local network address, e.g. 192.168.1.5:42050.'
  },
  introAdd: 'Another computer: open Remote Control in ProjectHub on it and scan the QR code. Computers you’ve already paired stay in the list.',
  intro: 'A remote for the agents on your computer. Open Remote Control in ProjectHub and scan the QR code.',
  backToPaired: '← Back to paired computers',
  noCryptoTitle: 'Encryption isn’t available on this page',
  noCryptoLead: 'The browser provides WebCrypto only over HTTPS. This page is open at ',
  noCryptoTail:
    ', so an encrypted connection isn’t possible, and the client won’t connect in plain text. Turn on the Remote Control HTTPS tunnel in ProjectHub and open the tunnel link, the Telegram Mini App or the mobile app.',
  notPairingLink: 'This doesn’t look like a ProjectHub pairing link.',
  scanQr: 'Scan QR code',
  pasteLink: 'Paste a pairing link',
  applyLink: 'Apply link',
  hideManual: 'Hide manual entry',
  showManual: 'Enter manually',
  modeLan: 'Local network',
  modeRelay: 'Via relay',
  lanAddressPlaceholder: 'Computer address: 192.168.1.5:42050',
  relayPlaceholder: 'Relay: wss://relay.example.com',
  hostIdPlaceholder: 'Host ID: ph_host_…',
  keyPlaceholder: 'Encryption key (64 hex)',
  connect: 'Connect',
  memoryStoreNote: 'The device key is kept only until the app closes: secure storage (Keychain/Keystore) isn’t connected yet.',
  /** Подсказка сканера QR: в приложении (камера WebView) и в Telegram. */
  scanHint: 'Point the camera at the QR code in ProjectHub',
  cameraDenied: 'No camera access. Allow the camera for ProjectHub in your phone settings or paste the pairing link.',
  /** Базовые элементы интерфейса (`components/ui`, `components/Markdown`). */
  ui: {
    code: 'code',
    copyCode: 'Copy code'
  }
};

export const ru: typeof en = {
  problems: {
    no_key: 'Нужен ключ шифрования из QR-кода ProjectHub.',
    bad_key: 'Ключ должен быть из 64 шестнадцатеричных символов.',
    no_relay: 'Для релея нужен адрес сервера.',
    no_host_id: 'Для релея нужен Host ID.',
    no_lan_address: 'Нужен адрес ПК в локальной сети, например 192.168.1.5:42050.'
  },
  introAdd: 'Ещё один компьютер: откройте Remote Control в ProjectHub на нём и отсканируйте QR-код. Уже сопряжённые компьютеры останутся в списке.',
  intro: 'Пульт агентов на вашем компьютере. Откройте Remote Control в ProjectHub и отсканируйте QR-код.',
  backToPaired: '← К сопряжённым компьютерам',
  noCryptoTitle: 'Шифрование недоступно на этой странице',
  noCryptoLead: 'Браузер даёт WebCrypto только по HTTPS. Страница открыта по ',
  noCryptoTail:
    ', поэтому зашифрованное соединение невозможно, а открытым текстом клиент не подключается. Включите в ProjectHub HTTPS-туннель Remote Control и откройте ссылку туннеля, Telegram Mini App или мобильное приложение.',
  notPairingLink: 'Не похоже на ссылку сопряжения ProjectHub.',
  scanQr: 'Сканировать QR-код',
  pasteLink: 'Вставьте ссылку сопряжения',
  applyLink: 'Применить ссылку',
  hideManual: 'Скрыть ручной ввод',
  showManual: 'Ввести вручную',
  modeLan: 'Локальная сеть',
  modeRelay: 'Через релей',
  lanAddressPlaceholder: 'Адрес ПК: 192.168.1.5:42050',
  relayPlaceholder: 'Релей: wss://relay.example.com',
  hostIdPlaceholder: 'Host ID: ph_host_…',
  keyPlaceholder: 'Ключ шифрования (64 hex)',
  connect: 'Подключиться',
  memoryStoreNote: 'Ключ устройства хранится только до закрытия приложения: защищённое хранилище (Keychain/Keystore) ещё не подключено.',
  scanHint: 'Наведите камеру на QR-код в ProjectHub',
  cameraDenied: 'Нет доступа к камере. Разрешите камеру для ProjectHub в настройках телефона или вставьте ссылку сопряжения.',
  ui: {
    code: 'код',
    copyCode: 'Копировать код'
  }
};
