/**
 * Файлы хуков агентов Codex CLI и Gemini CLI (TASK-261, decision-226): скрипт хука в каталоге ProjectHub и наш
 * обработчик в `.gemini/settings.json` рабочего каталога на время запуска. Без Electron — каталог передаёт вызывающий.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_HOOK_SCRIPT_FILE, AGENT_HOOK_SCRIPT_SOURCE, mergeGeminiAgentHooks } from './agentEngineHooks.js';
import { AppError } from '../../src/lib/appError.js';

/** Пишет скрипт хука в `<dir>/projecthub-agent-hook.mjs`, если его нет или он устарел; возвращает путь. */
export async function ensureAgentHookScript(dir: string): Promise<string> {
  const target = path.join(dir, AGENT_HOOK_SCRIPT_FILE);
  const current = await fs.readFile(target, 'utf-8').catch(() => null);
  if (current === AGENT_HOOK_SCRIPT_SOURCE) return target;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, AGENT_HOOK_SCRIPT_SOURCE, 'utf-8');
  await fs.rename(tmp, target);
  return target;
}

interface GeminiInstall {
  count: number;
  /** Текст файла до установки; null — файла не было, после снятия пустой файл удаляется. */
  original: string | null;
  /** Что записали мы: файл без чужих правок за время запуска возвращается к `original` байт в байт. */
  installed: string;
  createdDir: boolean;
  /** Очередь операций над файлом каталога: установка и снятие не перемешиваются. */
  chain: Promise<void>;
}

const geminiInstalls = new Map<string, GeminiInstall>();

function installKey(settingsPath: string): string {
  const resolved = path.resolve(settingsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Ставит наш обработчик в `.gemini/settings.json` каталога `workDir` и возвращает снятие. Несколько запусков в одном
 * каталоге делят одну запись (счётчик): обработчик один, а токен у каждого процесса свой — в его окружении.
 * Файл, созданный нами, после снятия удаляется вместе с пустым каталогом `.gemini`; чужие настройки сохраняются.
 */
export async function installGeminiWorkspaceHooks(workDir: string, command: string): Promise<() => Promise<void>> {
  const dir = path.join(workDir, '.gemini');
  const settingsPath = path.join(dir, 'settings.json');
  const key = installKey(settingsPath);
  let entry = geminiInstalls.get(key);
  if (entry) {
    entry.count += 1;
  } else {
    const created: GeminiInstall = { count: 1, original: null, installed: '', createdDir: false, chain: Promise.resolve() };
    geminiInstalls.set(key, created);
    entry = created;
    const install = async () => {
      const current = await fs.readFile(settingsPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      const merged = mergeGeminiAgentHooks(current, command);
      if (!merged.ok) throw new AppError('swarm.geminiSettingsInvalid', { path: settingsPath, reason: merged.error });
      const dirExisted = await fs.stat(dir).then(() => true, () => false);
      await fs.mkdir(dir, { recursive: true });
      created.createdDir = !dirExisted;
      created.original = current;
      created.installed = merged.content ?? '{}\n';
      await fs.writeFile(settingsPath, created.installed, 'utf-8');
    };
    created.chain = install();
    try {
      await created.chain;
    } catch (err) {
      geminiInstalls.delete(key);
      throw err;
    }
  }
  await entry.chain;
  const own = entry;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    own.count -= 1;
    if (own.count > 0) return;
    geminiInstalls.delete(key);
    own.chain = own.chain.then(async () => {
      const current = await fs.readFile(settingsPath, 'utf-8').catch(() => null);
      if (current === null) return;
      const merged = current === own.installed ? { ok: true as const, content: null } : mergeGeminiAgentHooks(current, null);
      // Агент испортил файл — оставляем как есть: чужие правки не перезаписываются.
      if (!merged.ok) return;
      if (merged.content === null) {
        // Кроме нашего обработчика в файле ничего не осталось: вернуть как было.
        if (own.original === null) {
          await fs.unlink(settingsPath).catch(() => undefined);
          if (own.createdDir) await fs.rmdir(dir).catch(() => undefined);
        } else {
          await fs.writeFile(settingsPath, own.original, 'utf-8');
        }
        return;
      }
      if (merged.content !== current) await fs.writeFile(settingsPath, merged.content, 'utf-8');
    });
    await own.chain.catch(() => undefined);
  };
}
