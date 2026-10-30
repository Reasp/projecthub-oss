/**
 * Запуск агента участника в его контейнере (TASK-150.2, TASK-246, [[decision-187]] п. 3–5, [[decision-191]]). Чистые
 * функции без процессов: план подготовки сети (внутренняя сеть + пересыльщик к шлюзу хоста), аргументы
 * `docker`/`podman run` для CLI движков и для разовых команд и проверок, конфиг HITL MCP — файлы хоста в контейнер не
 * попадают.
 *
 * Сеть: контейнер участника стоит только во внутренней сети участника (`--internal`, выхода наружу нет). В ней же —
 * пересыльщик `ph-gateway` (тот же образ, `forward.mjs`), подключённый и к сети по умолчанию: он передаёт TCP на шлюз
 * хоста (`memberGateway.ts`), который проверяет токен участника и подставляет ключи хоста. На Linux шлюз слушает
 * unix-сокет, и пересыльщик получает его монтированием каталога — сетевого адреса у шлюза нет. Команды агента
 * API-движка и проверки идут в разовом контейнере без сети.
 */
import { buildSandboxRun, SANDBOX_SECRET_DIR, type SandboxLimits, type SandboxPlan, type SandboxRuntime } from './memberSandbox.js';

export interface MemberSandboxSettings {
  runtime: SandboxRuntime;
  /** Образ с Node, git и CLI движков (`deploy/member-sandbox/Dockerfile`). */
  image: string;
  limits?: Partial<SandboxLimits>;
}

/**
 * Внутренняя сеть участника (`--internal`, выхода наружу нет): своя у каждого — контейнеры разных участников друг друга
 * не видят; общий в ней только пересыльщик шлюза.
 */
export function memberNetwork(memberId: string): string {
  return `ph-member-net-${memberId}`;
}
export const GATEWAY_CONTAINER = 'ph-gateway';
export const GATEWAY_CONTAINER_PORT = 8080;
/** Адрес шлюза изнутри сети участников. */
export const GATEWAY_URL = `http://${GATEWAY_CONTAINER}:${GATEWAY_CONTAINER_PORT}`;
/** Каталог сокета шлюза в пересыльщике (Linux) и имя сокета. */
export const GATEWAY_SOCKET_DIR = '/run/projecthub';
export const GATEWAY_SOCKET_NAME = 'gateway.sock';
/**
 * Своя внутренняя сеть пересыльщика на Linux: с unix-сокетом мост по умолчанию ему не нужен, и `0.0.0.0:8080` не виден
 * ни локальным пользователям, ни другим контейнерам хоста (ревью TASK-246).
 */
export const GATEWAY_NETWORK = 'ph-gateway-net';
/** Переменная с токеном шлюза для Codex CLI (`env_key` провайдера). */
export const GATEWAY_TOKEN_ENV = 'PROJECTHUB_GATEWAY_TOKEN';

export interface RuntimeStep {
  args: string[];
  /** Шаг может упасть без вреда: сеть уже есть, старого пересыльщика нет. */
  optional?: boolean;
}

/** Сеть участника и подключение к ней пересыльщика. Сеть может уже быть — её `--internal` проверяет сервис. */
export function memberNetworkPlan(memberId: string): RuntimeStep[] {
  const net = memberNetwork(memberId);
  return [
    { args: ['network', 'create', '--internal', net], optional: true },
    // Уже подключён — шаг падает без вреда.
    { args: ['network', 'connect', `--alias=${GATEWAY_CONTAINER}`, net, GATEWAY_CONTAINER], optional: true }
  ];
}

/**
 * Подготовка пересыльщика к шлюзу хоста (в сети по умолчанию; к сетям участников его подключает `memberNetworkPlan`).
 * - `hostPort` — Docker Desktop и Podman machine: контейнер достаёт loopback хоста через `host.docker.internal` /
 *   `host.containers.internal`.
 * - `socketDir` — Linux: шлюз слушает unix-сокет в этом каталоге хоста (`0700`), каталог монтируется пересыльщику
 *   только на чтение, процесс пересыльщика — пользователь хоста (иначе сокет ему недоступен). Сетевого адреса у шлюза
 *   нет: ни `0.0.0.0`, ни адреса моста.
 */
export function gatewayNetworkPlan(input: {
  runtime: SandboxRuntime;
  image: string;
  hostPort?: number;
  socketDir?: string;
  user?: { uid: number; gid: number };
}): RuntimeStep[] {
  const hostName = input.runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
  const unix = input.socketDir !== undefined;
  if (unix && /[,=\n]/.test(input.socketDir!)) throw new RangeError('socketDir');
  const user = input.user && Number.isInteger(input.user.uid) && Number.isInteger(input.user.gid) ? input.user : { uid: 1000, gid: 1000 };
  return [
    { args: ['rm', '-f', GATEWAY_CONTAINER], optional: true },
    ...(unix ? [{ args: ['network', 'create', '--internal', GATEWAY_NETWORK], optional: true }] : []),
    {
      args: [
        'run',
        '-d',
        `--name=${GATEWAY_CONTAINER}`,
        ...(unix ? [`--network=${GATEWAY_NETWORK}`] : []),
        '--label=projecthub.role=gateway',
        '--restart=unless-stopped',
        ...(unix
          ? [
              `--mount=type=bind,source=${input.socketDir},target=${GATEWAY_SOCKET_DIR},readonly`,
              ...(input.runtime === 'podman' ? ['--userns=keep-id'] : [`--user=${user.uid}:${user.gid}`])
            ]
          : input.runtime === 'docker'
            ? [`--add-host=${hostName}:host-gateway`]
            : []),
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--memory=128m',
        '--pids-limit=64',
        input.image,
        'node',
        '/opt/projecthub/forward.mjs',
        `0.0.0.0:${GATEWAY_CONTAINER_PORT}`,
        unix ? `unix:${GATEWAY_SOCKET_DIR}/${GATEWAY_SOCKET_NAME}` : `${hostName}:${input.hostPort ?? 0}`
      ]
    }
  ];
}

/**
 * Команда драйвера слияния или фильтра git (`node "scripts/task-merge-driver.mjs" %O %A %B`): относительный путь в ней
 * git разрешает от рабочего дерева — в worktree участника это файл, который пишет его агент. Пути закрепляются от корня
 * проекта хоста. Токены с `/` или `\\`, не абсолютные и не плейсхолдеры (`%A`, `$VAR`), считаются путями.
 */
export function pinRelativeCommand(command: string, projectRoot: string): string {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return command.replace(/"([^"]*)"|(\S+)/g, (all, quoted: string | undefined, bare: string | undefined) => {
    const token = quoted ?? bare ?? '';
    const looksPath = /[\\/]/.test(token) && !/^([A-Za-z]:|[\\/]|~|%|\$)/.test(token) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(token);
    if (!looksPath) return all;
    const abs = `${root}/${token.replace(/\\/g, '/').replace(/^\.\//, '')}`;
    return `"${abs}"`;
  });
}

/** Строки `git config --get-regexp`: «ключ значение» → пары. */
export function parseConfigList(output: string): Array<{ key: string; value: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => /^(\S+)\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: m[1], value: m[2] }));
}

/**
 * Конфиг HITL MCP для Claude CLI в контейнере — JSON для `--mcp-config`: подключение идёт к шлюзу, токен — участника;
 * токен MCP хоста подставит шлюз. `mcpPath` — путь SSE встроенного сервера (`/sse`). В контейнер он попадает
 * секретным файлом (`SANDBOX_SECRET_DIR`), а не аргументом.
 */
export function sandboxMcpConfig(input: { serverName: string; mcpPath: string; sessionParam: string; sessionId: string; token: string }): string {
  const url = new URL(`${GATEWAY_URL}/mcp${input.mcpPath.startsWith('/') ? '' : '/'}${input.mcpPath}`);
  url.searchParams.set(input.sessionParam, input.sessionId);
  return JSON.stringify({ mcpServers: { [input.serverName]: { type: 'sse', url: url.toString(), headers: { Authorization: `Bearer ${input.token}` } } } });
}

/** Имя секретного файла конфига MCP и его путь в контейнере. */
export const SANDBOX_MCP_CONFIG_FILE = 'mcp.json';
export const SANDBOX_MCP_CONFIG_PATH = `${SANDBOX_SECRET_DIR}/${SANDBOX_MCP_CONFIG_FILE}`;
/** Системный промпт роли и задачи в контейнере: файлом, а не аргументом `docker` — аргументы видны в списке процессов. */
export const SANDBOX_PROMPT_FILE = 'system-prompt.md';

export type SandboxEngine = 'claude-cli' | 'codex-cli' | 'gemini-cli';

/**
 * Codex CLI в контейнере (TASK-246): своя песочница Codex (Landlock, seccomp) внутри контейнера без привилегий не
 * поднимается — границей служит контейнер, Codex получает `danger-full-access`. Роль без записи файлов
 * (`--sandbox read-only`) становится worktree, смонтированным только на чтение.
 */
export function codexContainerArgs(args: string[]): { args: string[]; readOnlyWorktree: boolean } {
  const out = [...args];
  let readOnlyWorktree = false;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--sandbox' && i + 1 < out.length) {
      readOnlyWorktree = readOnlyWorktree || out[i + 1] === 'read-only';
      out[i + 1] = 'danger-full-access';
    } else if (out[i].startsWith('--sandbox=')) {
      readOnlyWorktree = readOnlyWorktree || out[i] === '--sandbox=read-only';
      out[i] = '--sandbox=danger-full-access';
    }
  }
  return { args: out, readOnlyWorktree };
}

/**
 * Команда и окружение CLI движка в контейнере: модель — через шлюз, токен участника вместо ключа. Подписки и ключи
 * хоста, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` в контейнер не передаются.
 * - Claude CLI: `ANTHROPIC_BASE_URL` и `ANTHROPIC_AUTH_TOKEN`.
 * - Codex CLI: провайдер `projecthub` через `-c` (OpenAI Responses API шлюза), токен — в `PROJECTHUB_GATEWAY_TOKEN`.
 * - Gemini CLI: `GOOGLE_GEMINI_BASE_URL` и `GEMINI_API_KEY`.
 */
export function engineSandboxCommand(engine: SandboxEngine, cliArgs: string[], token: string): { command: string[]; env: Record<string, string>; readOnlyWorktree: boolean } {
  const model = `${GATEWAY_URL}/model`;
  if (engine === 'codex-cli') {
    const codex = codexContainerArgs(cliArgs);
    const provider = [
      'model_provider="projecthub"',
      'model_providers.projecthub.name="ProjectHub"',
      `model_providers.projecthub.base_url="${model}/v1"`,
      `model_providers.projecthub.env_key="${GATEWAY_TOKEN_ENV}"`,
      'model_providers.projecthub.wire_api="responses"'
    ].flatMap((kv) => ['-c', kv]);
    return { command: ['codex', ...provider, ...codex.args], env: { [GATEWAY_TOKEN_ENV]: token }, readOnlyWorktree: codex.readOnlyWorktree };
  }
  if (engine === 'gemini-cli') {
    return { command: ['gemini', ...cliArgs], env: { GOOGLE_GEMINI_BASE_URL: model, GEMINI_API_KEY: token }, readOnlyWorktree: false };
  }
  return { command: ['claude', ...cliArgs], env: { ANTHROPIC_BASE_URL: model, ANTHROPIC_AUTH_TOKEN: token }, readOnlyWorktree: false };
}

interface SandboxTarget {
  settings: MemberSandboxSettings;
  memberId: string;
  projectRoot: string;
  worktree: string;
  user?: { uid: number; gid: number };
  /** Только на чтение внутри worktree (`.git`, каталог хуков). */
  readOnlyPaths?: string[];
}

/** Аргументы запуска CLI движка участника во внутренней сети с шлюзом. */
export function sandboxedCliRun(
  input: SandboxTarget & {
    engine: SandboxEngine;
    token: string;
    cliArgs: string[];
    extraEnv?: Record<string, string>;
    /** Секретные файлы команды (конфиг MCP с токеном) — см. `SandboxRequest.secretFiles`. */
    secretFiles?: Record<string, string>;
  }
): SandboxPlan {
  const engine = engineSandboxCommand(input.engine, input.cliArgs, input.token);
  return buildSandboxRun({
    runtime: input.settings.runtime,
    image: input.settings.image,
    memberId: input.memberId,
    projectRoot: input.projectRoot,
    worktree: input.worktree,
    ...(input.user ? { user: input.user } : {}),
    ...(input.settings.limits ? { limits: input.settings.limits } : {}),
    network: memberNetwork(input.memberId),
    homeVolume: `ph-member-${input.memberId}-home`,
    ...(input.readOnlyPaths ? { readOnlyPaths: input.readOnlyPaths } : {}),
    ...(engine.readOnlyWorktree ? { readOnlyWorktree: true } : {}),
    ...(input.secretFiles ? { secretFiles: input.secretFiles } : {}),
    proxy: { url: `${GATEWAY_URL}/model`, token: input.token },
    passEnv: { ...(input.extraEnv ?? {}), ...engine.env },
    command: engine.command
  });
}

/**
 * Разовая команда в контейнере участника (TASK-246): команда инструмента API-агента или проверка цикла «до
 * готовности» и арены. Сети нет (`none`), шлюза и токена тоже; HOME — временный `/tmp`, stdin закрыт. Команда идёт в
 * `sh -c` внутри контейнера — оболочки хоста нет, экранирование хоста не нужно.
 */
export function sandboxedShellRun(input: SandboxTarget & { command: string; env?: Record<string, string> }): SandboxPlan {
  return buildSandboxRun({
    runtime: input.settings.runtime,
    image: input.settings.image,
    memberId: input.memberId,
    projectRoot: input.projectRoot,
    worktree: input.worktree,
    ...(input.user ? { user: input.user } : {}),
    ...(input.settings.limits ? { limits: input.settings.limits } : {}),
    ...(input.readOnlyPaths ? { readOnlyPaths: input.readOnlyPaths } : {}),
    interactive: false,
    passEnv: { CI: '1', FORCE_COLOR: '0', ...(input.env ?? {}) },
    command: ['/bin/sh', '-c', input.command]
  });
}
