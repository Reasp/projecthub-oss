import type {
  ConnectionAccount,
  ConnectionAuthMethod,
  ConnectionServiceInfo,
  ConnectionSecret
} from './connectionTypes.js';

/**
 * Каталог сервисов слоя подключений (decision-102 п. 3): способы входа, адреса OAuth, как передавать
 * токен и как проверить аккаунт. Чистый модуль: без Electron и сети.
 */

/** Как токен передаётся в заголовке `Authorization`. */
export type TokenStyle = 'bearer' | 'token' | 'raw';

export type RevokeSpec =
  /** RFC 7009: POST с `token` и `client_id` в форме. */
  | { kind: 'rfc7009'; url: (baseUrl: string) => string }
  /** GitHub: `DELETE /applications/{client_id}/token`, Basic `client_id:client_secret`. */
  | { kind: 'github' };

export interface OAuthSpec {
  authorizeUrl: (baseUrl: string) => string;
  tokenUrl: (baseUrl: string) => string;
  deviceCodeUrl?: (baseUrl: string) => string;
  revoke?: RevokeSpec;
  /** Сервис принимает PKCE S256. */
  pkce: boolean;
  scopeSeparator: ' ' | ',';
  /** `form` — тело `application/x-www-form-urlencoded`; `query` — параметры в адресе (ClickUp). */
  tokenRequest: 'form' | 'query';
}

export interface ConnectionServiceDef extends ConnectionServiceInfo {
  /** Адрес API по базовому адресу веб-интерфейса. */
  apiBase: (baseUrl: string) => string;
  /** Как передавать личный токен (способ `token`). OAuth-токены всегда идут как `Bearer`. */
  tokenStyle: TokenStyle;
  /** Путь проверки аккаунта относительно `apiBase`. */
  verifyPath: string;
  parseAccount: (json: unknown) => ConnectionAccount | null;
  oauth?: OAuthSpec;
  /** Где отозвать доступ вручную. */
  manualRevokeUrl?: (baseUrl: string, method: ConnectionAuthMethod) => string;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Аккаунт из ответа: поля перечисляются в порядке предпочтения. */
function accountFrom(json: unknown, ids: string[], logins: string[], names: string[]): ConnectionAccount | null {
  const o = obj(json);
  if (!o) return null;
  const pick = (keys: string[]) => keys.map((k) => str(o[k])).find(Boolean);
  const account: ConnectionAccount = { id: pick(ids), login: pick(logins), name: pick(names) };
  return account.id || account.login ? account : null;
}

export const CONNECTION_SERVICES: readonly ConnectionServiceDef[] = [
  {
    id: 'github',
    label: 'GitHub',
    categories: ['vcs', 'tracker', 'ci'],
    methods: ['oauth-device', 'oauth-browser', 'token'],
    defaultBaseUrl: 'https://github.com',
    selfHosted: true,
    scopes: [{ id: 'read:user', default: true }, { id: 'repo' }, { id: 'workflow' }, { id: 'read:org' }],
    // GitHub не различает публичных и конфиденциальных клиентов: обмен кода требует секрет даже с PKCE.
    clientSecretRequired: { 'oauth-browser': true },
    tokenHelpUrl: 'https://github.com/settings/personal-access-tokens',
    oauthAppHelpUrl: 'https://github.com/settings/developers',
    apiBase: (base) => (new URL(base).host === 'github.com' ? 'https://api.github.com' : `${base}/api/v3`),
    tokenStyle: 'bearer',
    verifyPath: '/user',
    parseAccount: (json) => accountFrom(json, ['id'], ['login'], ['name']),
    oauth: {
      authorizeUrl: (base) => `${base}/login/oauth/authorize`,
      tokenUrl: (base) => `${base}/login/oauth/access_token`,
      deviceCodeUrl: (base) => `${base}/login/device/code`,
      revoke: { kind: 'github' },
      pkce: true,
      scopeSeparator: ' ',
      tokenRequest: 'form'
    },
    manualRevokeUrl: (base, method) => `${base}/settings/${method === 'token' ? 'tokens' : 'applications'}`
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    categories: ['vcs', 'tracker', 'ci'],
    methods: ['oauth-browser', 'oauth-device', 'token'],
    defaultBaseUrl: 'https://gitlab.com',
    selfHosted: true,
    scopes: [{ id: 'read_user', default: true }, { id: 'read_api' }, { id: 'api' }],
    clientSecretRequired: {},
    tokenHelpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    oauthAppHelpUrl: 'https://gitlab.com/-/user_settings/applications',
    apiBase: (base) => `${base}/api/v4`,
    tokenStyle: 'bearer',
    verifyPath: '/user',
    parseAccount: (json) => accountFrom(json, ['id'], ['username'], ['name']),
    oauth: {
      authorizeUrl: (base) => `${base}/oauth/authorize`,
      tokenUrl: (base) => `${base}/oauth/token`,
      deviceCodeUrl: (base) => `${base}/oauth/authorize_device`,
      revoke: { kind: 'rfc7009', url: (base) => `${base}/oauth/revoke` },
      pkce: true,
      scopeSeparator: ' ',
      tokenRequest: 'form'
    },
    manualRevokeUrl: (base, method) =>
      `${base}/-/user_settings/${method === 'token' ? 'personal_access_tokens' : 'applications'}`
  },
  {
    id: 'gitea',
    label: 'Gitea / Forgejo',
    categories: ['vcs', 'tracker', 'ci'],
    methods: ['oauth-browser', 'token'],
    selfHosted: true,
    scopes: [],
    clientSecretRequired: {},
    apiBase: (base) => `${base}/api/v1`,
    tokenStyle: 'token',
    verifyPath: '/user',
    parseAccount: (json) => accountFrom(json, ['id'], ['login', 'username'], ['full_name']),
    oauth: {
      authorizeUrl: (base) => `${base}/login/oauth/authorize`,
      tokenUrl: (base) => `${base}/login/oauth/access_token`,
      pkce: true,
      scopeSeparator: ' ',
      tokenRequest: 'form'
    },
    manualRevokeUrl: (base) => `${base}/user/settings/applications`
  },
  {
    id: 'clickup',
    label: 'ClickUp',
    categories: ['tracker'],
    methods: ['token', 'oauth-browser'],
    defaultBaseUrl: 'https://app.clickup.com',
    selfHosted: false,
    scopes: [],
    clientSecretRequired: { 'oauth-browser': true },
    tokenHelpUrl: 'https://app.clickup.com/settings/apps',
    oauthAppHelpUrl: 'https://developer.clickup.com/docs/authentication',
    apiBase: () => 'https://api.clickup.com/api/v2',
    // Личный токен `pk_…` ClickUp принимает только без префикса `Bearer`.
    tokenStyle: 'raw',
    verifyPath: '/user',
    parseAccount: (json) => accountFrom(obj(json)?.user, ['id'], ['username', 'email'], ['email']),
    oauth: {
      authorizeUrl: (base) => `${base}/api`,
      tokenUrl: () => 'https://api.clickup.com/api/v2/oauth/token',
      pkce: false,
      scopeSeparator: ' ',
      tokenRequest: 'query'
    },
    manualRevokeUrl: () => 'https://app.clickup.com/settings/apps'
  },
  {
    id: 'jira',
    label: 'Jira',
    categories: ['tracker'],
    methods: ['basic', 'token'],
    selfHosted: true,
    scopes: [],
    clientSecretRequired: {},
    tokenHelpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    usernameHint: 'email',
    apiBase: (base) => base,
    tokenStyle: 'bearer',
    verifyPath: '/rest/api/2/myself',
    parseAccount: (json) => accountFrom(json, ['accountId', 'key'], ['emailAddress', 'name'], ['displayName']),
    manualRevokeUrl: (base) =>
      new URL(base).host.endsWith('.atlassian.net')
        ? 'https://id.atlassian.com/manage-profile/security/api-tokens'
        : `${base}/secure/ViewProfile.jspa`
  },
  {
    id: 'jenkins',
    label: 'Jenkins',
    categories: ['ci'],
    methods: ['basic'],
    selfHosted: true,
    scopes: [],
    clientSecretRequired: {},
    apiBase: (base) => base,
    tokenStyle: 'bearer',
    verifyPath: '/me/api/json',
    parseAccount: (json) => accountFrom(json, ['id'], ['id'], ['fullName']),
    manualRevokeUrl: (base) => `${base}/me/configure`
  }
];

export function findConnectionService(id: string): ConnectionServiceDef | undefined {
  return CONNECTION_SERVICES.find((s) => s.id === id);
}

/** Описание сервисов для рендерера: без функций. */
export function connectionServiceInfos(): ConnectionServiceInfo[] {
  return CONNECTION_SERVICES.map((s) => ({
    id: s.id,
    label: s.label,
    categories: [...s.categories],
    methods: [...s.methods],
    defaultBaseUrl: s.defaultBaseUrl,
    selfHosted: s.selfHosted,
    scopes: s.scopes.map((sc) => ({ ...sc })),
    clientSecretRequired: { ...s.clientSecretRequired },
    builtinClientId: s.builtinClientId,
    tokenHelpUrl: s.tokenHelpUrl,
    oauthAppHelpUrl: s.oauthAppHelpUrl,
    usernameHint: s.usernameHint
  }));
}

/** Права по умолчанию; выбранные человеком фильтруются по списку сервиса, неизвестные отбрасываются. */
export function resolveScopes(service: ConnectionServiceDef, requested: readonly string[] | undefined): string[] {
  const known = new Set(service.scopes.map((s) => s.id));
  const picked = (requested ?? []).filter((s) => known.has(s));
  const base = picked.length > 0 ? picked : service.scopes.filter((s) => s.default).map((s) => s.id);
  return [...new Set(base)];
}

/** Значение заголовка `Authorization` для подключения. */
export function authorizationHeader(
  service: ConnectionServiceDef,
  method: ConnectionAuthMethod,
  secret: ConnectionSecret,
  username?: string
): string {
  if (method === 'basic') return `Basic ${Buffer.from(`${username ?? ''}:${secret.token}`, 'utf-8').toString('base64')}`;
  if (method === 'token') {
    if (service.tokenStyle === 'raw') return secret.token;
    if (service.tokenStyle === 'token') return `token ${secret.token}`;
  }
  return `Bearer ${secret.token}`;
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^\[::1\]$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /\.local$/i,
  /\.lan$/i
];

export type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; error: 'invalid' | 'insecure' | 'required' };

/**
 * Проверка адреса сервиса (decision-102 п. 9): `https`, а `http` — только для loopback и частных сетей.
 * Возвращает адрес без пути запроса, хэша и завершающего `/`; путь сохраняется (Jenkins под `/jenkins`).
 */
export function normalizeBaseUrl(input: string | undefined, fallback?: string): BaseUrlCheck {
  const raw = (input ?? '').trim() || fallback || '';
  if (!raw) return { ok: false, error: 'required' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.username || url.password) return { ok: false, error: 'invalid' };
  if (url.protocol === 'http:') {
    if (!PRIVATE_HOST.some((re) => re.test(url.hostname))) return { ok: false, error: 'insecure' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, error: 'invalid' };
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${pathname}` };
}
