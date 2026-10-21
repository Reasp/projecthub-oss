/**
 * Точки расширения для платных модулей `ee/` (TASK-151, decision-123 п. 4). Код открытый (MIT): он не знает ни о
 * бюджетах, ни о командах — только об «ограничениях запуска агента», «итоге запуска» и «методах IPC». В открытой
 * редакции ни одной подписки нет, и все проверки разрешают запуск без примечаний.
 *
 * Модуль `ee/electron/<имя>/index.ts` экспортирует `register(api)`; модули подключает `loadEditionModules`.
 */

/** Кто запускает агента и где — общий контекст проверки перед запуском. */
export interface AgentLaunchContext {
  projectPath: string;
  /** Задача Backlog.md, если запуск по задаче. */
  taskId?: string;
  /** Роль реестра — «агент» в терминах бюджетов. */
  roleSlug?: string;
  roleName?: string;
  engine: string;
  model?: string;
  /** `swarm` — человек из окна или с телефона; `assigned`/`automation` — без нажатия человека. */
  origin: 'swarm' | 'assigned' | 'automation' | 'studio';
  /** Участник общего хоста (TASK-142.1). Пусто — владелец хоста. */
  memberId?: string;
  /** Сколько агентов стартует этим запуском (арена — несколько слотов). */
  slots?: number;
}

export interface LaunchNotice {
  level: 'info' | 'warn' | 'block';
  text: string;
}

export interface AgentLaunchVerdict {
  allowed: boolean;
  /** Почему запуск запрещён — первое блокирующее примечание. */
  reason?: string;
  /** Потолок расхода запуска в USD: станет бюджетом сессии, если он ниже своего. */
  capUsd?: number;
  notices: LaunchNotice[];
}

/** Итог одного запуска агента (хода цикла «до готовности», слота арены) с расходом за этот запуск. */
export interface AgentRunRecord {
  at: number;
  startedAt: number;
  projectPath: string;
  taskId?: string;
  roleSlug?: string;
  roleName?: string;
  engine: string;
  model?: string;
  origin: AgentLaunchContext['origin'];
  memberId?: string;
  sessionId: string;
  agentId: string;
  status: string;
  costUsd?: number;
  costSource?: string;
  /** Токены оценены по длине текста. */
  estimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/** Идущий запуск: сколько он уже потратил с начала этого запуска. */
export interface LiveAgentRun extends Omit<AgentRunRecord, 'at' | 'status'> {
  status: 'running';
}

export type LaunchGuard = (ctx: AgentLaunchContext) => AgentLaunchVerdict | Promise<AgentLaunchVerdict>;
export type IpcHandler = (...args: unknown[]) => unknown;

export interface EditionMainApi {
  addLaunchGuard(guard: LaunchGuard): void;
  onAgentRun(listener: (record: AgentRunRecord) => void): void;
  /** Идущие запуски агентов — чтобы учесть расход, который ещё не попал в итог. */
  liveRuns(): LiveAgentRun[];
  /** Канал IPC рендерера. В ph-agent окна нет, и регистрация там ничего не делает. */
  handleIpc(channel: string, handler: IpcHandler): void;
  /** Сохранить текст через системный диалог окна. Без окна (ph-agent) — { success: false }. */
  saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult>;
}

export interface SaveTextFileOptions {
  title: string;
  defaultName: string;
  content: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveTextFileResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export interface EditionMainModule {
  register?: (api: EditionMainApi) => void | Promise<void>;
}

const guards: LaunchGuard[] = [];
const runListeners: Array<(record: AgentRunRecord) => void> = [];
let liveRunsProvider: () => LiveAgentRun[] = () => [];
let ipcRegistrar: (channel: string, handler: IpcHandler) => void = () => undefined;
const noWindowSave = async (): Promise<SaveTextFileResult> => ({ success: false, error: 'Нет окна для диалога сохранения' });
let textFileSaver: (options: SaveTextFileOptions) => Promise<SaveTextFileResult> = noWindowSave;

export const editionRegistry = {
  api(): EditionMainApi {
    return {
      addLaunchGuard: (guard) => {
        guards.push(guard);
      },
      onAgentRun: (listener) => {
        runListeners.push(listener);
      },
      liveRuns: () => liveRunsProvider(),
      handleIpc: (channel, handler) => ipcRegistrar(channel, handler),
      saveTextFile: (options) => textFileSaver(options)
    };
  },

  /** Сводка всех ограничений: блокирует любое, потолок — наименьший, примечания — все по порядку. */
  async checkAgentLaunch(ctx: AgentLaunchContext): Promise<AgentLaunchVerdict> {
    const notices: LaunchNotice[] = [];
    let capUsd: number | undefined;
    for (const guard of guards) {
      let verdict: AgentLaunchVerdict;
      try {
        verdict = await guard(ctx);
      } catch (err) {
        // Сломанное ограничение не должно молча открывать запуск: денег это касается напрямую.
        verdict = { allowed: false, notices: [{ level: 'block', text: `Проверка перед запуском не удалась: ${err instanceof Error ? err.message : String(err)}` }] };
      }
      notices.push(...verdict.notices);
      if (!verdict.allowed && !verdict.notices.some((n) => n.level === 'block')) {
        notices.push({ level: 'block', text: verdict.reason || 'Запуск запрещён' });
      }
      if (typeof verdict.capUsd === 'number' && verdict.capUsd >= 0) capUsd = capUsd === undefined ? verdict.capUsd : Math.min(capUsd, verdict.capUsd);
    }
    const block = notices.find((n) => n.level === 'block');
    return {
      allowed: !block,
      ...(block ? { reason: block.text } : {}),
      ...(capUsd !== undefined ? { capUsd } : {}),
      notices
    };
  },

  emitAgentRun(record: AgentRunRecord): void {
    for (const listener of runListeners) {
      try {
        listener(record);
      } catch (err) {
        console.warn('[edition] Подписчик итога запуска упал:', err);
      }
    }
  },

  setLiveRunsProvider(provider: () => LiveAgentRun[]): void {
    liveRunsProvider = provider;
  },

  setIpcRegistrar(registrar: (channel: string, handler: IpcHandler) => void): void {
    ipcRegistrar = registrar;
  },

  setTextFileSaver(saver: (options: SaveTextFileOptions) => Promise<SaveTextFileResult>): void {
    textFileSaver = saver;
  },

  /** Только для тестов: вернуть реестр в состояние открытой редакции. */
  resetForTests(): void {
    guards.length = 0;
    runListeners.length = 0;
    liveRunsProvider = () => [];
    ipcRegistrar = () => undefined;
    textFileSaver = noWindowSave;
  }
};

/** Бюджет сессии с учётом потолка ограничений: меньший из двух, если потолок есть. */
export function capSessionBudget(ownBudgetUsd: number | undefined, capUsd: number | undefined): number | undefined {
  const own = typeof ownBudgetUsd === 'number' && ownBudgetUsd > 0 ? ownBudgetUsd : undefined;
  if (capUsd === undefined) return own;
  // Потолок 0 у разрешённого запуска невозможен (тогда запуск блокирован), но на всякий случай — минимальный бюджет.
  const cap = Math.max(capUsd, 0.000001);
  return own === undefined ? cap : Math.min(own, cap);
}
