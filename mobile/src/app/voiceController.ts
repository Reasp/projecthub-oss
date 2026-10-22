import type { RemoteStudioSession, RemoteStudioSessionSummary } from '../../../src/types/remote';
import type { PhoneVoiceCommand } from '../../../src/utils/phoneVoice';
import type { OverviewProject } from '../../../src/utils/fleetOverview';
import { summarizeForSpeech } from '../../../src/services/ttsSummary';
import { dictFor } from '../i18n';
import type { RpcMethod } from '../protocol/remoteClient';
import { sendVoice } from '../protocol/voice';
import {
  fleetForVoice,
  localIntent,
  resolveTarget,
  stripWakeWord,
  spokenHostName,
  type VoiceContext,
  type VoiceHost,
  type VoiceLang
} from '../protocol/voiceCommands';
import { hitlFromEvent, hitlText } from '../protocol/models';
import type { TtsPort } from '../platform/types';
import { VOICE_ACTIONS, type VoiceActionContext, type VoiceNav, type VoiceWatch } from './voiceActions';
import { errorText } from './errorText';

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
  /** В постоянном слушании команда — только после обращения «Хаб». */
  wake: boolean;
  /** Голосом попросили открыть экран: приложение переходит и закрывает голосовой режим. */
  nav: (VoiceNav & { seq: number }) | null;
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

const LOG_MAX = 40;

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
  private watches = new Map<string, VoiceWatch>();
  /** Агенты на задачах, запущенные голосом, по `hostId|projectPath`: конец работы озвучивается один раз. */
  private agentWatches = new Map<string, VoiceWatch>();
  /** Сессия Studio, начатая голосом, по `hostId|projectPath`: следующий промпт в проект продолжает её. */
  private voiceSessions = new Map<string, string>();
  /** Конец ответа, пришедший раньше id сессии от `studio_send`. */
  private finishedEarly = new Map<string, { event: string; data: Record<string, unknown> }>();
  private offEvents: () => void;
  /** ПК со старым ProjectHub без `voice_command`. */
  private oldHosts = new Set<string>();
  /** Экран голоса открыт: только тогда новые запросы подтверждения озвучиваются сами. */
  private active = false;

  constructor(
    private readonly deps: VoiceDeps,
    lang: VoiceLang,
    wake = false
  ) {
    this.state = { phase: 'idle', lang, wake, log: [], confirm: null, context: null, nav: null };
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

  setWake(wake: boolean): void {
    this.set({ wake });
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

  /** Записанная фраза: распознать на ПК и выполнить. `handsFree` — фразу выделил VAD, а не нажатие. */
  async handleAudio(samples: Float32Array, opts: { handsFree?: boolean } = {}): Promise<void> {
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
    if (!text) return;
    // Обращение нужно только постоянному слушанию и не нужно ответу «да/нет» на переспрос.
    if (opts.handsFree && this.state.wake && !this.pending) {
      const command = stripWakeWord(text);
      if (command === null) return;
      if (!command) return this.say(this.v.listening);
      return this.handleText(command);
    }
    await this.handleText(text);
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
    const ctx: VoiceActionContext = {
      cmd,
      hosts: this.deps.hosts(),
      v: this.v,
      lang: this.state.lang,
      say: (text) => this.say(text),
      ask: (prompt, run) => this.ask(prompt, run),
      target: (needs) => {
        const t = resolveTarget(cmd, ctx.hosts, this.ctx, needs, this.v);
        if (t.kind === 'reply' && t.ask) this.resume = { cmd, ask: t.ask };
        return t;
      },
      remember: (host, project) => this.remember(host, project),
      rpc: (hostId, method, params) => this.deps.rpc(hostId, method, params),
      lastAnswer: (hostId, projectPath, sessionId) => this.lastAnswer(hostId, projectPath, sessionId),
      watch: (hostId, sessionId, w) => this.watch(hostId, sessionId, w),
      watchAgent: (w) => void this.agentWatches.set(`${w.hostId}|${w.projectPath}`, w),
      voiceSession: (hostId, projectPath) => this.voiceSessions.get(`${hostId}|${projectPath}`),
      setVoiceSession: (hostId, projectPath, sessionId) => void this.voiceSessions.set(`${hostId}|${projectPath}`, sessionId),
      navigate: (nav) => this.set({ nav: { ...nav, seq: ++this.seq } }),
      lastReply: () => this.lastReply,
      stopSpeaking: () => this.stopSpeaking()
    };
    await VOICE_ACTIONS[cmd.intent](ctx);
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

  private watch(hostId: string, sessionId: string, w: VoiceWatch): void {
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
    if ((event === 'agent:finished' || event === 'agent:failed') && typeof d.projectPath === 'string') {
      const key = `${hostId}|${d.projectPath}`;
      const w = this.agentWatches.get(key);
      if (!w) return;
      this.agentWatches.delete(key);
      const who = typeof d.agentName === 'string' && d.agentName ? d.agentName : w.project;
      const text = event === 'agent:failed' ? this.v.agentFailed(w.project, String(d.error ?? '')) : this.v.agentDone(who, w.project);
      void this.say(text);
      return;
    }
    if (event === 'ai:hitl' && this.active && !this.pending) {
      const host = this.deps.hosts().find((h) => h.id === hostId);
      const item = hitlFromEvent(d);
      const what = item ? hitlText(item, dictFor(this.state.lang).models.hitlText).title : typeof d.tool === 'string' ? d.tool : '';
      if (host && what) void this.say(`${this.v.pendingLine(1, spokenHostName(host.name))}. ${this.v.pendingFirst(what)}`);
    }
  }

  private async finishWatch(w: VoiceWatch, sessionId: string, event: string, d: Record<string, unknown>): Promise<void> {
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
