/**
 * Запуск агента участника в его контейнере (TASK-150.2, [[decision-187]] п. 3–5). Чистые функции без процессов:
 * план подготовки сети (внутренняя сеть + пересыльщик к шлюзу хоста), аргументы `docker`/`podman run` для Claude CLI
 * и конфиг HITL MCP строкой — файлы хоста в контейнер не попадают.
 *
 * Сеть: контейнер участника стоит только во внутренней сети `ph-members` (`--internal`, выхода наружу нет). В ней же —
 * пересыльщик `ph-gateway` (тот же образ, `forward.mjs`), подключённый и к сети по умолчанию: он передаёт TCP на шлюз
 * хоста (`memberGateway.ts`), который проверяет токен участника и подставляет ключи хоста.
 */
import { buildSandboxRun, type SandboxLimits, type SandboxPlan, type SandboxRuntime } from './memberSandbox.js';

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
 * Подготовка пересыльщика к шлюзу хоста (в сети по умолчанию; к сетям участников его подключает `memberNetworkPlan`). `hostGateway` — как контейнер достаёт хост: на Docker Desktop и Podman
 * machine — `host.docker.internal` / `host.containers.internal`, на Linux — `host-gateway` (шлюз должен слушать адрес
 * моста, а не только 127.0.0.1).
 */
export function gatewayNetworkPlan(input: { runtime: SandboxRuntime; image: string; hostPort: number }): RuntimeStep[] {
  const hostName = input.runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
  return [
    { args: ['rm', '-f', GATEWAY_CONTAINER], optional: true },
    {
      args: [
        'run',
        '-d',
        `--name=${GATEWAY_CONTAINER}`,
        '--label=projecthub.role=gateway',
        '--restart=unless-stopped',
        ...(input.runtime === 'docker' ? [`--add-host=${hostName}:host-gateway`] : []),
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--memory=128m',
        '--pids-limit=64',
        input.image,
        'node',
        '/opt/projecthub/forward.mjs',
        `0.0.0.0:${GATEWAY_CONTAINER_PORT}`,
        `${hostName}:${input.hostPort}`
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
 * Конфиг HITL MCP для Claude CLI в контейнере — строкой JSON для `--mcp-config`: подключение идёт к шлюзу, токен —
 * участника; токен MCP хоста подставит шлюз. `mcpPath` — путь SSE встроенного сервера (`/sse`).
 */
export function sandboxMcpConfig(input: { serverName: string; mcpPath: string; sessionParam: string; sessionId: string; token: string }): string {
  const url = new URL(`${GATEWAY_URL}/mcp${input.mcpPath.startsWith('/') ? '' : '/'}${input.mcpPath}`);
  url.searchParams.set(input.sessionParam, input.sessionId);
  return JSON.stringify({ mcpServers: { [input.serverName]: { type: 'sse', url: url.toString(), headers: { Authorization: `Bearer ${input.token}` } } } });
}

/**
 * Аргументы запуска Claude CLI участника. Модель — через шлюз (`ANTHROPIC_BASE_URL`, токен участника в
 * `ANTHROPIC_AUTH_TOKEN`); подписка и ключи хоста, `CLAUDE_CONFIG_DIR` в контейнер не передаются.
 */
export function sandboxedClaudeRun(input: {
  settings: MemberSandboxSettings;
  memberId: string;
  projectRoot: string;
  worktree: string;
  user?: { uid: number; gid: number };
  token: string;
  cliArgs: string[];
  extraEnv?: Record<string, string>;
  /** Только на чтение внутри worktree (`.git`, каталог хуков). */
  readOnlyPaths?: string[];
}): SandboxPlan {
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
    proxy: { url: `${GATEWAY_URL}/model`, token: input.token },
    passEnv: { ...(input.extraEnv ?? {}), ANTHROPIC_BASE_URL: `${GATEWAY_URL}/model`, ANTHROPIC_AUTH_TOKEN: input.token },
    command: ['claude', ...input.cliArgs]
  });
}
