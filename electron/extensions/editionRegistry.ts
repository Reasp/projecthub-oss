import type { HitlAuditEntry, HitlRequest } from '../services/hitlTypes';
import { onAuditAppend } from '../services/hitlAudit';
import { getStatePath } from '../services/appPaths';
import { AppError, withAppErrorKey, type AppErrorKey } from '../../src/lib/appError';
import type { ProjectToolContext, ProjectToolResult } from '../services/projectAgentTools';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Точки расширения для платных модулей `ee/` (TASK-151, decision-123 п. 4). Код открытый (MIT): он не знает ни о
 * бюджетах, ни о командах — только об «ограничениях запуска агента», «итоге запуска» и «методах IPC». В открытой
 * редакции ни одной подписки нет, и все проверки разрешают запуск без примечаний.
 *
 * Модуль `ee/electron/<имя>/index.ts` экспортирует `register(api)`; модули подключает `loadEditionModules`.
 */

/** Кто запускает агента и где — общий контекст проверки перед запуском. */
export interface AgentLaunchContext {
  projectPath: string;
  /** Задача Backlog.md, если запуск по задаче. */
  taskId?: string;
  /** Роль реестра — «агент» в терминах бюджетов. */
  roleSlug?: string;
  roleName?: string;
  engine: string;
  model?: string;
  /** `swarm` — человек из окна или с телефона; `assigned`/`automation` — без нажатия человека. */
  origin: 'swarm' | 'assigned' | 'automation' | 'studio';
  /** Участник общего хоста (TASK-142.1). Пусто — владелец хоста. */
  memberId?: string;
  /** Сколько агентов стартует этим запуском (арена — несколько слотов). */
  slots?: number;
}

export interface LaunchNotice {
  level: 'info' | 'warn' | 'block';
  /** Английский текст — журнал и старые клиенты. */
  text: string;
  /** Код текста (decision-165): окно и телефон показывают примечание на своём языке. */
  textKey?: AppErrorKey;
}

/** Примечание с кодом: английский текст и ключ рядом. */
function keyedNotice(level: LaunchNotice['level'], err: AppError): LaunchNotice {
  return { level, text: err.message, textKey: err.appErrorKey };
}

/** Отказ в запуске исключением: английская причина и её код, если он есть. */
export function launchRefusal(verdict: Pick<AgentLaunchVerdict, 'reason' | 'reasonKey'>): Error {
  if (!verdict.reason) return new AppError('edition.launchBlocked');
  return withAppErrorKey(new Error(verdict.reason), verdict.reasonKey);
}

export interface AgentLaunchVerdict {
  allowed: boolean;
  /** Почему запуск запрещён — первое блокирующее примечание. */
  reason?: string;
  reasonKey?: AppErrorKey;
  /** Потолок расхода запуска в USD: станет бюджетом сессии, если он ниже своего. */
  capUsd?: number;
  notices: LaunchNotice[];
}

/** Итог одного запуска агента (хода цикла «до готовности», слота арены) с расходом за этот запуск. */
export interface AgentRunRecord {
  at: number;
  startedAt: number;
  projectPath: string;
  taskId?: string;
  roleSlug?: string;
  roleName?: string;
  engine: string;
  model?: string;
  origin: AgentLaunchContext['origin'];
  memberId?: string;
  sessionId: string;
  agentId: string;
  status: string;
  costUsd?: number;
  costSource?: string;
  /** Токены оценены по длине текста. */
  estimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Чем закончился результат агента (отчёты о пользе, TASK-146): принят (победитель Arena, цикл
 * «до готовности» дошёл до цели), отклонён (проигравший кандидат, сессия удалена без слияния) или не удался.
 */
export interface AgentOutcomeRecord {
  at: number;
  /** `mergeQueue` — итог задачи в очереди слияния общего хоста (TASK-142.4): слито или возвращено автору. */
  kind: 'arena' | 'doneLoop' | 'discard' | 'mergeQueue';
  verdict: 'accepted' | 'rejected' | 'failed';
  projectPath: string;
  taskId?: string;
  sessionId: string;
  agentId: string;
  roleSlug?: string;
  engine: string;
  model?: string;
  memberId?: string;
  /** Кандидатов в сессии Arena (сравнение «на одной задаче»). */
  candidates?: number;
  /** Итераций цикла «до готовности». */
  iterations?: number;
  /** Какой по счёту заход задачи в очередь слияния: 1 — с первого раза. */
  attempt?: number;
  /** Итог цикла как его называет цикл: success, max_iterations, budget, agent_error… */
  loopOutcome?: string;
  /** Расход агента за всю сессию. */
  costUsd?: number;
  /** Время от создания сессии до итога. */
  durationMs?: number;
}

/** Идущий запуск: сколько он уже потратил с начала этого запуска. */
export interface LiveAgentRun extends Omit<AgentRunRecord, 'at' | 'status'> {
  status: 'running';
}

export type LaunchGuard = (ctx: AgentLaunchContext) => AgentLaunchVerdict | Promise<AgentLaunchVerdict>;

// ── Устройства Remote Control (участники общего хоста, decision-126) ──

export type DeviceRightsName = 'readOnly' | 'hitl' | 'full';

/** Доступ устройства к проекту хоста (TASK-180): `none` — проекта для устройства нет. */
export type ProjectAccessName = 'none' | DeviceRightsName;

const ACCESS_RANK: Record<ProjectAccessName, number> = { none: 0, readOnly: 1, hitl: 2, full: 3 };

function minAccess(a: ProjectAccessName, b: ProjectAccessName): ProjectAccessName {
  return ACCESS_RANK[a] <= ACCESS_RANK[b] ? a : b;
}

/** Устройство, от которого пришёл запрос: права — уже с учётом сужения точками расширения. */
export interface RemoteDeviceRef {
  id: string;
  name?: string;
  /** Чьё это устройство. Пусто — владельца хоста. */
  memberId?: string;
  rights: DeviceRightsName;
}

/** Сопряжённое устройство из справочника хоста. */
export interface PairedDeviceRef {
  deviceId: string;
  name: string;
  memberId?: string;
  rights: DeviceRightsName;
  connected: boolean;
  createdAt: number;
}

export interface DeviceDirectory {
  list(): PairedDeviceRef[];
  /** Отозвать токен и закрыть живое соединение. */
  revoke(deviceId: string): void;
}

/** Код сопряжения, который не PIN и не ключ хоста (приглашение участника): кому выдать устройство и с какими правами. */
export interface PairingRedemption {
  memberId: string;
  rights: DeviceRightsName;
}

export interface RemoteCallContext {
  device: RemoteDeviceRef;
  /** Активный проект хоста для этого запроса. */
  projectPath?: string;
  /** Событие всем подключённым клиентам (например, `backlog:changed`). */
  broadcast(event: string, payload: unknown): void;
}

export interface RemoteMethodSpec {
  /** Метод меняет данные: устройству только для чтения недоступен. */
  write: boolean;
  handler: (params: Record<string, unknown>, ctx: RemoteCallContext) => unknown;
  /**
   * Проект вызова, если он не в `params.projectPath` и не выбранный устройством (элемент очереди по `itemId`):
   * хост проверяет по нему права устройства на проект (TASK-180). `undefined` — проект по умолчанию.
   */
  projectOf?: (params: Record<string, unknown>) => Promise<string | undefined> | string | undefined;
}

// ── Работа участника общего хоста (TASK-142.3, decision-135) ──

/** Кто запустил агента: git-автор его коммитов и доверие к нему. */
export interface LauncherProfile {
  memberId: string;
  name: string;
  email: string;
  /** Может работать без HITL и с терминалом хоста (maintainer и выше). */
  trusted: boolean;
}

/** Личное рабочее дерево участника, в котором идут его агенты и сессии. */
export interface MemberWorkspace {
  worktreePath: string;
  branch: string;
}

export interface LauncherProvider {
  profile(memberId: string): LauncherProfile | null;
  /** Worktree участника для задачи (без задачи — личный). Ошибка — запуск запрещён, без отката в основное дерево. */
  workspace(input: { projectPath: string; memberId: string; taskId?: string }): Promise<MemberWorkspace | null>;
}

/** Запрос HITL для маршрутизации: чей он и когда создан. */
export interface HitlRouteRef {
  memberId?: string;
  createdAt: number;
}

export interface HitlRouting {
  /** Видит ли устройство запрос в момент `now`. */
  visible(request: HitlRouteRef, device: RemoteDeviceRef, now: number): boolean;
  /** Когда запрос становится виден старшим ролям (эскалация), если становится. */
  escalateAt(request: HitlRouteRef): number | undefined;
}

/** Адресное уведомление устройствам: событие клиентам и push тем, кому оно адресовано. */
export interface DeviceNotice {
  id: string;
  /** Событие клиентам Remote Control (телефон, hub-клиент) с данными. */
  event: string;
  payload: unknown;
  /** Текст push-уведомления; без него — только событие. */
  text?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  projectPath?: string;
  /** Заголовок системного уведомления на ПК в hub-режиме (`host:notice`); нет — `text`. */
  title?: string;
  /** Текст под заголовком на ПК в hub-режиме; нет — `text`. */
  body?: string;
  /** Вид уведомления на ПК в hub-режиме — его матрица каналов (`mergeQueue`). Нет — только push телефону. */
  kind?: string;
}

export type DeviceNotifier = (notice: DeviceNotice, audience: (device: RemoteDeviceRef) => boolean) => void;

/** Действие над чужой работой: решить чужой HITL, писать в чужую сессию, остановить чужой рой. */
export type OwnershipAction = 'hitl' | 'session';

const RIGHTS_RANK: Record<DeviceRightsName, number> = { readOnly: 0, hitl: 1, full: 2 };

/** Меньшие из двух прав. */
export function minRights(a: DeviceRightsName, b: DeviceRightsName): DeviceRightsName {
  return RIGHTS_RANK[a] <= RIGHTS_RANK[b] ? a : b;
}
export type IpcHandler = (...args: unknown[]) => unknown;

// ── Инструменты агентов проекта от модулей редакции (TASK-139.5, decision-153) ──

/** Вызов инструмента: проект уже проверен по реестру, HITL и аудит — те же, что у встроенных инструментов. */
export interface EditionToolScope {
  root: string;
  ctx: ProjectToolContext;
  /** Карточка HITL; нет — спросить некого, режим `ask` отказывает. */
  requestApproval?: (request: Omit<HitlRequest, 'id' | 'createdAt'>) => Promise<boolean>;
  audit(decision: 'allow' | 'deny', title: string, filePath?: string, detail?: string): string;
}

export interface EditionAgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Меняет данные: отказ и ошибка пишутся в аудит. */
  write: boolean;
  handler(args: Record<string, unknown>, scope: EditionToolScope): Promise<ProjectToolResult>;
}

export interface EditionMainApi {
  addLaunchGuard(guard: LaunchGuard): void;
  onAgentRun(listener: (record: AgentRunRecord) => void): void;
  /** Итог результата агента: принят, отклонён или не удался. */
  onAgentOutcome(listener: (record: AgentOutcomeRecord) => void): void;
  /** Идущие запуски агентов — чтобы учесть расход, который ещё не попал в итог. */
  liveRuns(): LiveAgentRun[];
  /** Канал IPC рендерера. В ph-agent окна нет, и регистрация там ничего не делает. */
  handleIpc(channel: string, handler: IpcHandler): void;
  /** Сохранить текст через системный диалог окна. Без окна (ph-agent) — { success: false }. */
  saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult>;
  /** Напечатать HTML в PDF (скрытое окно без сети) и сохранить через системный диалог. Без окна — { success: false }. */
  saveHtmlAsPdf(options: SaveHtmlAsPdfOptions): Promise<SaveTextFileResult>;
  /** Сузить права устройства (роль участника). Расширить нельзя: берётся меньшее из исходных и возвращённых. */
  addDeviceRightsLimit(limit: (device: RemoteDeviceRef) => DeviceRightsName): void;
  /** Запрет метода RPC для устройства: ошибка с кодом — причина отказа (decision-165). */
  addRpcGuard(guard: (method: string, device: RemoteDeviceRef) => AppError | null): void;
  /**
   * Сузить доступ устройства к проекту (TASK-180): проекты участника общего хоста. Расширить нельзя — берётся меньшее
   * из прав устройства на проект и возвращённого.
   */
  addProjectAccessLimit(limit: (device: RemoteDeviceRef, projectPath: string) => ProjectAccessName): void;
  /** Погасить код сопряжения, не совпавший с PIN и ключом хоста. */
  setPairingCodeRedeemer(redeem: (input: { code: string; deviceId: string; deviceName: string }) => Promise<PairingRedemption | null>): void;
  /** Свой метод RPC Remote Control (телефон, hub-клиент другого ПК). Имена открытых методов не перекрываются. */
  addRemoteMethod(name: string, spec: RemoteMethodSpec): void;
  /** Сопряжённые устройства хоста. */
  devices(): DeviceDirectory;
  /** Профиль и worktree участника, запустившего агента. */
  setLauncherProvider(provider: LauncherProvider): void;
  /** Кому из устройств показывать запрос HITL и когда звать старших. */
  setHitlRouting(routing: HitlRouting): void;
  /** Запрет действия над работой другого участника: ошибка с кодом — причина отказа (decision-165). */
  addOwnershipGuard(guard: (ownerMemberId: string | undefined, actorMemberId: string | undefined, action: OwnershipAction) => AppError | null): void;
  /** Событие и push только тем устройствам, которым оно адресовано (очередь слияния: автору, ревьюерам). */
  notifyDevices(notice: DeviceNotice, audience: (device: RemoteDeviceRef) => boolean): void;
  /** Инструмент агентов во встроенном MCP рядом с `task_*`/`doc_*`. Имя встроенного инструмента не перекрывается. */
  addAgentTool(tool: EditionAgentTool): void;
  /**
   * MCP-сервер с набором инструментов агента одного проекта — тем же, что у токена агента проекта: задачи, документы,
   * поиск, память, без HITL, процессов и управления компьютером (TASK-195). `null` — встроенный MCP ещё не поднят.
   */
  createProjectMcpServer(projectRoot: string, sessionId: string, memberId?: string): McpServer | null;
  /** Каждая записанная строка аудита HITL (TASK-148): цепочка хэшей и выгрузка в SIEM. */
  onAuditEntry(listener: (entry: HitlAuditEntry) => void): void;
  /** Каталог аудита хоста (`<userData>/audit`). */
  auditDir(): string;
  /** Открыт ли участнику проект хоста (TASK-223: база знаний компании в поиске участника по сети). */
  setMemberProjectAccess(check: (memberId: string, projectPath: string) => boolean): void;
  /** HTTP-маршрут по префиксу пути на сервере удалённого доступа (TASK-228: вход участника через IdP). Ответ пишет обработчик. */
  addHttpRoute(prefix: string, handler: EditionHttpHandler): void;
  /** Ссылка сопряжения по одноразовому коду участника (decision-126): адреса и ключ сессий хоста; `null` — хоста нет. */
  invitePairingUrl(code: string): string | null;
  /** Постоянный Ed25519-ключ хоста (decision-11 п. 1): подпись записей организации (TASK-226). */
  hostIdentity(): Promise<HostIdentity>;
  /** Адрес страницы хоста для другой машины: туннель или первый LAN-адрес; `null` — удалённый доступ выключен. */
  hostOrigin(): string | null;
  /** Запись членства и список отзыва организации для релея (TASK-226). Один поставщик на процесс. */
  setRelayTeamProvider(provider: RelayTeamProvider): void;
  /** Запись или список отзыва изменились: хост переподключается к релею или отправляет новый список. */
  refreshRelayTeam(): void;
}

export interface HostIdentity {
  hostId: string;
  machineName: string;
  publicKeyPem: string;
  /** Подпись Ed25519 строки (UTF-8), base64url. */
  sign(data: string): Promise<string>;
}

/** Ответ релея о членстве хоста в организации: принято или почему нет (`revoked`, `expired`, `bad_signature`…). */
export interface RelayTeamStatus {
  accepted: boolean;
  teamId?: string;
  reason?: string;
  at: number;
}

export interface RelayTeamProvider {
  /** Конверт записи членства (base64url JSON) для query-параметра `team`; `null` — хост не в организации. */
  credential(): string | null;
  /** Подписанный список отзыва, если этот хост — хост команды. */
  revocations(): unknown | null;
  onStatus(status: RelayTeamStatus): void;
}

interface HostServices {
  identity(): Promise<HostIdentity>;
  origin(): string | null;
  refreshRelayTeam(): void;
}

/** Обработчик HTTP-маршрута модуля редакции. */
export type EditionHttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

export interface SaveTextFileOptions {
  title: string;
  defaultName: string;
  content: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveHtmlAsPdfOptions {
  title: string;
  defaultName: string;
  html: string;
}

export interface SaveTextFileResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

/** Итог шлюза модулей редакции: `active: false` — остальные модули `ee/` в этом процессе не регистрируются. */
export interface EditionGateResult {
  active: boolean;
}

export interface EditionMainModule {
  register?: (api: EditionMainApi) => void | Promise<void>;
  /**
   * Шлюз (TASK-200): такой модуль регистрируется первым, и его ответ решает, регистрировать ли остальные. Открытый
   * код не знает, что именно проверяет шлюз; сам шлюз всегда зарегистрирован, чтобы через него можно было всё исправить.
   */
  gate?: () => EditionGateResult | Promise<EditionGateResult>;
}

const guards: LaunchGuard[] = [];
const runListeners: Array<(record: AgentRunRecord) => void> = [];
const outcomeListeners: Array<(record: AgentOutcomeRecord) => void> = [];
let liveRunsProvider: () => LiveAgentRun[] = () => [];
let ipcRegistrar: (channel: string, handler: IpcHandler) => void = () => undefined;
const noWindowSave = async (): Promise<SaveTextFileResult> => ({ success: false, error: 'No window for the save dialog' });
let textFileSaver: (options: SaveTextFileOptions) => Promise<SaveTextFileResult> = noWindowSave;
let pdfSaver: (options: SaveHtmlAsPdfOptions) => Promise<SaveTextFileResult> = noWindowSave;
const rightsLimits: Array<(device: RemoteDeviceRef) => DeviceRightsName> = [];
const rpcGuards: Array<(method: string, device: RemoteDeviceRef) => AppError | null> = [];
const projectAccessLimits: Array<(device: RemoteDeviceRef, projectPath: string) => ProjectAccessName> = [];
let pairingRedeemer: ((input: { code: string; deviceId: string; deviceName: string }) => Promise<PairingRedemption | null>) | null = null;
const remoteMethods = new Map<string, RemoteMethodSpec>();
const emptyDirectory: DeviceDirectory = { list: () => [], revoke: () => undefined };
let deviceDirectory: DeviceDirectory = emptyDirectory;
let launcherProvider: LauncherProvider | null = null;
let hitlRouting: HitlRouting | null = null;
let projectMcpFactory: ((projectRoot: string, sessionId: string, memberId?: string) => McpServer) | null = null;
const ownershipGuards: Array<(ownerMemberId: string | undefined, actorMemberId: string | undefined, action: OwnershipAction) => AppError | null> = [];
let deviceNotifier: DeviceNotifier = () => undefined;
const agentTools = new Map<string, EditionAgentTool>();
let memberProjectAccess: ((memberId: string, projectPath: string) => boolean) | null = null;
const httpRoutes = new Map<string, EditionHttpHandler>();
let invitePairingUrlProvider: ((code: string) => string | null) | null = null;
let hostServices: HostServices | null = null;
let relayTeamProvider: RelayTeamProvider | null = null;

export const editionRegistry = {
  api(): EditionMainApi {
    return {
      addLaunchGuard: (guard) => {
        guards.push(guard);
      },
      onAgentRun: (listener) => {
        runListeners.push(listener);
      },
      onAgentOutcome: (listener) => {
        outcomeListeners.push(listener);
      },
      liveRuns: () => liveRunsProvider(),
      handleIpc: (channel, handler) => ipcRegistrar(channel, handler),
      saveTextFile: (options) => textFileSaver(options),
      saveHtmlAsPdf: (options) => pdfSaver(options),
      addDeviceRightsLimit: (limit) => {
        rightsLimits.push(limit);
      },
      addRpcGuard: (guard) => {
        rpcGuards.push(guard);
      },
      addProjectAccessLimit: (limit) => {
        projectAccessLimits.push(limit);
      },
      setPairingCodeRedeemer: (redeem) => {
        pairingRedeemer = redeem;
      },
      addRemoteMethod: (name, spec) => {
        remoteMethods.set(name, spec);
      },
      devices: () => deviceDirectory,
      setLauncherProvider: (provider) => {
        launcherProvider = provider;
      },
      createProjectMcpServer: (projectRoot, sessionId, memberId) => projectMcpFactory?.(projectRoot, sessionId, memberId) ?? null,
      onAuditEntry: (listener) => onAuditAppend(listener),
      auditDir: () => getStatePath('audit'),
      setMemberProjectAccess: (check) => {
        memberProjectAccess = check;
      },
      setHitlRouting: (routing) => {
        hitlRouting = routing;
      },
      addOwnershipGuard: (guard) => {
        ownershipGuards.push(guard);
      },
      notifyDevices: (notice, audience) => {
        try {
          deviceNotifier(notice, audience);
        } catch (err) {
          console.warn('[edition] Уведомление устройствам не отправлено:', err);
        }
      },
      addAgentTool: (tool) => {
        agentTools.set(tool.name, tool);
      },
      addHttpRoute: (prefix, handler) => {
        if (!/^\/[a-z0-9-]+\/$/.test(prefix)) throw new Error(`HTTP route prefix must look like /name/: ${prefix}`);
        httpRoutes.set(prefix, handler);
      },
      invitePairingUrl: (code) => invitePairingUrlProvider?.(code) ?? null,
      hostIdentity: () => {
        if (!hostServices) return Promise.reject(new Error('Host services are not available'));
        return hostServices.identity();
      },
      hostOrigin: () => hostServices?.origin() ?? null,
      setRelayTeamProvider: (provider) => {
        relayTeamProvider = provider;
      },
      refreshRelayTeam: () => hostServices?.refreshRelayTeam()
    };
  },

  setHostServices(services: HostServices): void {
    hostServices = services;
  },

  /** Конверт записи членства для релея; сбой модуля — хост просто без организации. */
  relayTeamCredential(): string | null {
    try {
      return relayTeamProvider?.credential() ?? null;
    } catch (err) {
      console.warn('[edition] Запись организации не получена:', err);
      return null;
    }
  },

  relayTeamRevocations(): unknown | null {
    try {
      return relayTeamProvider?.revocations() ?? null;
    } catch (err) {
      console.warn('[edition] Список отзыва организации не получен:', err);
      return null;
    }
  },

  emitRelayTeamStatus(status: RelayTeamStatus): void {
    try {
      relayTeamProvider?.onStatus(status);
    } catch (err) {
      console.warn('[edition] Статус организации не принят модулем:', err);
    }
  },

  /** Маршрут модуля редакции для пути запроса; `/sso` без косой черты тоже ведёт в `/sso/`. */
  httpRoute(pathname: string): EditionHttpHandler | undefined {
    for (const [prefix, handler] of httpRoutes) {
      if (pathname.startsWith(prefix) || pathname === prefix.slice(0, -1)) return handler;
    }
    return undefined;
  },

  setInvitePairingUrlProvider(provider: (code: string) => string | null): void {
    invitePairingUrlProvider = provider;
  },

  /** Инструменты агентов от модулей редакции; встроенные с тем же именем отсекает `projectAgentTools`. */
  agentTools(): EditionAgentTool[] {
    return [...agentTools.values()];
  },

  agentTool(name: string): EditionAgentTool | undefined {
    return agentTools.get(name);
  },

  setDeviceNotifier(notifier: DeviceNotifier): void {
    deviceNotifier = notifier;
  },

  /** Профиль участника-запускающего; без модуля или для владельца хоста — `null` (работа как раньше). */
  launcherProfile(memberId: string | undefined): LauncherProfile | null {
    if (!memberId || !launcherProvider) return null;
    try {
      return launcherProvider.profile(memberId);
    } catch (err) {
      console.warn('[edition] Профиль участника не получен:', err);
      return null;
    }
  },

  /**
   * Worktree участника. Ошибку провайдера пробрасывает: агент участника не должен молча уйти в основное дерево
   * хоста (decision-84 п. 4).
   */
  async memberWorkspace(input: { projectPath: string; memberId: string | undefined; taskId?: string }): Promise<MemberWorkspace | null> {
    if (!input.memberId || !launcherProvider) return null;
    return launcherProvider.workspace({ projectPath: input.projectPath, memberId: input.memberId, ...(input.taskId ? { taskId: input.taskId } : {}) });
  },

  /** Видит ли устройство запрос HITL. Без модуля — все одобренные устройства, как раньше. Сбой — не видит. */
  hitlVisible(request: HitlRouteRef, device: RemoteDeviceRef, now: number): boolean {
    if (!hitlRouting) return true;
    try {
      return hitlRouting.visible(request, device, now);
    } catch (err) {
      console.warn('[edition] Маршрут HITL упал:', err);
      return false;
    }
  },

  hitlEscalateAt(request: HitlRouteRef): number | undefined {
    if (!hitlRouting) return undefined;
    try {
      return hitlRouting.escalateAt(request);
    } catch {
      return undefined;
    }
  },

  /** Причина запрета действия над чужой работой (ошибка с кодом) или `null`. Сбой проверки — запрет. */
  checkOwnership(ownerMemberId: string | undefined, actorMemberId: string | undefined, action: OwnershipAction): AppError | null {
    for (const guard of ownershipGuards) {
      try {
        const reason = guard(ownerMemberId, actorMemberId, action);
        if (reason) return reason;
      } catch (err) {
        return new AppError('edition.ownershipCheckFailed', { detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return null;
  },

  /** Права устройства после всех сужений. Сбой ограничения — только чтение: права не должны молча расширяться. */
  deviceRights(device: RemoteDeviceRef): DeviceRightsName {
    let rights = device.rights;
    for (const limit of rightsLimits) {
      try {
        rights = minRights(rights, limit({ ...device, rights }));
      } catch (err) {
        console.warn('[edition] Ограничение прав устройства упало:', err);
        return 'readOnly';
      }
    }
    return rights;
  },

  /**
   * Потолок доступа устройства к проекту от модулей редакции (TASK-180). Без модулей — `full`: доступ задают права
   * устройства. Сбой ограничения — нет доступа: права не должны молча расширяться.
   */
  projectAccessLimit(device: RemoteDeviceRef, projectPath: string): ProjectAccessName {
    let access: ProjectAccessName = 'full';
    for (const limit of projectAccessLimits) {
      try {
        access = minAccess(access, limit(device, projectPath));
      } catch (err) {
        console.warn('[edition] Ограничение доступа к проекту упало:', err);
        return 'none';
      }
    }
    return access;
  },

  /** Причина запрета метода RPC (ошибка с кодом) или `null`. */
  checkRpc(method: string, device: RemoteDeviceRef): AppError | null {
    for (const guard of rpcGuards) {
      try {
        const reason = guard(method, device);
        if (reason) return reason;
      } catch (err) {
        return new AppError('edition.rightsCheckFailed', { detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return null;
  },

  async redeemPairingCode(input: { code: string; deviceId: string; deviceName: string }): Promise<PairingRedemption | null> {
    if (!pairingRedeemer || !input.code) return null;
    try {
      return await pairingRedeemer(input);
    } catch (err) {
      console.warn('[edition] Код сопряжения не погашен:', err);
      return null;
    }
  },

  remoteMethod(name: string): RemoteMethodSpec | undefined {
    return remoteMethods.get(name);
  },

  setDeviceDirectory(directory: DeviceDirectory): void {
    deviceDirectory = directory;
  },

  /** Сводка всех ограничений: блокирует любое, потолок — наименьший, примечания — все по порядку. */
  async checkAgentLaunch(ctx: AgentLaunchContext): Promise<AgentLaunchVerdict> {
    const notices: LaunchNotice[] = [];
    let capUsd: number | undefined;
    for (const guard of guards) {
      let verdict: AgentLaunchVerdict;
      try {
        verdict = await guard(ctx);
      } catch (err) {
        // Сломанное ограничение не должно молча открывать запуск: денег это касается напрямую.
        verdict = { allowed: false, notices: [keyedNotice('block', new AppError('edition.launchCheckFailed', { detail: err instanceof Error ? err.message : String(err) }))] };
      }
      notices.push(...verdict.notices);
      if (!verdict.allowed && !verdict.notices.some((n) => n.level === 'block')) {
        notices.push(verdict.reason ? { level: 'block', text: verdict.reason, ...(verdict.reasonKey ? { textKey: verdict.reasonKey } : {}) } : keyedNotice('block', new AppError('edition.launchBlocked')));
      }
      if (typeof verdict.capUsd === 'number' && verdict.capUsd >= 0) capUsd = capUsd === undefined ? verdict.capUsd : Math.min(capUsd, verdict.capUsd);
    }
    const block = notices.find((n) => n.level === 'block');
    return {
      allowed: !block,
      ...(block ? { reason: block.text, ...(block.textKey ? { reasonKey: block.textKey } : {}) } : {}),
      ...(capUsd !== undefined ? { capUsd } : {}),
      notices
    };
  },

  /** Открыт ли участнику проект; без модуля участников участников нет и проверка проходит. */
  memberCanAccessProject(memberId: string, projectPath: string): boolean {
    try {
      return memberProjectAccess ? memberProjectAccess(memberId, projectPath) : true;
    } catch (err) {
      console.warn('[edition] Проверка доступа участника к проекту упала:', err);
      return false;
    }
  },

  emitAgentRun(record: AgentRunRecord): void {
    for (const listener of runListeners) {
      try {
        listener(record);
      } catch (err) {
        console.warn('[edition] Подписчик итога запуска упал:', err);
      }
    }
  },

  emitAgentOutcome(record: AgentOutcomeRecord): void {
    for (const listener of outcomeListeners) {
      try {
        listener(record);
      } catch (err) {
        console.warn('[edition] Подписчик итога результата упал:', err);
      }
    }
  },

  setLiveRunsProvider(provider: () => LiveAgentRun[]): void {
    liveRunsProvider = provider;
  },

  setIpcRegistrar(registrar: (channel: string, handler: IpcHandler) => void): void {
    ipcRegistrar = registrar;
  },

  setTextFileSaver(saver: (options: SaveTextFileOptions) => Promise<SaveTextFileResult>): void {
    textFileSaver = saver;
  },

  setPdfSaver(saver: (options: SaveHtmlAsPdfOptions) => Promise<SaveTextFileResult>): void {
    pdfSaver = saver;
  },

  /** Фабрику MCP-сервера проекта ставит встроенный MCP при запуске (TASK-195). */
  setProjectMcpFactory(factory: ((projectRoot: string, sessionId: string, memberId?: string) => McpServer) | null): void {
    projectMcpFactory = factory;
  },

  /** Только для тестов: вернуть реестр в состояние открытой редакции. */
  resetForTests(): void {
    projectMcpFactory = null;
    guards.length = 0;
    runListeners.length = 0;
    outcomeListeners.length = 0;
    liveRunsProvider = () => [];
    ipcRegistrar = () => undefined;
    textFileSaver = noWindowSave;
    pdfSaver = noWindowSave;
    rightsLimits.length = 0;
    rpcGuards.length = 0;
    projectAccessLimits.length = 0;
    pairingRedeemer = null;
    remoteMethods.clear();
    deviceDirectory = emptyDirectory;
    launcherProvider = null;
    hitlRouting = null;
    ownershipGuards.length = 0;
    deviceNotifier = () => undefined;
    agentTools.clear();
    memberProjectAccess = null;
  }
};

/**
 * Окружение git для процессов агента участника: автор — участник, коммиттер — ProjectHub Agent (decision-8 п. 1).
 * Так подписываются и коммиты, которые агент делает сам, и авто-коммит результата.
 */
export function launcherGitEnv(profile: LauncherProfile | null): Record<string, string> {
  if (!profile) return {};
  return {
    GIT_AUTHOR_NAME: profile.name,
    GIT_AUTHOR_EMAIL: profile.email,
    GIT_COMMITTER_NAME: AGENT_COMMITTER.name,
    GIT_COMMITTER_EMAIL: AGENT_COMMITTER.email
  };
}

export const AGENT_COMMITTER = { name: 'ProjectHub Agent', email: 'agent@projecthub.local' } as const;

/** Бюджет сессии с учётом потолка ограничений: меньший из двух, если потолок есть. */
export function capSessionBudget(ownBudgetUsd: number | undefined, capUsd: number | undefined): number | undefined {
  const own = typeof ownBudgetUsd === 'number' && ownBudgetUsd > 0 ? ownBudgetUsd : undefined;
  if (capUsd === undefined) return own;
  // Потолок 0 у разрешённого запуска невозможен (тогда запуск блокирован), но на всякий случай — минимальный бюджет.
  const cap = Math.max(capUsd, 0.000001);
  return own === undefined ? cap : Math.min(own, cap);
}
