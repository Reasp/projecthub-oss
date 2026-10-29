/**
 * Настройка `@huggingface/transformers` для main и воркеров (TASK-147.2, [[decision-186]] п. 4, 7). Один модуль на всех:
 * воркеры (`ragWorker`, `whisperWorker`) — обычные .mjs без сборки, main импортирует его же.
 *
 * Обычный режим: кэш моделей приложения (`<userData>/models`), недостающее качается с хаба. Закрытый контур (`offline`):
 * хаб выключен (`allowRemoteModels = false`), модели ищутся только в кэше и по тому же пути как локальные — туда их кладёт
 * офлайн-пакет. Обёртка `fetch` main воркеры не покрывает, поэтому запрет здесь, а не только на сетевом экране.
 */

/**
 * @param {{ cacheDir?: string, allowLocalModels?: boolean, allowRemoteModels?: boolean, localModelPath?: string }} env
 * @param {{ cacheDir: string, offline?: boolean }} options
 */
export function configureTransformersEnv(env, { cacheDir, offline = false }) {
  if (!env) return;
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  if (offline) {
    env.allowRemoteModels = false;
    // Раскладка кэша и локальных моделей одна и та же: `<каталог>/<id модели>/<файл>`.
    env.localModelPath = cacheDir.endsWith('/') || cacheDir.endsWith('\\') ? cacheDir : `${cacheDir}/`;
  }
}
