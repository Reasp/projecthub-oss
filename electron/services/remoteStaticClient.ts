import path from 'node:path';

/**
 * Раздача собранного мобильного клиента (`mobile/`, TASK-140.1, decision-79 п. 1) с HTTP-сервера
 * Remote Control. Чистые функции без Electron — маршруты, пути, заголовки покрыты unit-тестами.
 *
 * Страницы: `/`, `/remote` — встроенный клиент, `/telegram` — Telegram Mini App. Ассеты обеих —
 * `/m/…` (Vite `base: '/m/'`). Хост подставляет в страницу только данные о себе (hostId, релей,
 * режим) — код страницы один и тот же у всех хостов.
 */

export type MobilePageTarget = 'embedded' | 'telegram';

export type MobileClientRoute =
  | { kind: 'page'; target: MobilePageTarget; file: string }
  | { kind: 'asset'; relPath: string }
  | { kind: 'forbidden' };

export const MOBILE_PAGE_FILES: Record<MobilePageTarget, string> = {
  embedded: 'index.html',
  telegram: 'telegram.html'
};

/** Подкаталог сборки относительно корня приложения или репозитория. */
export const MOBILE_CLIENT_DIST = path.join('dist', 'mobile');

const ASSET_PREFIX = '/m/';

/** Маршрут для пути запроса; `null` — не наш путь (дальше 404 сервера). */
export function resolveMobileClientRoute(pathname: string): MobileClientRoute | null {
  if (pathname === '/' || pathname === '/remote' || pathname.startsWith('/remote/')) {
    return { kind: 'page', target: 'embedded', file: MOBILE_PAGE_FILES.embedded };
  }
  if (pathname === '/telegram' || pathname.startsWith('/telegram/')) {
    return { kind: 'page', target: 'telegram', file: MOBILE_PAGE_FILES.telegram };
  }
  if (pathname.startsWith(ASSET_PREFIX)) {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(ASSET_PREFIX.length));
    } catch {
      return { kind: 'forbidden' };
    }
    if (!isSafeRelativeAsset(rel)) return { kind: 'forbidden' };
    return { kind: 'asset', relPath: rel };
  }
  return null;
}

/** Относительный путь ассета без выхода из каталога, абсолютных путей и служебных символов. */
export function isSafeRelativeAsset(rel: string): boolean {
  if (!rel || rel.length > 200) return false;
  if (/[\\\0:]/.test(rel)) return false;
  if (rel.startsWith('/')) return false;
  const parts = rel.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('.'));
}

/** Абсолютный путь файла внутри `root` или `null`, если путь выходит за его пределы. */
export function resolveInside(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export interface HostPageDefaults {
  hostId: string;
  relayUrl: string;
  mode: 'lan' | 'relay';
}

export const HOST_DEFAULTS_PLACEHOLDER = '<!--ph-host-defaults-->';

/**
 * Вставка значений хоста блоком данных `type="application/json"` — браузер его не исполняет,
 * а `<` экранируется, чтобы значение не закрыло тег.
 */
export function injectHostDefaults(html: string, defaults: HostPageDefaults): string {
  const json = JSON.stringify({ hostId: defaults.hostId, relayUrl: defaults.relayUrl, mode: defaults.mode })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const tag = `<script id="ph-host-defaults" type="application/json">${json}</script>`;
  return html.includes(HOST_DEFAULTS_PLACEHOLDER) ? html.replace(HOST_DEFAULTS_PLACEHOLDER, tag) : html.replace('</head>', `${tag}</head>`);
}

/**
 * Заголовки страниц. Скрипты только с хоста (и SDK Telegram для Mini App), сокет — к хосту
 * или релею. Встроенный клиент нельзя встроить во фрейм; Mini App встраивает Telegram Web.
 */
export function pageHeaders(target: MobilePageTarget): Record<string, string> {
  const scriptSrc = target === 'telegram' ? "'self' https://telegram.org" : "'self'";
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    ...(target === 'embedded' ? ["frame-ancestors 'none'"] : [])
  ].join('; ');
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
}

/** Ассеты с хэшем в имени не меняются — кэшируются надолго. */
export function assetHeaders(file: string): Record<string, string> {
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path.basename(file));
  return {
    'Content-Type': contentTypeFor(file),
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
}

const MOBILE_CLIENT_MISSING_TEXT = {
  en: {
    title: 'The mobile client is not built',
    body: 'Build it on the computer with ProjectHub: <code>npm run build:mobile</code>, then reload the page.'
  },
  ru: {
    title: 'Мобильный клиент не собран',
    body: 'Соберите его на компьютере с ProjectHub: <code>npm run build:mobile</code>, затем обновите страницу.'
  }
} as const;

/** Язык страницы для браузера телефона: первый поддерживаемый из `Accept-Language`, иначе английский. */
export function pageLanguage(acceptLanguage: string | undefined): 'en' | 'ru' {
  for (const part of (acceptLanguage || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag.startsWith('ru')) return 'ru';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

/** Страница, если клиент не собран (dev-режим без `npm run build:mobile`) — на языке браузера телефона. */
export function mobileClientMissingHtml(acceptLanguage?: string): string {
  const lang = pageLanguage(acceptLanguage);
  const tx = MOBILE_CLIENT_MISSING_TEXT[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ProjectHub Remote</title></head>
<body style="background:#18181b;color:#e4e4e7;font-family:system-ui,sans-serif;padding:24px;line-height:1.5">
<h1 style="font-size:20px">${tx.title}</h1>
<p>${tx.body}</p>
</body></html>`;
}
