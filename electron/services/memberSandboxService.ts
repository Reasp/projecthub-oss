/**
 * Песочница участника на хосте (TASK-150.2, [[decision-187]]): проверка среды контейнеров, шлюз модели и HITL MCP,
 * внутренняя сеть участников с пересыльщиком и выдача коротких токенов на запуск. Решения — в чистых модулях
 * `memberSandbox.ts`, `memberSandboxLauncher.ts`, `memberGateway.ts`; здесь процессы `docker`/`podman` и жизненный цикл.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../../src/lib/appError.js';
import { MemberGateway, type GatewayUpstreams } from './memberGateway.js';
import { CLI_HITL_PERMISSION_TOOL } from './claudeBridgeService.js';
import { GATEWAY_CONTAINER, gatewayNetworkPlan, memberNetwork, memberNetworkPlan, parseConfigList, pinRelativeCommand, type MemberSandboxSettings, type RuntimeStep } from './memberSandboxLauncher.js';
import { llmProfileService } from './llmProfileService.js';

const run = promisify(execFile);

/**
 * Инструменты MCP, доступные агенту в контейнере: только запрос разрешения человека. Память проекта (`memory_*`) пишет
 * в основное дерево хоста без одобрения — изолированному участнику она закрыта (ревью TASK-150.2).
 */
export function sandboxToolAllowed(name: string): boolean {
  return name === CLI_HITL_PERMISSION_TOOL;
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return String(e?.stderr || e?.message || err).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300) ?? '';
}

/**
 * Что в worktree участника контейнер видит только на чтение: файл `.git` — иначе агент перенаправит `gitdir:` на свой
 * каталог с конфигом, и git хоста выполнит его код. Файл должен быть обычным файлом: симлинк увёл бы монтирование
 * (и запись хоста) за пределы worktree.
 */
export async function sandboxReadOnlyPaths(worktree: string): Promise<string[]> {
  const st = await fs.lstat(path.join(worktree, '.git')).catch(() => null);
  if (!st?.isFile()) throw new AppError('swarm.sandboxNoWorktree');
  return ['.git'];
}

/**
 * Git хоста в worktree изолированного участника не выполняет код из дерева (ревью TASK-150.2): настройки — в
 * `config.worktree` этого worktree (лежит в общем `.git`, в контейнер не монтируется). Хуки — пустой каталог хоста
 * (хуки проекта вызывают скрипты дерева, `node scripts/…`), `core.fsmonitor` выключен, команды драйверов слияния и
 * фильтров — с путями от корня проекта хоста, а не от worktree.
 */
export async function hardenMemberWorktreeGit(projectRoot: string, worktree: string, emptyHooksDir: string): Promise<void> {
  const git = (args: string[]) => run('git', args, { timeout: 30_000, windowsHide: true });
  await fs.mkdir(emptyHooksDir, { recursive: true });
  await git(['-C', projectRoot, 'config', 'extensions.worktreeConfig', 'true']);
  const set = (key: string, value: string) => git(['-C', worktree, 'config', '--worktree', key, value]);
  await set('core.hooksPath', emptyHooksDir);
  await set('core.fsmonitor', 'false');
  const drivers = await git(['-C', projectRoot, 'config', '--get-regexp', '^(merge|filter)\\..+\\.(driver|clean|smudge|process)$'])
    .then((r) => parseConfigList(r.stdout))
    .catch(() => []);
  for (const { key, value } of drivers) {
    const pinned = pinRelativeCommand(value, projectRoot);
    if (pinned !== value) await set(key, pinned);
  }
}

/** Корень API Anthropic для `ANTHROPIC_BASE_URL`: CLI сам дописывает `/v1/messages`. */
export function anthropicRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

class MemberSandboxService {
  private gateway: MemberGateway | null = null;
  private model: GatewayUpstreams['model'];
  private mcp: GatewayUpstreams['mcp'];
  /** Сеть и пересыльщик готовы для этой среды, образа и порта шлюза. */
  private readonly prepared = new Map<string, Promise<void>>();

  /** Встроенный MCP-сервер HITL: шлюз подставляет его токен вместо токена участника. */
  setMcpUpstream(mcp: NonNullable<GatewayUpstreams['mcp']>): void {
    this.mcp = mcp;
  }

  /**
   * Готовит запуск: среда контейнеров отвечает, ключ модели хоста известен шлюзу, шлюз слушает, сеть участников и
   * пересыльщик подняты. Отказ — `AppError`: агента участника без изоляции не запускаем.
   */
  async prepare(settings: MemberSandboxSettings, modelProfileId: string | undefined, memberId: string): Promise<void> {
    try {
      await run(settings.runtime, ['version', '--format', '{{.Server.Version}}'], { timeout: 20_000, windowsHide: true });
    } catch (err) {
      throw new AppError('swarm.sandboxRuntimeUnavailable', { runtime: settings.runtime, detail: firstLine(err) });
    }
    if (!modelProfileId) throw new AppError('swarm.sandboxNoModel');
    const { profile, apiKey } = await llmProfileService.getProfileWithKey(modelProfileId);
    this.model = { baseUrl: anthropicRoot(profile.baseUrl), headers: { ...(profile.headers ?? {}), ...(apiKey ? { 'x-api-key': apiKey } : {}) } };

    if (!this.gateway) {
      this.gateway = new MemberGateway(
        () => ({ ...(this.model ? { model: this.model } : {}), ...(this.mcp ? { mcp: this.mcp } : {}) }),
        (e) => console.log(`[MemberSandbox] ${e.memberId} ${e.kind} ${e.path} -> ${e.status}`),
        sandboxToolAllowed
      );
    }
    // Docker Desktop и Podman machine доводят host.docker.internal / host.containers.internal до loopback хоста. На Linux
    // контейнер приходит на адрес моста — шлюз слушает все адреса и пускает только по токену участника.
    const { port } = await this.gateway.start(process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1', 0);

    const key = `${settings.runtime}|${settings.image}|${port}`;
    let ready = this.prepared.get(key);
    // Docker перезапустили или пересыльщик упал — готовность из кэша уже неправда.
    if (ready && !(await this.gatewayRunning(settings))) {
      this.prepared.delete(key);
      ready = undefined;
    }
    if (!ready) {
      ready = this.runSteps(settings, gatewayNetworkPlan({ runtime: settings.runtime, image: settings.image, hostPort: port }));
      this.prepared.set(key, ready);
      ready.catch(() => this.prepared.delete(key));
    }
    await ready;
    // Своя сеть участника; пересыльщик пересоздан — подключить заново (шаг необязательный, если уже подключён).
    await this.runSteps(settings, memberNetworkPlan(memberId));
    const net = memberNetwork(memberId);
    const internal = await run(settings.runtime, ['network', 'inspect', '--format', '{{.Internal}}', net], { timeout: 20_000, windowsHide: true })
      .then((r) => r.stdout.trim())
      .catch(() => '');
    // Сеть с этим именем мог создать кто-то другой без --internal: контейнер вышел бы наружу.
    if (internal !== 'true') throw new AppError('swarm.sandboxNetworkNotInternal', { network: net });
  }

  private async gatewayRunning(settings: MemberSandboxSettings): Promise<boolean> {
    try {
      const { stdout } = await run(settings.runtime, ['inspect', '--format', '{{.State.Running}}', GATEWAY_CONTAINER], { timeout: 20_000, windowsHide: true });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Остановка контейнера участника: клиент docker убит (на Windows — без сигнала контейнеру), а контейнер ещё работает. */
  async removeContainer(runtime: MemberSandboxSettings['runtime'], name: string): Promise<void> {
    await run(runtime, ['rm', '-f', name], { timeout: 60_000, windowsHide: true }).catch(() => undefined);
  }

  private async runSteps(settings: MemberSandboxSettings, steps: RuntimeStep[]): Promise<void> {
    for (const step of steps) {
      try {
        await run(settings.runtime, step.args, { timeout: 120_000, windowsHide: true });
      } catch (err) {
        if (!step.optional) throw new AppError('swarm.sandboxNetworkFailed', { detail: firstLine(err) });
      }
    }
  }

  /** Короткий токен шлюза на один запуск агента. */
  grant(memberId: string, hitlSessionId: string): string {
    if (!this.gateway) throw new AppError('swarm.sandboxHitlUnavailable');
    return this.gateway.grant(memberId, { hitlSessionId });
  }

  revoke(token: string): void {
    this.gateway?.revoke(token);
  }

  async stop(): Promise<void> {
    await this.gateway?.stop();
    this.gateway = null;
    this.prepared.clear();
  }
}

export const memberSandboxService = new MemberSandboxService();
