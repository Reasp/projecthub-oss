import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  aiAgentService,
  killTree,
  quoteShellArg,
  type AIMessage,
  type AIProviderConfig,
  type LlmCompleteRequest,
  type LlmCompleteResult
} from './aiAgentService.js';
import { claudeBridgeService } from './claudeBridgeService.js';
import { buildAgentContext } from './contextBuilder.js';
import { llmProfileService } from './llmProfileService.js';
import { modelAssignmentService } from './modelAssignmentService.js';
import { modelTierService } from './modelTierService.js';
import { emptyModelAssignments, purposeLabel } from './modelPurposes.js';
import { emptyModelTierSettings } from './modelTiers.js';
import { assertModelUsable, describeResolvedModel, resolveModel, type ModelRouteContext, type ModelRouteInput, type ResolvedModel } from './modelRouter.js';
import { buildClaudeCliTurnCommand, parseClaudeCliTurnOutput } from './claudeCliTurn.js';
import { ProviderError, providerConfigError, timeoutError } from './providerErrors.js';
import { claudeCliEffortArgs } from './reasoningEffort.js';
import { apiToolNamesForCategories } from './roleEngineAdapter.js';
import { logger } from './logger.js';
import { claudeAccountService, defaultClaudeAccountDir } from './claudeAccountService.js';

/** Одноразовый запрос назначения: модель выбирает резолвер, а не вызывающий код. */
export interface ModelCompleteRequest extends Omit<LlmCompleteRequest, 'config'>, ModelRouteInput {}

export interface ModelCompleteResult extends LlmCompleteResult {
  resolved: ResolvedModel;
}

/** Один ход модели с чтением проекта: без worktree и без записи. */
export interface ModelTurnRequest extends ModelRouteInput {
  /** Идентификатор хода — для отмены и имён временных файлов. */
  sessionId: string;
  /** Каталог, который читает модель: проект или worktree кандидата. */
  projectPath: string;
  messages: AIMessage[];
  /** Системный промпт роли. */
  roleSystemPrompt?: string;
  /** Slug роли: по нему берётся привязка аккаунта Claude Code роли на машине (decision-87 п. 6). */
  roleSlug?: string;
  /** Задача, по которой собирается контекст (критерии, RAG, память). */
  taskId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Цель, разрешённая заранее (например, показанная пользователю до запуска). */
  resolved?: ResolvedModel;
}

export interface ModelTurnResult {
  text: string;
  /** Стоимость хода по API; у Claude Code по подписке её нет. */
  costUsd?: number;
  resolved: ResolvedModel;
}

type TurnOutput = Pick<ModelTurnResult, 'text' | 'costUsd'>;

export interface ModelCallDeps {
  loadContext(): Promise<ModelRouteContext>;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
  runApiTurn(req: ModelTurnRequest, config: AIProviderConfig): Promise<TurnOutput>;
  runCliTurn(req: ModelTurnRequest, resolved: ResolvedModel): Promise<TurnOutput>;
}

/** Что настроено у пользователя. Сбой чтения тиров или назначений не отменяет вызов: работает основная модель. */
async function loadRouteContext(): Promise<ModelRouteContext> {
  const [main, profiles, tiers, assignments] = await Promise.all([
    aiAgentService.getConfig(),
    llmProfileService.listProfiles().catch(() => []),
    modelTierService.getSettings().catch(() => emptyModelTierSettings()),
    modelAssignmentService.getSettings().catch(() => emptyModelAssignments())
  ]);
  return { main, profiles: profiles.map((p) => ({ id: p.id, name: p.name, local: p.local })), tiers, assignments };
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/** Один запрос `streamChat` без исполнителя инструментов — как это делали архитектор плана и ревьюер арены. */
function runApiTurn(req: ModelTurnRequest, config: AIProviderConfig): Promise<TurnOutput> {
  return new Promise<TurnOutput>((resolve, reject) => {
    let buffer = '';
    let costUsd: number | undefined;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      aiAgentService.abortStream(req.sessionId);
      finish(() => reject(new ProviderError(timeoutError(req.timeoutMs, { provider: config.provider, model: config.model }))));
    }, req.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      aiAgentService.abortStream(req.sessionId);
      finish(() => reject(abortError()));
    };
    if (req.signal?.aborted) {
      onAbort();
      return;
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });

    aiAgentService
      .streamChat(
        {
          sessionId: req.sessionId,
          projectPath: req.projectPath,
          messages: req.messages,
          config,
          mode: 'chat',
          ...(req.roleSystemPrompt ? { roleSystemPrompt: req.roleSystemPrompt } : {}),
          allowedToolNames: apiToolNamesForCategories(['read', 'search']),
          ...(req.taskId ? { taskId: req.taskId } : {})
        },
        (chunk) => {
          if (chunk.text) buffer += chunk.text;
          if (chunk.usage?.costUsd !== undefined) costUsd = chunk.usage.costUsd;
        },
        (finalMsg) => {
          if (finalMsg.usage?.costUsd !== undefined) costUsd = finalMsg.usage.costUsd;
          finish(() => resolve({ text: finalMsg.content || buffer, ...(costUsd !== undefined ? { costUsd } : {}) }));
        },
        (err, info) => finish(() => reject(info ? new ProviderError(info) : new Error(err)))
      )
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
  });
}

/** Промпт роли и контекст задачи — файлом: многострочный аргумент через `cmd.exe` обрезал бы команду. */
async function writeTurnSystemPrompt(req: ModelTurnRequest): Promise<string | undefined> {
  const parts: string[] = [];
  if (req.roleSystemPrompt?.trim()) parts.push(req.roleSystemPrompt.trim());
  try {
    const context = await buildAgentContext({ projectPath: req.projectPath, taskId: req.taskId });
    if (context.combined) parts.push(context.combined);
  } catch (err) {
    logger.warn('[modelCallService] contextBuilder failed:', err);
  }
  if (parts.length === 0) return undefined;
  const dir = path.join(defaultClaudeAccountDir(), 'turns');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${req.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.append-system-prompt.md`);
  await fs.writeFile(file, parts.join('\n\n'), { encoding: 'utf-8', mode: 0o600 });
  return file;
}

/** Ход через Claude Code CLI по подписке: рабочий каталог — проект, инструменты — только чтение. */
async function runCliTurn(req: ModelTurnRequest, resolved: ResolvedModel): Promise<TurnOutput> {
  const cli = await claudeBridgeService.ensureClaudeCliAvailable();
  if (!cli.available) throw providerConfigError(cli.message || 'Claude CLI недоступен.');
  if (req.signal?.aborted) throw abortError();

  const effort = claudeCliEffortArgs(resolved.reasoningEffort);
  if (effort.note) logger.info(`[modelCallService] ${effort.note}`);
  const systemPromptFile = await writeTurnSystemPrompt(req);
  const removeSystemPromptFile = () => {
    if (systemPromptFile) fs.unlink(systemPromptFile).catch(() => { /* файл мог быть уже удалён */ });
  };
  const errorContext = { provider: 'Claude Code', ...(resolved.model ? { model: resolved.model } : {}) };
  // Аккаунт — проекта хода (корень или worktree) и роли (decision-87 п. 5).
  const accountEnv = await claudeAccountService.envFor({ projectPath: req.projectPath, roleSlug: req.roleSlug });

  let command: ReturnType<typeof buildClaudeCliTurnCommand>;
  try {
    command = buildClaudeCliTurnCommand({
      ...(resolved.model ? { model: resolved.model } : {}),
      messages: req.messages,
      ...(systemPromptFile ? { systemPromptFile } : {}),
      effortArgs: effort.args
    });
  } catch (err) {
    removeSystemPromptFile();
    throw err;
  }

  return new Promise<TurnOutput>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('claude', command.args.map(quoteShellArg), {
        cwd: req.projectPath,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', ...accountEnv }
      });
    } catch (err) {
      removeSystemPromptFile();
      reject(new Error(`Не удалось запустить Claude CLI: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      removeSystemPromptFile();
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new ProviderError(timeoutError(req.timeoutMs, errorContext))));
    }, req.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      killTree(child);
      finish(() => reject(abortError()));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish(() => reject(new Error(`Claude CLI: ${err.message}`, { cause: err }))));
    child.on('close', (code) => {
      finish(() => {
        try {
          // Оценка CLI по прайс-листу в стоимость не идёт: на подписке деньги не списываются.
          resolve({ text: parseClaudeCliTurnOutput(stdout, errorContext).text });
        } catch (err) {
          if (err instanceof ProviderError) {
            reject(err);
            return;
          }
          const detail = stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : '';
          reject(new Error(`${err instanceof Error ? err.message : String(err)}; код выхода ${code}${detail}`, { cause: err }));
        }
      });
    });

    child.stdin.end(command.stdin, 'utf8');
  });
}

const DEFAULT_DEPS: ModelCallDeps = {
  loadContext: loadRouteContext,
  complete: (req) => aiAgentService.complete(req),
  runApiTurn,
  runCliTurn
};

/**
 * Вызовы модели по назначению (TASK-134.1, decision-74): резолвер выбирает движок и модель, исполнитель
 * делает вызов тем движком, который выбран. Виды вызова — одноразовый запрос (`complete`) и один ход с
 * чтением проекта (`turn`); агентов запускают AI Studio и fleet по тому же резолверу.
 */
export class ModelCallService {
  private readonly deps: ModelCallDeps;

  constructor(deps: Partial<ModelCallDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Чем сейчас обслуживается назначение. Не бросает: непригодная цель возвращается с `problem`. */
  async resolve(input: ModelRouteInput): Promise<ResolvedModel> {
    return resolveModel(input, await this.deps.loadContext());
  }

  async complete(req: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const { purpose, slot, role, tierHint, ...call } = req;
    const resolved = await this.usable({ purpose, slot, role, tierHint }, 'complete');
    const result = await this.deps.complete({ ...call, config: resolved.config });
    return { ...result, resolved };
  }

  async turn(req: ModelTurnRequest): Promise<ModelTurnResult> {
    const resolved = req.resolved ?? (await this.resolve(req));
    const config = this.checked(resolved, 'turn');
    logger.info(`[modelCallService] ${purposeLabel(resolved.purpose)}: ${describeResolvedModel(resolved)} (${resolved.source})`);
    const output = resolved.engine === 'claude-cli' ? await this.deps.runCliTurn(req, resolved) : await this.deps.runApiTurn(req, config);
    return { ...output, resolved };
  }

  private async usable(input: ModelRouteInput, kind: ResolvedModel['kind']): Promise<ResolvedModel & { config: AIProviderConfig }> {
    const resolved = await this.resolve(input);
    this.checked(resolved, kind);
    return resolved as ResolvedModel & { config: AIProviderConfig };
  }

  /** Вид вызова совпадает с назначением, цель пригодна, конфиг есть. */
  private checked(resolved: ResolvedModel, kind: ResolvedModel['kind']): AIProviderConfig {
    if (resolved.kind !== kind) {
      throw new Error(`Назначение «${purposeLabel(resolved.purpose)}» — вызов вида «${resolved.kind}», а не «${kind}».`);
    }
    assertModelUsable(resolved);
    if (!resolved.config) {
      // Резолвер помечает такие движки проблемой `engine_unsupported`; сюда попадает только ошибка кода.
      throw new Error(`Назначение «${purposeLabel(resolved.purpose)}»: у движка ${resolved.engine} нет конфига вызова.`);
    }
    return resolved.config;
  }
}

export const modelCallService = new ModelCallService();
