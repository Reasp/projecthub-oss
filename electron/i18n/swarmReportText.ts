/**
 * Тексты Markdown-отчёта swarm-сессии (TASK-56, TASK-202.7): человек сохраняет его в файл через системный диалог,
 * поэтому язык — язык хоста ([[decision-161]]). Английский — базовый (правило 25), русский обязан покрывать те же
 * ключи — это проверяет тип.
 *
 * Чистый модуль без Electron.
 */
import type { Language } from '../../src/i18n/types.js';

export type CheckpointPointKind = 'turn' | 'start' | 'end' | 'pre_rewind';
export type CostSourceKind = 'provider' | 'price-table' | 'local' | 'unknown';
export type RoutingSourceKind = 'explicit' | 'tier' | 'default';
export type AccountSourceKind = 'slot' | 'role' | 'project' | 'default';

export interface SwarmReportText {
  seconds: (s: string) => string;
  minSec: (m: number, s: number) => string;
  status: Record<string, string>;
  costSource: Record<CostSourceKind, string>;
  routingSource: Record<RoutingSourceKind, string>;
  accountSource: Record<AccountSourceKind, string>;
  localCost: (cost: string) => string;
  checkpointPoint: (kind: string | undefined, n: number | undefined) => string;
  truncated: (n: number) => string;
  modes: { handoff: string; doneLoop: string; fanOut: string };
  title: (id: string) => string;
  task: string;
  project: string;
  mode: string;
  baseBranch: string;
  statusLabel: string;
  created: string;
  completed: (at: string) => string;
  duration: string;
  tokens: string;
  tokensDetail: (input: string, output: string, cacheRead: string, cacheWrite: string) => string;
  cost: string;
  unknown: string;
  budget: (usd: string) => string;
  winner: string;
  error: string;
  prompt: string;
  agents: string;
  tableHeader: string;
  files: (n: number, ins: number, del: number) => string;
  stages: string;
  stageCancelled: (at: string) => string;
  stageReruns: (n: number) => string;
  loopIterations: string;
  loopOutcome: string;
  iteration: (failed: number, checks: number, accepted: number, criteria: number) => string;
  decision: (value: string) => string;
  rolledBack: (partial: boolean) => string;
  continuationN: (n: number) => string;
  continuations: string;
  loopContinued: (from: number) => string;
  stagesRestarted: (list: string) => string;
  agentContinued: string;
  afterRewind: (n: number) => string;
  clarification: (text: string) => string;
  provider: (label: string) => string;
  profile: (id: string, local: boolean) => string;
  account: (cli: string, name: string, source: string) => string;
  branch: (name: string) => string;
  agentError: (text: string) => string;
  errorKind: (kind: string) => string;
  reviewerUnavailable: (kind: string) => string;
  usage: (estimated: boolean, detail: string) => string;
  usageDetail: (input: string, output: string, cacheRead: string, cacheWrite: string) => string;
  usageModel: (model: string) => string;
  usageCost: (cost: string, source: string) => string;
  output: string;
  diff: string;
  modelTier: (tier: string, source: string, current?: string) => string;
  tiersNote: (note: string) => string;
  modelSwitches: string;
  waited: (s: number) => string;
  chainStopped: (why: string) => string;
  checkpoints: (count: number, n: number, where: string, commit: string) => string;
  rewind: (at: string, n: number, where: string, removed: number, pre?: number, commit?: string) => string;
}

const en: SwarmReportText = {
  seconds: (s) => `${s} s`,
  minSec: (m, s) => `${m} min ${s} s`,
  status: {
    pending: 'pending',
    preparing: 'preparing',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    stopped: 'stopped',
    interrupted: 'interrupted',
    budget_exceeded: 'budget exceeded'
  },
  costSource: { provider: 'reported by the provider', 'price-table': 'from the price table', local: 'local', unknown: 'unknown' },
  routingSource: { explicit: 'explicit slot or role model', tier: 'model from the tier table', default: 'engine default model' },
  accountSource: { slot: 'slot', role: 'role', project: 'project', default: 'default' },
  localCost: (cost) => `${cost} (local)`,
  checkpointPoint: (kind, n) => {
    switch (kind) {
      case 'turn':
        return n !== undefined ? `after turn ${n}` : 'after a turn';
      case 'start':
        return n !== undefined ? `before run ${n}` : 'before a run';
      case 'end':
        return n !== undefined ? `after run ${n}` : 'after a run';
      default:
        return 'before a rollback';
    }
  },
  truncated: (n) => `…[truncated: ${n} more characters]`,
  modes: { handoff: 'Handoff (pipeline)', doneLoop: 'Done-loop (until done)', fanOut: 'Fan-Out (arena)' },
  title: (id) => `# Swarm session ${id}`,
  task: 'Task',
  project: 'Project',
  mode: 'Mode',
  baseBranch: 'Base branch',
  statusLabel: 'Status',
  created: 'Created',
  completed: (at) => `, completed: ${at}`,
  duration: 'Duration',
  tokens: 'Tokens',
  tokensDetail: (i, o, r, w) => `input ${i}, output ${o}, cache read ${r}, cache write ${w}`,
  cost: 'Cost',
  unknown: 'unknown',
  budget: (usd) => ` (budget ${usd})`,
  winner: 'Winner',
  error: 'Error',
  prompt: '## Prompt',
  agents: '## Agents',
  tableHeader: '| Agent | Engine | Provider · model | Role | Status | Duration | Tokens (in/out) | Cost | Diff | Commit |',
  files: (n, ins, del) => `${n} files, +${ins}/-${del}`,
  stages: '## Pipeline stages',
  stageCancelled: (at) => `, result cancelled by a rollback ${at}`,
  stageReruns: (n) => `, restarts: ${n}`,
  loopIterations: '## “Until done” iterations',
  loopOutcome: 'Outcome',
  iteration: (failed, checks, accepted, criteria) => `checks failed ${failed}/${checks}, criteria accepted ${accepted}/${criteria}`,
  decision: (value) => `, decision: ${value}`,
  rolledBack: (partial) => `, cancelled by a rollback${partial ? ' partially' : ''}`,
  continuationN: (n) => `, continuation ${n}`,
  continuations: '## Continuations after a rollback',
  loopContinued: (from) => `the loop continued from iteration ${from}`,
  stagesRestarted: (list) => `stages ${list} restarted`,
  agentContinued: 'the agent continued',
  afterRewind: (n) => `, after a rollback to checkpoint #${n}`,
  clarification: (text) => `; clarification: ${text}`,
  provider: (label) => `- Provider: ${label}`,
  profile: (id, local) => `- Profile: id \`${id}\`${local ? ', local model' : ''}`,
  account: (cli, name, source) => `- ${cli} account: “${name}” (${source})`,
  branch: (name) => `- Branch: \`${name}\``,
  agentError: (text) => `- Error: ${text}`,
  errorKind: (kind) => `- Error kind: \`${kind}\``,
  reviewerUnavailable: (kind) => `- Reviewer unavailable: \`${kind}\``,
  usage: (estimated, detail) => `- Usage${estimated ? ' (estimated from the text length, the server did not report usage)' : ''}: ${detail}`,
  usageDetail: (i, o, r, w) => `input ${i}, output ${o}, cache read ${r}, cache write ${w}`,
  usageModel: (model) => `, model \`${model}\``,
  usageCost: (cost, source) => `, cost ${cost} (${source})`,
  output: '### Output',
  diff: '### Diff',
  modelTier: (tier, source, current) => `- Model tier: \`${tier}\` (${source})${current ? `, actual model: \`${current}\`` : ''}`,
  tiersNote: (note) => `- Tiers: ${note}`,
  modelSwitches: '- Model switches:',
  waited: (s) => `, waited ${s} s`,
  chainStopped: (why) => `- Chain stopped: ${why}`,
  checkpoints: (count, n, where, commit) => `- Checkpoints: ${count} (last #${n}, ${where}, \`${commit}\`)`,
  rewind: (at, n, where, removed, pre, commit) =>
    `- Rollback ${at}: to checkpoint #${n} (${where}), files removed ${removed}` +
    `${pre ? `, previous state is checkpoint #${pre}` : ''}${commit ? `, commit \`${commit}\`` : ''}`
};

const ru: SwarmReportText = {
  seconds: (s) => `${s} с`,
  minSec: (m, s) => `${m} мин ${s} с`,
  status: {
    pending: 'ожидает',
    preparing: 'подготовка',
    running: 'выполняется',
    completed: 'завершён',
    failed: 'ошибка',
    stopped: 'остановлен',
    interrupted: 'прерван',
    budget_exceeded: 'бюджет превышен'
  },
  costSource: { provider: 'по данным провайдера', 'price-table': 'по таблице цен', local: 'локальная', unknown: 'неизвестна' },
  routingSource: { explicit: 'явная модель слота или роли', tier: 'модель из таблицы тиров', default: 'модель по умолчанию движка' },
  accountSource: { slot: 'слот', role: 'роль', project: 'проект', default: 'по умолчанию' },
  localCost: (cost) => `${cost} (локальная)`,
  checkpointPoint: (kind, n) => {
    switch (kind) {
      case 'turn':
        return n !== undefined ? `после хода ${n}` : 'после хода';
      case 'start':
        return n !== undefined ? `перед запуском ${n}` : 'перед запуском';
      case 'end':
        return n !== undefined ? `после запуска ${n}` : 'после запуска';
      default:
        return 'перед откатом';
    }
  },
  truncated: (n) => `…[усечено: ещё ${n} символов]`,
  modes: { handoff: 'Handoff (конвейер)', doneLoop: 'Done-loop (до готовности)', fanOut: 'Fan-Out (арена)' },
  title: (id) => `# Swarm-сессия ${id}`,
  task: 'Задача',
  project: 'Проект',
  mode: 'Режим',
  baseBranch: 'Базовая ветка',
  statusLabel: 'Статус',
  created: 'Создана',
  completed: (at) => `, завершена: ${at}`,
  duration: 'Длительность',
  tokens: 'Токены',
  tokensDetail: (i, o, r, w) => `вход ${i}, выход ${o}, кэш чтение ${r}, кэш запись ${w}`,
  cost: 'Стоимость',
  unknown: 'неизвестна',
  budget: (usd) => ` (бюджет ${usd})`,
  winner: 'Победитель',
  error: 'Ошибка',
  prompt: '## Задание',
  agents: '## Агенты',
  tableHeader: '| Агент | Движок | Провайдер · модель | Роль | Статус | Длительность | Токены (вход/выход) | Стоимость | Дифф | Коммит |',
  files: (n, ins, del) => `${n} файлов, +${ins}/-${del}`,
  stages: '## Этапы конвейера',
  stageCancelled: (at) => `, результат отменён откатом ${at}`,
  stageReruns: (n) => `, перезапусков: ${n}`,
  loopIterations: '## Итерации цикла «до готовности»',
  loopOutcome: 'Итог',
  iteration: (failed, checks, accepted, criteria) => `проверок упало ${failed}/${checks}, критериев засчитано ${accepted}/${criteria}`,
  decision: (value) => `, решение: ${value}`,
  rolledBack: (partial) => `, отменена откатом${partial ? ' частично' : ''}`,
  continuationN: (n) => `, продолжение ${n}`,
  continuations: '## Продолжения после отката',
  loopContinued: (from) => `цикл продолжен с итерации ${from}`,
  stagesRestarted: (list) => `перезапуск этапов ${list}`,
  agentContinued: 'продолжение агента',
  afterRewind: (n) => `, после отката к чекпоинту #${n}`,
  clarification: (text) => `; уточнение: ${text}`,
  provider: (label) => `- Провайдер: ${label}`,
  profile: (id, local) => `- Профиль: id \`${id}\`${local ? ', локальная модель' : ''}`,
  account: (cli, name, source) => `- Аккаунт ${cli}: «${name}» (${source})`,
  branch: (name) => `- Ветка: \`${name}\``,
  agentError: (text) => `- Ошибка: ${text}`,
  errorKind: (kind) => `- Вид ошибки: \`${kind}\``,
  reviewerUnavailable: (kind) => `- Ревьюер недоступен: \`${kind}\``,
  usage: (estimated, detail) => `- Usage${estimated ? ' (оценка по длине текста, сервер не сообщил usage)' : ''}: ${detail}`,
  usageDetail: (i, o, r, w) => `вход ${i}, выход ${o}, кэш чтение ${r}, кэш запись ${w}`,
  usageModel: (model) => `, модель \`${model}\``,
  usageCost: (cost, source) => `, стоимость ${cost} (${source})`,
  output: '### Вывод',
  diff: '### Дифф',
  modelTier: (tier, source, current) => `- Тир модели: \`${tier}\` (${source})${current ? `, фактическая модель: \`${current}\`` : ''}`,
  tiersNote: (note) => `- Тиры: ${note}`,
  modelSwitches: '- Переключения модели:',
  waited: (s) => `, ожидание ${s} с`,
  chainStopped: (why) => `- Цепочка остановлена: ${why}`,
  checkpoints: (count, n, where, commit) => `- Чекпоинты: ${count} (последний #${n}, ${where}, \`${commit}\`)`,
  rewind: (at, n, where, removed, pre, commit) =>
    `- Откат ${at}: к чекпоинту #${n} (${where}), удалено файлов ${removed}` +
    `${pre ? `, прежнее состояние — чекпоинт #${pre}` : ''}${commit ? `, коммит \`${commit}\`` : ''}`
};

const TEXTS: Record<Language, SwarmReportText> = { en, ru };

export function swarmReportText(lang: Language = 'en'): SwarmReportText {
  return TEXTS[lang] ?? en;
}
