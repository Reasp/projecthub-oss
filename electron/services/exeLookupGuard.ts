/**
 * Поиск программы в рабочем каталоге на Windows (ревью TASK-246, [[decision-191]]). Node (libuv) и `cmd.exe` по голому
 * имени (`git`, `docker`, `npm`) сначала ищут исполняемый файл в текущем каталоге дочернего процесса, потом в `PATH`.
 * Хост запускает git, npm и docker в worktree, которые пишут агенты: подложенный `git.exe` выполнился бы от пользователя
 * хоста. Переменная `NoDefaultCurrentDirectoryInExePath` выключает этот поиск и для libuv, и для `cmd.exe`.
 *
 * Модуль импортируется первым в `main.ts`: переменная задана до любого запуска процессов. Команды, которые набирает
 * или задаёт сам человек (терминал, процессы проекта), получают окружение без неё — `start-web.bat` в каталоге проекта
 * у них запускается как раньше.
 */
export const EXE_LOOKUP_ENV = 'NoDefaultCurrentDirectoryInExePath';

export function guardExeLookup(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') env[EXE_LOOKUP_ENV] = '1';
}

/**
 * Окружение команд человека: прежний поиск программы в текущем каталоге `cmd.exe`. Рабочий каталог внутри `.worktrees/`
 * (его пишут агенты, в том числе изолированного участника) — защита остаётся: `cmd` не найдёт подложенный `npm.cmd`.
 */
export function humanShellEnv<T extends Record<string, string | undefined>>(env: T, cwd?: string): T {
  if (cwd && /(^|[\\/])\.worktrees([\\/]|$)/i.test(cwd)) return { ...env };
  const out = { ...env };
  delete out[EXE_LOOKUP_ENV];
  return out;
}

guardExeLookup();
