/**
 * Песочница участника на хосте (TASK-150.2, TASK-246, [[decision-187]], [[decision-191]]): проверка среды контейнеров,
 * шлюз модели и HITL MCP, внутренняя сеть участников с пересыльщиком, выдача коротких токенов на запуск и разовые
 * команды и проверки в контейнере без сети. Решения — в чистых модулях `memberSandbox.ts`, `memberSandboxLauncher.ts`,
 * `memberGateway.ts`; здесь процессы `docker`/`podman` и жизненный цикл.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../../src/lib/appError.js';
import { MemberGateway, type GatewayModelUpstream, type GatewayUpstreams } from './memberGateway.js';
import { CLI_HITL_PERMISSION_TOOL } from './claudeBridgeService.js';
import {
  GATEWAY_CONTAINER,
  GATEWAY_NETWORK,
  GATEWAY_SOCKET_NAME,
  gatewayNetworkPlan,
  memberNetwork,
  memberNetworkPlan,
  parseConfigList,
  pinRelativeCommand,
  sandboxedShellRun,
  type MemberSandboxSettings,
  type RuntimeStep
} from './memberSandboxLauncher.js';
import { llmProfileService } from './llmProfileService.js';
import { getUserDataDir } from './appPaths.js';
import { processManager, type RunOnceResult } from './processManager.js';
import { editionRegistry, type LauncherProfile } from '../extensions/editionRegistry.js';
import type { CheckSandboxRunner } from './checkRunner.js';

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
  const drivers = await git(['-C', projectRoot, 'config', '--get-regexp', '^((merge|filter)\\..+\\.(driver|clean|smudge|process)|diff\\..+\\.(textconv|command))$'])
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

/** Настройки контейнера из профиля запуска участника. */
export function sandboxSettingsOf(sandbox: NonNullable<LauncherProfile['sandbox']>): MemberSandboxSettings {
  return { runtime: sandbox.runtime, image: sandbox.image, ...(sandbox.limits ? { limits: sandbox.limits } : {}) };
}

/** Куда смонтировано: worktree участника и корень проекта после `realpath`, пользователь хоста, пути только на чтение. */
export interface MemberSandboxTarget {
  settings: MemberSandboxSettings;
  memberId: string;
  projectRoot: string;
  worktree: string;
  user?: { uid: number; gid: number };
  readOnlyPaths: string[];
}

/**
 * Каталог сокета шлюза на Linux: `$XDG_RUNTIME_DIR` пользователя (`0700`, короткий путь — у unix-сокета предел ~108
 * байт), иначе `<userData>`. Каталог свой, `0700`.
 */
async function gatewaySocketDir(): Promise<string> {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const dir = runtime && path.isAbsolute(runtime) ? path.join(runtime, 'projecthub-gateway') : path.join(getUserDataDir(), 'member-sandbox', 'gw');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const st = await fs.lstat(dir);
  // Чужой каталог или ссылка: сокет шлюза открылся бы другим пользователям хоста.
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new AppError('swarm.sandboxNetworkFailed', { detail: `gateway socket directory ${dir} is not owned by this user` });
  }
  if (Buffer.byteLength(path.join(dir, GATEWAY_SOCKET_NAME)) > 100) {
    throw new AppError('swarm.sandboxNetworkFailed', { detail: `gateway socket path is too long: ${dir}` });
  }
  return dir;
}

function hostUser(): { uid: number; gid: number } | undefined {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : undefined;
}

class MemberSandboxService {
  private gateway: MemberGateway | null = null;
  private mcp: GatewayUpstreams['mcp'];
  /** Сеть и пересыльщик готовы для этой среды, образа и адреса шлюза. */
  private readonly prepared = new Map<string, Promise<void>>();

  /** Встроенный MCP-сервер HITL: шлюз подставляет его токен вместо токена участника. */
  setMcpUpstream(mcp: NonNullable<GatewayUpstreams['mcp']>): void {
    this.mcp = mcp;
  }

  /** Среда контейнеров отвечает: иначе агента участника без изоляции не запускаем. */
  async checkRuntime(settings: MemberSandboxSettings): Promise<void> {
    try {
      await run(settings.runtime, ['version', '--format', '{{.Server.Version}}'], { timeout: 20_000, windowsHide: true });
    } catch (err) {
      throw new AppError('swarm.sandboxRuntimeUnavailable', { runtime: settings.runtime, detail: firstLine(err) });
    }
  }

  /**
   * Готовит запуск агента с моделью: среда контейнеров отвечает, ключ модели хоста известен, шлюз слушает, сеть
   * участника и пересыльщик подняты. Возвращает модель для токена этого запуска (у каждого участника свой профиль).
   * Отказ — `AppError`: агента участника без изоляции не запускаем.
   */
  async prepare(settings: MemberSandboxSettings, modelProfileId: string | undefined, memberId: string): Promise<GatewayModelUpstream> {
    await this.checkRuntime(settings);
    if (!modelProfileId) throw new AppError('swarm.sandboxNoModel');
    const { profile, apiKey } = await llmProfileService.getProfileWithKey(modelProfileId);
    const model: GatewayModelUpstream = { baseUrl: profile.baseUrl, ...(apiKey ? { apiKey } : {}), ...(profile.headers ? { headers: profile.headers } : {}) };

    if (!this.gateway) {
      this.gateway = new MemberGateway(
        () => (this.mcp ? { mcp: this.mcp } : {}),
        (e) => console.log(`[MemberSandbox] ${e.memberId} ${e.kind} ${e.path} -> ${e.status}`),
        sandboxToolAllowed
      );
    }
    // Docker Desktop и Podman machine доводят host.docker.internal / host.containers.internal до loopback хоста. На
    // Linux у шлюза нет сетевого адреса: unix-сокет в каталоге 0700, пересыльщику — монтированием каталога.
    let plan: RuntimeStep[];
    let key: string;
    if (process.platform === 'linux') {
      const socketDir = await gatewaySocketDir();
      await this.gateway.startSocket(path.join(socketDir, GATEWAY_SOCKET_NAME));
      const user = hostUser();
      plan = gatewayNetworkPlan({ runtime: settings.runtime, image: settings.image, socketDir, ...(user ? { user } : {}) });
      key = `${settings.runtime}|${settings.image}|${socketDir}`;
    } else {
      const { port } = await this.gateway.start('127.0.0.1', 0);
      plan = gatewayNetworkPlan({ runtime: settings.runtime, image: settings.image, hostPort: port });
      key = `${settings.runtime}|${settings.image}|${port}`;
    }

    let ready = this.prepared.get(key);
    // Docker перезапустили или пересыльщик упал — готовность из кэша уже неправда.
    if (ready && !(await this.gatewayRunning(settings))) {
      this.prepared.delete(key);
      ready = undefined;
    }
    if (!ready) {
      ready = this.runSteps(settings, plan);
      this.prepared.set(key, ready);
      ready.catch(() => this.prepared.delete(key));
    }
    await ready;
    if (process.platform === 'linux') await this.assertInternal(settings, GATEWAY_NETWORK);
    // Своя сеть участника; пересыльщик пересоздан — подключить заново (шаг необязательный, если уже подключён).
    await this.runSteps(settings, memberNetworkPlan(memberId));
    await this.assertInternal(settings, memberNetwork(memberId));
    return model;
  }

  /** Сеть с этим именем мог создать кто-то другой без --internal: контейнер вышел бы наружу. */
  private async assertInternal(settings: MemberSandboxSettings, net: string): Promise<void> {
    const internal = await run(settings.runtime, ['network', 'inspect', '--format', '{{.Internal}}', net], { timeout: 20_000, windowsHide: true })
      .then((r) => r.stdout.trim())
      .catch(() => '');
    if (internal !== 'true') throw new AppError('swarm.sandboxNetworkNotInternal', { network: net });
  }

  /**
   * Куда монтировать для запуска участника: пути после `realpath` (junction или симлинк не уведут монтирование в чужой
   * каталог, decision-187 п. 2), `.git` worktree только на чтение, git хоста в worktree без кода агента.
   */
  async target(profile: LauncherProfile, projectPath: string, worktreePath: string): Promise<MemberSandboxTarget> {
    if (!profile.sandbox) throw new AppError('swarm.sandboxNoWorktree');
    const projectRoot = await fs.realpath(projectPath);
    const worktree = await fs.realpath(worktreePath);
    const readOnlyPaths = await sandboxReadOnlyPaths(worktree);
    await hardenMemberWorktreeGit(projectRoot, worktree, path.join(getUserDataDir(), 'member-sandbox', 'empty-hooks'));
    const user = hostUser();
    return { settings: sandboxSettingsOf(profile.sandbox), memberId: profile.memberId, projectRoot, worktree, ...(user ? { user } : {}), readOnlyPaths };
  }

  /**
   * Разовая команда в контейнере участника без сети (TASK-246): команда инструмента API-агента, проверка цикла «до
   * готовности» или арены. Таймаут и отмена снимают контейнер по имени.
   */
  async runShell(
    target: MemberSandboxTarget,
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (text: string) => void; env?: Record<string, string>; maxOutputBytes?: number } = {}
  ): Promise<RunOnceResult> {
    const plan = sandboxedShellRun({ ...target, command, ...(options.env ? { env: options.env } : {}) });
    if (!plan.ok) throw new AppError('swarm.sandboxPlanInvalid', { reason: plan.reason });
    const stop = () => void this.removeContainer(target.settings.runtime, plan.name);
    return processManager.runOnce(command, {
      // Клиент docker/podman — из каталога хоста: в worktree агент мог положить свой docker.exe (decision-191).
      cwd: getUserDataDir(),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
      exec: { file: target.settings.runtime, args: plan.args, env: plan.env, onStop: stop }
    });
  }

  /**
   * Проверки участника в его контейнере (TASK-246): `null` — участник не изолирован, проверки идут на хосте как раньше.
   * Изолирован, а контейнер недоступен — `AppError`: проверки не выполняются хостом.
   */
  async checkRunner(memberId: string | undefined, projectPath: string, workdir: string): Promise<CheckSandboxRunner | null> {
    const profile = editionRegistry.launcherProfile(memberId);
    if (!profile?.sandbox) return null;
    await this.checkRuntime(sandboxSettingsOf(profile.sandbox));
    const target = await this.target(profile, projectPath, workdir);
    return (command, options) => this.runShell(target, command, options);
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

  /** Короткий токен шлюза на один запуск агента с моделью участника. */
  grant(memberId: string, hitlSessionId: string | undefined, model: GatewayModelUpstream): string {
    if (!this.gateway) throw new AppError('swarm.sandboxHitlUnavailable');
    return this.gateway.grant(memberId, { ...(hitlSessionId ? { hitlSessionId } : {}), model });
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
