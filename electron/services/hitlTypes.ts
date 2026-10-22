/**
 * Типы единого HITL-контура (TASK-57, decision-10).
 *
 * Модуль намеренно без зависимостей от Electron и сервисов: его импортируют и `hitlService`,
 * и `claudeBridgeService`, и `agentFleetService`, и unit-тесты. Зеркало для рендерера —
 * `src/types/electron.d.ts` (ApprovalRequest, HitlAuditEntry, AppBusEvent).
 */

/** Откуда пришёл агент, запросивший разрешение. */
/** `external` — внешний MCP-клиент (Claude Code в терминале, Antigravity) через прокси ProjectHub (TASK-82). */
/** `terminal` — хуки терминальной сессии Claude Code или Codex (TASK-77, decision-54). */
export type HitlOrigin = 'studio' | 'swarm' | 'handoff' | 'assigned' | 'external' | 'automation' | 'terminal';

/** `antigravity` — терминальная сессия Google Antigravity через хуки (TASK-106, decision-62). */
export type HitlEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli' | 'api' | 'antigravity';

/** `computer_action` — действие управления компьютером через прокси `computer_*` (TASK-82, decision-27). */
export type HitlRequestType = 'command' | 'file_write' | 'question' | 'subagent_dispatch' | 'computer_action';

/**
 * Класс риска запроса (TASK-140.4, decision-112): `low` — чтение и проверки, `moderate` — изменения в проекте,
 * `high` — удаление, отправка наружу, сеть, запись вне проекта, секреты, управление компьютером, неизвестный инструмент.
 */
export type HitlRisk = 'low' | 'moderate' | 'high';

/**
 * Как человек подтвердил решение на удалённом устройстве (decision-112 п. 3): кнопка уведомления на заблокированном
 * телефоне, действие уведомления после разблокировки, кнопка в приложении, кнопка в мессенджере, подпись ключом
 * устройства с биометрией.
 */
export type HitlConfirmMethod = 'notification' | 'unlocked' | 'app' | 'chat' | 'biometric';

/** Скриншоты «до/после» действия управления компьютером — пути к файлам в каталоге аудита. */
export interface HitlScreenshots {
  before?: string;
  after?: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionData {
  title: string;
  subtitle?: string;
  options: QuestionOption[];
  isMultiSelect?: boolean;
  allowOther?: boolean;
}

/**
 * Запрос на решение человека. Поля до `createdAt` — исторический `ApprovalRequest` карточки
 * Agents Studio; остальные добавлены в TASK-57 для адресации, политики роли и аудита.
 */
export interface HitlRequest {
  id: string;
  sessionId: string;
  projectPath: string;
  type: HitlRequestType;
  title: string;
  details?: string;
  command?: string;
  filePath?: string;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    patch: string;
  };
  questionData?: QuestionData;
  createdAt: number;
  /** Источник агента (Agents Studio, Swarm, Handoff, назначенная задача). */
  origin?: HitlOrigin;
  engine?: HitlEngine;
  /** Идентификатор агента внутри Swarm/Handoff; для Agents Studio отсутствует. */
  agentId?: string;
  agentName?: string;
  /** Роль агента (decision-9); для Agents Studio отсутствует. */
  role?: string;
  /** Имя профиля аккаунта Claude Code, под которым идёт агент (decision-87 п. 14); не e-mail. */
  claudeAccount?: string;
  /** Хост, на котором работает агент (federation, decision-11). */
  hostId?: string;
  /** Участник общего хоста, чей агент спрашивает (TASK-142.3): ему запрос и уходит. Пусто — владелец хоста. */
  memberId?: string;
  /** Имя инструмента движка (Bash, Write, run_command …). */
  tool?: string;
  /** Класс риска; считает `hitlService.request` (`classifyRisk`), вызывающий сервис может только ужесточить. */
  risk?: HitlRisk;
  /** Почему такой класс — для карточки и телефона. */
  riskReason?: string;
  /** Момент, после которого запрос считается истёкшим (решение deny). */
  expiresAt?: number;
  /**
   * Запрос восстановлен из `pending.json` после перезапуска: агент уже не ждёт ответа,
   * решение попадёт только в аудит.
   */
  orphaned?: boolean;
}

export type ApprovalResponse = { approved: boolean; text?: string };

export type HitlDecisionSourceKind =
  /** Пользователь в окне ProjectHub. */
  | 'local'
  /** Удалённое устройство (Remote Control, Telegram Mini App). */
  | 'remote'
  /** Внешний MCP-клиент (Claude Code, Cursor …) через встроенный MCP-сервер. */
  | 'mcp'
  /** Авто-правило политики (auto-approve, deny-list, путь вне проекта). */
  | 'auto'
  /** Истёк срок ожидания — решение deny по умолчанию. */
  | 'timeout'
  /** Сессия завершена/прервана до решения. */
  | 'cancelled'
  /** Приложение закрывается. */
  | 'shutdown';

export interface HitlDecisionSource {
  kind: HitlDecisionSourceKind;
  deviceId?: string;
  deviceName?: string;
  /** Участник общего хоста, чьё устройство решило (decision-126). Пусто — владелец. */
  memberId?: string;
  /** Имя сработавшего правила для `auto`. */
  rule?: string;
  /** Способ подтверждения на удалённом устройстве (`remote`); без него — кнопка в приложении. */
  confirm?: HitlConfirmMethod;
  /** Подпись `biometric` проверена хостом ключом подтверждения устройства. */
  confirmVerified?: boolean;
}

export type HitlDecideResult =
  | { ok: true; request: HitlRequest }
  | { ok: false; reason: 'not_found' | 'already_decided' | 'invalid_source' | 'confirmation_required'; risk?: HitlRisk }
  /** Запрос чужого агента: решает запустивший участник или maintainer (TASK-142.3). */
  | { ok: false; reason: 'not_owner'; message: string; risk?: undefined };

export type HitlOutcome = 'executed' | 'failed' | 'not_executed' | 'session_gone';

/** Строка аудит-лога `<userData>/audit/hitl-<yyyy-mm>.jsonl`. Без секретов и содержимого файлов. */
export interface HitlAuditEntry {
  /** ISO-время записи. */
  ts: string;
  kind: 'decision' | 'outcome' | 'fallback';
  requestId: string;
  sessionId: string;
  projectPath: string;
  hostId?: string;
  origin?: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  /** Имя профиля аккаунта Claude Code (decision-87 п. 14). */
  claudeAccount?: string;
  tool?: string;
  type?: HitlRequestType;
  title?: string;
  filePath?: string;
  /** SHA-256 команды (hex). */
  commandHash?: string;
  /** Начало команды с вырезанными секретами. */
  commandPreview?: string;
  decision?: 'allow' | 'deny';
  decidedBy?: HitlDecisionSourceKind;
  deviceId?: string;
  deviceName?: string;
  /** Участник общего хоста (decision-126). */
  memberId?: string;
  rule?: string;
  /** Класс риска запроса (decision-112). */
  risk?: HitlRisk;
  /** Способ подтверждения на удалённом устройстве; `biometric` пишется, только если подпись проверена. */
  confirm?: HitlConfirmMethod;
  /** Комментарий пользователя (усечённый). */
  comment?: string;
  /** Сколько запрос ждал решения. */
  waitedMs?: number;
  outcome?: HitlOutcome;
  detail?: string;
  /** Длительность инструмента от решения до завершения, без ожидания человека (строка `outcome`, TASK-77). */
  durationMs?: number;
  /** Скриншоты до/после для `computer_action` (TASK-82). */
  screenshots?: HitlScreenshots;
}

export interface HitlAuditQuery {
  /** `YYYY-MM`; без него — все месяцы. */
  month?: string;
  sessionId?: string;
  projectPath?: string;
  decidedBy?: HitlDecisionSourceKind;
  decision?: 'allow' | 'deny';
  kind?: HitlAuditEntry['kind'];
  origin?: HitlOrigin;
  /** Подстрока в title/tool/filePath/commandPreview/agentName/role. */
  search?: string;
  limit?: number;
}

/**
 * Права роли (decision-9). Любое поле только сужает глобальные настройки пользователя:
 * `false` запрещает, списки объединяются, таймауты берутся минимальные.
 */
export interface RolePermissions {
  autoApprove?: boolean;
  allowCommands?: boolean;
  allowFileWrite?: boolean;
  allowFileRead?: boolean;
  allowSubagents?: boolean;
  writeExcludePatterns?: string[];
  readExcludePatterns?: string[];
  commandDenyList?: string[];
  commandTimeoutSec?: number;
  /** Allow-список инструментов; всё вне списка отклоняется без карточки. Пустой/отсутствует — без ограничений. */
  allowedTools?: string[];
  /** Таймаут ожидания решения человека в минутах. */
  approvalTimeoutMin?: number;
  /**
   * Заведение задач инструментом `task_create` (decision-89): `propose` — сразу, с меткой `agent-created`
   * до подтверждения человеком (право роли «менеджер»); `ask` — через карточку HITL; `deny` — запрещено.
   * Не задано — `ask` у роли, `propose` у сессии без роли.
   */
  taskCreate?: TaskCreateMode;
  /**
   * Слияние ветки документации агентом (`doc_branch_merge`, decision-151): `allow` — сразу (роль-ревьюер документации),
   * `ask` — через карточку HITL, `deny` — запрещено. Не задано — `ask`.
   */
  docMerge?: DocMergeMode;
  /**
   * Захват задачи на origin агентом (`task_claim`/`task_release`, decision-153): `allow` — сразу, `ask` — через карточку
   * HITL, `deny` — запрещено. Не задано — `ask`: захват — push, а push идёт по явному действию человека.
   */
  taskClaim?: TaskClaimMode;
}

export type TaskCreateMode = 'propose' | 'ask' | 'deny';
export type DocMergeMode = 'allow' | 'ask' | 'deny';
export type TaskClaimMode = 'allow' | 'ask' | 'deny';

export function isDocMergeMode(value: unknown): value is DocMergeMode {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

export function isTaskClaimMode(value: unknown): value is TaskClaimMode {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

// ─────────────────────────── Шина событий (decision-10, п. 5) ───────────────────────────

export interface AgentEventBase {
  sessionId: string;
  projectPath: string;
  origin: HitlOrigin;
  engine?: HitlEngine;
  agentId?: string;
  agentName?: string;
  role?: string;
  hostId?: string;
  at: number;
}

export type AppBusEvent =
  | { type: 'hitl:requested'; request: HitlRequest }
  | { type: 'hitl:decided'; request: HitlRequest; approved: boolean; source: HitlDecisionSource; comment?: string }
  | { type: 'hitl:expired'; request: HitlRequest }
  | { type: 'hitl:cancelled'; request: HitlRequest; reason?: string }
  | {
      type: 'hitl:fallback';
      sessionId: string;
      projectPath: string;
      origin: HitlOrigin;
      engine: HitlEngine;
      agentId?: string;
      agentName?: string;
      role?: string;
      reason: string;
      at: number;
    }
  | ({ type: 'agent:started' } & AgentEventBase)
  | ({ type: 'agent:finished'; outcome: 'done' | 'aborted'; durationMs?: number } & AgentEventBase)
  | ({ type: 'agent:failed'; error: string; durationMs?: number } & AgentEventBase)
  /** Слот переключился на следующую модель fallback-цепочки (TASK-79, decision-44). */
  | ({
      type: 'agent:modelFallback';
      fromModel: string;
      toModel: string;
      errorKind: string;
      errorReason?: string;
      waitedMs?: number;
    } & AgentEventBase)
  // ── События уведомлений (TASK-63, decision-13 п.1) ──
  | {
      type: 'swarm:finished';
      swarmId: string;
      projectPath: string;
      name: string;
      /** `plan` — сводное событие плана подзадач (TASK-80, decision-49). */
      mode: 'fan-out' | 'handoff' | 'plan';
      outcome: 'completed' | 'failed' | 'stopped';
      agentsTotal: number;
      agentsFailed: number;
      totalCostUsd?: number;
      durationMs?: number;
      hostId?: string;
      at: number;
    }
  | {
      type: 'process:crashed';
      processId: string;
      name: string;
      projectPath: string;
      exitCode?: number;
      hostId?: string;
      at: number;
    }
  | {
      type: 'pr:created';
      projectPath: string;
      number: number;
      title: string;
      url: string;
      hostId?: string;
      at: number;
    }
  | {
      type: 'pr:checksFailed';
      projectPath: string;
      number: number;
      title: string;
      url: string;
      hostId?: string;
      at: number;
    }
  | {
      type: 'remote:deviceConnected';
      deviceId: string;
      deviceName: string;
      mode: string;
      isApproved: boolean;
      hostId?: string;
      at: number;
    }
  /** Телефон познакомил этот ПК с другим ПК владельца: тот добавлен пиром hub-режима (decision-143). */
  | {
      type: 'federation:peerIntroduced';
      peerHostId: string;
      peerName: string;
      byDevice: string;
      hostId?: string;
      at: number;
    }
  /** Устройство прошло проверку PIN/ключа/токена, но ждёт одобрения на ПК (TASK-173). */
  | {
      type: 'remote:deviceApprovalRequested';
      deviceId: string;
      deviceName: string;
      mode: string;
      hostId?: string;
      at: number;
    }
  /** Ожидание одобрения закончилось: одобрено, отклонено или устройство отключилось (TASK-173). */
  | {
      type: 'remote:deviceApprovalResolved';
      deviceId: string;
      outcome: 'approved' | 'rejected' | 'disconnected';
      hostId?: string;
      at: number;
    }
  /** Уведомление удалённого хоста для этого ПК в hub-режиме (`host:notice`): очередь слияния и др. (decision-138). */
  | {
      type: 'federation:hostNotice';
      hostId: string;
      machineName: string;
      id: string;
      kind: string;
      title: string;
      text: string;
      level: 'info' | 'success' | 'warning' | 'error';
      projectPath?: string;
      at: number;
    }
  /** Событие, пришедшее с удалённого хоста федерации в hub-режиме (TASK-66, decision-11 п.4). */
  | {
      type: 'federation:peerEvent';
      hostId: string;
      machineName: string;
      event: string;
      at: number;
    }
  // ── События задач и автоматизаций (TASK-74, decision-52 п. 2, 6) ──
  /** Файл задачи добавлен или изменён; `changes` — что изменилось в статусе и исполнителях. */
  | {
      type: 'task:updated';
      projectPath: string;
      taskId: string;
      title: string;
      status: string;
      assignee: string[];
      labels: string[];
      created: boolean;
      changes: TaskBusChanges;
      at: number;
    }
  /**
   * Агент завёл задачи через `task_create`, они ждут подтверждения человека (decision-89). Задачи одной
   * сессии за несколько секунд приходят одним событием — менеджер не шлёт десять push подряд.
   */
  | {
      type: 'task:agentCreated';
      projectPath: string;
      /** Автор: `agent:<роль>`. */
      reporter: string;
      tasks: Array<{ id: string; title: string }>;
      at: number;
      /** Билет кнопки «Подтвердить» вне окна (TASK-155): подтверждает ровно задачи этой пачки. */
      approvalTicket?: string;
    }
  /** Ветка документации открыта, изменена, подтянула основную, предложена, принята или закрыта (decision-151). */
  | {
      type: 'docs:branchChanged';
      projectPath: string;
      branchId: string;
      event: 'opened' | 'updated' | 'synced' | 'proposed' | 'merged' | 'closed';
      title?: string;
      author?: string;
      at: number;
    }
  /** Действие `notify` правила автоматизации. */
  | {
      type: 'automation:notify';
      ruleId: string;
      ruleName: string;
      projectPath?: string;
      title: string;
      body?: string;
      at: number;
    }
  /** Правило приостановлено до полуночи: исчерпан дневной бюджет или число запусков. */
  | {
      type: 'automation:suspended';
      ruleId: string;
      ruleName: string;
      projectPath?: string;
      reason: 'budget' | 'runs';
      until: number;
      spentUsd?: number;
      limitUsd?: number;
      at: number;
    }
  /**
   * Ограничение расходов (точки расширения, decision-123 п. 4; бюджеты Team, decision-124): `warn` — израсходована
   * заметная доля лимита, `block` — лимит исчерпан и новые запуски остановлены. Текст готовит модуль-источник.
   */
  | {
      type: 'limits:notice';
      limitId: string;
      level: 'warn' | 'block';
      title: string;
      body: string;
      /** Ключ дедупликации: один порог одного лимита за один период — одно уведомление. */
      dedupKey: string;
      projectPath?: string;
      at: number;
    }
  /**
   * Очередь слияния общего хоста (TASK-142.4, decision-136): элемент ждёт ревью, слит, возвращён автору, очередь на
   * паузе. Для окна хоста; участникам событие уходит адресно на их устройства. Текст готовит модуль-источник.
   */
  | {
      type: 'queue:notice';
      itemId: string;
      level: 'info' | 'warn';
      title: string;
      body: string;
      dedupKey: string;
      projectPath?: string;
      at: number;
    }
  /** Запуск правила завершился (успех или ошибка действия). */
  | {
      type: 'automation:runFinished';
      ruleId: string;
      ruleName: string;
      runId: string;
      projectPath?: string;
      action: string;
      outcome: 'success' | 'failed';
      detail?: string;
      costUsd?: number;
      swarmId?: string;
      at: number;
    }
  // ── Ревью PR (TASK-81, decision-53) ──
  /** Опрос PR увидел новый открытый PR. */
  | ({ type: 'pr:opened' } & PrBusInfo)
  /** В PR новая голова (коммиты, force-push) или черновик стал готовым к ревью. */
  | ({ type: 'pr:updated'; previousSha?: string; reason: 'commits' | 'ready' } & PrBusInfo)
  /** PR, пропавший из открытых, оказался слит (TASK-138.5). Задачи переведены до публикации. */
  | {
      type: 'pr:merged';
      projectPath: string;
      number: number;
      title: string;
      url: string;
      headRef: string;
      baseRef: string;
      author?: string;
      /** Задачи PR: ссылка в `references` или номер в ветке и заголовке. */
      taskIds: string[];
      /** Задачи, переведённые по настройке проекта: из `Review` в выбранный статус. */
      movedTasks: Array<{ taskId: string; from: string; to: string }>;
      at: number;
    }
  /** Ревью PR завершено. */
  | {
      type: 'pr:reviewFinished';
      projectPath: string;
      number: number;
      title: string;
      url?: string;
      headSha: string;
      reviewId: string;
      status: 'done' | 'failed';
      confirmed: number;
      refuted: number;
      unverified: number;
      costUsd?: number;
      publish: 'pending' | 'manual' | 'none';
      error?: string;
      at: number;
    }
  /** Security Health: новые находки аудита, секреты или рискованные пакеты в слоте Swarm (decision-56 п. 10). */
  | {
      type: 'security:finding';
      projectPath: string;
      source: 'audit' | 'secrets' | 'dependencies';
      severity: 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';
      title: string;
      /** Сводка без значений секретов: уровни и пакеты, виды и файлы. */
      summary: string;
      count: number;
      /** Ключ дедупликации: набор advisory или агент и состояние его диффа. */
      key: string;
      swarmId?: string;
      agentId?: string;
      at: number;
    };

/** Поля PR в событиях опроса (TASK-81). */
export interface PrBusInfo {
  projectPath: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  author?: string;
  at: number;
}

export interface TaskBusChanges {
  status?: { from: string; to: string };
  assignee?: { from: string[]; to: string[] };
}

export type AppBusEventType = AppBusEvent['type'];
