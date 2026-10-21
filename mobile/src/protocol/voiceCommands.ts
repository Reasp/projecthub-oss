/**
 * Голосовой режим телефона (TASK-179.3, [[decision-137]] п. 5–7): чистая логика исполнения команд по флоту — список
 * компьютеров для разбора на ПК, короткие ответы без модели, выбор компьютера и проекта, ответы о состоянии по
 * снимкам `get_overview`. Без React и сети.
 */
import type { PhoneVoiceCommand, PhoneVoiceComputer } from '../../../src/utils/phoneVoice';
import type { OverviewPendingRequest, OverviewProject, RemoteOverview } from '../../../src/utils/fleetOverview';
import type { Dict } from '../i18n';

export type VoiceLang = 'ru' | 'en';

/** ПК флота глазами голосового режима. */
export interface VoiceHost {
  /** id профиля сопряжения на телефоне. */
  id: string;
  name: string;
  ready: boolean;
  /** Право `full` и хост не «только чтение». */
  write: boolean;
  overview: RemoteOverview | null;
}

/** Компьютер и проект, к которым относится фраза без явной цели. */
export interface VoiceContext {
  hostId?: string;
  projectPath?: string;
}

type VoiceDict = Dict['voice'];

/** Список для `voice_command`: только ПК на связи. Имена проектов — из снимков. */
export function fleetForVoice(hosts: readonly VoiceHost[]): PhoneVoiceComputer[] {
  return hosts.filter((h) => h.ready).map((h) => ({ name: h.name, projects: (h.overview?.projects ?? []).map((p) => p.name) }));
}

/** Короткие слова распознаются на телефоне без модели: «да», «нет», «стоп», «повтори», «помощь». */
export type LocalIntent = 'yes' | 'no' | 'stop' | 'repeat' | 'help';

const LOCAL: Array<[LocalIntent, RegExp]> = [
  ['yes', /^(да|ага|угу|конечно|давай|отправляй|отправь|подтверждаю|верно|yes|yeah|yep|sure|ok|okay|go ahead|do it|confirm)$/],
  ['no', /^(нет|не надо|не нужно|отмена|отмени|отменить|no|nope|cancel|don't|do not)$/],
  ['stop', /^(стоп|хватит|замолчи|тихо|выключись|stop|quiet|shut up|be quiet)$/],
  ['repeat', /^(повтори|повтори пожалуйста|ещё раз|еще раз|что ты сказала?|repeat|say again|again|what)$/],
  ['help', /^(помощь|что ты умеешь|какие команды|help|what can you do)$/]
];

export function localIntent(text: string): LocalIntent | null {
  const norm = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?…«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [intent, re] of LOCAL) if (re.test(norm)) return intent;
  return null;
}

export type VoiceTarget =
  | { kind: 'ok'; host: VoiceHost; project?: OverviewProject }
  | { kind: 'reply'; text: string; ask?: 'computer' | 'project' };

/**
 * Куда идёт команда. Названное во фразе важнее прошлого контекста. Проект нужен не всем интентам: «что делают агенты»
 * отвечается и по компьютеру, и по флоту.
 */
export function resolveTarget(
  cmd: Pick<PhoneVoiceCommand, 'computer' | 'project' | 'unknownComputer' | 'unknownProject'>,
  hosts: readonly VoiceHost[],
  ctx: VoiceContext,
  needs: 'project' | 'computer' | 'write-computer',
  v: VoiceDict
): VoiceTarget {
  if (cmd.unknownComputer) return { kind: 'reply', text: v.unknownComputer(cmd.unknownComputer), ask: 'computer' };
  const named = cmd.computer ? hosts.find((h) => h.name === cmd.computer) : undefined;
  const host = named ?? hosts.find((h) => h.id === ctx.hostId);
  if (!host) return { kind: 'reply', text: v.askComputer, ask: 'computer' };
  if (!host.ready) return { kind: 'reply', text: v.offline(spokenHostName(host.name)) };
  if (needs !== 'computer' && !host.write) return { kind: 'reply', text: v.readOnly(spokenHostName(host.name)) };
  if (needs !== 'project') return { kind: 'ok', host };
  if (cmd.unknownProject) return { kind: 'reply', text: v.unknownProject(cmd.unknownProject), ask: 'project' };
  const projects = host.overview?.projects ?? [];
  // Без названного проекта — проект контекста, если компьютер тот же, или единственный проект компьютера.
  const project = cmd.project
    ? projects.find((p) => p.name === cmd.project)
    : ((!named || named.id === ctx.hostId) && projects.find((p) => p.path === ctx.projectPath)) || (projects.length === 1 ? projects[0] : undefined);
  if (cmd.project && !project) return { kind: 'reply', text: v.unknownProject(cmd.project), ask: 'project' };
  if (!project) return { kind: 'reply', text: v.askProject, ask: 'project' };
  return { kind: 'ok', host, project };
}

function hostParts(o: RemoteOverview, v: VoiceDict): string[] {
  const parts: string[] = [];
  if (o.counts.running) parts.push(v.running(o.counts.running));
  if (o.counts.waiting) parts.push(v.waiting(o.counts.waiting));
  if (o.counts.failed) parts.push(v.failedCount(o.counts.failed));
  return parts;
}

/** Чем заняты агенты одного проекта: до трёх громких сессий. */
function projectLine(p: OverviewProject, v: VoiceDict): string {
  const loud = p.sessions.filter((s) => s.state === 'waiting' || s.state === 'failed' || s.state === 'running').slice(0, 3);
  if (loud.length === 0) return v.inProject(p.name, v.quiet);
  return v.inProject(p.name, loud.map((s) => v.sessionLine(s.title, v.states[s.state])).join('; '));
}

/**
 * «Что делают агенты»: по проекту — его сессии, по компьютеру — счётчики и громкие проекты, по флоту — по
 * компьютеру на фразу. Тихий флот — одной фразой.
 */
export function describeStatus(hosts: readonly VoiceHost[], scope: { host?: VoiceHost; project?: OverviewProject }, v: VoiceDict): string {
  if (scope.project) return `${projectLine(scope.project, v)}.`;
  const list = (scope.host ? [scope.host] : hosts).filter((h) => h.ready && h.overview);
  if (list.length === 0) return v.noData;
  const lines = list
    .map((h) => {
      const o = h.overview!;
      const parts = hostParts(o, v);
      if (parts.length === 0) return scope.host ? v.hostSummary(spokenHostName(h.name), v.quiet) : '';
      const loud = o.projects.filter((p) => p.attention !== 'quiet').slice(0, 3);
      return v.hostSummary(spokenHostName(h.name), [parts.join(', '), ...loud.map((p) => projectLine(p, v))].join('; '));
    })
    .filter(Boolean);
  return lines.length ? lines.join(' ') : v.allQuiet;
}

export interface PendingItem {
  host: VoiceHost;
  project: OverviewProject;
  request: OverviewPendingRequest;
}

/** Запросы подтверждения в снимках, старые первыми. */
export function pendingRequests(hosts: readonly VoiceHost[], scope: { host?: VoiceHost; project?: OverviewProject }): PendingItem[] {
  const out: PendingItem[] = [];
  for (const host of scope.host ? [scope.host] : hosts) {
    if (!host.ready || !host.overview) continue;
    for (const project of host.overview.projects) {
      if (scope.project && project.path !== scope.project.path) continue;
      for (const s of project.sessions) for (const request of s.pending ?? []) out.push({ host, project, request });
    }
  }
  return out.sort((a, b) => (a.request.createdAt ?? 0) - (b.request.createdAt ?? 0));
}

export function describePending(items: readonly PendingItem[], v: VoiceDict): string {
  if (items.length === 0) return v.nothingPending;
  const byHost = new Map<string, number>();
  for (const i of items) byHost.set(spokenHostName(i.host.name), (byHost.get(spokenHostName(i.host.name)) ?? 0) + 1);
  const lines = [...byHost].map(([pc, n]) => v.pendingLine(n, pc)).join(', ');
  return `${lines}. ${v.pendingFirst(items[0].request.title)}`;
}

/** Имя компьютера для голоса: без `.local` — так его и произносят. */
export function spokenHostName(name: string): string {
  return name.replace(/\.local$/i, '');
}
