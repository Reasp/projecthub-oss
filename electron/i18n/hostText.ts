/**
 * Тексты, которые рисует сам хост (TASK-205, [[decision-161]]): системные уведомления, Telegram, рабочие чаты, меню
 * трея, служебные строки main в ответах Studio. Язык — язык интерфейса окна (`hostLanguage.ts`); английский — базовый
 * (правило 25), русский обязан покрывать те же ключи — это проверяет тип.
 *
 * Чистый модуль без Electron: его импортируют чистые модули правил и unit-тесты.
 */
import type { Language } from '../../src/i18n/types.js';
import type { ApprovalRequest } from '../../src/types/electron';
import { describeHitlRequest, type HitlTextLabels } from '../../src/lib/agentStatusText.js';
import { hitlRequestTextEn, hitlRequestTextRu } from '../../src/i18n/hitlRequestText.js';

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export interface HostText {
  hitl: HitlTextLabels;
  agent: string;
  duration: { sec: (s: number) => string; min: (m: number) => string; minSec: (m: number, s: number) => string };
  notify: {
    hitlTitle: (title: string) => string;
    hitlCommand: (command: string) => string;
    hitlFile: (file: string) => string;
    agentDone: string;
    agentAborted: string;
    agentFailed: string;
    modelFallback: string;
    swarmAgentsOk: (ok: number, total: number) => string;
    swarmTitle: (mode: string, name: string, outcome: 'completed' | 'failed' | 'stopped') => string;
    processCrashed: (name: string) => string;
    exitCode: (code: string) => string;
    prCreated: (n: number) => string;
    prMerged: (n: number) => string;
    prChecksFailed: (n: number) => string;
    peerIntroduced: string;
    peerIntroducedBy: (device: string) => string;
    deviceConnected: string;
    deviceApproved: string;
    deviceAwaitingApproval: string;
    deviceApprovalTitle: string;
    deviceApprovalHint: string;
    automationBudget: (spent?: string, limit?: string) => string;
    automationRuns: string;
    automationSuspended: string;
    automationFailed: (rule: string) => string;
    reviewFailed: (error: string) => string;
    reviewError: string;
    reviewDone: (confirmed: number, refuted: number, unverified: number) => string;
    reviewPublishPending: string;
    reviewTitle: (n: number, title: string) => string;
    agentTaskOne: (id: string, title: string) => string;
    agentTaskMany: (count: number) => string;
    agentTaskPending: string;
    docBranchProposed: (branchId: string, title?: string) => string;
    testTitle: string;
    testBody: string;
  };
  decision: {
    allow: string;
    deny: string;
    allowed: (by: string) => string;
    denied: (by: string) => string;
    expired: string;
    cancelled: string;
    confirmTasks: string;
    confirmTasksAll: (count: number) => string;
    tasksConfirmedPhone: string;
    tasksConfirmedWindow: string;
    highRiskLine: string;
    project: (name: string) => string;
    decideElsewhere: string;
    open: string;
    mattermostHint: string;
    mattermostDenyHint: string;
    rejectHighRisk: string;
    rejectAlreadyDecided: string;
    rejectNotFound: string;
    rejectOther: (reason: string) => string;
    notInList: string;
  };
  tray: {
    states: { idle: string; working: string; attention: string; recording: string };
    pendingTooltip: (n: number) => string;
    sessionsTooltip: (n: number) => string;
    open: string;
    pendingHeader: (n: number) => string;
    more: (n: number) => string;
    decisionCenter: string;
    noPending: string;
    sessionsHeader: (n: number) => string;
    agents: (n: number) => string;
    noSessions: string;
    processes: string;
    remote: string;
    quit: string;
    quitConfirm: { cancel: string; quit: string; title: string; message: (n: number) => string; detail: string };
  };
  studio: { cancelledByUser: string };
  /** Рабочие чаты (TASK-138.4): пробное сообщение в канал и подпись использования подключения. */
  chat: { testTitle: string; testBody: string; usageLabel: string };
}

const en: HostText = {
  hitl: hitlRequestTextEn,
  agent: 'Agent',
  duration: { sec: (s) => `${s} s`, min: (m) => `${m} min`, minSec: (m, s) => `${m} min ${s} s` },
  notify: {
    hitlTitle: (title) => `Decision needed: ${title}`,
    hitlCommand: (command) => `Command: ${command}`,
    hitlFile: (file) => `File: ${file}`,
    agentDone: 'Agent finished',
    agentAborted: 'Agent interrupted',
    agentFailed: 'Agent stopped with an error',
    modelFallback: 'Agent switched model',
    swarmAgentsOk: (ok, total) => `${ok}/${total} agents succeeded`,
    swarmTitle: (mode, name, outcome) =>
      `${mode} “${name}”: ${outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'finished with errors' : 'stopped'}`,
    processCrashed: (name) => `Process “${name}” crashed`,
    exitCode: (code) => `exit code ${code}`,
    prCreated: (n) => `Pull Request #${n} created`,
    prMerged: (n) => `Pull Request #${n} merged`,
    prChecksFailed: (n) => `Pull Request #${n} checks failed`,
    peerIntroduced: 'Computer added',
    peerIntroducedBy: (device) => `introduced from device ${device}`,
    deviceConnected: 'Device connected',
    deviceApproved: 'approved',
    deviceAwaitingApproval: 'awaiting approval',
    deviceApprovalTitle: 'Device awaits approval',
    deviceApprovalHint: 'allow access in Remote Control → Devices',
    automationBudget: (spent, limit) => `daily budget exhausted${limit ? ` ($${spent} of $${limit})` : ''}`,
    automationRuns: 'daily run limit reached',
    automationSuspended: 'Automation paused until midnight',
    automationFailed: (rule) => `Automation “${rule}” failed`,
    reviewFailed: (error) => `failed: ${error}`,
    reviewError: 'error',
    reviewDone: (confirmed, refuted, unverified) =>
      `confirmed ${confirmed}, dismissed ${refuted}${unverified ? `, unverified ${unverified}` : ''}`,
    reviewPublishPending: 'publishing awaits a decision',
    reviewTitle: (n, title) => `PR #${n} review “${title}”`,
    agentTaskOne: (id, title) => `Agent created a task: ${id} “${title}”`,
    agentTaskMany: (count) => `Agent created ${count} tasks awaiting confirmation`,
    agentTaskPending: 'awaiting confirmation',
    docBranchProposed: (branchId, title) => `Documentation changes await acceptance: ${branchId}${title ? ` “${title}”` : ''}`,
    testTitle: 'ProjectHub notification test',
    testBody: 'If you can see this, the delivery channel works'
  },
  decision: {
    allow: 'Allow',
    deny: 'Deny',
    allowed: (by) => `Allowed (${by})`,
    denied: (by) => `Denied (${by})`,
    expired: 'Timed out — denied',
    cancelled: 'Request cancelled',
    confirmTasks: 'Confirm',
    confirmTasksAll: (count) => `Confirm all (${count})`,
    tasksConfirmedPhone: 'Confirmed from the phone',
    tasksConfirmedWindow: 'Confirmed in the ProjectHub window',
    highRiskLine: 'High risk: approve only in ProjectHub on the PC or in the app with biometrics; deny here.',
    project: (name) => `Project: ${name}`,
    decideElsewhere: 'Decide in ProjectHub, on the phone or with Telegram buttons.',
    open: 'Open',
    mattermostHint: 'Decision: react :white_check_mark: to allow, :x: to deny.',
    mattermostDenyHint: 'Decision: react :x: to deny.',
    rejectHighRisk: 'High risk: this request can only be approved in ProjectHub on the PC or in the app with biometrics. You can deny it here.',
    rejectAlreadyDecided: 'The request has already been decided.',
    rejectNotFound: 'Request not found — it may have expired.',
    rejectOther: (reason) => `ProjectHub did not accept the decision: ${reason}`,
    notInList: 'Only people from the subscription list can decide ProjectHub requests in this channel. Your action was not applied.'
  },
  tray: {
    states: { idle: 'Idle: no active agents', working: 'Agents are working', attention: 'A human decision is needed', recording: 'Recording voice' },
    pendingTooltip: (n) => `Awaiting decision: ${n}`,
    sessionsTooltip: (n) => `Active sessions: ${n}`,
    open: 'Open ProjectHub',
    pendingHeader: (n) => `Awaiting decision (${n})`,
    more: (n) => `…and ${n} more`,
    decisionCenter: 'Decision center…',
    noPending: 'No requests awaiting decision',
    sessionsHeader: (n) => `Active sessions (${n})`,
    agents: (n) => `${n} ${n === 1 ? 'agent' : 'agents'}`,
    noSessions: 'No active sessions',
    processes: 'Processes',
    remote: 'Remote access',
    quit: 'Quit',
    quitConfirm: {
      cancel: 'Cancel',
      quit: 'Quit',
      title: 'Quit ProjectHub',
      message: (n) => `Agents are running: ${n}`,
      detail: 'Quitting will interrupt their work and cancel pending decision requests. Continue?'
    }
  },
  studio: { cancelledByUser: '*(Cancelled by the user)*' },
  chat: { testTitle: 'ProjectHub channel check', testBody: 'If you see this, notifications are delivered to this channel', usageLabel: 'Chat' }
};

const ru: HostText = {
  hitl: hitlRequestTextRu,
  agent: 'Агент',
  duration: { sec: (s) => `${s} с`, min: (m) => `${m} мин`, minSec: (m, s) => `${m} мин ${s} с` },
  notify: {
    hitlTitle: (title) => `Нужно решение: ${title}`,
    hitlCommand: (command) => `Команда: ${command}`,
    hitlFile: (file) => `Файл: ${file}`,
    agentDone: 'Агент завершил работу',
    agentAborted: 'Агент прерван',
    agentFailed: 'Агент завершился с ошибкой',
    modelFallback: 'Агент переключил модель',
    swarmAgentsOk: (ok, total) => `${ok}/${total} агентов успешно`,
    swarmTitle: (mode, name, outcome) =>
      `${mode} «${name}»: ${outcome === 'completed' ? 'завершён' : outcome === 'failed' ? 'с ошибками' : 'остановлен'}`,
    processCrashed: (name) => `Процесс «${name}» аварийно завершился`,
    exitCode: (code) => `код выхода ${code}`,
    prCreated: (n) => `Pull Request #${n} создан`,
    prMerged: (n) => `Pull Request #${n} слит`,
    prChecksFailed: (n) => `Проверки Pull Request #${n} упали`,
    peerIntroduced: 'Компьютер добавлен',
    peerIntroducedBy: (device) => `знакомство с устройства ${device}`,
    deviceConnected: 'Подключено устройство',
    deviceApproved: 'одобрено',
    deviceAwaitingApproval: 'ожидает одобрения',
    deviceApprovalTitle: 'Устройство ждёт подтверждения',
    deviceApprovalHint: 'разрешите доступ в Remote Control → Устройства',
    automationBudget: (spent, limit) => `исчерпан дневной бюджет${limit ? ` ($${spent} из $${limit})` : ''}`,
    automationRuns: 'исчерпано число запусков за день',
    automationSuspended: 'Автоматизация приостановлена до полуночи',
    automationFailed: (rule) => `Автоматизация «${rule}» не выполнена`,
    reviewFailed: (error) => `не выполнено: ${error}`,
    reviewError: 'ошибка',
    reviewDone: (confirmed, refuted, unverified) =>
      `подтверждено ${confirmed}, отброшено ${refuted}${unverified ? `, не проверено ${unverified}` : ''}`,
    reviewPublishPending: 'публикация ждёт решения',
    reviewTitle: (n, title) => `Ревью PR #${n} «${title}»`,
    agentTaskOne: (id, title) => `Агент завёл задачу: ${id} «${title}»`,
    agentTaskMany: (count) => `Агент завёл задачи (${count}), ждут подтверждения`,
    agentTaskPending: 'ждёт подтверждения',
    docBranchProposed: (branchId, title) => `Правки документации ждут принятия: ${branchId}${title ? ` «${title}»` : ''}`,
    testTitle: 'Проверка уведомлений ProjectHub',
    testBody: 'Если вы это видите, канал доставки работает'
  },
  decision: {
    allow: 'Разрешить',
    deny: 'Отклонить',
    allowed: (by) => `Разрешено (${by})`,
    denied: (by) => `Отклонено (${by})`,
    expired: 'Истёк срок ожидания — отклонено',
    cancelled: 'Запрос отменён',
    confirmTasks: 'Подтвердить',
    confirmTasksAll: (count) => `Подтвердить все (${count})`,
    tasksConfirmedPhone: 'Подтверждено с телефона',
    tasksConfirmedWindow: 'Подтверждено в окне ProjectHub',
    highRiskLine: 'Высокий риск: одобрить можно только в ProjectHub на ПК или в приложении с биометрией; отклонить — здесь.',
    project: (name) => `Проект: ${name}`,
    decideElsewhere: 'Решение — в ProjectHub, на телефоне или кнопками Telegram.',
    open: 'Открыть',
    mattermostHint: 'Решение: реакция :white_check_mark: — разрешить, :x: — отклонить.',
    mattermostDenyHint: 'Решение: реакция :x: — отклонить.',
    rejectHighRisk: 'Высокий риск: такой запрос одобряется только в ProjectHub на ПК или в приложении с биометрией. Отклонить можно и здесь.',
    rejectAlreadyDecided: 'Запрос уже решён.',
    rejectNotFound: 'Запрос не найден — возможно, истёк.',
    rejectOther: (reason) => `ProjectHub не принял решение: ${reason}`,
    notInList: 'Решать запросы ProjectHub в этом канале могут только люди из списка подписки. Ваше нажатие не применено.'
  },
  tray: {
    states: { idle: 'Простой: активных агентов нет', working: 'Агенты работают', attention: 'Требуется решение человека', recording: 'Идёт запись голоса' },
    pendingTooltip: (n) => `Ожидают решения: ${n}`,
    sessionsTooltip: (n) => `Активных сессий: ${n}`,
    open: 'Открыть ProjectHub',
    pendingHeader: (n) => `Ожидают решения (${n})`,
    more: (n) => `…и ещё ${n}`,
    decisionCenter: 'Центр решений…',
    noPending: 'Запросов на решение нет',
    sessionsHeader: (n) => `Активные сессии (${n})`,
    agents: (n) => `${n} ${pluralRu(n, 'агент', 'агента', 'агентов')}`,
    noSessions: 'Активных сессий нет',
    processes: 'Процессы',
    remote: 'Удалённый доступ',
    quit: 'Выход',
    quitConfirm: {
      cancel: 'Отмена',
      quit: 'Выйти',
      title: 'Выход из ProjectHub',
      message: (n) => `Сейчас работают агенты: ${n}`,
      detail: 'При выходе их работа будет прервана, а незавершённые запросы на решение отменены. Продолжить?'
    }
  },
  studio: { cancelledByUser: '*(Отменено пользователем)*' },
  chat: { testTitle: 'Проверка канала ProjectHub', testBody: 'Если вы это видите, уведомления в этот канал доставляются', usageLabel: 'Чат' }
};

const TEXTS: Record<Language, HostText> = { en, ru };

export function hostText(lang: Language = 'en'): HostText {
  return TEXTS[lang] ?? en;
}

/**
 * Заголовок запроса HITL на языке читателя, который сам назвал язык (`?lang=` очереди для бота Telegram, decision-164).
 * Неизвестный язык или запрос без кода — запасной `title` хоста.
 */
export function hitlTitleIn(req: Pick<ApprovalRequest, 'title' | 'details' | 'questionData' | 'textKey'>, lang: unknown): string {
  if (lang !== 'en' && lang !== 'ru') return req.title;
  return describeHitlRequest(req, TEXTS[lang].hitl).title;
}
