/**
 * Ссылки сопряжения Remote Control (TASK-140.1). Общий модуль: QR в `RemoteControlBadge` строит
 * ссылки здесь, мобильный клиент (`mobile/src/protocol/pairing.ts`) разбирает тем же форматом.
 *
 * Ключ едет только в hash (`#key=…`): браузер не отправляет hash на сервер, поэтому ни туннель,
 * ни прокси его не видят. В `start_param` Telegram (≤ 64 символов `[A-Za-z0-9_-]`) hex-ключ из
 * 64 символов не помещается — туда кладётся base64url (`kb_` + 43 символа).
 */

/** hex → base64url без `=`. */
export function hexToBase64Url(hex: string, encodeBase64: (s: string) => string = btoa): string {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return encodeBase64(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (без `=`) → hex; `null`, если строка не base64url. */
export function base64UrlToHex(value: string, decodeBase64: (s: string) => string = atob): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const bin = decodeBase64(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

export interface PairingSource {
  hostId: string;
  key: string;
  relayServerUrl: string;
  mode: 'lan' | 'relay';
  port: number;
  /** Первый адрес LAN; без него — `localhost`. */
  localIp?: string;
  /** Публичный HTTPS-туннель, если запущен. */
  tunnelUrl?: string;
}

export function buildPairingHash(src: PairingSource, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ hostId: src.hostId, key: src.key, relay: src.relayServerUrl, mode: src.mode, ...extra });
  return params.toString();
}

/** `start_param` Mini App с полным ключом. */
export function buildTelegramStartParam(key: string): string {
  return `kb_${hexToBase64Url(key)}`;
}

/**
 * Адрес страницы клиента. HTTPS-туннель предпочтительнее LAN: только в защищённом контексте
 * браузер даёт WebCrypto, без которого клиент не шифрует и не подключается (decision-80).
 */
export function clientPageOrigin(src: PairingSource): string {
  return src.tunnelUrl ? src.tunnelUrl.replace(/\/+$/, '') : `http://${src.localIp || 'localhost'}:${src.port}`;
}

/** Ссылка на встроенный клиент для QR. */
export function buildEmbeddedPairingUrl(src: PairingSource): string {
  return `${clientPageOrigin(src)}/remote#${buildPairingHash(src)}`;
}

/** Ссылка на Mini App: через бота (`startapp`), иначе страница Mini App на хосте с hash. */
export function buildTelegramPairingUrl(src: PairingSource, botUsername?: string): string {
  if (botUsername) return `https://t.me/${botUsername}?startapp=${buildTelegramStartParam(src.key)}`;
  return `${clientPageOrigin(src)}/telegram#${buildPairingHash(src)}`;
}
