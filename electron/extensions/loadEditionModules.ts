import { edition, modules } from 'virtual:projecthub-edition/main';
import { editionRegistry, type EditionMainApi, type EditionMainModule } from './editionRegistry.js';

/** Редакция сборки: `team` — с модулями `ee/`, `open` — без них (decision-123 п. 3). */
export const buildEdition: 'open' | 'team' = edition;

let loaded: Promise<void> | null = null;
let active = true;

/** Модули `ee/` работают: ни один шлюз (`gate`) не отказал. В открытой редакции модулей нет, и ответ — true. */
export function editionModulesActive(): boolean {
  return active;
}

/**
 * Регистрация списка модулей. Сначала модули-шлюзы (TASK-200): если хоть один ответил `active: false`, остальные не
 * регистрируются. Сбой самого шлюза модули не отключает — он пишется в лог, а за поведение при ошибке отвечает шлюз.
 * Возвращает итог шлюзов.
 */
export async function registerModules(list: readonly EditionMainModule[], api: EditionMainApi): Promise<boolean> {
  const gates = list.filter((mod) => typeof mod.gate === 'function');
  const rest = list.filter((mod) => typeof mod.gate !== 'function');
  const register = async (mod: EditionMainModule) => {
    try {
      await mod.register?.(api);
    } catch (err) {
      console.error('[edition] Модуль не зарегистрировался:', err);
    }
  };
  for (const mod of gates) await register(mod);
  let ok = true;
  for (const mod of gates) {
    try {
      if (!(await mod.gate!()).active) ok = false;
    } catch (err) {
      console.error('[edition] Шлюз модулей не ответил:', err);
    }
  }
  if (!ok) {
    console.warn('[edition] Модули редакции отключены шлюзом; открытая часть работает');
    return false;
  }
  for (const mod of rest) await register(mod);
  return true;
}

/** Регистрирует модули `ee/electron/*` один раз на процесс; в открытой редакции список пуст. */
export function loadEditionModules(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      active = await registerModules(modules as EditionMainModule[], editionRegistry.api());
    })();
  }
  return loaded;
}
