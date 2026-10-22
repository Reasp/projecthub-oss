import type {
  RemoteAgentOutput,
  RemoteInbox,
  RemoteProcessSummary,
  RemoteReviewItem,
  RemoteRoleSummary,
  RemoteStudioUsage,
  RemoteTaskSummary
} from '../../../src/types/remote';
import { overviewRequestTitle, type OverviewProject, type OverviewSession } from '../../../src/utils/fleetOverview';
import type { PhoneVoiceCommand, PhoneVoiceIntent, PhoneVoiceScreen } from '../../../src/utils/phoneVoice';
import { summarizeForSpeech } from '../../../src/services/ttsSummary';
import { dictFor, type Dict } from '../i18n';
import type { RpcMethod } from '../protocol/remoteClient';
import {
  describePending,
  describeStatus,
  pendingRequests,
  spokenHostName,
  type VoiceHost,
  type VoiceTarget
} from '../protocol/voiceCommands';

/**
 * Действия голосового режима ([[decision-137]] п. 4–7): обработчик на каждый интент каталога `phoneVoice.ts`. Новая
 * голосовая функция — запись в каталоге и обработчик здесь; контроллер о ней не знает. Обработчик говорит только через
 * контекст: переспросить, подтвердить, ответить, перейти на экран.
 */

export interface VoiceWatch {
  hostId: string;
  projectPath: string;
  project: string;
}

/** Переход на экран телефона голосом: на другом ПК — с переключением на него. */
export interface VoiceNav {
  screen: PhoneVoiceScreen;
  /** id профиля ПК; пусто — открытый. */
  profileId?: string;
  /** `hostId` хоста для `requestNav`. */
  hostId?: string;
  projectPath?: string;
}

export interface VoiceActionContext {
  cmd: PhoneVoiceCommand;
  hosts: VoiceHost[];
  v: Dict['voice'];
  lang: 'ru' | 'en';
  say(text: string): Promise<void>;
  /** Переспросить «да или нет»; `run` выполнится после «да» и вернёт ответ. */
  ask(prompt: string, run: () => Promise<string>): Promise<void>;
  /** Компьютер и проект команды; `reply` — что сказать вместо действия (и переспрос, если нужен). */
  target(needs: 'project' | 'computer' | 'write-computer'): VoiceTarget;
  remember(host: VoiceHost, project?: OverviewProject): void;
  rpc<T>(hostId: string, method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
  lastAnswer(hostId: string, projectPath: string, sessionId?: string): Promise<string>;
  watch(hostId: string, sessionId: string, w: VoiceWatch): void;
  /** Агент на задаче запущен голосом: его конец озвучивается (`agent:finished` / `agent:failed`). */
  watchAgent(w: VoiceWatch): void;
  /** Сессия Studio, начатая голосом в этом проекте: следующий промпт продолжает её. */
  voiceSession(hostId: string, projectPath: string): string | undefined;
  setVoiceSession(hostId: string, projectPath: string, sessionId: string): void;
  navigate(nav: VoiceNav): void;
  lastReply(): string;
  stopSpeaking(): void;
}

export type VoiceAction = (c: VoiceActionContext) => Promise<void>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Действие над проектом: найти цель, запомнить её, выполнить; ошибка RPC — сказать, а не упасть. */
function inProject(fn: (c: VoiceActionContext, host: VoiceHost, project: OverviewProject) => Promise<void>): VoiceAction {
  return async (c) => {
    const t = c.target('project');
    if (t.kind === 'reply') return c.say(t.text);
    c.remember(t.host, t.project);
    try {
      await fn(c, t.host, t.project!);
    } catch (err) {
      await c.say(c.v.failed(errorText(err)));
    }
  };
}

/** Область вопроса: названные компьютер или проект, иначе весь флот. */
function scopeOf(c: VoiceActionContext): { host?: VoiceHost; project?: OverviewProject } | string {
  const { cmd } = c;
  if (!(cmd.computer || cmd.project || cmd.unknownComputer || cmd.unknownProject)) return {};
  const t = c.target(cmd.project || cmd.unknownProject ? 'project' : 'computer');
  if (t.kind === 'reply') return t.text;
  c.remember(t.host, t.project);
  return { host: t.host, project: t.project };
}

const statusLabel = (c: VoiceActionContext, status: string) => c.v.statuses[status] ?? status;

const taskLine = (t: RemoteTaskSummary) => `${t.id} ${t.title}`;

function findTask(tasks: readonly RemoteTaskSummary[], id: string | undefined): RemoteTaskSummary | undefined {
  return id ? tasks.find((t) => t.id.toLowerCase() === id.toLowerCase()) : undefined;
}

/** Работающие или ждущие агенты проекта из снимка: Studio и рои. */
function liveAgents(project: OverviewProject): OverviewSession[] {
  return project.sessions.filter((s) => s.kind !== 'terminal' && (s.state === 'running' || s.state === 'waiting'));
}

async function reviewItems(c: VoiceActionContext, hosts: VoiceHost[]): Promise<Array<{ host: VoiceHost; item: RemoteReviewItem }>> {
  const out: Array<{ host: VoiceHost; item: RemoteReviewItem }> = [];
  for (const host of hosts) {
    const inbox = await c.rpc<RemoteInbox>(host.id, 'get_inbox').catch(() => null);
    for (const item of inbox?.review ?? []) out.push({ host, item });
  }
  return out;
}

const review = (accept: boolean): VoiceAction => async (c) => {
  const scope = scopeOf(c);
  if (typeof scope === 'string') return c.say(scope);
  const hosts = (scope.host ? [scope.host] : c.hosts).filter((h) => h.ready && h.write);
  const items = (await reviewItems(c, hosts)).filter(({ item }) => !scope.project || item.projectPath === scope.project.path);
  const found = c.cmd.taskId ? items.find(({ item }) => item.id.toLowerCase() === c.cmd.taskId!.toLowerCase()) : items[0];
  if (!found) return c.say(c.cmd.taskId ? c.v.taskNotFound(c.cmd.taskId) : c.v.nothingInReview);
  const { host, item } = found;
  const comment = c.cmd.comment ?? '';
  return c.ask(accept ? c.v.confirmAccept(item.id, item.title) : c.v.confirmReturn(item.id, comment), async () => {
    await c.rpc(host.id, 'review_task', {
      action: accept ? 'done' : 'return',
      projectPath: item.projectPath,
      taskId: item.id,
      ...(comment ? { comment } : {}),
      ...(!accept && item.roleSlug ? { restart: true } : {})
    });
    return accept ? c.v.accepted(item.id) : c.v.returned(item.id);
  });
};

const decide = (approve: boolean): VoiceAction => async (c) => {
  const scope = scopeOf(c);
  if (typeof scope === 'string') return c.say(scope);
  const first = pendingRequests(c.hosts, scope)[0];
  if (!first) return c.say(c.v.nothingPending);
  // Опасное одобряется только на экране с биометрией (decision-112); отклонить можно и голосом.
  if (approve && first.request.risk === 'high') return c.say(c.v.needScreen);
  const pc = spokenHostName(first.host.name);
  const title = overviewRequestTitle(first.request, dictFor(c.lang).models.hitlText);
  return c.ask(approve ? c.v.confirmApprove(title, pc) : c.v.confirmReject(title, pc), async () => {
    const res = await c.rpc<{ ok: boolean; reason?: string }>(first.host.id, 'hitl_decision', {
      requestId: first.request.requestId,
      decision: approve ? 'allow' : 'deny',
      confirm: 'app'
    });
    if (res && res.ok === false) return res.reason === 'confirmation_required' ? c.v.needScreen : c.v.failed(res.reason ?? '');
    return approve ? c.v.approved : c.v.rejected;
  });
};

const git = (method: 'git_push' | 'git_pull'): VoiceAction =>
  inProject(async (c, host, project) => {
    const pc = spokenHostName(host.name);
    return c.ask(method === 'git_push' ? c.v.confirmPush(project.name, pc) : c.v.confirmPull(project.name, pc), async () => {
      await c.rpc(host.id, method, { projectPath: project.path });
      return method === 'git_push' ? c.v.pushed : c.v.pulled;
    });
  });

export const VOICE_ACTIONS: Record<PhoneVoiceIntent, VoiceAction> = {
  unknown: (c) => c.say(c.v.notUnderstood),
  repeat: (c) => c.say(c.lastReply()),
  help: (c) => c.say(c.v.help),
  stop: async (c) => c.stopSpeaking(),

  status: async (c) => {
    const scope = scopeOf(c);
    return c.say(typeof scope === 'string' ? scope : describeStatus(c.hosts, scope, c.v));
  },
  pending: async (c) => {
    const scope = scopeOf(c);
    return c.say(typeof scope === 'string' ? scope : describePending(pendingRequests(c.hosts, scope), c.v, dictFor(c.lang).models.hitlText));
  },
  select: async (c) => {
    const t = c.target(c.cmd.project || c.cmd.unknownProject ? 'project' : 'computer');
    if (t.kind === 'reply') return c.say(t.text);
    c.remember(t.host, t.project);
    return c.say(c.v.selected(t.project?.name ?? null, spokenHostName(t.host.name)));
  },

  prompt_agent: inProject(async (c, host, project) => {
    const text = c.cmd.text ?? '';
    const continued = c.cmd.session === 'new' ? undefined : c.voiceSession(host.id, project.path);
    return c.ask(c.v.confirmPrompt(text, project.name, spokenHostName(host.name)), async () => {
      const res = await c.rpc<{ sessionId: string }>(host.id, 'studio_send', {
        projectPath: project.path,
        prompt: text,
        ...(continued ? { sessionId: continued } : {})
      });
      c.setVoiceSession(host.id, project.path, res.sessionId);
      c.watch(host.id, res.sessionId, { hostId: host.id, projectPath: project.path, project: project.name });
      return c.v.sent(project.name);
    });
  }),

  create_task: inProject(async (c, host, project) => {
    await c.rpc(host.id, 'create_task', { projectPath: project.path, title: c.cmd.title, description: c.cmd.description ?? '' });
    return c.say(c.v.taskCreated(c.cmd.title ?? '', project.name));
  }),

  start_agent: inProject(async (c, host, project) => {
    const roles = await c.rpc<RemoteRoleSummary[]>(host.id, 'get_roles', { projectPath: project.path });
    const said = c.cmd.role?.toLowerCase();
    const role = (said && roles.find((r) => r.slug.toLowerCase().includes(said) || r.name.toLowerCase().includes(said))) || roles[0];
    if (!role) return c.say(c.v.noRoles(project.name));
    const taskId = c.cmd.taskId ?? '';
    return c.ask(c.v.confirmStart(taskId, role.name, project.name), async () => {
      await c.rpc(host.id, 'start_assigned_agent', { projectPath: project.path, taskId, taskTitle: taskId, roleSlug: role.slug });
      c.watchAgent({ hostId: host.id, projectPath: project.path, project: project.name });
      return c.v.agentStarted(taskId, project.name);
    });
  }),

  approve: decide(true),
  reject: decide(false),

  read_answer: inProject(async (c, host, project) => {
    const text = await c.lastAnswer(host.id, project.path);
    return c.say(text ? c.v.lastAnswer(project.name, summarizeForSpeech(text, { maxChars: 400 })) : c.v.noAnswer(project.name));
  }),

  create_project: async (c) => {
    const t = c.target('write-computer');
    if (t.kind === 'reply') return c.say(t.text);
    const name = c.cmd.name ?? '';
    const pc = spokenHostName(t.host.name);
    return c.ask(c.v.confirmProject(name, pc), async () => {
      await c.rpc(t.host.id, 'create_project', { name, language: c.lang });
      c.remember(t.host);
      return c.v.projectCreated(name, pc);
    });
  },

  list_tasks: inProject(async (c, host, project) => {
    const tasks = await c.rpc<RemoteTaskSummary[]>(host.id, 'get_tasks', { projectPath: project.path });
    const status = c.cmd.status;
    if (status) {
      const list = tasks.filter((t) => t.status === status);
      if (list.length === 0) return c.say(c.v.noTasks(statusLabel(c, status), project.name));
      return c.say(c.v.tasksList(statusLabel(c, status), project.name, list.length, list.slice(0, 5).map(taskLine).join('; ')));
    }
    const parts = (['In Progress', 'Review', 'To Do'] as const)
      .map((s) => [s, tasks.filter((t) => t.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => c.v.tasksCount(n, statusLabel(c, s)));
    return c.say(parts.length ? c.v.tasksAll(project.name, parts.join(', ')) : c.v.noTasks(statusLabel(c, 'In Progress'), project.name));
  }),

  move_task: inProject(async (c, host, project) => {
    const tasks = await c.rpc<RemoteTaskSummary[]>(host.id, 'get_tasks', { projectPath: project.path });
    const task = findTask(tasks, c.cmd.taskId);
    if (!task) return c.say(c.v.taskNotFound(c.cmd.taskId ?? ''));
    const status = c.cmd.status ?? '';
    await c.rpc(host.id, 'update_task_status', { projectPath: project.path, filePath: task.filePath, newStatus: status });
    return c.say(c.v.taskMoved(task.id, statusLabel(c, status)));
  }),

  review_accept: review(true),
  review_return: review(false),

  run_action: inProject(async (c, host, project) => {
    const action = c.cmd.action ?? '';
    const run = async () => {
      await c.rpc(host.id, 'run_action', { projectPath: project.path, action });
      return c.v.actionStarted(action, project.name);
    };
    // Деплой меняет внешний мир — только с подтверждением; запуск и тесты — сразу.
    if (action === 'deploy') return c.ask(c.v.confirmAction(action, project.name, spokenHostName(host.name)), run);
    return c.say(await run());
  }),

  stop_process: inProject(async (c, host, project) => {
    const running = (await c.rpc<RemoteProcessSummary[]>(host.id, 'get_processes', { projectPath: project.path })).filter((p) => p.status === 'running');
    if (running.length === 0) return c.say(c.v.noProcesses(project.name));
    const said = c.cmd.process?.toLowerCase();
    const proc = said ? running.find((p) => p.name.toLowerCase().includes(said)) : running.length === 1 ? running[0] : undefined;
    if (!proc) return c.say(c.v.whichProcess(running.map((p) => p.name).join(', ')));
    return c.ask(c.v.confirmStopProcess(proc.name, project.name), async () => {
      await c.rpc(host.id, 'stop_process', { projectPath: project.path, processId: proc.id });
      return c.v.processStopped(proc.name);
    });
  }),

  stop_agent: inProject(async (c, host, project) => {
    const agent = liveAgents(project)[0];
    if (!agent) return c.say(c.v.noRunningAgent(project.name));
    return c.ask(c.v.confirmStopAgent(agent.title, project.name), async () => {
      if (agent.kind === 'studio') await c.rpc(host.id, 'studio_abort', { projectPath: project.path, sessionId: agent.id });
      else await c.rpc(host.id, 'stop_swarm', { swarmId: agent.id });
      return c.v.agentStopped;
    });
  }),

  agent_output: inProject(async (c, host, project) => {
    const agents = liveAgents(project);
    const agent = c.cmd.taskId ? project.sessions.find((s) => s.taskId?.toLowerCase() === c.cmd.taskId!.toLowerCase()) : agents[0];
    if (!agent) return c.say(c.cmd.taskId ? c.v.noAgentOnTask(c.cmd.taskId) : c.v.noRunningAgent(project.name));
    let text: string;
    if (agent.kind === 'swarm' && agent.agentId) {
      const out = await c.rpc<RemoteAgentOutput>(host.id, 'get_agent_output', { swarmId: agent.id, agentId: agent.agentId });
      text = out.text.slice(-1500);
    } else text = await c.lastAnswer(host.id, project.path, agent.id);
    return c.say(c.v.agentOutput(agent.agentName ?? agent.title, summarizeForSpeech(text || agent.detail || '', { maxChars: 300 })));
  }),

  git_status: inProject(async (c, host, project) => {
    const git = await c.rpc<{ currentBranch: string; files: unknown[]; isClean: boolean } | null>(host.id, 'get_git_status', { projectPath: project.path });
    if (!git) return c.say(c.v.noGit(project.name));
    return c.say(git.isClean ? c.v.gitClean(git.currentBranch) : c.v.gitStatus(git.currentBranch, git.files.length));
  }),

  git_commit: inProject(async (c, host, project) => {
    const message = c.cmd.message ?? '';
    return c.ask(c.v.confirmCommit(message, project.name), async () => {
      await c.rpc(host.id, 'git_commit', { projectPath: project.path, message, stageAll: true });
      return c.v.committed;
    });
  }),
  git_push: git('git_push'),
  git_pull: git('git_pull'),

  usage: async (c) => {
    const t = c.target('computer');
    if (t.kind === 'reply') return c.say(t.text);
    try {
      const u = await c.rpc<RemoteStudioUsage>(t.host.id, 'studio_get_usage', {});
      const parts = [
        u.sessionLimit ? c.v.usageSession(Math.round(u.sessionLimit.percent)) : '',
        u.weeklyLimit ? c.v.usageWeekly(Math.round(u.weeklyLimit.percent)) : ''
      ].filter(Boolean);
      return c.say(parts.length ? c.v.usageLine(parts.join(', ')) : c.v.usageUnknown);
    } catch (err) {
      return c.say(c.v.failed(errorText(err)));
    }
  },

  inbox: async (c) => {
    const scope = scopeOf(c);
    if (typeof scope === 'string') return c.say(scope);
    const lines: string[] = [];
    for (const host of (scope.host ? [scope.host] : c.hosts).filter((h) => h.ready)) {
      const inbox = await c.rpc<RemoteInbox>(host.id, 'get_inbox').catch(() => null);
      if (!inbox) continue;
      const parts = [
        inbox.review.length ? c.v.inboxReview(inbox.review.length) : '',
        inbox.hitl.length ? c.v.inboxHitl(inbox.hitl.length) : '',
        inbox.agentTasks.length ? c.v.inboxAgentTasks(inbox.agentTasks.length) : ''
      ].filter(Boolean);
      if (parts.length) lines.push(c.v.inboxLine(spokenHostName(host.name), parts.join(', ')));
    }
    return c.say(lines.length ? lines.join(' ') : c.v.inboxEmpty);
  },

  open_screen: async (c) => {
    const screen = c.cmd.screen as PhoneVoiceScreen;
    let nav: VoiceNav = { screen };
    if (c.cmd.computer || c.cmd.project || c.cmd.unknownComputer || c.cmd.unknownProject) {
      const t = c.target(c.cmd.project || c.cmd.unknownProject ? 'project' : 'computer');
      if (t.kind === 'reply') return c.say(t.text);
      c.remember(t.host, t.project);
      // Проект не назван, а на компьютере он один — переходим сразу в него.
      const projects = t.host.overview?.projects ?? [];
      const project = t.project ?? (projects.length === 1 ? projects[0] : undefined);
      nav = { screen, profileId: t.host.id, hostId: t.host.overview?.hostId, projectPath: project?.path };
    }
    await c.say(c.v.opening(c.v.screens[screen] ?? screen));
    c.navigate(nav);
  }
};
