/**
 * Слой движков вкладки Agents Studio (TASK-277, decision-220). Движок ведёт ход вкладки: получает запрос Studio и
 * переводит свои события в общие чанки `ClaudeBridgeMessageChunk` (текст, рассуждения, вызовы инструментов, карточки
 * HITL, id своей сессии), конец хода — `onComplete`/`onError`.
 *
 * Встроенные движки — Claude Code CLI и API-путь — регистрирует `claudeBridgeService`: им нужны его сессии, HITL и
 * статус проекта. Новый CLI-агент (Antigravity, opencode, Codex) — новый модуль с `StudioEngine` и строка в
 * `src/lib/studioEngines.ts`, а не новая ветка в `runAgentTask`.
 *
 * Модуль без Electron: реестр проверяют unit-тесты.
 */
import type { AIMessage, AIProviderConfig } from './aiAgentService.js';
import type { ProviderErrorInfo } from './providerErrors.js';
import type { ContextPartKey } from './contextBuilder.js';
import type { AppError } from '../../src/lib/appError.js';
import {
  STUDIO_ENGINES,
  isStudioEngineId,
  type StudioEngineCapabilities,
  type StudioEngineId,
  type StudioEngineStatus
} from '../../src/lib/studioEngines.js';
import { mainEngineOf } from './modelTarget.js';

/** Запрос хода вкладки — общий для всех движков; поля `claudeCli*` читает только Claude Code. */
export interface StudioEngineRequest {
  sessionId: string;
  projectPath: string;
  messages: AIMessage[];
  config: AIProviderConfig;
  mode: 'agent' | 'chat' | 'architect';
  /** Движок вкладки; без поля — по `config` (`studioEngineOfRequest`). */
  engine?: StudioEngineId;
  /** Id разговора движка: с ним ход продолжает разговор. */
  engineSessionId?: string;
  /** Рабочее дерево вкладки (worktree); по умолчанию — корень проекта (TASK-62). */
  workspaceRoot?: string;
  /** Задача вкладки (TASK-64): по ней contextBuilder собирает контекст. */
  taskId?: string;
  contextParts?: Partial<Record<ContextPartKey, boolean>>;
  /** Встроенные инструменты движка (`--tools` у Claude Code); пустой список — ни одного, только MCP ProjectHub. */
  builtinTools?: string[];
  /** Дополнение системного промпта (правила голосовой команды). */
  systemPromptAddon?: string;
  /** Аккаунт Claude Code вкладки (TASK-170). */
  claudeAccountId?: string;
  /** Участник общего хоста, чья сессия (TASK-142.3). */
  memberId?: string;
  /** Ответвление разговора Claude Code (TASK-283). */
  claudeCliFork?: 'branch' | 'side';
  /** Откат разговора `/rewind` (TASK-284). */
  claudeCliResumeAt?: string;
  /** Каталоги `/add-dir` вкладки (TASK-285). */
  claudeCliAddDirs?: string[];
}

/** Колбэки хода: чанки по ходу ответа, ровно один из `onComplete`/`onError` в конце (отмена — `onComplete`). */
export interface StudioEngineHandlers<Chunk> {
  onChunk: (chunk: Chunk) => void;
  onComplete: (msg: AIMessage) => void;
  /** `info` — снимок ошибки с кодом (decision-43, decision-165): карточка окна и телефон показывают её на своём языке. */
  onError: (err: string, info?: ProviderErrorInfo) => void;
  /** Подсказка следующего промпта (TASK-294), после `onComplete`; движок без неё не зовёт. */
  onPromptSuggestion?: (text: string) => void;
}

/** Найден ли движок на машине. */
export interface StudioEngineDetection {
  available: boolean;
  version?: string;
  error?: AppError;
}

export interface StudioEngine<Chunk = unknown> {
  id: StudioEngineId;
  capabilities: StudioEngineCapabilities;
  /** Проверка, что движок установлен (CLI в PATH); результат движок кэширует сам. */
  detect(force?: boolean): Promise<StudioEngineDetection>;
  /**
   * Ход вкладки. Промис CLI-движка может завершиться сразу после запуска процесса: конец хода — только колбэки
   * `onComplete`/`onError`.
   */
  run(req: StudioEngineRequest, handlers: StudioEngineHandlers<Chunk>): Promise<void>;
}

/**
 * Движок запроса: явный и зарегистрированный — он; иначе по конфигу, правилом подписки `mainEngineOf` (decision-74).
 * Claude Code с провайдером не Anthropic не бывает: такой запрос идёт API-путём, как и раньше.
 */
export function studioEngineOfRequest(req: Pick<StudioEngineRequest, 'engine' | 'config'>): StudioEngineId {
  if (isStudioEngineId(req.engine) && (req.engine !== 'claude-code' || req.config.provider === 'anthropic')) return req.engine;
  return mainEngineOf(req.config) === 'claude-cli' ? 'claude-code' : 'api';
}

export class StudioEngineRegistry<Chunk = unknown> {
  private readonly engines = new Map<StudioEngineId, StudioEngine<Chunk>>();

  register(engine: StudioEngine<Chunk>): void {
    if (this.engines.has(engine.id)) throw new Error(`Studio engine already registered: ${engine.id}`);
    this.engines.set(engine.id, engine);
  }

  get(id: StudioEngineId): StudioEngine<Chunk> | undefined {
    return this.engines.get(id);
  }

  /** Движок запроса; незарегистрированный — ошибка вызывающего кода, а не тихий откат на другой движок. */
  resolve(req: Pick<StudioEngineRequest, 'engine' | 'config'>): StudioEngine<Chunk> {
    const id = studioEngineOfRequest(req);
    const engine = this.engines.get(id);
    if (!engine) throw new Error(`Studio engine is not registered: ${id}`);
    return engine;
  }

  ids(): StudioEngineId[] {
    return [...this.engines.keys()];
  }

  /** Доступность зарегистрированных движков в порядке `STUDIO_ENGINES`; сбой проверки — «не найден». */
  async statuses(force = false): Promise<StudioEngineStatus[]> {
    const ids = (Object.keys(STUDIO_ENGINES) as StudioEngineId[]).filter((id) => this.engines.has(id));
    return Promise.all(
      ids.map(async (id) => {
        const detection = await this.engines.get(id)!.detect(force).catch((): StudioEngineDetection => ({ available: false }));
        return { id, available: detection.available, ...(detection.version ? { version: detection.version } : {}) };
      })
    );
  }
}
