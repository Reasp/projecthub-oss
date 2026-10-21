import fs from 'node:fs';
import path from 'node:path';

/**
 * Запуск npm-CLI на Windows без оболочки (TASK-168). npm ставит CLI обёрткой `<name>.cmd`. `execFile` без оболочки
 * её не находит (ENOENT), а `shell: true` отдаёт аргументы разбору cmd.exe: пути с `&`, `%` или кавычками
 * выполнились бы как команды. Поэтому обёртка разбирается: из неё берётся JS-точка входа пакета, и она
 * запускается через node с аргументами как есть.
 */

export interface NodeCliCommand {
  command: string;
  /** Аргументы перед аргументами вызова: путь к JS-точке входа пакета. */
  prefixArgs: string[];
}

/**
 * Точка входа из содержимого npm-обёртки `.cmd` (cmd-shim): `"%dp0%\node_modules\pkg\cli.js" %*` (новый формат)
 * или `"%~dp0\node_modules\pkg\cli.js" %*` (старый). `null`, если это не обёртка node-скрипта.
 */
export function parseNpmCmdShim(content: string, shimDir: string): string | null {
  const match = content.match(/"%~?dp0%?\\([^"%]+\.[cm]?js)"\s+%\*/i);
  if (!match) return null;
  return path.win32.join(shimDir, match[1]);
}

export interface ResolveNodeCliDeps {
  platform: NodeJS.Platform;
  pathEnv: string | undefined;
  exists(file: string): boolean;
  readFile(file: string): string;
}

const realDeps = (): ResolveNodeCliDeps => ({
  platform: process.platform,
  pathEnv: process.env.PATH ?? process.env.Path,
  exists: (file) => fs.existsSync(file),
  readFile: (file) => fs.readFileSync(file, 'utf-8')
});

/**
 * Как запустить npm-CLI `name` без оболочки. На Windows — node и JS-точка входа из первой `name.cmd` в PATH
 * (node рядом с обёрткой, если есть, как делает сама обёртка). Не Windows или обёртка не найдена — сам `name`.
 */
export function resolveNodeCli(name: string, deps: ResolveNodeCliDeps = realDeps()): NodeCliCommand {
  if (deps.platform !== 'win32') return { command: name, prefixArgs: [] };
  for (const dir of (deps.pathEnv ?? '').split(';')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    const shim = path.win32.join(trimmed, `${name}.cmd`);
    if (!deps.exists(shim)) continue;
    let script: string | null;
    try {
      script = parseNpmCmdShim(deps.readFile(shim), trimmed);
    } catch {
      script = null;
    }
    if (!script || !deps.exists(script)) continue;
    const localNode = path.win32.join(trimmed, 'node.exe');
    return { command: deps.exists(localNode) ? localNode : 'node', prefixArgs: [script] };
  }
  return { command: name, prefixArgs: [] };
}
