import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  authorizationHeader,
  connectionServiceInfos,
  findConnectionService,
  normalizeBaseUrl,
  resolveScopes,
  webhookTarget,
  type ConnectionServiceDef,
  type OAuthSpec
} from './connectionCatalog.js';
import {
  ConnectionAuthError,
  type ConnectionAccount,
  type ConnectionFlowView,
  type ConnectionInput,
  type ConnectionRecord,
  type ConnectionRemoveResult,
  type ConnectionSecret,
  type ConnectionServiceInfo,
  type ConnectionsFile,
  type ConnectionUsage,
  type ConnectionView
} from './connectionTypes.js';
import {
  buildAuthorizeUrl,
  buildCodeExchangeRequest,
  buildDeviceCodeRequest,
  buildDevicePollRequest,
  buildRefreshRequest,
  createPkcePair,
  createState,
  describeOAuthError,
  nextDevicePollStep,
  parseDeviceCodeResponse,
  parseTokenResponse,
  type HttpRequest,
  type TokenSet
} from './oauthFlow.js';
import { LoopbackError, startLoopbackServer } from './oauthLoopback.js';
import { AppError } from '../../src/lib/appError.js';
import { registerSensitiveValue, unregisterSensitiveValue } from './sensitiveValues.js';

/**
 * Слой подключений к внешним сервисам (TASK-138.1, decision-102).
 *
 * Записи без секретов — `<userData>/connections.json`; токены, refresh-токены, пароли и `client_secret`
 * своего приложения — запись `connection:<id>` в хранилище секретов. Интеграции получают доступ через
 * `authorizedFetch`: он подставляет авторизацию, обновляет токен и помечает отозванные подключения.
 */

export const CONNECTIONS_FILE_NAME = 'connections.json';
export const SECRET_KEY_PREFIX = 'connection:';
/** Обновлять токен заранее, чтобы запрос не ушёл с истекающим (decision-102 п. 6). */
export const REFRESH_SKEW_MS = 60_000;
export const BROWSER_FLOW_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_FINISHED_FLOWS = 20;

export interface ConnectionSecretsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Сокет подключения (TASK-138.6): то немногое, что нужно интеграциям от WebSocket. */
export interface ConnectionSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface ConnectionServiceDeps {
  dir: () => string;
  secrets: ConnectionSecretsStore;
  fetch: typeof fetch;
  /** Исходящий WebSocket: адрес и заголовки уже проверены и собраны сервисом подключений. */
  openSocket?: (url: string, headers: Record<string, string>) => ConnectionSocket;
  openExternal: (url: string) => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  browserTimeoutMs?: number;
}

interface HttpResult {
  status: number;
  contentType: string | null;
  text: string;
}

interface FlowEntry {
  view: ConnectionFlowView;
  abort: AbortController;
  /** Адрес, который откроет кнопка «Открыть страницу» — только из main, не из рендерера. */
  pageUrl?: string;
  cleanup?: () => void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Запись из файла: битые и неизвестные поля отбрасываются, файл чужой версии не ломает приложение. */
export function normalizeConnectionsFile(raw: unknown): ConnectionsFile {
  const list = isObject(raw) && Array.isArray(raw.connections) ? raw.connections : [];
  const connections: ConnectionRecord[] = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const { id, serviceId, baseUrl, method } = item;
    if (typeof id !== 'string' || typeof serviceId !== 'string' || typeof baseUrl !== 'string' || typeof method !== 'string') continue;
    if (!['oauth-browser', 'oauth-device', 'token', 'basic'].includes(method)) continue;
    const status = ['connected', 'needsReauth', 'error', 'unchecked'].includes(String(item.status))
      ? (item.status as ConnectionRecord['status'])
      : 'unchecked';
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const account = isObject(item.account)
      ? { id: text(item.account.id), login: text(item.account.login), name: text(item.account.name) }
      : undefined;
    connections.push({
      id,
      serviceId,
      label: text(item.label) ?? serviceId,
      baseUrl,
      method: method as ConnectionRecord['method'],
      scopes: Array.isArray(item.scopes) ? item.scopes.filter((s): s is string => typeof s === 'string') : [],
      account,
      username: text(item.username),
      oauthClientId: text(item.oauthClientId),
      redirectPort: num(item.redirectPort),
      status,
      statusDetail: text(item.statusDetail),
      expiresAt: num(item.expiresAt),
      createdAt: num(item.createdAt) ?? 0,
      updatedAt: num(item.updatedAt) ?? 0,
      lastCheckedAt: num(item.lastCheckedAt)
    });
  }
  return { version: 1, connections };
}

function parseSecret(raw: string | null): ConnectionSecret | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || typeof parsed.token !== 'string' || !parsed.token) return null;
    return {
      token: parsed.token,
      refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed.refreshToken : undefined,
      clientSecret: typeof parsed.clientSecret === 'string' && parsed.clientSecret ? parsed.clientSecret : undefined
    };
  } catch {
    return null;
  }
}

function secretValues(secret: ConnectionSecret | null | undefined): string[] {
  return secret ? [secret.token, secret.refreshToken, secret.clientSecret].filter((v): v is string => Boolean(v)) : [];
}

/** Ошибка сети без подробностей запроса: только код причины (ENOTFOUND, ECONNREFUSED). */
function networkError(err: unknown): Error {
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`network: ${cause ?? message}`);
}

export class ConnectionService {
  private readonly deps: ConnectionServiceDeps;
  private file: ConnectionsFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly secretCache = new Map<string, ConnectionSecret>();
  private readonly refreshing = new Map<string, Promise<ConnectionSecret>>();
  private readonly flows = new Map<string, FlowEntry>();
  private readonly changeListeners = new Set<(list: ConnectionView[]) => void>();
  private readonly flowListeners = new Set<(flow: ConnectionFlowView) => void>();
  private readonly usageProviders = new Set<() => ConnectionUsage[]>();

  constructor(deps: ConnectionServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get filePath(): string {
    return path.join(this.deps.dir(), CONNECTIONS_FILE_NAME);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<ConnectionsFile> {
    if (this.file) return this.file;
    try {
      this.file = normalizeConnectionsFile(JSON.parse(await fs.readFile(this.filePath, 'utf-8')));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.warn('[Connections] connections.json is unreadable, starting empty:', (err as Error).message);
      this.file = { version: 1, connections: [] };
    }
    return this.file;
  }

  private async persist(): Promise<void> {
    const data = await this.load();
    const file = this.filePath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
      await fs.rename(tmp, file);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
    }
    void this.emitChanged();
  }

  /** Изменить запись под очередью и сохранить файл. */
  private update(id: string, patch: Partial<ConnectionRecord>): Promise<ConnectionRecord> {
    return this.serialize(async () => {
      const data = await this.load();
      const record = data.connections.find((c) => c.id === id);
      if (!record) throw new AppError('connections.notFound', { id });
      Object.assign(record, patch, { updatedAt: this.now() });
      await this.persist();
      return { ...record };
    });
  }

  private async getRecord(id: string): Promise<ConnectionRecord> {
    const data = await this.load();
    const record = data.connections.find((c) => c.id === id);
    if (!record) throw new AppError('connections.notFound', { id });
    return record;
  }

  private serviceOf(record: { serviceId: string }): ConnectionServiceDef {
    const service = findConnectionService(record.serviceId);
    if (!service) throw new AppError('connections.unknownService', { service: record.serviceId });
    return service;
  }

  private async readSecret(id: string): Promise<ConnectionSecret | null> {
    const cached = this.secretCache.get(id);
    if (cached) return cached;
    const secret = parseSecret(await this.deps.secrets.get(`${SECRET_KEY_PREFIX}${id}`));
    if (secret) {
      this.secretCache.set(id, secret);
      for (const v of secretValues(secret)) registerSensitiveValue(v);
    }
    return secret;
  }

  private async writeSecret(id: string, secret: ConnectionSecret): Promise<void> {
    const previous = this.secretCache.get(id) ?? parseSecret(await this.deps.secrets.get(`${SECRET_KEY_PREFIX}${id}`));
    for (const v of secretValues(secret)) registerSensitiveValue(v);
    await this.deps.secrets.set(`${SECRET_KEY_PREFIX}${id}`, JSON.stringify(secret));
    this.secretCache.set(id, secret);
    for (const v of secretValues(previous)) unregisterSensitiveValue(v);
  }

  private async dropSecret(id: string): Promise<void> {
    const previous = this.secretCache.get(id) ?? parseSecret(await this.deps.secrets.get(`${SECRET_KEY_PREFIX}${id}`));
    this.secretCache.delete(id);
    await this.deps.secrets.delete(`${SECRET_KEY_PREFIX}${id}`);
    for (const v of secretValues(previous)) unregisterSensitiveValue(v);
  }

  private async send(req: HttpRequest, signal?: AbortSignal): Promise<HttpResult> {
    let res: Response;
    try {
      res = await this.deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
    } catch (err) {
      throw networkError(err);
    }
    return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() };
  }

  // ─────────────────────────── Публичный API ───────────────────────────

  services(): ConnectionServiceInfo[] {
    return connectionServiceInfos();
  }

  registerUsageProvider(provider: () => ConnectionUsage[]): () => void {
    this.usageProviders.add(provider);
    void this.emitChanged();
    return () => {
      this.usageProviders.delete(provider);
      void this.emitChanged();
    };
  }

  private usages(): ConnectionUsage[] {
    const out: ConnectionUsage[] = [];
    for (const provider of this.usageProviders) {
      try {
        out.push(...provider());
      } catch (err) {
        console.warn('[Connections] Usage provider failed:', err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  async list(): Promise<ConnectionView[]> {
    const data = await this.load();
    const usages = this.usages();
    const views: ConnectionView[] = [];
    for (const record of data.connections) {
      const secret = await this.readSecret(record.id);
      views.push({
        ...record,
        scopes: [...record.scopes],
        account: record.account ? { ...record.account } : undefined,
        serviceLabel: findConnectionService(record.serviceId)?.label ?? record.serviceId,
        hasRefreshToken: Boolean(secret?.refreshToken),
        hasClientSecret: Boolean(secret?.clientSecret),
        usedBy: usages.filter((u) => u.connectionId === record.id).map((u) => u.label)
      });
    }
    return views;
  }

  onChanged(listener: (list: ConnectionView[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onFlowChanged(listener: (flow: ConnectionFlowView) => void): () => void {
    this.flowListeners.add(listener);
    return () => this.flowListeners.delete(listener);
  }

  private async emitChanged(): Promise<void> {
    if (this.changeListeners.size === 0) return;
    const list = await this.list().catch(() => null);
    if (!list) return;
    for (const l of this.changeListeners) {
      try {
        l(list);
      } catch (err) {
        console.warn('[Connections] Change listener failed:', err);
      }
    }
  }

  private emitFlow(entry: FlowEntry): void {
    const view = { ...entry.view };
    for (const l of this.flowListeners) {
      try {
        l(view);
      } catch (err) {
        console.warn('[Connections] Flow listener failed:', err);
      }
    }
  }

  /** Проверка аккаунта новым токеном. `rejected` — сервис ответил 401/403. */
  private async fetchAccount(
    service: ConnectionServiceDef,
    baseUrl: string,
    header: string,
    signal?: AbortSignal
  ): Promise<{ rejected: boolean; account: ConnectionAccount | null }> {
    const res = await this.send(
      {
        url: `${service.apiBase(baseUrl)}${service.verifyPath}`,
        method: service.verifyBody ? 'POST' : 'GET',
        headers: { Authorization: header, Accept: 'application/json', ...(service.verifyBody ? { 'Content-Type': 'application/json' } : {}) },
        ...(service.verifyBody ? { body: service.verifyBody } : {})
      },
      signal
    );
    if (res.status === 401 || res.status === 403) return { rejected: true, account: null };
    if (res.status < 200 || res.status >= 300) throw new Error(`http_${res.status}`);
    let json: unknown = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      // ответ без JSON — аккаунт неизвестен, но токен принят
    }
    if (service.rejectedBody?.(json)) return { rejected: true, account: null };
    return { rejected: false, account: service.parseAccount(json) };
  }

  private prepareInput(input: ConnectionInput): { service: ConnectionServiceDef; baseUrl: string } {
    const service = findConnectionService(String(input?.serviceId ?? ''));
    if (!service) throw new AppError('connections.unknownService', { service: String(input?.serviceId ?? '') });
    if (!service.methods.includes(input.method)) throw new AppError('connections.methodUnsupported', { service: service.label });
    const base = normalizeBaseUrl(input.baseUrl, service.defaultBaseUrl);
    if (!base.ok) {
      throw new AppError(
        base.error === 'insecure' ? 'connections.httpLocalOnly' : base.error === 'required' ? 'connections.urlRequired' : 'connections.urlInvalid'
      );
    }
    if (!service.selfHosted && service.defaultBaseUrl && base.baseUrl !== service.defaultBaseUrl) {
      throw new AppError('connections.cloudOnly', { service: service.label });
    }
    return { service, baseUrl: base.baseUrl };
  }

  private defaultLabel(service: ConnectionServiceDef, baseUrl: string, account: ConnectionAccount | null | undefined): string {
    const who = account?.login ?? account?.name;
    const host = service.defaultBaseUrl === baseUrl ? '' : ` (${new URL(baseUrl).host})`;
    return who ? `${service.label}${host} — ${who}` : `${service.label}${host}`;
  }

  /** Сохранить подключение: новая запись или переподключение существующей с тем же `id`. */
  private async store(
    reconnectId: string | undefined,
    fields: Omit<ConnectionRecord, 'id' | 'createdAt' | 'updatedAt' | 'label'> & { label?: string },
    secret: ConnectionSecret
  ): Promise<ConnectionRecord> {
    const service = this.serviceOf(fields);
    const id = reconnectId ?? `conn_${randomBytes(6).toString('hex')}`;
    await this.writeSecret(id, secret);
    return this.serialize(async () => {
      const data = await this.load();
      const now = this.now();
      const index = reconnectId ? data.connections.findIndex((c) => c.id === reconnectId) : -1;
      const existing = index >= 0 ? data.connections[index] : undefined;
      const label = fields.label?.trim() || existing?.label || this.defaultLabel(service, fields.baseUrl, fields.account);
      const record: ConnectionRecord = {
        ...fields,
        id,
        label,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) data.connections[index] = record;
      else data.connections.push(record);
      await this.persist();
      console.log(`[Connections] ${existing ? 'Reconnected' : 'Added'} ${service.id} connection ${id} (${fields.method})`);
      return { ...record };
    });
  }

  /** Подключение по личному токену, API-ключу или Basic: токен проверяется до сохранения. */
  async addWithToken(input: ConnectionInput, reconnectId?: string): Promise<ConnectionView> {
    if (input.method !== 'token' && input.method !== 'basic') throw new AppError('connections.invalidMethod');
    const { service, baseUrl } = this.prepareInput(input);
    const token = String(input.token ?? '').trim();
    if (!token) throw new AppError('connections.tokenRequired');
    const username = input.method === 'basic' ? String(input.username ?? '').trim() : undefined;
    if (input.method === 'basic' && !username) throw new AppError('connections.usernameRequired');
    if (reconnectId) await this.getRecord(reconnectId);
    const secret: ConnectionSecret = { token };
    registerSensitiveValue(token);
    try {
      // Вебхук (Teams Workflows) проверяется по форме адреса: пробный запрос опубликовал бы сообщение в канал.
      const hook = service.webhookHosts ? webhookTarget(service, token) : undefined;
      if (hook === null) throw new AppError('connections.webhookRequired', { service: service.label });
      const verified = hook
        ? { rejected: false, account: { login: hook.hostname.split('.')[0] } }
        : await this.fetchAccount(service, baseUrl, authorizationHeader(service, input.method, secret, username));
      if (verified.rejected) throw new AppError('connections.tokenRejected');
      const record = await this.store(
        reconnectId,
        {
          serviceId: service.id,
          label: input.label,
          baseUrl,
          method: input.method,
          scopes: [],
          account: verified.account ?? undefined,
          username,
          status: 'connected',
          lastCheckedAt: this.now()
        },
        secret
      );
      return this.viewOf(record.id);
    } finally {
      unregisterSensitiveValue(token);
    }
  }

  private async viewOf(id: string): Promise<ConnectionView> {
    const view = (await this.list()).find((v) => v.id === id);
    if (!view) throw new AppError('connections.notFound', { id });
    return view;
  }

  /** Начать вход через OAuth: браузер с возвратом на loopback или код устройства. */
  async startOAuth(input: ConnectionInput, reconnectId?: string): Promise<ConnectionFlowView> {
    if (input.method !== 'oauth-browser' && input.method !== 'oauth-device') throw new AppError('connections.invalidMethod');
    const { service, baseUrl } = this.prepareInput(input);
    const spec = service.oauth;
    if (!spec) throw new AppError('connections.oauthUnsupported', { service: service.label });
    const existing = reconnectId ? await this.getRecord(reconnectId) : undefined;
    const existingSecret = reconnectId ? await this.readSecret(reconnectId) : null;
    const clientId = String(input.clientId ?? '').trim() || existing?.oauthClientId || service.builtinClientId || '';
    if (!clientId) throw new AppError('connections.clientIdRequired');
    const clientSecret = String(input.clientSecret ?? '').trim() || existingSecret?.clientSecret || undefined;
    if (service.clientSecretRequired[input.method] && !clientSecret) throw new AppError('connections.clientSecretRequired', { service: service.label });
    if (clientSecret) registerSensitiveValue(clientSecret);
    const scopes = resolveScopes(service, input.scopes ?? existing?.scopes);
    const ctx: OAuthContext = {
      service,
      spec,
      baseUrl,
      clientId,
      clientSecret,
      scopes,
      label: input.label,
      redirectPort: input.redirectPort ?? existing?.redirectPort,
      reconnectId
    };
    return input.method === 'oauth-browser' ? this.startBrowserFlow(ctx) : this.startDeviceFlow(ctx);
  }

  private newFlow(ctx: OAuthContext, method: ConnectionFlowView['method'], expiresAt: number): FlowEntry {
    const flowId = `flow_${randomBytes(8).toString('hex')}`;
    const entry: FlowEntry = {
      view: { flowId, serviceId: ctx.service.id, method, state: 'pending', expiresAt },
      abort: new AbortController()
    };
    this.flows.set(flowId, entry);
    const finished = [...this.flows.values()].filter((f) => f.view.state !== 'pending' && f.view.state !== 'exchanging');
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_FLOWS))) this.flows.delete(old.view.flowId);
    return entry;
  }

  private setFlow(entry: FlowEntry, patch: Partial<ConnectionFlowView>): void {
    Object.assign(entry.view, patch);
    this.emitFlow(entry);
  }

  private async startBrowserFlow(ctx: OAuthContext): Promise<ConnectionFlowView> {
    const pkce = createPkcePair();
    const state = createState();
    const timeoutMs = this.deps.browserTimeoutMs ?? BROWSER_FLOW_TIMEOUT_MS;
    const loop = await startLoopbackServer({ state, port: ctx.redirectPort, timeoutMs });
    const authorizeUrl = buildAuthorizeUrl({
      spec: ctx.spec,
      baseUrl: ctx.baseUrl,
      clientId: ctx.clientId,
      redirectUri: loop.redirectUri,
      scopes: ctx.scopes,
      state,
      codeChallenge: pkce.challenge
    });
    const entry = this.newFlow(ctx, 'oauth-browser', this.now() + timeoutMs);
    entry.view.authorizeUrl = authorizeUrl;
    entry.pageUrl = authorizeUrl;
    entry.cleanup = () => loop.close();
    entry.abort.signal.addEventListener('abort', () => loop.close(), { once: true });

    void (async () => {
      try {
        const code = await loop.code;
        this.setFlow(entry, { state: 'exchanging' });
        const res = await this.send(
          buildCodeExchangeRequest({
            spec: ctx.spec,
            baseUrl: ctx.baseUrl,
            clientId: ctx.clientId,
            clientSecret: ctx.clientSecret,
            code,
            redirectUri: loop.redirectUri,
            codeVerifier: pkce.verifier
          }),
          entry.abort.signal
        );
        const parsed = parseTokenResponse(res.status, res.contentType, res.text, this.now());
        if (!parsed.ok) throw new Error(describeOAuthError(parsed.error, parsed.description));
        await this.completeFlow(entry, ctx, 'oauth-browser', parsed.token);
      } catch (err) {
        this.failFlow(entry, err);
      }
    })();

    try {
      await this.deps.openExternal(authorizeUrl);
    } catch (err) {
      console.warn('[Connections] Could not open the browser for sign-in:', err instanceof Error ? err.message : err);
    }
    this.emitFlow(entry);
    return { ...entry.view };
  }

  private async startDeviceFlow(ctx: OAuthContext): Promise<ConnectionFlowView> {
    const res = await this.send(buildDeviceCodeRequest({ spec: ctx.spec, baseUrl: ctx.baseUrl, clientId: ctx.clientId, scopes: ctx.scopes }));
    const parsed = parseDeviceCodeResponse(res.status, res.contentType, res.text, this.now());
    if (!parsed.ok) throw new Error(describeOAuthError(parsed.error, parsed.description));
    const device = parsed.device;
    const entry = this.newFlow(ctx, 'oauth-device', device.expiresAt);
    entry.view.userCode = device.userCode;
    entry.view.verificationUri = device.verificationUri;
    entry.pageUrl = device.verificationUriComplete ?? device.verificationUri;
    const sleep = this.deps.sleep ?? defaultSleep;

    void (async () => {
      let interval = device.intervalSec;
      try {
        while (this.now() < device.expiresAt) {
          await sleep(interval * 1000, entry.abort.signal);
          const poll = await this.send(
            buildDevicePollRequest({
              spec: ctx.spec,
              baseUrl: ctx.baseUrl,
              clientId: ctx.clientId,
              clientSecret: ctx.clientSecret,
              deviceCode: device.deviceCode
            }),
            entry.abort.signal
          );
          const token = parseTokenResponse(poll.status, poll.contentType, poll.text, this.now());
          if (token.ok) {
            this.setFlow(entry, { state: 'exchanging' });
            await this.completeFlow(entry, ctx, 'oauth-device', token.token);
            return;
          }
          const step = nextDevicePollStep(token.error, interval);
          if (step.action === 'fail') {
            throw new Error(step.reason === 'error' ? describeOAuthError(token.error, token.description) : step.reason);
          }
          interval = step.intervalSec;
        }
        throw new Error('expired');
      } catch (err) {
        this.failFlow(entry, err);
      }
    })();

    this.emitFlow(entry);
    return { ...entry.view };
  }

  private async completeFlow(entry: FlowEntry, ctx: OAuthContext, method: 'oauth-browser' | 'oauth-device', token: TokenSet): Promise<void> {
    registerSensitiveValue(token.accessToken);
    registerSensitiveValue(token.refreshToken);
    try {
      let account: ConnectionAccount | null = null;
      let status: ConnectionRecord['status'] = 'connected';
      let rejected = false;
      try {
        const verified = await this.fetchAccount(ctx.service, ctx.baseUrl, `Bearer ${token.accessToken}`, entry.abort.signal);
        rejected = verified.rejected;
        account = verified.account;
      } catch {
        // Сеть или 5xx при проверке: токен получен, подключение сохраняется непроверенным.
        status = 'unchecked';
      }
      if (rejected) throw new AppError('connections.issuedTokenRejected');
      const record = await this.store(
        ctx.reconnectId,
        {
          serviceId: ctx.service.id,
          label: ctx.label,
          baseUrl: ctx.baseUrl,
          method,
          scopes: token.scopes ?? ctx.scopes,
          account: account ?? undefined,
          oauthClientId: ctx.clientId,
          redirectPort: ctx.redirectPort,
          status,
          expiresAt: token.expiresAt,
          lastCheckedAt: status === 'connected' ? this.now() : undefined
        },
        { token: token.accessToken, refreshToken: token.refreshToken, clientSecret: ctx.clientSecret }
      );
      this.setFlow(entry, { state: 'done', connectionId: record.id });
    } finally {
      unregisterSensitiveValue(token.accessToken);
      unregisterSensitiveValue(token.refreshToken);
      if (ctx.clientSecret) unregisterSensitiveValue(ctx.clientSecret);
    }
  }

  private failFlow(entry: FlowEntry, err: unknown): void {
    if (entry.view.state === 'done' || entry.view.state === 'cancelled') return;
    const cancelled = entry.abort.signal.aborted || (err instanceof LoopbackError && err.reason === 'cancelled');
    const message = err instanceof LoopbackError ? err.reason : err instanceof Error ? err.message : String(err);
    if (!cancelled) console.warn(`[Connections] Sign-in to ${entry.view.serviceId} failed: ${describeOAuthError(message)}`);
    this.setFlow(entry, cancelled ? { state: 'cancelled' } : { state: 'error', error: describeOAuthError(message) });
  }

  getFlow(flowId: string): ConnectionFlowView | null {
    const entry = this.flows.get(flowId);
    return entry ? { ...entry.view } : null;
  }

  cancelFlow(flowId: string): ConnectionFlowView | null {
    const entry = this.flows.get(flowId);
    if (!entry) return null;
    if (entry.view.state === 'pending' || entry.view.state === 'exchanging') {
      entry.abort.abort();
      entry.cleanup?.();
      this.setFlow(entry, { state: 'cancelled' });
    }
    return { ...entry.view };
  }

  /** Открыть страницу входа ещё раз. Адрес берётся из main: рендерер передаёт только id хода. */
  async openFlowPage(flowId: string): Promise<boolean> {
    const entry = this.flows.get(flowId);
    if (!entry?.pageUrl || entry.view.state !== 'pending') return false;
    await this.deps.openExternal(entry.pageUrl);
    return true;
  }

  async rename(id: string, label: string): Promise<ConnectionView> {
    const trimmed = String(label ?? '').trim();
    if (!trimmed) throw new AppError('connections.nameEmpty');
    await this.update(id, { label: trimmed.slice(0, 120) });
    return this.viewOf(id);
  }

  /** Обновить токен по refresh-токену. Параллельные вызовы ждут одно обновление. */
  private refresh(record: ConnectionRecord, secret: ConnectionSecret): Promise<ConnectionSecret> {
    const pending = this.refreshing.get(record.id);
    if (pending) return pending;
    const run = (async () => {
      const service = this.serviceOf(record);
      if (!service.oauth || !secret.refreshToken || !record.oauthClientId) {
        await this.markNeedsReauth(record.id, 'token_expired');
        throw new ConnectionAuthError(record.id, 'connections.authExpired');
      }
      const res = await this.send(
        buildRefreshRequest({
          spec: service.oauth,
          baseUrl: record.baseUrl,
          clientId: record.oauthClientId,
          clientSecret: secret.clientSecret,
          refreshToken: secret.refreshToken
        })
      );
      const parsed = parseTokenResponse(res.status, res.contentType, res.text, this.now());
      if (!parsed.ok) {
        const detail = describeOAuthError(parsed.error, parsed.description);
        if (parsed.error === 'invalid_grant' || parsed.error === 'unauthorized_client' || parsed.status === 400 || parsed.status === 401) {
          await this.markNeedsReauth(record.id, detail);
          throw new ConnectionAuthError(record.id, 'connections.authRevoked');
        }
        await this.update(record.id, { status: 'error', statusDetail: detail });
        throw new AppError('connections.tokenRefreshFailed', { detail });
      }
      const next: ConnectionSecret = {
        token: parsed.token.accessToken,
        refreshToken: parsed.token.refreshToken ?? secret.refreshToken,
        clientSecret: secret.clientSecret
      };
      await this.writeSecret(record.id, next);
      await this.update(record.id, { expiresAt: parsed.token.expiresAt, status: 'connected', statusDetail: undefined });
      console.log(`[Connections] Refreshed access token of ${record.id}`);
      return next;
    })();
    this.refreshing.set(record.id, run);
    run.finally(() => this.refreshing.delete(record.id)).catch(() => undefined);
    return run;
  }

  private async markNeedsReauth(id: string, detail: string): Promise<void> {
    console.warn(`[Connections] Connection ${id} needs sign-in again: ${describeOAuthError(detail)}`);
    await this.update(id, { status: 'needsReauth', statusDetail: describeOAuthError(detail) });
  }

  private async freshSecret(record: ConnectionRecord): Promise<ConnectionSecret> {
    const secret = await this.readSecret(record.id);
    if (!secret) {
      await this.markNeedsReauth(record.id, 'secret_missing');
      throw new ConnectionAuthError(record.id, 'connections.tokenMissing');
    }
    if (record.expiresAt && this.now() >= record.expiresAt - REFRESH_SKEW_MS) return this.refresh(record, secret);
    return secret;
  }

  /**
   * Запрос к API сервиса от имени подключения (decision-102 п. 7). `target` — путь относительно API
   * или полный адрес; полный адрес допускается только на origin API подключения. Ответ 401 после
   * попытки обновить токен переводит подключение в `needsReauth` и бросает `ConnectionAuthError`.
   */
  async authorizedFetch(id: string, target: string, init: RequestInit = {}): Promise<Response> {
    const record = await this.getRecord(id);
    if (record.status === 'needsReauth') throw new ConnectionAuthError(id, 'connections.needsReauth');
    const service = this.serviceOf(record);
    if (service.webhookHosts) return this.webhookFetch(record, service, target, init);
    const apiBase = service.apiBase(record.baseUrl);
    const apiOrigin = new URL(apiBase).origin;
    const url = /^https?:\/\//i.test(target) ? new URL(target) : new URL(`${apiBase}${target.startsWith('/') ? '' : '/'}${target}`);
    if (url.origin !== apiOrigin) throw new AppError('connections.apiOriginOnly');

    const attempt = async (secret: ConnectionSecret): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', authorizationHeader(service, record.method, secret, record.username));
      if (!headers.has('Accept')) headers.set('Accept', 'application/json');
      let current = url;
      for (let hop = 0; ; hop += 1) {
        let res: Response;
        try {
          res = await this.deps.fetch(current.toString(), { ...init, headers, redirect: 'manual' });
        } catch (err) {
          throw networkError(err);
        }
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location || hop >= MAX_REDIRECTS) return res;
        const next = new URL(location, current);
        // Токен не уходит на чужой адрес: переход на другой origin возвращается вызывающему как есть.
        if (next.origin !== apiOrigin) return res;
        current = next;
      }
    };

    const secret = await this.freshSecret(record);
    let res = await attempt(secret);
    if (res.status !== 401) return res;
    if (service.oauth && secret.refreshToken) {
      const renewed = await this.refresh(record, secret);
      res = await attempt(renewed);
      if (res.status !== 401) return res;
    }
    await this.markNeedsReauth(id, 'http_401');
    throw new ConnectionAuthError(id, 'connections.authRejected');
  }

  /** Запрос на вебхук (секрет — адрес целиком): только на сам адрес, без `Authorization`, без перехода по редиректу. */
  private async webhookFetch(record: ConnectionRecord, service: ConnectionServiceDef, target: string, init: RequestInit): Promise<Response> {
    if (target && target !== '/') throw new AppError('connections.webhookPathNotAllowed');
    const secret = await this.freshSecret(record);
    const url = webhookTarget(service, secret.token);
    if (!url) throw new AppError('connections.webhookInvalid', { service: service.label });
    try {
      return await this.deps.fetch(url.toString(), { ...init, redirect: 'manual' });
    } catch (err) {
      throw networkError(err);
    }
  }

  /**
   * Исходящий WebSocket подключения (TASK-138.6, decision-113). Путь — относительно API сервиса, токен уходит в
   * `Authorization` (Mattermost `/websocket`). Полный адрес `wss://` — только на `socketHosts` сервиса и без токена:
   * Slack Socket Mode выдаёт адрес с одноразовым билетом через `apps.connections.open`.
   */
  async openWebSocket(id: string, target: string): Promise<ConnectionSocket> {
    if (!this.deps.openSocket) throw new AppError('connections.socketUnavailable');
    const record = await this.getRecord(id);
    if (record.status === 'needsReauth') throw new ConnectionAuthError(id, 'connections.needsReauth');
    const service = this.serviceOf(record);
    if (/^wss?:\/\//i.test(target)) {
      const url = new URL(target);
      if (url.protocol !== 'wss:' || !service.socketHosts?.some((re) => re.test(url.hostname))) {
        throw new AppError('connections.socketOriginOnly');
      }
      return this.deps.openSocket(url.toString(), {});
    }
    const api = new URL(service.apiBase(record.baseUrl));
    const url = new URL(`${api.toString().replace(/\/$/, '')}${target.startsWith('/') ? '' : '/'}${target}`);
    url.protocol = api.protocol === 'http:' ? 'ws:' : 'wss:';
    const secret = await this.freshSecret(record);
    return this.deps.openSocket(url.toString(), { Authorization: authorizationHeader(service, record.method, secret, record.username) });
  }

  /** Проверить подключение: запрос профиля, обновление аккаунта и статуса. */
  async check(id: string): Promise<ConnectionView> {
    const record = await this.getRecord(id);
    const service = this.serviceOf(record);
    try {
      if (record.status === 'needsReauth') return this.viewOf(id);
      if (service.webhookHosts) {
        // Проверка вебхука без публикации: адрес на месте и проходит проверку формы.
        const secret = await this.freshSecret(record);
        const ok = Boolean(webhookTarget(service, secret.token));
        await this.update(id, { status: ok ? 'connected' : 'error', statusDetail: ok ? undefined : 'webhook_invalid', lastCheckedAt: this.now() });
        return this.viewOf(id);
      }
      const res = await this.authorizedFetch(
        id,
        service.verifyPath,
        service.verifyBody ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: service.verifyBody } : {}
      );
      if (!res.ok) {
        await this.update(id, { status: 'error', statusDetail: `http_${res.status}`, lastCheckedAt: this.now() });
      } else {
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          // без JSON — аккаунт прежний
        }
        if (service.rejectedBody?.(json)) {
          await this.markNeedsReauth(id, 'rejected');
          return this.viewOf(id);
        }
        await this.update(id, {
          status: 'connected',
          statusDetail: undefined,
          account: service.parseAccount(json) ?? record.account,
          lastCheckedAt: this.now()
        });
      }
    } catch (err) {
      if (!(err instanceof ConnectionAuthError)) {
        await this.update(id, { status: 'error', statusDetail: describeOAuthError(err instanceof Error ? err.message : String(err)), lastCheckedAt: this.now() });
      }
    }
    return this.viewOf(id);
  }

  /** Отозвать токен у сервиса, где это возможно, затем удалить секрет и запись (decision-102 п. 6). */
  async remove(id: string): Promise<ConnectionRemoveResult> {
    const record = await this.getRecord(id);
    const service = this.serviceOf(record);
    const secret = await this.readSecret(id);
    const manualRevokeUrl = service.manualRevokeUrl?.(record.baseUrl, record.method);
    let remoteRevoke: ConnectionRemoveResult['remoteRevoke'] = 'unsupported';
    if (!secret) {
      remoteRevoke = 'notNeeded';
    } else if (record.method === 'oauth-browser' || record.method === 'oauth-device') {
      const revoke = service.oauth?.revoke;
      try {
        if (revoke?.kind === 'rfc7009' && record.oauthClientId) {
          const form = new URLSearchParams({ token: secret.refreshToken ?? secret.token, client_id: record.oauthClientId });
          if (secret.clientSecret) form.set('client_secret', secret.clientSecret);
          const res = await this.send({
            url: revoke.url(record.baseUrl),
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: form.toString()
          });
          remoteRevoke = res.status >= 200 && res.status < 300 ? 'revoked' : 'failed';
        } else if (revoke?.kind === 'github' && record.oauthClientId && secret.clientSecret) {
          const basic = Buffer.from(`${record.oauthClientId}:${secret.clientSecret}`, 'utf-8').toString('base64');
          const res = await this.send({
            url: `${service.apiBase(record.baseUrl)}/applications/${encodeURIComponent(record.oauthClientId)}/token`,
            method: 'DELETE',
            headers: { Authorization: `Basic ${basic}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: secret.token })
          });
          remoteRevoke = res.status === 204 || res.status === 404 ? 'revoked' : 'failed';
        }
      } catch (err) {
        console.warn(`[Connections] Remote revoke of ${id} failed:`, describeOAuthError(err instanceof Error ? err.message : String(err)));
        remoteRevoke = 'failed';
      }
    }
    await this.dropSecret(id);
    await this.serialize(async () => {
      const data = await this.load();
      data.connections = data.connections.filter((c) => c.id !== id);
      await this.persist();
    });
    console.log(`[Connections] Removed ${service.id} connection ${id}; remote revoke: ${remoteRevoke}`);
    return {
      removed: true,
      remoteRevoke,
      manualRevokeUrl: remoteRevoke === 'revoked' || remoteRevoke === 'notNeeded' ? undefined : manualRevokeUrl
    };
  }

  /** Отменить все незавершённые входы (выход из приложения). */
  dispose(): void {
    for (const entry of this.flows.values()) {
      if (entry.view.state === 'pending' || entry.view.state === 'exchanging') {
        entry.abort.abort();
        entry.cleanup?.();
      }
    }
  }
}

interface OAuthContext {
  service: ConnectionServiceDef;
  spec: OAuthSpec;
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  label?: string;
  redirectPort?: number;
  reconnectId?: string;
}
