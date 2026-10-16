import path from 'node:path';
import { existsSync } from 'node:fs';

/** Подпапка инфраструктуры шаблона по умолчанию (`DEFAULT_SUBFOLDER` в templateManifest.ts). */
const DEFAULT_SUBFOLDER = '.projecthub/infra';

/**
 * Каталог состояния env-tools проекта (`processes.json`, логи). env-tools шаблона пишет его рядом со
 * своими скриптами (`INFRA_ROOT/.env-state`): в корне проекта, если инфраструктура в корне, и в
 * `.projecthub/infra/.env-state`, если шаблон лёг в подпапку (decision-78, п. 6). Корень — по умолчанию.
 */
export function envStateDir(projectPath: string, exists: (p: string) => boolean = existsSync): string {
  const root = path.normalize(projectPath);
  const rootDir = path.join(root, '.env-state');
  if (exists(rootDir)) return rootDir;
  const infraDir = path.join(root, ...DEFAULT_SUBFOLDER.split('/'), '.env-state');
  return exists(infraDir) ? infraDir : rootDir;
}
