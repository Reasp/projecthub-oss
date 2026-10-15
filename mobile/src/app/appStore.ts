import type {
  FederationHost,
  RemoteAgentOutput,
  RemoteHostStatus,
  RemotePendingApproval,
  RemoteProcessSummary,
  RemoteProjectSummary,
  RemoteRoleSummary,
  RemoteSwarmSummary,
  RemoteTaskSummary
} from '../../../src/types/remote';
import {
  addHitl,
  appendLog,
  dropHitl,
  hitlFromEvent,
  hitlFromPending,
  hitlRejectReason,
  replaceHitl,
  stripAnsi,
  type HitlItem
} from '../protocol/models';
import type { ClientSnapshot, RpcMethod } from '../protocol/remoteClient';

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

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
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
  studio: { sessionId: string | null; messages: StudioMessage[]; busy: boolean };
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

  constructor(
    private readonly client: RpcPort,
    private readonly prefs: PrefsPort = noopPrefs,
    private readonly debounceMs = 400
  ) {
    this.state = {
      conn: client.getSnapshot(),
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
      studio: { sessionId: null, messages: [], busy: false },
      toast: null
    };
    this.unsubscribers.push(
      client.subscribe((conn) => this.set({ conn })),
      client.onEvent((event, data) => this.handleEvent(event, data))
    );
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
      this.refreshHosts(),
      this.refreshHitl(),
      this.refreshTasks(),
      this.refreshProcesses(),
      this.refreshSwarms(),
      this.refreshGit()
    ]);
  }

  async selectProject(projectPath: string): Promise<void> {
    if (projectPath === this.state.projectPath) return;
    this.set({ projectPath, tasks: [], tasksLoaded: false, processes: [], logs: {}, swarms: [], roles: [], gitBranch: null });
    if (this.state.status) this.prefs.set(`project:${this.state.status.hostId}`, projectPath);
    await Promise.all([this.refreshTasks(), this.refreshProcesses(), this.refreshSwarms(), this.refreshGit()]);
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
    const item = this.state.hitl.find((h) => h.requestId === requestId);
    this.set({ hitl: dropHitl(this.state.hitl, requestId) });
    const res = await this.call<{ ok: boolean; reason?: string }>('hitl_decision', {
      requestId,
      sessionId: item?.sessionId,
      decision: approve ? 'allow' : 'deny',
      ...(reason ? { reason } : {})
    });
    if (!res) {
      // Ошибка доставки — запрос возвращается в очередь, решение можно повторить.
      if (item) this.set({ hitl: addHitl(this.state.hitl, item) });
      return false;
    }
    if (res.ok === false) {
      this.showToast(hitlRejectReason(res.reason), 'error');
      return false;
    }
    this.showToast(approve ? 'Одобрено' : 'Отклонено', 'success');
    return true;
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
      this.showToast('Задача создана', 'success');
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
      this.showToast('Запущено', 'success');
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
      this.showToast('Остановлено', 'success');
      await this.refreshSwarms();
    }
  }

  async startAssignedAgent(taskId: string, taskTitle: string, roleSlug: string, prompt: string): Promise<boolean> {
    const res = await this.call('start_assigned_agent', this.withProject({ taskId, taskTitle, roleSlug, prompt: prompt || undefined }));
    if (res) {
      this.showToast('Агент запущен', 'success');
      await this.refreshSwarms();
    }
    return Boolean(res);
  }

  getAgentOutput(swarmId: string, agentId: string): Promise<RemoteAgentOutput | null> {
    return this.call<RemoteAgentOutput>('get_agent_output', { swarmId, agentId }, true);
  }

  // ── AI Studio ──

  async sendPrompt(prompt: string): Promise<boolean> {
    const text = prompt.trim();
    if (!text || !this.state.projectPath) return false;
    const studio = this.state.studio;
    const userMsg: StudioMessage = { id: `u${Date.now()}`, role: 'user', text };
    this.set({ studio: { ...studio, messages: [...studio.messages, userMsg], busy: true } });
    const res = await this.call<{ sessionId: string; accepted: boolean }>(
      'send_ai_prompt',
      this.withProject({ prompt: text, ...(studio.sessionId ? { sessionId: studio.sessionId } : {}) })
    );
    if (!res) {
      this.set({ studio: { ...this.state.studio, busy: false } });
      return false;
    }
    this.set({ studio: { ...this.state.studio, sessionId: res.sessionId } });
    return true;
  }

  newStudioSession(): void {
    this.set({ studio: { sessionId: null, messages: [], busy: false } });
  }

  private appendAssistant(text: string): void {
    const studio = this.state.studio;
    const last = studio.messages[studio.messages.length - 1];
    const messages =
      last && last.role === 'assistant'
        ? [...studio.messages.slice(0, -1), { ...last, text: last.text + text }]
        : [...studio.messages, { id: `a${Date.now()}`, role: 'assistant' as const, text }];
    this.set({ studio: { ...studio, messages } });
  }

  // ── события хоста ──

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
        if (!d.projectPath || d.projectPath === this.state.projectPath) this.debounced('tasks', () => void this.refreshTasks());
        return;
      case 'projects:changed':
        this.debounced('all', () => void this.refreshAll());
        return;
      case 'ai:chunk':
        if (d.sessionId === this.state.studio.sessionId && typeof d.text === 'string' && d.text) this.appendAssistant(d.text);
        return;
      case 'ai:complete': {
        if (d.sessionId !== this.state.studio.sessionId) return;
        const studio = this.state.studio;
        const last = studio.messages[studio.messages.length - 1];
        const content = (d.message as { content?: unknown } | undefined)?.content;
        // Движок без потоковых кусков — текст приходит целиком в итоговом сообщении.
        if ((!last || last.role !== 'assistant') && typeof content === 'string' && content) this.appendAssistant(content);
        this.set({ studio: { ...this.state.studio, busy: false } });
        return;
      }
      case 'ai:error':
        if (d.sessionId !== this.state.studio.sessionId) return;
        this.set({
          studio: {
            ...this.state.studio,
            busy: false,
            messages: [...this.state.studio.messages, { id: `e${Date.now()}`, role: 'error', text: String(d.error || 'Ошибка агента') }]
          }
        });
        return;
      default:
        if (event.startsWith('agent:')) this.debounced('swarms', () => void this.refreshSwarms());
    }
  }
}
