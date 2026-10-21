import { edition, modules } from 'virtual:projecthub-edition/main';
import { editionRegistry, type EditionMainModule } from './editionRegistry.js';

/** Редакция сборки: `team` — с модулями `ee/`, `open` — без них (decision-123 п. 3). */
export const buildEdition: 'open' | 'team' = edition;

let loaded: Promise<void> | null = null;

/** Регистрирует модули `ee/electron/*` один раз на процесс; в открытой редакции список пуст. */
export function loadEditionModules(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const api = editionRegistry.api();
      for (const mod of modules as EditionMainModule[]) {
        try {
          await mod.register?.(api);
        } catch (err) {
          console.error('[edition] Модуль не зарегистрировался:', err);
        }
      }
    })();
  }
  return loaded;
}
