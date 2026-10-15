/**
 * Команда запуска Cloudflare Quick Tunnel (TASK-140.9). Чистый модуль без Electron.
 *
 * Раньше туннель запускался как `spawn('npx.cmd', …)` без shell. Node 18.20+/20.12+ запрещает запуск
 * `.cmd`/`.bat` без shell (CVE-2024-27980) и бросает `EINVAL` синхронно, поэтому на Windows кнопка
 * «Запустить туннель» молча не делала ничего. Теперь сначала ищем установленный `cloudflared`: он
 * запускается напрямую, без shell, и его можно остановить обычным `kill`. Если его нет — `npx cloudflared`
 * через shell (аргументы — константы, внешнего ввода в них нет).
 */

export interface TunnelCommand {
  command: string;
  args: string[];
  /** Нужен shell (только для `npx`): процесс тогда останавливается деревом, а не одним `kill`. */
  shell: boolean;
}

export interface TunnelCommandEnv {
  platform: NodeJS.Platform;
  /** Значение `PATH`. */
  pathEnv: string;
  /** `ProgramFiles` и `ProgramFiles(x86)` на Windows. */
  programFiles?: string[];
  exists: (file: string) => boolean;
  /** Разделитель путей; по умолчанию `;` на Windows и `:` иначе. */
  delimiter?: string;
  /** Склейка пути; по умолчанию через `\` на Windows и `/` иначе. */
  join?: (...parts: string[]) => string;
}

export function tunnelArgs(port: number): string[] {
  return ['tunnel', '--url', `http://127.0.0.1:${port}`];
}

/** Путь к установленному `cloudflared` или `null`. */
export function findCloudflared(env: TunnelCommandEnv): string | null {
  const win = env.platform === 'win32';
  const delimiter = env.delimiter ?? (win ? ';' : ':');
  const join = env.join ?? ((...parts: string[]) => parts.join(win ? '\\' : '/').replace(win ? /\\+/g : /\/+/g, win ? '\\' : '/'));
  const exe = win ? 'cloudflared.exe' : 'cloudflared';
  const dirs = env.pathEnv.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  // Установщик Cloudflare для Windows кладёт exe в Program Files (x86)\cloudflared и не всегда добавляет его в PATH.
  if (win) {
    for (const pf of env.programFiles ?? []) {
      if (pf) dirs.push(join(pf, 'cloudflared'));
    }
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  }
  for (const dir of dirs) {
    const file = join(dir, exe);
    if (env.exists(file)) return file;
  }
  return null;
}

export function resolveTunnelCommand(port: number, env: TunnelCommandEnv): TunnelCommand {
  const installed = findCloudflared(env);
  if (installed) return { command: installed, args: tunnelArgs(port), shell: false };
  return {
    command: env.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', 'cloudflared', ...tunnelArgs(port)],
    shell: env.platform === 'win32'
  };
}
