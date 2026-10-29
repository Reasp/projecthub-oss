/**
 * Песочница участника общего хоста (TASK-150.1, [[decision-187]]): сборка аргументов `docker run` / `podman run`.
 * Чистый модуль без Electron и процессов. В контейнер монтируется только worktree участника — прямой подкаталог
 * `<проект>/.worktrees/`; основной `.git` проекта не монтируется: операции git делает хост ([[decision-187]] п. 2).
 * Пути передаются уже через `realpath`: junction или симлинк на чужой каталог сборщик по строке не распознает.
 * Ключей и токенов движков в контейнере нет: модель — через прокси хоста, его токен уходит переменной окружения
 * процесса `docker`/`podman`, а не аргументом (аргументы видны в списке процессов).
 */
import path from 'node:path';

export type SandboxRuntime = 'docker' | 'podman';

export interface SandboxLimits {
  /** Доля ядер, например 2 или 0.5. */
  cpus: number;
  memoryMb: number;
  pids: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { cpus: 2, memoryMb: 4096, pids: 512 };

export interface SandboxRequest {
  runtime: SandboxRuntime;
  image: string;
  memberId: string;
  /** Корень проекта на хосте (после `realpath`). */
  projectRoot: string;
  /** Worktree участника на хосте (после `realpath`) — единственный каталог с записью. */
  worktree: string;
  /** Пользователь хоста, от которого пишутся файлы worktree (Docker; Podman отображает его сам через `keep-id`). */
  user?: { uid: number; gid: number };
  limits?: Partial<SandboxLimits>;
  /**
   * Сеть контейнера. Без прокси — `none`. С прокси — имя внутренней сети, где кроме контейнера есть только прокси
   * хоста ([[decision-187]] п. 3): выхода наружу в ней нет.
   */
  network?: string;
  /** Адрес прокси модели в сети контейнера и короткий токен участника. */
  proxy?: { url: string; token: string };
  command: string[];
}

export type SandboxPlan =
  | { ok: true; runtime: SandboxRuntime; args: string[]; env: Record<string, string> }
  | { ok: false; reason: 'imageInvalid' | 'pathInvalid' | 'worktreeOutsideProject' | 'memberInvalid' | 'emptyCommand' | 'networkInvalid' | 'networkRequired' };

/** Путь внутри контейнера, куда монтируется worktree. */
export const SANDBOX_WORKDIR = '/workspace';
export const PROXY_TOKEN_ENV = 'PROJECTHUB_MODEL_PROXY_TOKEN';

const sameFs = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Прямой подкаталог `<root>/.worktrees/`: ни сам `.worktrees` (все участники), ни основное дерево, ни `.git`. */
function isWorktreeOf(worktree: string, projectRoot: string): boolean {
  const parent = path.dirname(path.resolve(worktree));
  const name = path.basename(path.resolve(worktree));
  return sameFs(parent, path.join(path.resolve(projectRoot), '.worktrees')) && name !== '' && name !== '.' && name !== '..';
}

function clampLimits(raw: Partial<SandboxLimits> | undefined): SandboxLimits {
  const num = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
  return {
    cpus: num(raw?.cpus, DEFAULT_SANDBOX_LIMITS.cpus, 0.25, 64),
    memoryMb: Math.round(num(raw?.memoryMb, DEFAULT_SANDBOX_LIMITS.memoryMb, 256, 262144)),
    pids: Math.round(num(raw?.pids, DEFAULT_SANDBOX_LIMITS.pids, 64, 32768))
  };
}

export function buildSandboxRun(req: SandboxRequest): SandboxPlan {
  if (!/^[a-z0-9][a-z0-9._/:@-]{0,254}$/i.test(req.image)) return { ok: false, reason: 'imageInvalid' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.memberId)) return { ok: false, reason: 'memberInvalid' };
  // Запятая и `=` в пути разорвали бы `--mount=type=bind,source=…` на лишние параметры.
  if (/[,=\n]/.test(req.worktree)) return { ok: false, reason: 'pathInvalid' };
  if (!isWorktreeOf(req.worktree, req.projectRoot)) return { ok: false, reason: 'worktreeOutsideProject' };
  if (req.command.length === 0) return { ok: false, reason: 'emptyCommand' };
  if (req.network !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(req.network)) return { ok: false, reason: 'networkInvalid' };
  // С прокси нужна сеть до него; `bridge`/`host` по умолчанию выпустили бы контейнер наружу.
  if (req.proxy && (!req.network || /^(none|bridge|host|default)$/i.test(req.network))) return { ok: false, reason: 'networkRequired' };

  const limits = clampLimits(req.limits);
  const user = req.user && Number.isInteger(req.user.uid) && Number.isInteger(req.user.gid) ? req.user : { uid: 1000, gid: 1000 };
  const args = [
    'run',
    '--rm',
    '--interactive',
    `--name=ph-member-${req.memberId}-${Date.now().toString(36)}`,
    `--label=projecthub.member=${req.memberId}`,
    `--network=${req.network ?? 'none'}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    // HOME — в /tmp: кэши CLI и загружаемые бинарники должны запускаться, поэтому `exec`.
    '--tmpfs=/tmp:rw,exec,size=1024m',
    // Podman rootless: пользователь хоста отображается в контейнер (`keep-id`), файлы worktree остаются его.
    ...(req.runtime === 'podman' ? ['--userns=keep-id'] : [`--user=${user.uid}:${user.gid}`]),
    `--cpus=${limits.cpus}`,
    `--memory=${limits.memoryMb}m`,
    `--memory-swap=${limits.memoryMb}m`,
    `--pids-limit=${limits.pids}`,
    `--mount=type=bind,source=${path.resolve(req.worktree)},target=${SANDBOX_WORKDIR}`,
    `--workdir=${SANDBOX_WORKDIR}`,
    '--env=HOME=/tmp',
    `--env=PROJECTHUB_MEMBER_ID=${req.memberId}`,
    // Только имя: значение `docker`/`podman` берёт из своего окружения.
    ...(req.proxy ? [`--env=PROJECTHUB_MODEL_PROXY=${req.proxy.url}`, `--env=${PROXY_TOKEN_ENV}`] : []),
    req.image,
    ...req.command
  ];
  return { ok: true, runtime: req.runtime, args, env: req.proxy ? { [PROXY_TOKEN_ENV]: req.proxy.token } : {} };
}
