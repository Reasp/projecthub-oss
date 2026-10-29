/**
 * Шлюз участника на хосте (TASK-150.2, [[decision-187]] п. 4): агент участника в контейнере ходит к модели и к HITL MCP
 * ProjectHub только сюда, со своим коротким токеном. Шлюз проверяет токен и подставляет учётные данные хоста — ключ
 * провайдера модели и токен MCP; в контейнер они не попадают никогда.
 *
 * Маршруты — только те, что нужны Claude CLI, и только в своей сессии:
 * - `POST /model/v1/messages` и `/v1/messages/count_tokens` → API модели хоста. Остальные пути API (файлы, пакеты,
 *   администрирование аккаунта) закрыты: ключ хоста не должен открывать данные аккаунта владельца.
 * - `GET /mcp/sse?<сессия HITL>` → SSE встроенного MCP-сервера, только для сессии, выданной этому токену. Адрес для
 *   сообщений из события `endpoint` шлюз переписывает на свой `/mcp/message` и привязывает id сессии MCP к токену.
 * - `POST /mcp/message?sessionId=…` → только привязанная к токену сессия MCP и только вызовы разрешённых инструментов
 *   (запрос разрешения и память проекта): остальные инструменты сервера (процессы, одобрение чужих запросов,
 *   управление компьютером) из контейнера недоступны.
 * Решения по запросу — чистые функции; сервер только проксирует потоком.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export interface GatewayGrant {
  memberId: string;
  /** Сессия HITL этого запуска: SSE MCP пропускается только с ней в query-параметре. */
  hitlSessionId?: string;
  /** Сессии MCP (`sessionId` транспорта SSE), открытые этим токеном. */
  mcpSessions?: Set<string>;
  expiresAt: number;
}

export interface GatewayMcpUpstream {
  baseUrl: string;
  token: string;
  /** Query-параметр сессии HITL (`phSession`). */
  sessionParam: string;
  ssePath?: string;
  messagePath?: string;
}

export interface GatewayUpstreams {
  /** Базовый адрес API модели и заголовки с учётными данными хоста (`x-api-key`, `authorization`). */
  model?: { baseUrl: string; headers: Record<string, string> };
  /** Адрес встроенного MCP-сервера HITL и его токен. */
  mcp?: GatewayMcpUpstream;
}

export type GatewayKind = 'model' | 'mcpSse' | 'mcpMessage';

export type GatewayRoute =
  | { ok: true; memberId: string; kind: GatewayKind; target: URL; headers: Record<string, string>; grant: GatewayGrant }
  | { ok: false; status: 401 | 403 | 404 | 405 | 503; code: 'noToken' | 'badToken' | 'expired' | 'notFound' | 'method' | 'sessionMismatch' | 'notConfigured' };

/** Пути API модели, которые нужны Claude CLI. */
export const MODEL_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

/** Заголовки, которые не уходят вверх: учётные данные контейнера, хоп-заголовки и адрес шлюза. */
const DROP_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'cookie']);

/** Токен запроса: `Authorization: Bearer …` (ANTHROPIC_AUTH_TOKEN, MCP) или `x-api-key` (ANTHROPIC_API_KEY). */
export function gatewayToken(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const auth = one(headers.authorization);
  const bearer = auth && /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (bearer) return bearer[1];
  const key = one(headers['x-api-key'])?.trim();
  return key || null;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function joinUrl(base: string, rest: string, search: string): URL {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${rest.replace(/^\/+/, '')}`;
  u.search = search;
  return u;
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export function resolveGatewayRoute(
  req: { url: string; method?: string; headers: Record<string, string | string[] | undefined> },
  grants: ReadonlyMap<string, GatewayGrant>,
  upstreams: GatewayUpstreams,
  now: number
): GatewayRoute {
  const token = gatewayToken(req.headers);
  if (!token) return { ok: false, status: 401, code: 'noToken' };
  let grant: GatewayGrant | undefined;
  for (const [t, g] of grants) if (sameToken(t, token)) grant = g;
  if (!grant) return { ok: false, status: 401, code: 'badToken' };
  if (grant.expiresAt <= now) return { ok: false, status: 401, code: 'expired' };

  const url = new URL(req.url, 'http://gateway.invalid');
  const method = (req.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_HEADERS.has(name.toLowerCase())) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }

  if (url.pathname.startsWith('/model/')) {
    const rest = url.pathname.slice('/model'.length);
    if (!MODEL_PATHS.has(rest)) return { ok: false, status: 404, code: 'notFound' };
    if (method !== 'POST') return { ok: false, status: 405, code: 'method' };
    if (!upstreams.model) return { ok: false, status: 503, code: 'notConfigured' };
    return { ok: true, memberId: grant.memberId, kind: 'model', grant, target: joinUrl(upstreams.model.baseUrl, rest, url.search), headers: { ...headers, ...lower(upstreams.model.headers) } };
  }

  const mcp = upstreams.mcp;
  const ssePath = mcp?.ssePath ?? '/sse';
  const messagePath = mcp?.messagePath ?? '/message';
  if (url.pathname === `/mcp${ssePath}`) {
    if (method !== 'GET') return { ok: false, status: 405, code: 'method' };
    if (!mcp) return { ok: false, status: 503, code: 'notConfigured' };
    // Подключение MCP привязано к сессии HITL query-параметром: чужую сессию (чужие решения, чужой проект) не подставить.
    if (!grant.hitlSessionId || url.searchParams.get(mcp.sessionParam) !== grant.hitlSessionId) return { ok: false, status: 403, code: 'sessionMismatch' };
    const search = new URLSearchParams({ [mcp.sessionParam]: grant.hitlSessionId });
    return { ok: true, memberId: grant.memberId, kind: 'mcpSse', grant, target: joinUrl(mcp.baseUrl, ssePath, `?${search}`), headers: { ...headers, authorization: `Bearer ${mcp.token}` } };
  }
  if (url.pathname === `/mcp${messagePath}`) {
    if (method !== 'POST') return { ok: false, status: 405, code: 'method' };
    if (!mcp) return { ok: false, status: 503, code: 'notConfigured' };
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!sessionId || !grant.mcpSessions?.has(sessionId)) return { ok: false, status: 403, code: 'sessionMismatch' };
    const search = new URLSearchParams({ sessionId });
    return { ok: true, memberId: grant.memberId, kind: 'mcpMessage', grant, target: joinUrl(mcp.baseUrl, messagePath, `?${search}`), headers: { ...headers, authorization: `Bearer ${mcp.token}` } };
  }
  return { ok: false, status: 404, code: 'notFound' };
}

/**
 * Сообщение JSON-RPC для MCP после проверки: служебные методы протокола и вызов разрешённого инструмента; пакет — только
 * если разрешено всё в нём. Возвращает тело, заново собранное из разобранного JSON, или `null`. Пересборка обязательна:
 * сервер декодирует тело по `charset` (в том числе UTF-7), и исходные байты могли бы значить для него другое, чем для
 * проверки (дубликат ключа `name`, невидимый в UTF-8).
 */
export function filterMcpMessage(body: string, allowTool: (name: string) => boolean): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return null;
  return items.every((item) => mcpItemAllowed(item, allowTool)) ? JSON.stringify(parsed) : null;
}

/** То же решением да/нет — для проверок. */
export function mcpMessageAllowed(body: string, allowTool: (name: string) => boolean): boolean {
  return filterMcpMessage(body, allowTool) !== null;
}

function mcpItemAllowed(item: unknown, allowTool: (name: string) => boolean): boolean {
  if (!item || typeof item !== 'object') return false;
  const m = item as { method?: unknown; params?: { name?: unknown }; result?: unknown; error?: unknown };
  // Ответы клиента на запросы сервера (без method) — пропускаются.
  if (m.method === undefined) return 'result' in m || 'error' in m;
  if (typeof m.method !== 'string') return false;
  if (m.method === 'tools/call') return typeof m.params?.name === 'string' && allowTool(m.params.name);
  return ['initialize', 'ping', 'tools/list'].includes(m.method) || m.method.startsWith('notifications/');
}

/**
 * Событие `endpoint` SSE-транспорта MCP: адрес для сообщений сервер даёт своим путём (`/message?sessionId=…`). Шлюз
 * переписывает его на свой (`/mcp/message?sessionId=…`) и сообщает id сессии — его привязывают к токену.
 */
export function rewriteSseEndpoint(text: string, messagePath: string): { text: string; sessionId: string | null } {
  let sessionId: string | null = null;
  const out = text.replace(/^(event: endpoint\r?\ndata: )(\S+)$/m, (all, head: string, target: string) => {
    const u = new URL(target, 'http://upstream.invalid');
    if (u.pathname !== messagePath) return all;
    sessionId = u.searchParams.get('sessionId');
    return `${head}/mcp${messagePath}?${new URLSearchParams({ sessionId: sessionId ?? '' })}`;
  });
  return { text: out, sessionId };
}

export interface GatewayRequestLog {
  memberId: string;
  kind: GatewayKind;
  status: number;
  path: string;
}

/** Тело сообщения MCP больше этого — не HITL. */
const MAX_MCP_BODY = 1024 * 1024;

/** Сервер шлюза. До контейнера его доводит пересыльщик во внутренней сети. */
export class MemberGateway {
  private server: http.Server | null = null;
  private readonly grants = new Map<string, GatewayGrant>();
  private port = 0;
  private host = '127.0.0.1';

  constructor(
    private readonly upstreams: () => GatewayUpstreams,
    private readonly onRequest: (entry: GatewayRequestLog) => void = () => undefined,
    /** Инструменты MCP, разрешённые агенту в контейнере. */
    private readonly allowTool: (name: string) => boolean = () => false
  ) {}

  get address(): { host: string; port: number } | null {
    return this.server ? { host: this.host, port: this.port } : null;
  }

  /** Короткий токен участника на один запуск; отзывается по завершении агента. */
  grant(memberId: string, opts: { hitlSessionId?: string; ttlMs?: number } = {}): string {
    const token = `phg_${crypto.randomBytes(32).toString('base64url')}`;
    this.grants.set(token, {
      memberId,
      ...(opts.hitlSessionId ? { hitlSessionId: opts.hitlSessionId } : {}),
      mcpSessions: new Set(),
      expiresAt: Date.now() + (opts.ttlMs ?? 12 * 3600_000)
    });
    return token;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  async start(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.host, port: this.port };
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.host = host;
    this.port = (server.address() as { port: number }).port;
    return { host, port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.grants.clear();
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  private deny(res: http.ServerResponse, status: number, code: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: code }));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = resolveGatewayRoute({ url: req.url ?? '/', method: req.method, headers: req.headers }, this.grants, this.upstreams(), Date.now());
    if (!route.ok) return this.deny(res, route.status, route.code);
    if (route.kind === 'mcpMessage') {
      // Тело читается целиком: вызов инструмента проверяется до передачи серверу.
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_MCP_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        const filtered = filterMcpMessage(Buffer.concat(chunks).toString('utf8'), this.allowTool);
        if (filtered === null) return this.deny(res, 403, 'toolDenied');
        // Серверу уходит ровно то, что проверено: UTF-8 без указания кодировки клиента.
        route.headers['content-type'] = 'application/json';
        this.forward(route, req.method ?? 'POST', res, Buffer.from(filtered, 'utf8'));
      });
      return;
    }
    this.forward(route, req.method ?? 'GET', res, req);
  }

  private forward(route: Extract<GatewayRoute, { ok: true }>, method: string, res: http.ServerResponse, body: Buffer | http.IncomingMessage): void {
    const client = route.target.protocol === 'https:' ? https : http;
    const headers = Buffer.isBuffer(body) ? { ...route.headers, 'content-length': String(body.length) } : route.headers;
    const upstream = client.request(route.target, { method, headers }, (up) => {
      this.onRequest({ memberId: route.memberId, kind: route.kind, status: up.statusCode ?? 0, path: route.target.pathname });
      res.writeHead(up.statusCode ?? 502, up.headers);
      if (route.kind !== 'mcpSse') return void up.pipe(res);
      // До события endpoint поток копится и переписывается; дальше — как есть.
      const messagePath = this.upstreams().mcp?.messagePath ?? '/message';
      let pending = '';
      let rewritten = false;
      up.on('data', (chunk: Buffer) => {
        if (rewritten) return void res.write(chunk);
        pending += chunk.toString('utf8');
        if (!/\n\r?\n/.test(pending) && pending.length < 64 * 1024) return;
        const { text, sessionId } = rewriteSseEndpoint(pending, messagePath);
        if (sessionId) route.grant.mcpSessions?.add(sessionId);
        rewritten = true;
        res.write(text);
      });
      up.on('end', () => res.end(rewritten ? undefined : pending));
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream' }));
    });
    // Оборванный клиент (агент остановлен) рвёт и запрос вверх: SSE MCP не висит.
    res.on('close', () => upstream.destroy());
    if (Buffer.isBuffer(body)) upstream.end(body);
    else body.pipe(upstream);
  }
}
