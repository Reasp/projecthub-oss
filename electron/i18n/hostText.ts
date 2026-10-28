/**
 * Тексты, которые рисует сам хост (TASK-205, [[decision-161]]): системные уведомления, Telegram, рабочие чаты, меню
 * трея, служебные строки main в ответах Studio. Язык — язык интерфейса окна (`hostLanguage.ts`); английский — базовый
 * (правило 25), русский обязан покрывать те же ключи — это проверяет тип.
 *
 * Чистый модуль без Electron: его импортируют чистые модули правил и unit-тесты.
 */
import type { Language } from '../../src/i18n/types.js';
import type { ApprovalRequest, DoneLoopOutcome } from '../../src/types/electron';
import { describeHitlRequest, type HitlTextLabels } from '../../src/lib/agentStatusText.js';
import { hitlRequestTextEn, hitlRequestTextRu } from '../../src/i18n/hitlRequestText.js';
import { appErrorTextEn, appErrorTextRu, type AppErrorLabels } from '../../src/i18n/appErrorText.js';

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
  /** Словарь ошибок по коду (decision-165): причина в уведомлении и файле задачи на языке хоста. */
  appErrors: AppErrorLabels;
  agent: string;
  duration: { sec: (s: number) => string; min: (m: number) => string; minSec: (m: number, s: number) => string };
  /** Ход агента в push на экране блокировки (TASK-140.7, TASK-202.11). */
  progress: {
    agent: string;
    phases: Record<string, string>;
    waiting: string;
    doneIn: (iteration: number, max: number) => string;
    iteration: (iteration: number, max: number, phase: string) => string;
    doneOf: (ok: number, total: number) => string;
    done: string;
    failedWith: (error: string) => string;
    failed: string;
    stopped: string;
    agentsRunning: (active: number, total: number) => string;
    agentRunning: string;
  };
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
    builtinRuleName: string;
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
  studio: { cancelledByUser: string; emptyPrompt: string; mcpUnavailableWarning: string; stepLimit: (max: number) => string };
  /** Заголовок вкладки терминала входа в CLI (TASK-202.13). */
  terminal: { loginTitle: (account: string) => string };
  /** Заголовки системных диалогов сохранения. */
  /** Системные диалоги и тестовое уведомление Telegram (TASK-202.11 — выбор папки, экспорт HITL, тест). */
  dialogs: {
    exportTrace: string;
    exportSwarm: string;
    selectProjectFolder: string;
    exportHitlAudit: string;
    telegramTest: string;
    exportProfile: string;
    importProfile: string;
    profileFileFilter: string;
    cloneProjectInto: string;
  };
  /** Рабочие чаты (TASK-138.4): пробное сообщение в канал и подпись использования подключения. */
  chat: { testTitle: string; testBody: string; usageLabel: string };
  /** Имя устройства, которое привёл соседний ПК федерации (decision-111): сохраняется в записи токена. */
  remote: { phoneName: string; viaPeer: (device: string, peer: string) => string; studioProfile: string };
  /** Заметка хода роя в Implementation Notes задачи (TASK-76, TASK-202.7). */
  sessionNote: {
    modes: Record<string, string>;
    statuses: { completed: string; failed: string; stopped: string };
    iterations: (n: number) => string;
    continuation: (n: number) => string;
    header: (at: string, head: string) => string;
    reason: (text: string) => string;
    branch: (name: string) => string;
    commit: (hash: string) => string;
    summary: (text: string) => string;
  };
  /** Комментарий ревью в PR и заметка в задаче (TASK-81, TASK-202.7): их читают люди команды. */
  prReview: {
    title: (sha: string) => string;
    confirmed: (n: number, reviewers: string, verifier?: string) => string;
    none: string;
    suggestion: string;
    proof: string;
    foundBy: (n: number) => string;
    refuted: (n: number) => string;
    unverified: (n: number) => string;
    cost: (usd: string) => string;
    noteHeader: (n: number, at: string, sha: string) => string;
    noteFindings: (n: number, confirmed: number, refuted: number) => string;
    noteReviewers: (list: string) => string;
    reviewerError: string;
  };
  /** Сводка результата проверки (TASK-202.7): итог цикла в файле задачи. Статус проверки — код (`passed`, `failed`). */
  checks: {
    failedTests: (failed: number, total?: number) => string;
    errors: (n: number) => string;
    seconds: (s: string) => string;
    artifacts: (shots: number, traces: number, truncated: boolean) => string;
  };
  /** Итог цикла «до готовности» в разделе Final Summary задачи (TASK-202.7): файл задачи коммитится в проект. */
  /** Диалог «сборка на диске заменена» (TASK-202.11). */
  rebuilt: {
    title: string;
    message: string;
    detail: (current: string, onDisk: string, agents: number) => string;
    later: string;
    restart: string;
  };
  doneLoop: {
    outcomes: Record<DoneLoopOutcome, string>;
    iterations: (n: number, max: number) => string;
    iterationsAfterRewind: (n: number, inSegment: number, max: number) => string;
    headline: (agent: string, engine: string, outcome: string, count: string) => string;
    criteriaHeader: string;
    preChecked: string;
    screenshots: (list: string) => string;
    checksHeader: string;
    checksNone: string;
    cost: (usd?: string) => string;
    duration: (s: number) => string;
    branch: (name: string) => string;
    commit: (hash: string) => string;
    total: (parts: string) => string;
    cancelled: (checkpoint: number | undefined, at: string) => string;
  };
}

const en: HostText = {
  hitl: hitlRequestTextEn,
  appErrors: appErrorTextEn,
  agent: 'Agent',
  duration: { sec: (s) => `${s} s`, min: (m) => `${m} min`, minSec: (m, s) => `${m} min ${s} s` },
  progress: {
    agent: 'Agent',
    phases: { running_agent: 'agent working', checking: 'checks', verifying: 'verifying criteria', finished: 'done', failed: 'failed', stopped: 'stopped' },
    waiting: 'waiting for a decision',
    doneIn: (i, max) => `done in ${i} of ${max}`,
    iteration: (i, max, phase) => `iteration ${i} of ${max} — ${phase}`,
    doneOf: (ok, total) => `done: ${ok} of ${total}`,
    done: 'done',
    failedWith: (error) => `error: ${error}`,
    failed: 'error',
    stopped: 'stopped',
    agentsRunning: (active, total) => `agents working: ${active} of ${total}`,
    agentRunning: 'agent working'
  },
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
    builtinRuleName: 'Auto-start assigned tasks',
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
  studio: {
    cancelledByUser: '*(Cancelled by the user)*',
    stepLimit: (max) => `*(Stopped: the limit of tool steps is reached — ${max})*`,
    emptyPrompt: 'Please enter a message.',
    mcpUnavailableWarning: 'The built-in ProjectHub MCP server is unavailable: Claude Code was started without permission checks, the exclusion and deny lists do not apply to this answer.'
  },
  terminal: { loginTitle: (account) => `Sign-in: ${account}` },
  dialogs: {
    exportTrace: 'Export agent trace',
    exportSwarm: 'Export swarm session',
    selectProjectFolder: 'Choose a project folder with Backlog.md or a repository',
    exportHitlAudit: 'Export HITL decision history',
    telegramTest: 'Test notification from ProjectHub! 🚀',
    exportProfile: 'Export ProjectHub profile',
    importProfile: 'Import ProjectHub profile',
    profileFileFilter: 'ProjectHub profile',
    cloneProjectInto: 'Folder to clone the project into'
  },
  chat: { testTitle: 'ProjectHub channel check', testBody: 'If you see this, notifications are delivered to this channel', usageLabel: 'Chat' },
  remote: { phoneName: 'Phone', viaPeer: (device, peer) => `${device} · via ${peer}`, studioProfile: 'Profile' },
  sessionNote: {
    modes: { fan_out: 'arena (fan-out)', handoff: 'pipeline (handoff)', done_loop: '“until done” loop' },
    statuses: { completed: 'success', failed: 'failure', stopped: 'stopped' },
    iterations: (n) => `iterations: ${n}`,
    continuation: (n) => `continuation ${n}`,
    header: (at, head) => `**Agent session ${at} UTC** — ${head}`,
    reason: (text) => `Reason: ${text}`,
    branch: (name) => `branch \`${name}\``,
    commit: (hash) => `commit ${hash}`,
    summary: (text) => `Result: ${text}`
  },
  prReview: {
    title: (sha) => `### ProjectHub review · ${sha}`,
    confirmed: (n, reviewers, verifier) => `Confirmed findings: **${n}** (reviewers: ${reviewers}${verifier ? `; verification: ${verifier}` : ''}).`,
    none: 'No confirmed findings.',
    suggestion: 'Suggestion',
    proof: 'Confirmation',
    foundBy: (n) => `_Found by ${n} reviewers._`,
    refuted: (n) => `refuted on verification: ${n}`,
    unverified: (n) => `not verified: ${n}`,
    cost: (usd) => `review cost: $${usd}`,
    noteHeader: (n, at, sha) => `**PR #${n} review ${at} UTC** — head \`${sha}\``,
    noteFindings: (n, confirmed, refuted) => `- findings ${n}: confirmed ${confirmed}, refuted on verification ${refuted}`,
    noteReviewers: (list) => `- reviewers: ${list}`,
    reviewerError: 'error'
  },
  checks: {
    failedTests: (failed, total) => `failed tests: ${failed}${total ? ` of ${total}` : ''}`,
    errors: (n) => `errors: ${n}`,
    seconds: (s) => `${s} s`,
    artifacts: (shots, traces, truncated) =>
      `screenshots: ${shots}${traces > 0 ? `, trace: ${traces}` : ''}${truncated ? ' (some were not saved due to the limit)' : ''}`
  },
  rebuilt: {
    title: 'ProjectHub was rebuilt',
    message: 'The application on disk was replaced by a new build, but the old one is running.',
    detail: (current, onDisk, agents) =>
      `Running: ${current}\nOn disk: ${onDisk}\n\n` +
      (agents > 0 ? `Agents are working now (${agents}): a restart will interrupt them.\n\n` : '') +
      'Restart to open the new build?',
    later: 'Later',
    restart: 'Restart'
  },
  doneLoop: {
    outcomes: {
      success: 'done',
      iteration_limit: 'iteration limit reached',
      budget: 'budget exhausted',
      agent_error: 'agent error',
      task_error: 'task error',
      stopped: 'stopped by a person'
    },
    iterations: (n, max) => `iterations ${n} of ${max}`,
    iterationsAfterRewind: (n, inSegment, max) => `iterations ${n}, after the rollback ${inSegment} of ${max}`,
    headline: (agent, engine, outcome, count) =>
      `Done by a ProjectHub agent in the “until done” mode (${agent}, engine ${engine}): ${outcome}, ${count}.`,
    criteriaHeader: 'Acceptance criteria (verified by ProjectHub against the agent report):',
    preChecked: 'checked before the start',
    screenshots: (list) => `screenshots: ${list}`,
    checksHeader: 'Checks of the last iteration:',
    checksNone: 'Checks: not configured.',
    cost: (usd) => `cost ${usd ?? 'unknown'}`,
    duration: (s) => `duration ${s} s`,
    branch: (name) => `branch \`${name}\``,
    commit: (hash) => `commit ${hash}`,
    total: (parts) => `Total: ${parts}.`,
    cancelled: (checkpoint, at) =>
      `The “until done” result was cancelled by a rollback${checkpoint !== undefined ? ` to checkpoint #${checkpoint}` : ''} ` +
      `(${at}); the loop continues, the criteria checkmarks are cleared until a new result.`
  }
};

const ru: HostText = {
  hitl: hitlRequestTextRu,
  appErrors: appErrorTextRu,
  agent: 'Агент',
  duration: { sec: (s) => `${s} с`, min: (m) => `${m} мин`, minSec: (m, s) => `${m} мин ${s} с` },
  progress: {
    agent: 'Агент',
    phases: { running_agent: 'агент работает', checking: 'проверки', verifying: 'сверка критериев', finished: 'готово', failed: 'не удалось', stopped: 'остановлено' },
    waiting: 'ждёт решения',
    doneIn: (i, max) => `готово за ${i} из ${max}`,
    iteration: (i, max, phase) => `итерация ${i} из ${max} — ${phase}`,
    doneOf: (ok, total) => `готово: ${ok} из ${total}`,
    done: 'готово',
    failedWith: (error) => `ошибка: ${error}`,
    failed: 'ошибка',
    stopped: 'остановлено',
    agentsRunning: (active, total) => `агентов работает: ${active} из ${total}`,
    agentRunning: 'агент работает'
  },
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
    builtinRuleName: 'Автозапуск назначенных задач',
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
  studio: {
    cancelledByUser: '*(Отменено пользователем)*',
    stepLimit: (max) => `*(Остановлено: достигнут лимит шагов с инструментами — ${max})*`,
    emptyPrompt: 'Пожалуйста, введите сообщение.',
    mcpUnavailableWarning: 'Встроенный MCP-сервер ProjectHub недоступен: Claude Code запущен без проверки разрешений, списки исключений и запрещённых команд в этом ответе не применяются.'
  },
  terminal: { loginTitle: (account) => `Вход: ${account}` },
  dialogs: {
    exportTrace: 'Экспорт трассы агента',
    exportSwarm: 'Экспорт swarm-сессии',
    selectProjectFolder: 'Выберите папку проекта с Backlog.md или репозиторием',
    exportHitlAudit: 'Экспорт истории решений HITL',
    telegramTest: 'Тестовое уведомление от ProjectHub! 🚀',
    exportProfile: 'Экспорт профиля ProjectHub',
    importProfile: 'Импорт профиля ProjectHub',
    profileFileFilter: 'Профиль ProjectHub',
    cloneProjectInto: 'Папка, куда клонировать проект'
  },
  chat: { testTitle: 'Проверка канала ProjectHub', testBody: 'Если вы это видите, уведомления в этот канал доставляются', usageLabel: 'Чат' },
  remote: { phoneName: 'Телефон', viaPeer: (device, peer) => `${device} · через ${peer}`, studioProfile: 'Профиль' },
  sessionNote: {
    modes: { fan_out: 'арена (fan-out)', handoff: 'конвейер (handoff)', done_loop: 'цикл «до готовности»' },
    statuses: { completed: 'успех', failed: 'провал', stopped: 'остановлена' },
    iterations: (n) => `итераций: ${n}`,
    continuation: (n) => `продолжение ${n}`,
    header: (at, head) => `**Сессия агента ${at} UTC** — ${head}`,
    reason: (text) => `Причина: ${text}`,
    branch: (name) => `ветка \`${name}\``,
    commit: (hash) => `коммит ${hash}`,
    summary: (text) => `Итог: ${text}`
  },
  prReview: {
    title: (sha) => `### Ревью ProjectHub · ${sha}`,
    confirmed: (n, reviewers, verifier) => `Подтверждено замечаний: **${n}** (ревьюеры: ${reviewers}${verifier ? `; проверка: ${verifier}` : ''}).`,
    none: 'Подтверждённых замечаний нет.',
    suggestion: 'Предложение',
    proof: 'Подтверждение',
    foundBy: (n) => `_Нашли ${n} ревьюера._`,
    refuted: (n) => `отброшено при проверке: ${n}`,
    unverified: (n) => `не проверено: ${n}`,
    cost: (usd) => `стоимость ревью: $${usd}`,
    noteHeader: (n, at, sha) => `**Ревью PR #${n} ${at} UTC** — голова \`${sha}\``,
    noteFindings: (n, confirmed, refuted) => `- находок ${n}: подтверждено ${confirmed}, отброшено при проверке ${refuted}`,
    noteReviewers: (list) => `- ревьюеры: ${list}`,
    reviewerError: 'ошибка'
  },
  checks: {
    failedTests: (failed, total) => `упавших тестов: ${failed}${total ? ` из ${total}` : ''}`,
    errors: (n) => `ошибок: ${n}`,
    seconds: (s) => `${s} с`,
    artifacts: (shots, traces, truncated) =>
      `скриншотов: ${shots}${traces > 0 ? `, trace: ${traces}` : ''}${truncated ? ' (часть не сохранена по лимиту)' : ''}`
  },
  rebuilt: {
    title: 'ProjectHub пересобран',
    message: 'Приложение на диске заменено новой сборкой, а работает прежняя.',
    detail: (current, onDisk, agents) =>
      `Работает: ${current}\nНа диске: ${onDisk}\n\n` +
      (agents > 0 ? `Сейчас работают агенты (${agents}): перезапуск прервёт их.\n\n` : '') +
      'Перезапустить, чтобы открыть новую сборку?',
    later: 'Позже',
    restart: 'Перезапустить'
  },
  doneLoop: {
    outcomes: {
      success: 'готово',
      iteration_limit: 'исчерпан лимит итераций',
      budget: 'исчерпан бюджет',
      agent_error: 'ошибка агента',
      task_error: 'ошибка задачи',
      stopped: 'остановлен человеком'
    },
    iterations: (n, max) => `итераций ${n} из ${max}`,
    iterationsAfterRewind: (n, inSegment, max) => `итераций ${n}, после отката ${inSegment} из ${max}`,
    headline: (agent, engine, outcome, count) =>
      `Выполнено агентом ProjectHub в режиме «до готовности» (${agent}, движок ${engine}): ${outcome}, ${count}.`,
    criteriaHeader: 'Критерии приёмки (сверены ProjectHub по отчёту агента):',
    preChecked: 'отмечен до запуска',
    screenshots: (list) => `скриншоты: ${list}`,
    checksHeader: 'Проверки последней итерации:',
    checksNone: 'Проверки: не настроены.',
    cost: (usd) => `стоимость ${usd ?? 'неизвестна'}`,
    duration: (s) => `длительность ${s} с`,
    branch: (name) => `ветка \`${name}\``,
    commit: (hash) => `коммит ${hash}`,
    total: (parts) => `Итого: ${parts}.`,
    cancelled: (checkpoint, at) =>
      `Итог цикла «до готовности» отменён откатом${checkpoint !== undefined ? ` к чекпоинту #${checkpoint}` : ''} ` +
      `(${at}); цикл продолжен, отметки критериев сняты до нового результата.`
  }
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
