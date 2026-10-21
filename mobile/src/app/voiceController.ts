import type { RemoteRoleSummary, RemoteStudioSession, RemoteStudioSessionSummary } from '../../../src/types/remote';
import type { PhoneVoiceCommand } from '../../../src/utils/phoneVoice';
import type { OverviewProject } from '../../../src/utils/fleetOverview';
import { summarizeForSpeech } from '../../../src/services/ttsSummary';
import { dictFor } from '../i18n';
import type { RpcMethod } from '../protocol/remoteClient';
import { sendVoice } from '../protocol/voice';
import {
  describePending,
  describeStatus,
  fleetForVoice,
  localIntent,
  pendingRequests,
  resolveTarget,
  spokenHostName,
  type VoiceContext,
  type VoiceHost,
  type VoiceLang
} from '../protocol/voiceCommands';
import type { TtsPort } from '../platform/types';

/**
 * Голосовой режим телефона (TASK-179, [[decision-137]]): фраза → распознавание и разбор на ПК → исполнение на нужном
 * ПК флота → ответ голосом. Экран только показывает состояние и подаёт звук; вся логика — здесь.
 */

export type VoicePhase = 'idle' | 'recognizing' | 'thinking' | 'speaking';

export interface VoiceLogEntry {
  id: number;
  who: 'you' | 'me';
  text: string;
}

export interface VoiceState {
  phase: VoicePhase;
  lang: VoiceLang;
  log: VoiceLogEntry[];
  /** Телефон ждёт «да» или «нет». */
  confirm: string | null;
  /** «Проект · компьютер» прошлой команды. */
  context: string | null;
}

export interface VoiceDeps {
  /** ПК флота; открытый — первым. */
  hosts(): VoiceHost[];
  activeHostId(): string | null;
  rpc<T>(hostId: string, method: RpcMethod, params?: Record<string, unknown>): Promise<T>;
  onHostEvent(listener: (hostId: string, event: string, data: unknown) => void): () => void;
  tts: TtsPort | null;
}

interface Pending {
  prompt: string;
  run: () => Promise<string>;
}

interface Watch {
  hostId: string;
  projectPath: string;
  project: string;
}

const LOG_MAX = 40;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class VoiceController {
  private state: VoiceState;
  private listeners = new Set<() => void>();
  private seq = 0;
  private ctx: VoiceContext = {};
  private pending: Pending | null = null;
  /** Телефон переспросил компьютер или проект: команда ждёт ответа и выполнится с ним. */
  private resume: { cmd: PhoneVoiceCommand; ask: 'computer' | 'project' } | null = null;
  private lastReply = '';
  /** Сессии Studio, начатые голосом: ответ агента озвучивается, ключ — `hostId|sessionId`. */
  private watches = new Map<string, Watch>();
  /** Конец ответа, пришедший раньше id сессии от `studio_send`. */
  private finishedEarly = new Map<string, { event: string; data: Record<string, unknown> }>();
  private offEvents: () => void;
  /** ПК со старым ProjectHub без `voice_command`. */
  private oldHosts = new Set<string>();
  /** Экран голоса открыт: только тогда новые запросы подтверждения озвучиваются сами. */
  private active = false;

  constructor(
    private readonly deps: VoiceDeps,
    lang: VoiceLang
  ) {
    this.state = { phase: 'idle', lang, log: [], confirm: null, context: null };
    this.offEvents = deps.onHostEvent((hostId, event, data) => this.onHostEvent(hostId, event, data));
  }

  getState = (): VoiceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.offEvents();
    this.deps.tts?.stop();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.stopSpeaking();
  }

  setLang(lang: VoiceLang): void {
    this.set({ lang });
  }

  private set(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private log(who: VoiceLogEntry['who'], text: string): void {
    this.set({ log: [...this.state.log, { id: ++this.seq, who, text }].slice(-LOG_MAX) });
  }

  private get v() {
    return dictFor(this.state.lang).voice;
  }

  /**
   * ПК для распознавания и разбора: открытый, затем остальные на связи с правом записи. ПК со старым ProjectHub без
   * `voice_command` уходят в конец: распознать фразу они могут, разобрать — нет.
   */
  private brains(): VoiceHost[] {
    const hosts = this.deps.hosts().filter((h) => h.ready && h.write);
    const active = this.deps.activeHostId();
    const rank = (h: VoiceHost) => (this.oldHosts.has(h.id) ? 2 : h.id === active ? 0 : 1);
    return [...hosts].sort((a, b) => rank(a) - rank(b));
  }

  private brain(): VoiceHost | null {
    return this.brains()[0] ?? null;
  }

  /** `voice_command` на первом ПК, который его знает. */
  private async parse(params: Record<string, unknown>): Promise<PhoneVoiceCommand | null> {
    for (const host of this.brains()) {
      if (this.oldHosts.has(host.id)) continue;
      try {
        return await this.deps.rpc<PhoneVoiceCommand>(host.id, 'voice_command', params);
      } catch (err) {
        if (!/Unknown RPC method/i.test(errorText(err))) throw err;
        this.oldHosts.add(host.id);
      }
    }
    return null;
  }

  /** Сказать и записать в ленту. Пустой ответ — промолчать. */
  async say(text: string): Promise<void> {
    if (!text) return;
    this.lastReply = text;
    this.log('me', text);
    const tts = this.deps.tts;
    if (!tts) return;
    this.set({ phase: 'speaking' });
    try {
      await tts.speak(text, this.state.lang);
    } catch {
      // Нет голоса или языка в движке — ответ остаётся текстом на экране.
    } finally {
      if (this.state.phase === 'speaking') this.set({ phase: 'idle' });
    }
  }

  stopSpeaking(): void {
    this.deps.tts?.stop();
    if (this.state.phase === 'speaking') this.set({ phase: 'idle' });
  }

  /** Записанная фраза: распознать на ПК и выполнить. */
  async handleAudio(samples: Float32Array): Promise<void> {
    const brain = this.brain();
    if (!brain) return this.say(this.v.noHost);
    this.set({ phase: 'recognizing' });
    let text: string;
    try {
      const res = await sendVoice((params) => this.deps.rpc(brain.id, 'voice_chunk', params), samples, this.state.lang);
      text = res.text.trim();
    } catch (err) {
      this.set({ phase: 'idle' });
      return this.say(this.v.failed(errorText(err)));
    }
    this.set({ phase: 'idle' });
    if (text) await this.handleText(text);
  }

  /** Распознанная фраза. */
  async handleText(text: string): Promise<void> {
    this.log('you', text);
    const local = localIntent(text);
    if (this.pending) {
      if (local === 'yes' || local === 'no') return this.answer(local === 'yes');
      if (local !== 'stop' && local !== 'repeat') return this.say(this.v.sayYesNo);
    }
    if (local === 'stop') {
      this.stopSpeaking();
      this.pending = null;
      this.resume = null;
      this.set({ confirm: null });
      return;
    }
    if (local === 'repeat') return this.say(this.lastReply);
    if (local === 'help') return this.say(this.v.help);
    if (local === 'yes' || local === 'no') return;

    if (!this.brain()) return this.say(this.v.noHost);
    this.set({ phase: 'thinking' });
    const hosts = this.deps.hosts();
    // До первой команды контекст — открытый ПК: модель должна знать, какой компьютер «текущий».
    if (!this.ctx.hostId) {
      const active = hosts.find((h) => h.id === this.deps.activeHostId());
      if (active) this.ctx = { hostId: active.id };
    }
    const ctxHost = hosts.find((h) => h.id === this.ctx.hostId);
    const ctxProject = ctxHost?.overview?.projects.find((p) => p.path === this.ctx.projectPath);
    let cmd: PhoneVoiceCommand | null;
    try {
      cmd = await this.parse({
        text,
        language: this.state.lang,
        computers: fleetForVoice(hosts),
        current: { computer: ctxHost?.name, project: ctxProject?.name },
        ...(this.resume ? { awaiting: this.resume.ask } : {})
      });
    } catch (err) {
      this.set({ phase: 'idle' });
      return this.say(this.v.failed(errorText(err)));
    }
    this.set({ phase: 'idle' });
    if (!cmd) {
      // Ни один ПК на связи не знает `voice_command`: назвать старые и те, что не в сети, — может, нужный просто выключен.
      const names = (list: VoiceHost[]) => list.map((h) => spokenHostName(h.name)).join(', ');
      const old = hosts.filter((h) => this.oldHosts.has(h.id));
      const offline = hosts.filter((h) => !h.ready);
      return this.say([this.v.needUpdate(names(old)), offline.length ? this.v.alsoOffline(names(offline)) : ''].filter(Boolean).join(' '));
    }
    // Ответ на «на каком компьютере?»: отложенная команда получает названное и выполняется.
    if (this.resume && cmd.intent === 'select') {
      const merged: PhoneVoiceCommand = { ...this.resume.cmd, unknownComputer: undefined, unknownProject: undefined, ...pickTarget(cmd) };
      this.resume = null;
      return this.execute(merged);
    }
    this.resume = null;
    return this.execute(cmd);
  }

  /** «Да» или «нет» на переспрос — голосом или кнопкой. */
  async answer(yes: boolean): Promise<void> {
    const p = this.pending;
    this.pending = null;
    this.set({ confirm: null });
    if (!p) return;
    if (!yes) return this.say(this.v.cancelled);
    this.set({ phase: 'thinking' });
    let reply: string;
    try {
      reply = await p.run();
    } catch (err) {
      reply = this.v.failed(errorText(err));
    }
    this.set({ phase: 'idle' });
    return this.say(reply);
  }

  private ask(prompt: string, run: () => Promise<string>): Promise<void> {
    this.pending = { prompt, run };
    this.set({ confirm: prompt });
    return this.say(prompt);
  }

  private remember(host: VoiceHost, project?: OverviewProject): void {
    this.ctx = { hostId: host.id, ...(project ? { projectPath: project.path } : this.ctx.hostId === host.id ? { projectPath: this.ctx.projectPath } : {}) };
    const pc = spokenHostName(host.name);
    const name = project?.name ?? host.overview?.projects.find((p) => p.path === this.ctx.projectPath)?.name;
    this.set({ context: name ? `${name} · ${pc}` : pc });
  }

  private async execute(cmd: PhoneVoiceCommand): Promise<void> {
    const v = this.v;
    const hosts = this.deps.hosts();
    const target = (needs: 'project' | 'computer' | 'write-computer') => {
      const t = resolveTarget(cmd, hosts, this.ctx, needs, v);
      if (t.kind === 'reply' && t.ask) this.resume = { cmd, ask: t.ask };
      return t;
    };

    switch (cmd.intent) {
      case 'unknown':
        return this.say(v.notUnderstood);
      case 'repeat':
        return this.say(this.lastReply);
      case 'help':
        return this.say(v.help);
      case 'stop':
        this.stopSpeaking();
        return;

      case 'status':
      case 'pending': {
        const named = cmd.computer || cmd.project || cmd.unknownComputer || cmd.unknownProject;
        let scope: { host?: VoiceHost; project?: OverviewProject } = {};
        if (named) {
          const t = target(cmd.project || cmd.unknownProject ? 'project' : 'computer');
          if (t.kind === 'reply') return this.say(t.text);
          scope = { host: t.host, project: t.project };
          this.remember(t.host, t.project);
        }
        return this.say(cmd.intent === 'status' ? describeStatus(hosts, scope, v) : describePending(pendingRequests(hosts, scope), v));
      }

      case 'select': {
        const t = target(cmd.project || cmd.unknownProject ? 'project' : 'computer');
        if (t.kind === 'reply') return this.say(t.text);
        this.remember(t.host, t.project);
        return this.say(v.selected(t.project?.name ?? null, spokenHostName(t.host.name)));
      }

      case 'prompt_agent': {
        const t = target('project');
        if (t.kind === 'reply') return this.say(t.text);
        const { host, project } = t;
        const text = cmd.text ?? '';
        this.remember(host, project);
        return this.ask(v.confirmPrompt(text, project!.name, spokenHostName(host.name)), async () => {
          const res = await this.deps.rpc<{ sessionId: string }>(host.id, 'studio_send', { projectPath: project!.path, prompt: text });
          this.watch(host.id, res.sessionId, { hostId: host.id, projectPath: project!.path, project: project!.name });
          return v.sent(project!.name);
        });
      }

      case 'create_task': {
        const t = target('project');
        if (t.kind === 'reply') return this.say(t.text);
        this.remember(t.host, t.project);
        try {
          await this.deps.rpc(t.host.id, 'create_task', { projectPath: t.project!.path, title: cmd.title, description: cmd.description ?? '' });
          return this.say(v.taskCreated(cmd.title ?? '', t.project!.name));
        } catch (err) {
          return this.say(v.failed(errorText(err)));
        }
      }

      case 'start_agent': {
        const t = target('project');
        if (t.kind === 'reply') return this.say(t.text);
        const { host, project } = t;
        this.remember(host, project);
        let roles: RemoteRoleSummary[];
        try {
          roles = await this.deps.rpc<RemoteRoleSummary[]>(host.id, 'get_roles', { projectPath: project!.path });
        } catch (err) {
          return this.say(v.failed(errorText(err)));
        }
        const said = cmd.role?.toLowerCase();
        const role = (said && roles.find((r) => r.slug.toLowerCase().includes(said) || r.name.toLowerCase().includes(said))) || roles[0];
        if (!role) return this.say(v.noRoles(project!.name));
        const taskId = cmd.taskId ?? '';
        return this.ask(v.confirmStart(taskId, role.name, project!.name), async () => {
          await this.deps.rpc(host.id, 'start_assigned_agent', { projectPath: project!.path, taskId, taskTitle: taskId, roleSlug: role.slug });
          return v.agentStarted(taskId, project!.name);
        });
      }

      case 'approve':
      case 'reject': {
        const named = cmd.computer || cmd.project;
        let scope: { host?: VoiceHost; project?: OverviewProject } = {};
        if (named) {
          const t = target(cmd.project ? 'project' : 'computer');
          if (t.kind === 'reply') return this.say(t.text);
          scope = { host: t.host, project: t.project };
        }
        const first = pendingRequests(hosts, scope)[0];
        if (!first) return this.say(v.nothingPending);
        // Опасное одобряется только на экране с биометрией (decision-112); отклонить можно и голосом.
        if (cmd.intent === 'approve' && first.request.risk === 'high') return this.say(v.needScreen);
        const approve = cmd.intent === 'approve';
        const pc = spokenHostName(first.host.name);
        return this.ask(approve ? v.confirmApprove(first.request.title, pc) : v.confirmReject(first.request.title, pc), async () => {
          const res = await this.deps.rpc<{ ok: boolean; reason?: string }>(first.host.id, 'hitl_decision', {
            requestId: first.request.requestId,
            decision: approve ? 'allow' : 'deny',
            confirm: 'app'
          });
          if (res && res.ok === false) return res.reason === 'confirmation_required' ? v.needScreen : v.failed(res.reason ?? '');
          return approve ? v.approved : v.rejected;
        });
      }

      case 'read_answer': {
        const t = target('project');
        if (t.kind === 'reply') return this.say(t.text);
        this.remember(t.host, t.project);
        try {
          const text = await this.lastAnswer(t.host.id, t.project!.path);
          return this.say(text ? v.lastAnswer(t.project!.name, summarizeForSpeech(text, { maxChars: 400 })) : v.noAnswer(t.project!.name));
        } catch (err) {
          return this.say(v.failed(errorText(err)));
        }
      }

      case 'create_project': {
        const t = target('write-computer');
        if (t.kind === 'reply') return this.say(t.text);
        const name = cmd.name ?? '';
        const pc = spokenHostName(t.host.name);
        return this.ask(v.confirmProject(name, pc), async () => {
          await this.deps.rpc(t.host.id, 'create_project', { name, language: this.state.lang });
          this.remember(t.host);
          return v.projectCreated(name, pc);
        });
      }
    }
  }

  private async lastAnswer(hostId: string, projectPath: string, sessionId?: string): Promise<string> {
    let id = sessionId;
    if (!id) {
      const list = await this.deps.rpc<RemoteStudioSessionSummary[]>(hostId, 'studio_list_sessions', { projectPath });
      id = [...(Array.isArray(list) ? list : [])].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
    }
    if (!id) return '';
    const s = await this.deps.rpc<RemoteStudioSession>(hostId, 'studio_get_session', { projectPath, sessionId: id });
    return [...(s?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.text.trim())?.text ?? '';
  }

  private watch(hostId: string, sessionId: string, w: Watch): void {
    const key = `${hostId}|${sessionId}`;
    const early = this.finishedEarly.get(key);
    this.finishedEarly.delete(key);
    if (early) void this.finishWatch(w, sessionId, early.event, early.data);
    else this.watches.set(key, w);
  }

  private onHostEvent(hostId: string, event: string, data: unknown): void {
    const d = (data || {}) as Record<string, unknown>;
    if (event === 'studio:complete' || event === 'studio:error') {
      if (typeof d.sessionId !== 'string') return;
      const key = `${hostId}|${d.sessionId}`;
      const w = this.watches.get(key);
      if (!w) {
        this.finishedEarly.set(key, { event, data: d });
        if (this.finishedEarly.size > 20) this.finishedEarly.delete(this.finishedEarly.keys().next().value!);
        return;
      }
      this.watches.delete(key);
      void this.finishWatch(w, d.sessionId, event, d);
      return;
    }
    if (event === 'ai:hitl' && this.active && !this.pending) {
      const host = this.deps.hosts().find((h) => h.id === hostId);
      const what = typeof d.description === 'string' && d.description ? d.description : typeof d.tool === 'string' ? d.tool : '';
      if (host && what) void this.say(`${this.v.pendingLine(1, spokenHostName(host.name))}. ${this.v.pendingFirst(what)}`);
    }
  }

  private async finishWatch(w: Watch, sessionId: string, event: string, d: Record<string, unknown>): Promise<void> {
    if (event === 'studio:error') return this.say(this.v.agentFailed(w.project, String(d.error ?? '')));
    // Окно записывает сессию на диск после события — даём ему мгновение.
    await new Promise((r) => setTimeout(r, 800));
    try {
      const text = await this.lastAnswer(w.hostId, w.projectPath, sessionId);
      if (text) await this.say(this.v.agentAnswered(w.project, summarizeForSpeech(text, { maxChars: 400 })));
    } catch {
      // ПК пропал — ответ останется в Studio.
    }
  }
}

/** Цель из ответа на переспрос: только названное, чтобы не стереть то, что было в отложенной команде. */
function pickTarget(cmd: PhoneVoiceCommand): Partial<PhoneVoiceCommand> {
  const out: Partial<PhoneVoiceCommand> = {};
  for (const key of ['computer', 'project', 'unknownComputer', 'unknownProject'] as const) if (cmd[key]) out[key] = cmd[key];
  return out;
}
