import type {
  FederationHost,
  RemoteAgentOutput,
  RemoteLaunchCheck,
  RemoteAgentTaskApproval,
  RemoteEnrollment,
  RemoteHitlDetail,
  RemotePendingAgentTask,
  RemoteHostStatus,
  RemotePendingApproval,
  RemoteProcessSummary,
  RemoteProjectSummary,
  RemoteQueueItem,
  RemoteQueueView,
  RemoteRoleSummary,
  RemoteTeam,
  RemoteClaims,
  RemoteStudioOptions,
  RemoteStudioSession,
  RemoteStudioSessionSummary,
  RemoteStudioUsage,
  RemoteSwarmSummary,
  RemoteTaskSummary,
  StudioMode,
  StudioModelSelection
} from '../../../src/types/remote';
import { applyStudioChunk, emptyStudio, markRunning, type StudioMessage, type StudioState } from './studioState';
import {
  addHitl,
  appendLog,
  confirmErrorText,
  dropHitl,
  pushErrorText,
  hitlFromEvent,
  hitlConfirmPayload,
  hitlFromPending,
  hitlRejectReason,
  replaceHitl,
  stripAnsi,
  type HitlItem
} from '../protocol/models';
import type { ClientSnapshot, RpcMethod } from '../protocol/remoteClient';
import type { ConfirmPort, PushPort } from '../platform/types';
import { uploadInChunks, type PreparedAttachment } from '../protocol/attachments';
import { loadInbox, type InboxRpc, type InboxSnapshot } from '../protocol/inbox';
import { sendVoice } from '../protocol/voice';
import type { OverviewSessionKind, RemoteOverview } from '../../../src/utils/fleetOverview';
import { t } from '../i18n';
import { parseScope, SCOPE_PREF, serializeScope, type Scope } from '../protocol/scope';

/**
 * Состояние экранов и действия мобильного клиента (TASK-140.1). Без React: экраны читают его
 * через `useAppState`, а логика проверяется unit-тестами с поддельным клиентом.
 */

/** То, что нужно стору от `RemoteClient`. */
export interface RpcPort {
  rpc<T = unknown>(method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  subscribe(listener: (snapshot: ClientSnapshot) => void): () => void;
  getSnapshot(): ClientSnapshot;
}

export type { StudioMessage } from './studioState';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

/**
 * Переход из экрана «Компьютеры» (TASK-174, decision-129 п. 11): открыть сессию на ПК и в проекте. Если ПК другой,
 * намерение ждёт подключения к нему и применяется после загрузки.
 */
export interface NavIntent {
  hostId: string;
  projectPath: string;
  /** `project` — только выбрать проект на другом ПК; `task` — открыть задачу `sessionId` (путь файла) во «Задачах». */
  kind: OverviewSessionKind | 'project' | 'task';
  sessionId: string;
  agentId?: string;
}

export interface AppState {
  conn: ClientSnapshot;
  status: RemoteHostStatus | null;
  projects: RemoteProjectSummary[];
  projectPath: string;
  hosts: FederationHost[];
  gitBranch: string | null;
  tasks: RemoteTaskSummary[];
  tasksLoaded: boolean;
  processes: RemoteProcessSummary[];
  /** Логи по `processId`. */
  logs: Record<string, string>;
  swarms: RemoteSwarmSummary[];
  roles: RemoteRoleSummary[];
  hitl: HitlItem[];
  /** Задачи агентов всех проектов хоста, ждущие подтверждения. */
  agentTasks: RemotePendingAgentTask[];
  studio: StudioState;
  /** Push с этого ПК на этот телефон (TASK-140.3): `null` — ещё не спрашивали хост. */
  push: { enabled: boolean; busy: boolean } | null;
  /** Лента «Входящих» открытого ПК (TASK-140.5): Review с отчётами и журнал; HITL и задачи агентов — в полях выше. */
  inbox: InboxSnapshot | null;
  /** Общий хост команды (TASK-142.5): кто я и кто что ведёт; `null` — хост без модуля Team или нет проекта. */
  team: RemoteTeam | null;
  /** Захваты задач на origin (decision-152); `null` — хост без модуля Team, `available: false` — у проекта нет origin. */
  claims: RemoteClaims | null;
  /** Очередь слияния проекта (TASK-142.4); `null` — хост без очереди. */
  queue: RemoteQueueView | null;
  /** Дерево открытого ПК (`get_overview`); `null` — ещё не загружено или хост старый. */
  overview: RemoteOverview | null;
  overviewUnsupported: boolean;
  /** Переход к сессии, готовый к показу: экраны открывают её и сбрасывают `consumeNav`. */
  nav: (NavIntent & { seq: number }) | null;
  /** Область нижнего меню (TASK-181): узел дерева «Обзора»; переживает переключение ПК. */
  scope: Scope;
  toast: Toast | null;
}

export interface PrefsPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const noopPrefs: PrefsPort = { get: () => null, set: () => undefined };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppStore {
  private state: AppState;
  private listeners = new Set<() => void>();
  private toastSeq = 0;
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribers: Array<() => void> = [];
  /**
   * Чанки сессий, id которых телефон ещё не знает: промпт в новую сессию — окно начинает отвечать раньше,
   * чем хост вернёт её id. По ответу `studio_send` чанки своей сессии проигрываются.
   */
  private studioBuffer = new Map<string, Array<{ text?: unknown; tool?: unknown }>>();
  private awaitingNewSession = false;
  /** Намерение перехода на другой ПК: переживает `reset()` при переключении хоста. */
  private pendingNav: NavIntent | null = null;
  private navSeq = 0;

  constructor(
    private readonly client: RpcPort,
    private readonly prefs: PrefsPort = noopPrefs,
    private readonly debounceMs = 400,
    /** Подпись решений `high` биометрией (TASK-140.6); только в приложении с нативным плагином. */
    private readonly confirm: ConfirmPort | null = null,
    /** Push с ПК (TASK-140.3); только в приложении с нативным плагином. */
    private readonly push: PushPort | null = null
  ) {
    this.state = { ...AppStore.initialState(client.getSnapshot()), scope: parseScope(prefs.get(SCOPE_PREF)) };
    this.unsubscribers.push(
      client.subscribe((conn) => this.set({ conn })),
      client.onEvent((event, data) => this.handleEvent(event, data))
    );
  }

  private static initialState(conn: ClientSnapshot): AppState {
    return {
      conn,
      status: null,
      projects: [],
      projectPath: '',
      hosts: [],
      gitBranch: null,
      tasks: [],
      tasksLoaded: false,
      processes: [],
      logs: {},
      swarms: [],
      roles: [],
      hitl: [],
      agentTasks: [],
      studio: emptyStudio(),
      push: null,
      inbox: null,
      team: null,
      claims: null,
      queue: null,
      overview: null,
      overviewUnsupported: false,
      nav: null,
      scope: { kind: 'all' },
      toast: null
    };
  }

  /** Переключение на другой хост (TASK-140.2): данные прежнего хоста не должны мелькнуть на экране нового. */
  reset(): void {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    this.studioBuffer.clear();
    this.awaitingNewSession = false;
    this.state = { ...AppStore.initialState(this.client.getSnapshot()), toast: this.state.toast, scope: this.state.scope };
    for (const l of this.listeners) l();
  }

  /** Доступ к соседу по федерации через открытый хост (`federation_enroll`, decision-111). */
  enrollFederationHost(hostId: string): Promise<RemoteEnrollment | null> {
    return this.call<RemoteEnrollment>('federation_enroll', { hostId });
  }

  dispose(): void {
    for (const u of this.unsubscribers) u();
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
  }

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  showToast(text: string, kind: Toast['kind'] = 'info'): void {
    this.set({ toast: { id: ++this.toastSeq, text, kind } });
  }

  dismissToast(id: number): void {
    if (this.state.toast?.id === id) this.set({ toast: null });
  }

  /** RPC с показом ошибки хоста (в т. ч. отказ по правам) вместо молчаливого провала. */
  private async call<T>(method: RpcMethod, params: Record<string, unknown> = {}, quiet = false): Promise<T | null> {
    try {
      return await this.client.rpc<T>(method, params);
    } catch (err) {
      if (!quiet) this.showToast(errorText(err), 'error');
      return null;
    }
  }

  private withProject(params: Record<string, unknown> = {}): Record<string, unknown> {
    return this.state.projectPath ? { projectPath: this.state.projectPath, ...params } : params;
  }

  private debounced(key: string, fn: () => void): void {
    const prev = this.refreshTimers.get(key);
    if (prev) clearTimeout(prev);
    this.refreshTimers.set(
      key,
      setTimeout(() => {
        this.refreshTimers.delete(key);
        fn();
      }, this.debounceMs)
    );
  }

  // ── загрузка ──

  /** Всё, что нужно экранам, после подключения или переподключения. */
  async refreshAll(): Promise<void> {
    const status = await this.call<RemoteHostStatus>('get_status', {}, true);
    if (status) this.set({ status });
    // Хосты до TASK-140.1 отдают записи реестра без имени — берём имя папки.
    const projects = ((await this.call<RemoteProjectSummary[]>('get_projects', {}, true)) ?? []).map((p) => ({
      ...p,
      name: p.name || p.path.split(/[\\/]/).filter(Boolean).pop() || p.path
    }));
    const remembered = status ? this.prefs.get(`project:${status.hostId}`) : null;
    const pick =
      [remembered, this.state.projectPath, status?.activeProjectPath].find((p) => p && projects.some((x) => x.path === p)) ??
      projects[0]?.path ??
      '';
    this.set({ projects, projectPath: pick });
    await Promise.all([
      this.refreshOverview(),
      this.refreshHosts(),
      this.refreshHitl(),
      this.refreshInbox(),
      this.refreshAgentTasks(),
      this.refreshTasks(),
      this.refreshProcesses(),
      this.refreshSwarms(),
      this.refreshGit(),
      this.refreshStudio(),
      this.refreshTeam(),
      this.refreshClaims(),
      this.refreshQueue()
    ]);
    this.applyPendingNav();
  }

  /** Дерево всех проектов открытого ПК одним снимком (decision-129 п. 6). */
  async refreshOverview(): Promise<void> {
    try {
      const overview = await this.client.rpc<RemoteOverview>('get_overview');
      this.set({ overview, overviewUnsupported: false });
    } catch (err) {
      if (/Unknown RPC method/i.test(errorText(err))) this.set({ overview: null, overviewUnsupported: true });
    }
  }

  /**
   * Открыть сессию из экрана «Компьютеры». На открытом ПК — сразу: проект, затем `nav` для экранов. На другом ПК
   * вызывающий переключает хост, а намерение применится после загрузки нового ПК (`applyPendingNav`).
   */
  async requestNav(intent: NavIntent): Promise<void> {
    const hostId = this.state.status?.hostId || this.state.conn.hostId;
    if (hostId && hostId === intent.hostId) {
      await this.selectProject(intent.projectPath);
      this.set({ nav: { ...intent, seq: ++this.navSeq } });
      return;
    }
    this.pendingNav = intent;
    // Проект нового ПК выбирается при загрузке по запомненному — запоминаем нужный заранее.
    this.prefs.set(`project:${intent.hostId}`, intent.projectPath);
  }

  /** Выбрать узел дерева «Обзора» (TASK-181): область запоминается между запусками. */
  setScope(scope: Scope): void {
    this.prefs.set(SCOPE_PREF, serializeScope(scope));
    this.set({ scope });
  }

  /** Переход показан: экран не откроет сессию повторно. */
  consumeNav(seq: number): void {
    if (this.state.nav?.seq === seq) this.set({ nav: null });
  }

  private applyPendingNav(): void {
    const intent = this.pendingNav;
    if (!intent || intent.hostId !== this.state.status?.hostId) return;
    this.pendingNav = null;
    void this.requestNav(intent);
  }

  async selectProject(projectPath: string): Promise<void> {
    if (projectPath === this.state.projectPath) return;
    this.set({
      projectPath,
      tasks: [],
      tasksLoaded: false,
      processes: [],
      logs: {},
      swarms: [],
      roles: [],
      gitBranch: null,
      team: null,
      claims: null,
      queue: null,
      studio: { ...emptyStudio(this.state.studio), sessions: [], sessionsLoaded: false }
    });
    if (this.state.status) this.prefs.set(`project:${this.state.status.hostId}`, projectPath);
    await Promise.all([
      this.refreshTasks(),
      this.refreshProcesses(),
      this.refreshSwarms(),
      this.refreshGit(),
      this.refreshStudio(),
      this.refreshTeam(),
      this.refreshClaims(),
      this.refreshQueue()
    ]);
  }

  async refreshHosts(): Promise<void> {
    const res = await this.call<{ hosts: FederationHost[] }>('get_federation_hosts', {}, true);
    if (res?.hosts) this.set({ hosts: res.hosts });
  }

  async refreshGit(): Promise<void> {
    if (!this.state.projectPath) return;
    const git = await this.call<{ branch?: string } | null>('get_git_status', this.withProject(), true);
    this.set({ gitBranch: git?.branch ?? null });
  }

  // ── HITL ──

  async refreshHitl(): Promise<void> {
    const pending = await this.call<RemotePendingApproval[]>('get_pending_approvals', {}, true);
    if (Array.isArray(pending)) this.set({ hitl: replaceHitl(pending.map(hitlFromPending)) });
  }

  /** Решение строго по `requestId` (TASK-57). Возвращает, принял ли его хост. */
  async decideHitl(requestId: string, approve: boolean, reason?: string): Promise<boolean> {
    // Кнопка в открытом приложении (decision-112): хост сверит способ с классом риска запроса.
    return this.sendHitlDecision(requestId, approve, { confirm: 'app', ...(reason ? { reason } : {}) });
  }

  /** Можно ли подписать решение биометрией: плагин есть, и хост знает ключ подтверждения этого сопряжения. */
  canConfirmBiometric(): boolean {
    return Boolean(this.confirm && this.state.conn.biometricConfirm && this.state.conn.deviceId);
  }

  /** Запрос целиком — команда и дифф — перед одобрением `high` (decision-114 п. 3). */
  loadHitlDetail(requestId: string): Promise<RemoteHitlDetail | null> {
    return this.call<RemoteHitlDetail>('get_hitl_detail', { requestId });
  }

  /**
   * Одобрение с подписью ключом подтверждения (decision-112 п. 4): ОС спрашивает биометрию, ключ подписывает хост,
   * запрос, решение и класс. Отмена биометрии — запрос остаётся в очереди.
   */
  async approveWithBiometric(requestId: string): Promise<boolean> {
    const item = this.state.hitl.find((h) => h.requestId === requestId);
    const hostId = this.state.conn.hostId || this.state.status?.hostId || '';
    if (!item?.risk || !this.confirm || !this.canConfirmBiometric() || !hostId) {
      this.showToast(t().store.biometricNotSetUp, 'error');
      return false;
    }
    let proof: string;
    try {
      proof = await this.confirm.sign(this.state.conn.deviceId, hitlConfirmPayload(hostId, requestId, 'allow', item.risk), {
        title: t().store.biometricTitle,
        subtitle: item.title.slice(0, 120),
        description: item.command ? item.command.slice(0, 300) : (item.filePath ?? '')
      });
    } catch (err) {
      const text = confirmErrorText(err);
      if (text) this.showToast(text, 'error');
      return false;
    }
    return this.sendHitlDecision(requestId, true, { confirm: 'biometric', proof });
  }

  private async sendHitlDecision(requestId: string, approve: boolean, extra: Record<string, unknown>): Promise<boolean> {
    const item = this.state.hitl.find((h) => h.requestId === requestId);
    this.set({ hitl: dropHitl(this.state.hitl, requestId) });
    const res = await this.call<{ ok: boolean; reason?: string }>('hitl_decision', {
      requestId,
      sessionId: item?.sessionId,
      decision: approve ? 'allow' : 'deny',
      ...extra
    });
    if (!res) {
      // Ошибка доставки — запрос возвращается в очередь, решение можно повторить.
      if (item) this.set({ hitl: addHitl(this.state.hitl, item) });
      return false;
    }
    if (res.ok === false) {
      // Хост не принял одобрение по классу риска — запрос по-прежнему ждёт, возвращаем его в список.
      if (res.reason === 'confirmation_required' && item) this.set({ hitl: addHitl(this.state.hitl, item) });
      this.showToast(hitlRejectReason(res.reason), 'error');
      return false;
    }
    this.showToast(approve ? t().store.approved : t().store.rejected, 'success');
    return true;
  }

  // ── «Входящие» (TASK-140.5, decision-117) ──

  /** RPC открытого ПК без тоста — для действий «Входящих», которые сами показывают итог. */
  request<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.rpc<T>(method, params);
  }

  async refreshInbox(): Promise<void> {
    try {
      const inbox = await loadInbox(((method, params) => this.client.rpc(method, params)) as InboxRpc);
      this.set({ inbox });
    } catch {
      // нет связи — остаётся прежний снимок
    }
  }

  /** Убрать записи журнала сразу на экране; ошибка хоста возвращает их. */
  async dismissInbox(ids: string[]): Promise<boolean> {
    const prev = this.state.inbox;
    if (!prev || ids.length === 0) return false;
    const drop = new Set(ids);
    this.set({ inbox: { ...prev, events: prev.events.filter((e) => !drop.has(e.id)) } });
    const res = await this.call<{ removed: number }>('inbox_dismiss', { ids });
    if (!res) this.set({ inbox: prev });
    return Boolean(res);
  }

  // ── задачи агентов, ждущие подтверждения (TASK-155, decision-89 п. 11) ──

  async refreshAgentTasks(): Promise<void> {
    const list = await this.call<RemotePendingAgentTask[]>('get_pending_agent_tasks', {}, true);
    if (Array.isArray(list)) this.set({ agentTasks: list });
  }

  /**
   * Подтвердить задачи агента. Телефон передаёт id тех задач, которые человек видит на экране: задачи,
   * которые агент заведёт позже, этим нажатием не подтверждаются.
   */
  async approveAgentTasks(projectPath: string, taskIds: string[]): Promise<boolean> {
    if (taskIds.length === 0) return false;
    const prev = this.state.agentTasks;
    const keys = new Set(taskIds.map((id) => id.toUpperCase()));
    this.set({ agentTasks: prev.filter((t) => t.projectPath !== projectPath || !keys.has(t.id.toUpperCase())) });
    const res = await this.call<RemoteAgentTaskApproval>('approve_agent_tasks', { projectPath, taskIds });
    if (!res) {
      this.set({ agentTasks: prev });
      return false;
    }
    if (res.approved.length > 0) this.showToast(res.approved.length > 1 ? t().inbox.tasksConfirmed(res.approved.length) : t().store.agentTaskApproved(res.approved[0]), 'success');
    else this.showToast(t().inbox.tasksAlreadyConfirmed, 'info');
    if (projectPath === this.state.projectPath) this.debounced('tasks', () => void this.refreshTasks());
    return res.approved.length > 0;
  }

  // ── задачи ──

  async refreshTasks(): Promise<void> {
    if (!this.state.projectPath) {
      this.set({ tasks: [], tasksLoaded: true });
      return;
    }
    const path = this.state.projectPath;
    const tasks = await this.call<RemoteTaskSummary[]>('get_tasks', { projectPath: path }, true);
    if (this.state.projectPath !== path) return;
    this.set({ tasks: Array.isArray(tasks) ? tasks : this.state.tasks, tasksLoaded: true });
  }

  // ── общий хост команды: свои задачи и очередь слияния (TASK-142.5) ──

  /** Кто я и кто что ведёт. Хост без модуля Team отвечает «Unknown RPC method» — тогда `null`, кнопок команды нет. */
  async refreshTeam(): Promise<void> {
    const path = this.state.projectPath;
    if (!path) return this.set({ team: null });
    const team = await this.call<RemoteTeam>('get_team', { projectPath: path }, true);
    if (this.state.projectPath === path) this.set({ team });
  }

  /** Кто какую задачу взял на origin. Хост без модуля отвечает «Unknown RPC method» — тогда `null`. */
  async refreshClaims(refresh = false): Promise<void> {
    const path = this.state.projectPath;
    if (!path) return this.set({ claims: null });
    const claims = await this.call<RemoteClaims>('get_claims', { projectPath: path, ...(refresh ? { refresh: true } : {}) }, true);
    if (this.state.projectPath === path) this.set({ claims });
  }

  /** Взять задачу на origin: другие копии репозитория увидят, что она занята (decision-152). */
  async claimTask(task: RemoteTaskSummary): Promise<boolean> {
    const res = await this.call<{ alreadyMine?: boolean }>('claim_task', this.withProject({ taskId: task.id }));
    if (res) this.showToast(res.alreadyMine ? t().tasks.claimAlreadyMine : t().tasks.claimed, 'success');
    await Promise.all([this.refreshTasks(), this.refreshClaims()]);
    return Boolean(res);
  }

  /** Отдать задачу на origin; `force` — снять чужой протухший захват (хост проверит возраст). */
  async releaseClaim(task: RemoteTaskSummary, force = false): Promise<boolean> {
    const res = await this.call<{ released?: boolean }>('release_claim', this.withProject({ taskId: task.id, ...(force ? { force: true } : {}) }));
    if (res) this.showToast(res.released ? t().tasks.claimReleased : t().tasks.claimNone, 'info');
    await Promise.all([this.refreshTasks(), this.refreshClaims()]);
    return Boolean(res);
  }

  async refreshQueue(): Promise<void> {
    const path = this.state.projectPath;
    if (!path) return this.set({ queue: null });
    const queue = await this.call<RemoteQueueView>('queue_list', { projectPath: path }, true);
    if (this.state.projectPath === path) this.set({ queue });
  }

  /** Взять задачу себе: исполнитель — я, статус «в работе», на хосте — моя ветка и worktree (decision-126 п. 7). */
  async takeTask(task: RemoteTaskSummary): Promise<boolean> {
    const res = await this.call<{ claimError?: string }>('take_task', this.withProject({ taskId: task.id }));
    // Origin недоступен: задача взята только на хосте, другие копии её занятой не увидят (decision-153).
    if (res?.claimError) this.showToast(t().tasks.takenHostOnly(res.claimError), 'error');
    else if (res) this.showToast(t().tasks.taken, 'success');
    await Promise.all([this.refreshTasks(), this.refreshTeam(), this.refreshClaims()]);
    return Boolean(res);
  }

  async releaseTask(task: RemoteTaskSummary): Promise<boolean> {
    const res = await this.call('release_task', this.withProject({ taskId: task.id }));
    if (res) this.showToast(t().tasks.released, 'info');
    await Promise.all([this.refreshTasks(), this.refreshTeam()]);
    return Boolean(res);
  }

  /** Поставить свою задачу в очередь слияния: работа фиксируется на хосте, задача — в Review. */
  async enqueueTask(task: RemoteTaskSummary): Promise<boolean> {
    const item = await this.call<RemoteQueueItem>('queue_enqueue', this.withProject({ taskId: task.id }));
    if (item) this.showToast(t().tasks.enqueued(item.n), 'success');
    await Promise.all([this.refreshQueue(), this.refreshTasks()]);
    return Boolean(item);
  }

  /** Ревью элемента очереди: одобрить или вернуть автору с комментарием (хост не даст одобрить своё). */
  async reviewQueueItem(itemId: string, approved: boolean, comment = ''): Promise<boolean> {
    const res = await this.call('queue_review', this.withProject({ itemId, approved, ...(comment.trim() ? { comment: comment.trim() } : {}) }));
    if (res) this.showToast(approved ? t().tasks.approved : t().tasks.returned, approved ? 'success' : 'info');
    await Promise.all([this.refreshQueue(), this.refreshTasks()]);
    return Boolean(res);
  }

  async cancelQueueItem(itemId: string): Promise<boolean> {
    const res = await this.call('queue_cancel', this.withProject({ itemId }));
    await Promise.all([this.refreshQueue(), this.refreshTasks()]);
    return Boolean(res);
  }

  async setTaskStatus(task: RemoteTaskSummary, newStatus: string): Promise<boolean> {
    if (task.status === newStatus) return true;
    const prev = this.state.tasks;
    this.set({ tasks: prev.map((t) => (t.filePath === task.filePath ? { ...t, status: newStatus } : t)) });
    const res = await this.call('update_task_status', this.withProject({ filePath: task.filePath, newStatus }));
    if (!res) this.set({ tasks: prev });
    return Boolean(res);
  }

  async toggleCriterion(task: RemoteTaskSummary, index: number, completed: boolean): Promise<boolean> {
    const prev = this.state.tasks;
    this.set({
      tasks: prev.map((t) =>
        t.filePath === task.filePath ? { ...t, criteria: t.criteria.map((c, i) => (i === index ? { ...c, completed } : c)) } : t
      )
    });
    const res = await this.call('toggle_task_criterion', this.withProject({ filePath: task.filePath, index, completed }));
    if (!res) this.set({ tasks: prev });
    return Boolean(res);
  }

  async createTask(title: string, description: string): Promise<boolean> {
    const res = await this.call('create_task', this.withProject({ title, description }));
    if (res) {
      this.showToast(t().store.taskCreated, 'success');
      await this.refreshTasks();
    }
    return Boolean(res);
  }

  // ── процессы ──

  async refreshProcesses(): Promise<void> {
    if (!this.state.projectPath) return;
    const list = await this.call<RemoteProcessSummary[]>('get_processes', this.withProject(), true);
    if (Array.isArray(list)) this.set({ processes: list });
  }

  async stopProcess(processId: string): Promise<void> {
    if (await this.call('stop_process', this.withProject({ processId }))) await this.refreshProcesses();
  }

  async restartProcess(processId: string): Promise<void> {
    if (await this.call('restart_process', this.withProject({ processId }))) await this.refreshProcesses();
  }

  /** Действие проекта из `.projecthub.json` (`run`/`test`/`deploy`) — без произвольной команды с телефона. */
  async runAction(action: string): Promise<boolean> {
    const res = await this.call('run_action', this.withProject({ action }));
    if (res) {
      this.showToast(t().store.actionStarted, 'success');
      await this.refreshProcesses();
    }
    return Boolean(res);
  }

  async loadLogs(proc: RemoteProcessSummary, lines = 200): Promise<void> {
    const text = await this.call<string>('get_process_logs', this.withProject({ processName: proc.name, lines }), true);
    if (typeof text === 'string') this.set({ logs: { ...this.state.logs, [proc.id]: stripAnsi(text) } });
  }

  // ── агенты ──

  async refreshSwarms(): Promise<void> {
    const list = await this.call<RemoteSwarmSummary[]>('get_swarms', this.withProject(), true);
    if (Array.isArray(list)) this.set({ swarms: list });
  }

  async loadRoles(): Promise<void> {
    const roles = await this.call<RemoteRoleSummary[]>('get_roles', this.withProject(), true);
    if (Array.isArray(roles)) this.set({ roles });
  }

  async stopSwarm(swarmId: string): Promise<void> {
    if (await this.call('stop_swarm', { swarmId })) {
      this.showToast(t().store.stopped, 'success');
      await this.refreshSwarms();
    }
  }

  async startAssignedAgent(taskId: string, taskTitle: string, roleSlug: string, prompt: string): Promise<boolean> {
    const res = await this.call('start_assigned_agent', this.withProject({ taskId, taskTitle, roleSlug, prompt: prompt || undefined }));
    if (res) {
      this.showToast(t().store.agentStarted, 'success');
      await this.refreshSwarms();
    }
    return Boolean(res);
  }

  /** Ограничения запуска до нажатия «Запустить» (бюджеты Team, decision-124). Старый хост без метода — `null`. */
  checkAgentLaunch(taskId: string, roleSlug: string): Promise<RemoteLaunchCheck | null> {
    return this.call<RemoteLaunchCheck>('check_agent_launch', this.withProject({ taskId, roleSlug }), true);
  }

  getAgentOutput(swarmId: string, agentId: string): Promise<RemoteAgentOutput | null> {
    return this.call<RemoteAgentOutput>('get_agent_output', { swarmId, agentId }, true);
  }

  // ── Agents Studio (TASK-140.10, decision-83) ──

  private setStudio(patch: Partial<StudioState>): void {
    this.set({ studio: { ...this.state.studio, ...patch } });
  }

  /** Список сессий и выбор моделей; открытая сессия перечитывается (после разрыва — догнать ответ). */
  async refreshStudio(): Promise<void> {
    if (!this.state.projectPath) return;
    await Promise.all([this.refreshStudioSessions(), this.state.studio.options ? Promise.resolve() : this.loadStudioOptions()]);
    if (this.state.studio.sessionId) await this.openStudioSession(this.state.studio.sessionId, true);
  }

  async refreshStudioSessions(): Promise<void> {
    const path = this.state.projectPath;
    if (!path) return;
    const list = await this.call<RemoteStudioSessionSummary[]>('studio_list_sessions', { projectPath: path }, true);
    if (this.state.projectPath !== path || !Array.isArray(list)) return;
    this.setStudio({ sessions: list, sessionsLoaded: true });
  }

  async loadStudioOptions(): Promise<void> {
    const options = await this.call<RemoteStudioOptions>('studio_get_options', {}, true);
    if (!options) return;
    this.setStudio({ options, selection: this.state.studio.selection ?? options.current });
  }

  /** Открыть сессию (вкладку ПК или из истории): история и модель её последнего промпта. */
  async openStudioSession(sessionId: string, quiet = false): Promise<boolean> {
    const path = this.state.projectPath;
    if (!path) return false;
    if (!quiet) this.setStudio({ loading: true });
    const s = await this.call<RemoteStudioSession>('studio_get_session', { projectPath: path, sessionId }, quiet);
    if (this.state.projectPath !== path) return false;
    if (!s) {
      this.setStudio({ loading: false });
      return false;
    }
    this.setStudio({
      sessionId: s.id,
      title: s.title,
      messages: s.messages,
      olderOmitted: s.olderOmitted,
      busy: s.running,
      loading: false,
      selection: s.lastSelection ?? this.state.studio.selection,
      mode: s.lastMode ?? this.state.studio.mode,
      sessionUsage: s.usage ?? null
    });
    return true;
  }

  /** Окно Usage: лимиты Claude Code с ПК. `force` — не из кэша (запускает `claude -p /usage`, до 20 с). */
  async loadUsage(force = false): Promise<void> {
    this.setStudio({ usageLoading: true });
    const usage = await this.call<RemoteStudioUsage>('studio_get_usage', { forceRefresh: force }, !force);
    this.setStudio({ usageLoading: false, ...(usage ? { usage } : {}) });
  }

  /** /clear: очистить открытую сессию так же, как кнопкой на ПК (история и сессия Claude CLI сбрасываются). */
  async clearStudioSession(): Promise<boolean> {
    const { sessionId } = this.state.studio;
    if (!sessionId) {
      this.newStudioSession();
      return true;
    }
    const res = await this.call('studio_clear', this.withProject({ sessionId }));
    if (!res) return false;
    // Не перечитываем с диска: окно пишет сессию с задержкой (1,5 с), и телефон получил бы старую историю.
    if (this.state.studio.sessionId === sessionId) this.setStudio({ messages: [], olderOmitted: 0, title: t().store.newChat, sessionUsage: null });
    this.showToast(t().store.sessionCleared, 'success');
    this.debounced('studioSessions', () => void this.refreshStudioSessions());
    return true;
  }

  newStudioSession(): void {
    this.setStudio({ ...emptyStudio(this.state.studio) });
  }

  setStudioSelection(selection: StudioModelSelection): void {
    this.setStudio({ selection });
  }

  setStudioMode(mode: StudioMode): void {
    this.setStudio({ mode });
  }

  // ── push с этого ПК (TASK-140.3, decision-115) ──

  canPush(): boolean {
    return Boolean(this.push);
  }

  async refreshPush(): Promise<void> {
    if (!this.push) return;
    const res = await this.call<{ enabled: boolean }>('push_status', {}, true);
    if (res) this.set({ push: { enabled: Boolean(res.enabled), busy: false } });
  }

  /**
   * Включить push с открытого ПК: разрешение на уведомления, регистрация у дистрибьютора UnifiedPush с новыми ключами,
   * `push_register` на этом ПК. Другие ПК не затрагиваются — у каждого своя регистрация (`instance` — id профиля).
   */
  async enablePush(instance: string, label: string): Promise<boolean> {
    if (!this.push) return false;
    this.set({ push: { enabled: this.state.push?.enabled ?? false, busy: true } });
    const done = (enabled: boolean, text?: string, kind: Toast['kind'] = 'error') => {
      this.set({ push: { enabled, busy: false } });
      if (text) this.showToast(text, kind);
      return enabled;
    };
    if (!(await this.push.requestPermission())) return done(false, t().store.allowNotifications);
    let data;
    try {
      data = await this.push.register(instance, label);
    } catch (err) {
      return done(false, pushErrorText(err));
    }
    const res = await this.call<{ ok: boolean }>('push_register', {
      kind: data.kind,
      endpoint: data.endpoint,
      p256dh: data.p256dh,
      auth: data.auth,
      actionKey: data.actionKey
    });
    if (!res?.ok) {
      await this.push.unregister(instance);
      return done(false);
    }
    return done(true, t().store.pushEnabled(label), 'success');
  }

  async disablePush(instance: string): Promise<void> {
    if (!this.push) return;
    this.set({ push: { enabled: this.state.push?.enabled ?? false, busy: true } });
    await this.call('push_unregister', {}, true);
    await this.push.unregister(instance);
    this.set({ push: { enabled: false, busy: false } });
  }

  async testPush(): Promise<void> {
    if (await this.call('push_test', {})) this.showToast(t().store.pushTestSent, 'success');
  }

  /**
   * Голосовой промпт (TASK-140.7, decision-121 п. 4): запись распознаёт ПК тем же движком, что голос в окне. `null` —
   * не распознано (тост уже показан), пустая строка — речи не было.
   */
  async transcribeVoice(samples: Float32Array, language: 'ru' | 'en' | 'auto'): Promise<string | null> {
    try {
      const res = await sendVoice((params) => this.client.rpc('voice_chunk', params), samples, language);
      if (!res.text) this.showToast(t().store.voiceNotRecognized, 'info');
      return res.text;
    } catch (err) {
      this.showToast(t().store.voiceFailed(errorText(err)), 'error');
      return null;
    }
  }

  /** Вложение в промпт (TASK-140.6): файл сохраняется в проект на хосте, возвращается путь в проекте. */
  async uploadAttachment(file: PreparedAttachment, onProgress?: (sent: number, total: number) => void): Promise<string | null> {
    if (!this.state.projectPath) return null;
    try {
      return await uploadInChunks((params) => this.client.rpc('studio_attach', this.withProject(params)), file, onProgress);
    } catch (err) {
      this.showToast(t().store.attachmentFailed(file.name, errorText(err)), 'error');
      return null;
    }
  }

  /** Промпт; `attachments` — пути уже загруженных вложений, хост допишет их в промпт для агента. */
  async sendPrompt(prompt: string, attachments: readonly string[] = []): Promise<boolean> {
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || !this.state.projectPath || this.state.studio.busy) return false;
    const studio = this.state.studio;
    const shown = [text, ...attachments.map((p) => `📎 ${p.split('/').pop()}`)].filter(Boolean).join('\n');
    const userMsg: StudioMessage = { id: `u${Date.now()}`, role: 'user', text: shown };
    const isNew = !studio.sessionId;
    this.setStudio({ messages: [...studio.messages, userMsg], busy: true, ...(isNew ? { title: shown.slice(0, 40) } : {}) });
    if (isNew) {
      this.awaitingNewSession = true;
      this.studioBuffer.clear();
    }
    const res = await this.call<{ sessionId: string; accepted: boolean }>(
      'studio_send',
      this.withProject({
        prompt: text,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        ...(studio.sessionId ? { sessionId: studio.sessionId } : {}),
        ...(studio.selection ? { selection: studio.selection } : {}),
        mode: studio.mode
      })
    );
    this.awaitingNewSession = false;
    if (!res) {
      this.studioBuffer.clear();
      // Промпт не принят (занято, нет окна): возвращаем текст в поле ввода, сообщение убираем.
      this.setStudio({ busy: false, messages: this.state.studio.messages.filter((m) => m.id !== userMsg.id) });
      return false;
    }
    let messages = this.state.studio.messages;
    for (const chunk of this.studioBuffer.get(res.sessionId) ?? []) messages = applyStudioChunk(messages, chunk);
    this.studioBuffer.clear();
    this.setStudio({ sessionId: res.sessionId, messages });
    this.debounced('studioSessions', () => void this.refreshStudioSessions());
    return true;
  }

  async abortStudio(): Promise<void> {
    const { sessionId } = this.state.studio;
    if (!sessionId) return;
    if (await this.call('studio_abort', this.withProject({ sessionId }))) this.showToast(t().store.answerStopped, 'info');
  }

  // ── события хоста ──

  /** Поток Agents Studio любой сессии проекта: с ПК или с телефона (TASK-140.10). */
  private handleStudioEvent(event: string, d: Record<string, unknown>): void {
    if (d.projectPath !== this.state.projectPath || typeof d.sessionId !== 'string') return;
    const id = d.sessionId;
    const current = this.state.studio.sessionId === id;

    if (event === 'studio:started') {
      this.setStudio({ sessions: markRunning(this.state.studio.sessions, id, true), ...(current ? { busy: true } : {}) });
      if (!this.state.studio.sessions.some((s) => s.id === id)) this.debounced('studioSessions', () => void this.refreshStudioSessions());
      return;
    }
    if (event === 'studio:chunk') {
      if (current) this.setStudio({ messages: applyStudioChunk(this.state.studio.messages, d) });
      else if (this.awaitingNewSession) {
        const list = this.studioBuffer.get(id) ?? [];
        if (list.length < 500) list.push({ text: d.text, tool: d.tool });
        this.studioBuffer.set(id, list);
      }
      return;
    }
    // Конец ответа: окно уже записало сессию на диск — перечитываем, чтобы текст совпал с ПК.
    const sessions = markRunning(this.state.studio.sessions, id, false);
    if (current) {
      const messages =
        event === 'studio:error'
          ? [...this.state.studio.messages, { id: `e${Date.now()}`, role: 'error' as const, text: String(d.error || t().store.agentError) }]
          : this.state.studio.messages;
      this.setStudio({ sessions, busy: false, messages });
      this.debounced('studioReload', () => {
        if (this.state.studio.sessionId === id) void this.openStudioSession(id, true);
      });
    } else this.setStudio({ sessions });
    this.debounced('studioSessions', () => void this.refreshStudioSessions());
  }

  handleEvent(event: string, data: unknown): void {
    const d = (data || {}) as Record<string, unknown>;
    switch (event) {
      case 'client:ready':
        void this.refreshAll();
        return;
      case 'ai:hitl': {
        const item = hitlFromEvent(data);
        if (item) this.set({ hitl: addHitl(this.state.hitl, item) });
        return;
      }
      case 'ai:hitlDecided':
        if (typeof d.requestId === 'string') this.set({ hitl: dropHitl(this.state.hitl, d.requestId) });
        return;
      case 'inbox:changed':
        this.debounced('inbox', () => void this.refreshInbox());
        return;
      case 'overview:changed':
        this.debounced('overview', () => void this.refreshOverview());
        return;
      case 'agent:finished':
      case 'agent:failed':
        this.debounced('inbox', () => void this.refreshInbox());
        this.debounced('swarms', () => void this.refreshSwarms());
        return;
      case 'process:logChunk':
        if (typeof d.processId === 'string' && typeof d.text === 'string') {
          const prev = this.state.logs[d.processId] ?? '';
          this.set({ logs: { ...this.state.logs, [d.processId]: appendLog(prev, stripAnsi(d.text)) } });
        }
        return;
      case 'process:statusChanged':
        this.debounced('processes', () => void this.refreshProcesses());
        return;
      case 'backlog:changed':
        if (!d.projectPath || d.projectPath === this.state.projectPath) {
          this.debounced('tasks', () => void this.refreshTasks());
          this.debounced('team', () => void this.refreshTeam());
          this.debounced('claims', () => void this.refreshClaims());
        }
        // Задачи агентов и Review во «Входящих» — по всем проектам хоста (TASK-155, TASK-140.5).
        this.debounced('agentTasks', () => void this.refreshAgentTasks());
        this.debounced('inbox', () => void this.refreshInbox());
        return;
      case 'notification':
        if (d.kind === 'agentTask') this.debounced('agentTasks', () => void this.refreshAgentTasks());
        return;
      // Очередь слияния (TASK-142.5): итог автору и просьба о ревью приходят только адресатам.
      case 'queue:notice':
        if (typeof d.title === 'string') this.showToast(`${d.title}${typeof d.body === 'string' && d.body ? ` — ${d.body}` : ''}`, d.kind === 'returned' || d.kind === 'paused' ? 'error' : 'info');
        this.debounced('queue', () => void this.refreshQueue());
        this.debounced('tasks', () => void this.refreshTasks());
        return;
      case 'queue:changed':
        if (!d.projectPath || d.projectPath === this.state.projectPath) this.debounced('queue', () => void this.refreshQueue());
        return;
      case 'projects:changed':
        this.debounced('all', () => void this.refreshAll());
        return;
      case 'studio:started':
      case 'studio:chunk':
      case 'studio:complete':
      case 'studio:error':
        this.handleStudioEvent(event, d);
        return;
      default:
        if (event.startsWith('agent:')) this.debounced('swarms', () => void this.refreshSwarms());
    }
  }
}
