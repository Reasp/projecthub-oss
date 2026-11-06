#!/usr/bin/env node
/**
 * Запуск CLI gitnexus с OpenSSL для FTS-расширения LadybugDB (TASK-306, decision-223).
 *
 * `node scripts/gitnexus/gitnexus.mjs mcp` — так MCP-сервер gitnexus подключён в `.mcp.json` и
 * `.agents/mcp_config.json`. На Windows FTS-расширение импортирует `libssl-3-x64.dll` и `libcrypto-3-x64.dll`,
 * которые обычно есть только в `mingw64\bin` Git for Windows; агент запускает MCP без этого каталога в PATH, и
 * поиск `query` идёт без BM25 («FTS indexes missing»). Обёртка находит каталог, дописывает его в конец PATH и
 * запускает gitnexus с теми же аргументами и stdio. Не Windows или OpenSSL уже в PATH — окружение не меняется.
 *
 * Та же логика в ProjectHub — `electron/services/gitnexusRuntime.ts`; совпадение проверяет его unit-тест.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENSSL_DLLS = ['libssl-3-x64.dll', 'libcrypto-3-x64.dll'];

export function envPathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

export function splitWinPath(value) {
  return (value ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function sameDir(a, b) {
  const norm = (dir) => path.win32.normalize(dir).replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function gitBinFromGitDir(dir) {
  const normalized = path.win32.normalize(dir).replace(/\\+$/, '');
  const name = path.win32.basename(normalized).toLowerCase();
  const parent = path.win32.dirname(normalized);
  if (name === 'bin' && path.win32.basename(parent).toLowerCase() === 'mingw64') return normalized;
  return path.win32.join(parent, 'mingw64', 'bin');
}

export function gitBinFromExecPath(execPath) {
  const trimmed = String(execPath ?? '').trim();
  if (!trimmed) return null;
  return path.win32.resolve(path.win32.normalize(trimmed), '..', '..', 'bin');
}

export function opensslCandidates(env, exists) {
  const out = [];
  const add = (dir) => {
    if (dir && !out.some((known) => sameDir(known, dir))) out.push(dir);
  };
  for (const dir of splitWinPath(env[envPathKey(env)])) {
    if (exists(path.win32.join(dir, 'git.exe'))) add(gitBinFromGitDir(dir));
  }
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) add(path.win32.join(env[key], 'Git', 'mingw64', 'bin'));
  }
  if (env.LOCALAPPDATA) add(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'mingw64', 'bin'));
  return out;
}

const hasDlls = (dir, exists) => OPENSSL_DLLS.every((dll) => exists(path.win32.join(dir, dll)));

export function opensslOnPath(env, exists) {
  const pathDirs = splitWinPath(env[envPathKey(env)]);
  return OPENSSL_DLLS.every((dll) => pathDirs.some((dir) => exists(path.win32.join(dir, dll))));
}

/** Каталог, который нужно дописать в PATH; `null` — не Windows, уже в PATH или OpenSSL не найден. */
export function findOpensslDir({ platform, env, exists, gitExecPath }) {
  if (platform !== 'win32' || opensslOnPath(env, exists)) return null;
  const found = opensslCandidates(env, exists).find((dir) => hasDlls(dir, exists));
  if (found) return found;
  let execPath;
  try {
    execPath = gitExecPath();
  } catch {
    execPath = null;
  }
  const fromGit = execPath ? gitBinFromExecPath(execPath) : null;
  return fromGit && hasDlls(fromGit, exists) ? fromGit : null;
}

export function gitnexusEnvPatch(env, opensslDir) {
  if (!opensslDir) return {};
  const key = envPathKey(env);
  const current = env[key] ?? '';
  if (splitWinPath(current).some((dir) => sameDir(dir, opensslDir))) return {};
  return { [key]: current ? `${current.replace(/;+$/, '')};${opensslDir}` : opensslDir };
}

/**
 * Как запустить gitnexus без оболочки: на Windows npm ставит обёртку `gitnexus.cmd` — из неё берётся JS-точка
 * входа и запускается через node (аргументы не разбирает cmd.exe). Не нашли — сам `gitnexus` через оболочку.
 */
export function resolveGitnexusCli(env, exists, readFile) {
  for (const dir of splitWinPath(env[envPathKey(env)])) {
    const shim = path.win32.join(dir, 'gitnexus.cmd');
    if (!exists(shim)) continue;
    let content;
    try {
      content = readFile(shim);
    } catch {
      continue;
    }
    const match = content.match(/"%~?dp0%?\\([^"%]+\.[cm]?js)"\s+%\*/i);
    if (!match) continue;
    const script = path.win32.join(dir, match[1]);
    if (!exists(script)) continue;
    const localNode = path.win32.join(dir, 'node.exe');
    return { command: exists(localNode) ? localNode : process.execPath, prefixArgs: [script], shell: false };
  }
  return { command: 'gitnexus', prefixArgs: [], shell: true };
}

function main() {
  const exists = (file) => existsSync(file);
  const opensslDir = findOpensslDir({
    platform: process.platform,
    env: process.env,
    exists,
    gitExecPath: () => execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  });
  const env = { ...process.env, ...gitnexusEnvPatch(process.env, opensslDir) };
  const cli =
    process.platform === 'win32'
      ? resolveGitnexusCli(process.env, exists, (file) => readFileSync(file, 'utf8'))
      : { command: 'gitnexus', prefixArgs: [], shell: false };
  // stdio как есть: MCP идёт по stdin/stdout, а gitnexus mcp сам завершается, когда закрывается stdin.
  const child = spawn(cli.command, [...cli.prefixArgs, ...process.argv.slice(2)], { stdio: 'inherit', env, shell: cli.shell, windowsHide: true });
  child.on('error', (err) => {
    process.stderr.write(`gitnexus: failed to start (${err.message}); install the CLI: npm i -g gitnexus\n`);
    process.exit(127);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
