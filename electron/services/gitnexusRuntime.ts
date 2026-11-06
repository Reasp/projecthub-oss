/**
 * Окружение процессов GitNexus (TASK-306, decision-223). FTS-расширение LadybugDB на Windows
 * (`~/.lbdb/extension/<ver>/win_amd64/fts/libfts.lbug_extension`) импортирует `libssl-3-x64.dll` и
 * `libcrypto-3-x64.dll`. Обычно они есть только в `mingw64\bin` Git for Windows, а этот каталог в PATH лишь у
 * Git Bash и git-хуков. Без него `gitnexus analyze` молча собирает граф без полнотекстового поиска
 * (`capabilities.fts.status: "unavailable"`, exit 0), а `gitnexus mcp`/`serve` отвечают без BM25.
 *
 * Здесь чистая часть: поиск каталога с OpenSSL, дописывание его в конец PATH (в конце он ничего не затеняет,
 * DLL Windows всё равно ищет по всему PATH) и разбор `capabilities.fts` из `.gitnexus/meta.json`.
 * Та же логика для MCP-сервера из `.mcp.json` — в `template/scripts/gitnexus/gitnexus.mjs`, совпадение
 * проверяет `tests/unit/gitnexusRuntime.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** DLL, которые импортирует FTS-расширение LadybugDB на Windows x64. */
export const OPENSSL_DLLS = ['libssl-3-x64.dll', 'libcrypto-3-x64.dll'] as const;

type Env = Record<string, string | undefined>;

/** Имя переменной PATH так, как оно записано в окружении (на Windows обычно `Path`). */
export function envPathKey(env: Env): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** Каталоги списка PATH Windows: без пустых и обрамляющих кавычек. */
export function splitWinPath(value: string | undefined): string[] {
  return (value ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function sameDir(a: string, b: string): boolean {
  const norm = (dir: string) => path.win32.normalize(dir).replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Каталог `mingw64\bin` по каталогу с `git.exe` из PATH: `<Git>\cmd`, `<Git>\bin` или сам `<Git>\mingw64\bin`. */
export function gitBinFromGitDir(dir: string): string {
  const normalized = path.win32.normalize(dir).replace(/\\+$/, '');
  const name = path.win32.basename(normalized).toLowerCase();
  const parent = path.win32.dirname(normalized);
  if (name === 'bin' && path.win32.basename(parent).toLowerCase() === 'mingw64') return normalized;
  return path.win32.join(parent, 'mingw64', 'bin');
}

/** Каталог `mingw64\bin` по выводу `git --exec-path` (`C:/Program Files/Git/mingw64/libexec/git-core`). */
export function gitBinFromExecPath(execPath: string): string | null {
  const trimmed = execPath.trim();
  if (!trimmed) return null;
  return path.win32.resolve(path.win32.normalize(trimmed), '..', '..', 'bin');
}

export interface OpensslLookupDeps {
  platform: NodeJS.Platform;
  env: Env;
  exists(file: string): boolean;
  /** `git --exec-path`; зовётся последним и только если другие места не подошли. */
  gitExecPath(): string | null;
}

/** Каталоги, где обычно лежит OpenSSL Git for Windows, без `git --exec-path`. */
export function opensslCandidates(env: Env, exists: (file: string) => boolean): string[] {
  const out: string[] = [];
  const add = (dir: string | null | undefined) => {
    if (dir && !out.some((known) => sameDir(known, dir))) out.push(dir);
  };
  for (const dir of splitWinPath(env[envPathKey(env)])) {
    if (exists(path.win32.join(dir, 'git.exe'))) add(gitBinFromGitDir(dir));
  }
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = env[key];
    if (base) add(path.win32.join(base, 'Git', 'mingw64', 'bin'));
  }
  if (env.LOCALAPPDATA) add(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'mingw64', 'bin'));
  return out;
}

const hasDlls = (dir: string, exists: (file: string) => boolean) => OPENSSL_DLLS.every((dll) => exists(path.win32.join(dir, dll)));

/** Обе DLL OpenSSL уже находятся по PATH окружения. */
export function opensslOnPath(env: Env, exists: (file: string) => boolean): boolean {
  const pathDirs = splitWinPath(env[envPathKey(env)]);
  return OPENSSL_DLLS.every((dll) => pathDirs.some((dir) => exists(path.win32.join(dir, dll))));
}

/**
 * Каталог, который нужно дописать в PATH процесса GitNexus, чтобы загрузилось FTS-расширение. `null` — не
 * Windows, DLL уже находятся по PATH или OpenSSL нигде не найден.
 */
export function findOpensslDir(deps: OpensslLookupDeps): string | null {
  if (deps.platform !== 'win32' || opensslOnPath(deps.env, deps.exists)) return null;
  const found = opensslCandidates(deps.env, deps.exists).find((dir) => hasDlls(dir, deps.exists));
  if (found) return found;
  let execPath: string | null;
  try {
    execPath = deps.gitExecPath();
  } catch {
    execPath = null;
  }
  const fromGit = execPath ? gitBinFromExecPath(execPath) : null;
  return fromGit && hasDlls(fromGit, deps.exists) ? fromGit : null;
}

/** Изменение окружения для процесса GitNexus: PATH с каталогом OpenSSL в конце; пусто, если дописывать нечего. */
export function gitnexusEnvPatch(env: Env, opensslDir: string | null): Record<string, string> {
  if (!opensslDir) return {};
  const key = envPathKey(env);
  const current = env[key] ?? '';
  if (splitWinPath(current).some((dir) => sameDir(dir, opensslDir))) return {};
  return { [key]: current ? `${current.replace(/;+$/, '')};${opensslDir}` : opensslDir };
}

/** Команда запускает CLI gitnexus (`gitnexus analyze …`), — ей нужно окружение с OpenSSL. */
export function isGitnexusCommand(command: string): boolean {
  return /^\s*gitnexus(\.cmd)?(\s|$)/i.test(command);
}

export type FtsStatus = 'available' | 'unavailable';

/**
 * `capabilities.fts.status` из `.gitnexus/meta.json`. `null` — meta не читается или GitNexus старый и не пишет
 * capabilities: тогда о полнотекстовом поиске ничего не известно и предупреждать не о чем.
 */
export function parseFtsStatus(metaText: string | null): FtsStatus | null {
  if (!metaText) return null;
  try {
    const meta = JSON.parse(metaText) as { capabilities?: { fts?: { status?: unknown } } };
    const status = meta?.capabilities?.fts?.status;
    return status === 'available' || status === 'unavailable' ? status : null;
  } catch {
    return null;
  }
}

let resolvedOpensslDir: { dir: string | null } | null = null;

/** Каталог OpenSSL для процессов GitNexus этой машины; ищется один раз за жизнь процесса ProjectHub. */
export function gitnexusOpensslDir(): string | null {
  if (resolvedOpensslDir) return resolvedOpensslDir.dir;
  const dir = findOpensslDir({
    platform: process.platform,
    env: process.env,
    exists: (file) => existsSync(file),
    gitExecPath: () => execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  });
  resolvedOpensslDir = { dir };
  if (dir) console.log(`[GitNexus] OpenSSL для FTS-расширения: ${dir} (дописывается в PATH процессов gitnexus)`);
  return dir;
}

/**
 * Загрузится ли FTS-расширение у процессов gitnexus, которые запускает ProjectHub: не Windows, OpenSSL уже в PATH
 * или найден и дописывается. `false` — на Windows OpenSSL 3 нет нигде (нет Git for Windows).
 */
export function gitnexusFtsLoadable(): boolean {
  if (process.platform !== 'win32') return true;
  return gitnexusOpensslDir() !== null || opensslOnPath(process.env, (file) => existsSync(file));
}

/** Переменные окружения поверх `base` для процесса gitnexus (для `startProcess`/`runOnce` с `env`). */
export function gitnexusEnvOverrides(base: Env = process.env): Record<string, string> {
  return gitnexusEnvPatch(base, gitnexusOpensslDir());
}

/** Полное окружение процесса gitnexus: `base` с каталогом OpenSSL в конце PATH. */
export function gitnexusProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...gitnexusEnvOverrides(base) };
}
