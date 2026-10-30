/**
 * Песочница участника общего хоста (TASK-150.1, [[decision-187]]): сборка аргументов `docker run` / `podman run`.
 * Чистый модуль без Electron и процессов. В контейнер монтируется только worktree участника — прямой подкаталог
 * `<проект>/.worktrees/`; основной `.git` проекта не монтируется: операции git делает хост ([[decision-187]] п. 2).
 * Пути передаются уже через `realpath`: junction или симлинк на чужой каталог сборщик по строке не распознает.
 * Ключей и токенов движков в контейнере нет: модель — через прокси хоста, его токен уходит переменной окружения
 * процесса `docker`/`podman`, а не аргументом (аргументы видны в списке процессов).
 */
import crypto from 'node:crypto';
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
  /**
   * Переменные для процесса в контейнере (TASK-150.2): адрес шлюза для CLI движка, его токен. В аргументы уходит только
   * имя, значение `docker`/`podman` берёт из своего окружения — секрет не виден в списке процессов.
   */
  passEnv?: Record<string, string>;
  /**
   * Именованный том для HOME участника (TASK-150.2): сессии CLI переживают `--rm` контейнера, и `--resume` цикла
   * «до готовности» находит разговор. Свой том на участника — чужие сессии не видны. Нет — HOME во временном /tmp.
   */
  homeVolume?: string;
  /**
   * Пути внутри worktree, которые контейнер видит только на чтение (TASK-150.2): файл `.git` (иначе агент перенаправит
   * `gitdir:` на свой каталог с `core.fsmonitor`, и git хоста выполнит его код) и каталог хуков при относительном
   * `core.hooksPath` (иначе подложенный хук выполнит коммит хоста). Пути относительные, через `/`, без `..`.
   */
  readOnlyPaths?: string[];
  /** Worktree целиком только на чтение: роль без записи файлов (Codex с `danger-full-access` внутри контейнера). */
  readOnlyWorktree?: boolean;
  /**
   * Файлы с секретами для команды (TASK-246): имя → содержимое. Значение уходит переменной окружения процесса
   * `docker`/`podman` (в аргументах только её имя), в контейнере обёртка `sh` пишет его в `SANDBOX_SECRET_DIR/<имя>`
   * с правами `0600`, снимает переменную и запускает команду. Конфиг MCP с токеном шлюза так не виден в списке процессов.
   */
  secretFiles?: Record<string, string>;
  /** Держать stdin открытым (`--interactive`): промпт CLI идёт через него. Проверкам и командам — `false`. */
  interactive?: boolean;
  command: string[];
}

export type SandboxPlan =
  | { ok: true; runtime: SandboxRuntime; args: string[]; env: Record<string, string>; name: string }
  | { ok: false; reason: 'imageInvalid' | 'pathInvalid' | 'worktreeOutsideProject' | 'memberInvalid' | 'emptyCommand' | 'networkInvalid' | 'networkRequired' | 'envInvalid' | 'volumeInvalid' };

/** Путь внутри контейнера, куда монтируется worktree. */
export const SANDBOX_WORKDIR = '/workspace';
/** HOME участника в томе (образ создаёт каталог пользователю node — новый том наследует владельца). */
export const SANDBOX_HOME = '/home/member';
export const PROXY_TOKEN_ENV = 'PROJECTHUB_MODEL_PROXY_TOKEN';
/** Каталог секретных файлов команды внутри контейнера: во временном `/tmp`, исчезает вместе с контейнером. */
export const SANDBOX_SECRET_DIR = '/tmp/projecthub';
const SECRET_ENV_PREFIX = 'PROJECTHUB_SECRET_FILE_';

/**
 * Путь из контейнера (`/workspace/…` или относительный от него) → путь на хосте внутри worktree; `null` — путь вне
 * worktree (файлы образа, `/tmp` контейнера, выход через `..`). Хост читает и пишет только то, что под worktree.
 */
export function hostPathFromSandbox(p: string, worktree: string): string | null {
  const posix = p.replace(/\\/g, '/');
  if (!posix) return null;
  let rel: string;
  if (posix === SANDBOX_WORKDIR) rel = '.';
  else if (posix.startsWith(`${SANDBOX_WORKDIR}/`)) rel = posix.slice(SANDBOX_WORKDIR.length + 1);
  else if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
  else rel = posix;
  const norm = path.posix.normalize(rel || '.');
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return norm === '.' ? worktree : path.join(worktree, ...norm.split('/'));
}

/** Поля путей во входе инструментов Claude Code (`Write`, `Edit`, `Read`, `NotebookEdit`, `Glob`, `Grep`). */
const TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath'] as const;
/** Путь вне worktree для политики: под этим префиксом он гарантированно вне корня проекта хоста. */
const OUTSIDE_PREFIX = '/__projecthub_container__';

/**
 * Вход инструмента агента в контейнере → вход для политики хоста (TASK-246): пути контейнера (`/workspace/…`)
 * становятся путями хоста под worktree, остальные — путями заведомо вне проекта (файлы образа и `/tmp` контейнера).
 * Иначе политика сочла бы любую запись в `/workspace` выходом из проекта, а абсолютный путь хоста, совпавший по
 * написанию, — путём внутри него.
 */
export function sandboxToolInput(input: Record<string, unknown>, worktree: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of TOOL_PATH_KEYS) {
    const v = input[key];
    if (typeof v !== 'string' || v === '') continue;
    out[key] = hostPathFromSandbox(v, worktree) ?? `${OUTSIDE_PREFIX}/${v.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  }
  return out;
}

/** Кусок значения одной переменной: на Windows одна переменная окружения не длиннее 32 767 символов. */
const SECRET_CHUNK = 16_000;

/** Значение по кускам без разрыва суррогатной пары. Пустое — один пустой кусок (файл всё равно создаётся). */
export function chunkSecret(value: string, size = SECRET_CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of value) {
    if (cur.length + ch.length > size) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Обёртка `sh -c` для секретных файлов: имена уже проверены, значения — только в переменных окружения, скрипт их не
 * содержит. `exec "$@"` — команда без лишней оболочки, со своими аргументами как есть.
 */
function secretWrapper(files: Array<{ name: string; vars: string[] }>, command: string[]): string[] {
  const writes = files.flatMap(({ name, vars }) => vars.map((v, j) => `printf '%s' "$${v}" ${j === 0 ? '>' : '>>'} ${SANDBOX_SECRET_DIR}/${name}`));
  const unset = files.flatMap((f) => f.vars).join(' ');
  const script = ['umask 077', `mkdir -p ${SANDBOX_SECRET_DIR}`, ...writes, `unset ${unset}`, 'exec "$@"'].join(' && ');
  return ['/bin/sh', '-c', script, 'projecthub-secrets', ...command];
}

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
  const passEnv = Object.entries(req.passEnv ?? {});
  // Имена как в окружении POSIX; служебные переменные контейнера не перекрываются.
  if (
    passEnv.some(([name]) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || ['HOME', 'PATH', 'PROJECTHUB_MEMBER_ID'].includes(name) || name.startsWith(SECRET_ENV_PREFIX))
  ) {
    return { ok: false, reason: 'envInvalid' };
  }
  const secretEntries = Object.entries(req.secretFiles ?? {});
  if (secretEntries.some(([name]) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name))) return { ok: false, reason: 'pathInvalid' };
  // Имена переменных — по номеру файла и куска; значения уходят только в окружение процесса docker/podman.
  const secrets = secretEntries.map(([name, content], i) => {
    const chunks = chunkSecret(content);
    return { name, vars: chunks.map((_, j) => `${SECRET_ENV_PREFIX}${i}_${j}`), chunks };
  });

  if (req.homeVolume !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(req.homeVolume)) return { ok: false, reason: 'volumeInvalid' };
  const readOnly = req.readOnlyPaths ?? [];
  if (readOnly.some((p) => !p || /[,=\n\\]/.test(p) || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..'))) {
    return { ok: false, reason: 'pathInvalid' };
  }
  const limits = clampLimits(req.limits);
  // Разовые команды и проверки участника идут параллельно: одной метки времени мало для уникального имени.
  const name = `ph-member-${req.memberId}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const home = req.homeVolume ? SANDBOX_HOME : '/tmp';
  const user = req.user && Number.isInteger(req.user.uid) && Number.isInteger(req.user.gid) ? req.user : { uid: 1000, gid: 1000 };
  const args = [
    'run',
    '--rm',
    ...(req.interactive === false ? [] : ['--interactive']),
    `--name=${name}`,
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
    `--mount=type=bind,source=${path.resolve(req.worktree)},target=${SANDBOX_WORKDIR}${req.readOnlyWorktree ? ',readonly' : ''}`,
    // Поверх worktree и после него: более поздний mount перекрывает путь.
    ...readOnly.map((p) => `--mount=type=bind,source=${path.join(path.resolve(req.worktree), ...p.split('/'))},target=${SANDBOX_WORKDIR}/${p},readonly`),
    ...(req.homeVolume ? [`--mount=type=volume,source=${req.homeVolume},target=${SANDBOX_HOME}`] : []),
    `--workdir=${SANDBOX_WORKDIR}`,
    `--env=HOME=${home}`,
    `--env=PROJECTHUB_MEMBER_ID=${req.memberId}`,
    // Только имя: значение `docker`/`podman` берёт из своего окружения.
    ...(req.proxy ? [`--env=PROJECTHUB_MODEL_PROXY=${req.proxy.url}`, `--env=${PROXY_TOKEN_ENV}`] : []),
    ...passEnv.map(([name]) => `--env=${name}`),
    ...secrets.flatMap((f) => f.vars.map((v) => `--env=${v}`)),
    req.image,
    ...(secrets.length > 0 ? secretWrapper(secrets, req.command) : req.command)
  ];
  return {
    ok: true,
    runtime: req.runtime,
    name,
    args,
    env: {
      ...(req.proxy ? { [PROXY_TOKEN_ENV]: req.proxy.token } : {}),
      ...Object.fromEntries(passEnv),
      ...Object.fromEntries(secrets.flatMap((f) => f.vars.map((v, j) => [v, f.chunks[j]])))
    }
  };
}
