import type { CliCommandList } from '../types/electron';

/**
 * Команды Claude Code для автодополнения `/` (TASK-300, decision-214). Список даёт CLI ответом `initialize` — это запуск
 * процесса на секунды, поэтому он кэшируется на аккаунт, каталог и `/add-dir` вкладки. Старый список показывается сразу,
 * а через {@link CLI_COMMANDS_TTL_MS} перезапрашивается в фоне: так появляются новые команды проекта и скиллы.
 */

export const CLI_COMMANDS_TTL_MS = 5 * 60_000;

export interface CliCommandScope {
  claudeAccountId?: string;
  cwd: string;
  addDirs?: readonly string[];
}

interface Entry {
  at: number;
  value?: CliCommandList | null;
  pending?: Promise<CliCommandList | null>;
}

export function cliCommandScopeKey(scope: CliCommandScope): string {
  return [scope.claudeAccountId ?? '', scope.cwd, ...(scope.addDirs ?? [])].join('\n');
}

export function createCliCommandCache(fetchList: (scope: CliCommandScope) => Promise<CliCommandList | null>, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  return {
    /** Что уже есть: список, `null` — CLI не ответил, `undefined` — ещё не спрашивали. */
    peek(scope: CliCommandScope): CliCommandList | null | undefined {
      return entries.get(cliCommandScopeKey(scope))?.value;
    },
    /** Запросить, если списка нет или он устарел; повторный вызов во время запроса ждёт тот же запрос. */
    load(scope: CliCommandScope): Promise<CliCommandList | null> {
      const key = cliCommandScopeKey(scope);
      const entry = entries.get(key);
      if (entry?.pending) return entry.pending;
      if (entry && entry.value !== undefined && now() - entry.at < CLI_COMMANDS_TTL_MS) return Promise.resolve(entry.value);
      const pending = fetchList(scope)
        .catch(() => null)
        .then((value) => {
          const prev = entries.get(key);
          // Сбой фонового обновления не стирает прежний список.
          entries.set(key, { at: now(), value: value ?? prev?.value ?? null });
          return value ?? prev?.value ?? null;
        });
      entries.set(key, { at: entry?.at ?? 0, ...(entry?.value !== undefined ? { value: entry.value } : {}), pending });
      return pending;
    }
  };
}

const caches = new Map<string, ReturnType<typeof createCliCommandCache>>();

/** Кэш окна: команды запрашиваются через `ai:cliCommands` под аккаунтом вкладки. */
export function windowCliCommandCache(projectPath: string) {
  let cache = caches.get(projectPath);
  if (!cache) {
    cache = createCliCommandCache(async (scope) => {
      const result = await window.api.cliCommands({
        projectPath,
        cwd: scope.cwd,
        ...(scope.claudeAccountId ? { claudeAccountId: scope.claudeAccountId } : {}),
        ...(scope.addDirs?.length ? { addDirs: [...scope.addDirs] } : {})
      });
      return result.ok ? result.list : null;
    });
    caches.set(projectPath, cache);
  }
  return cache;
}
