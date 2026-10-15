import path from 'node:path';

export type TemplateSource = 'custom' | 'registry' | 'env' | 'builtin' | 'none';

export interface TemplateCandidates {
  /** Путь, переданный явно (поле мастера). */
  custom?: string | null;
  /** `settings.templatePath` из реестра. */
  registry?: string | null;
  /** Переменная окружения `PROJECT_TEMPLATE_PATH`. */
  env?: string | null;
  /** Встроенный шаблон (`resources/template` или `template/` репозитория). */
  builtin?: string | null;
}

/**
 * Выбор шаблона по приоритету (decision-78, п. 7): явный путь → настройка → `PROJECT_TEMPLATE_PATH` →
 * встроенный шаблон. Пустые строки пропускаются. Встроенный берётся, только если каталог существует.
 */
export function pickTemplatePath(
  candidates: TemplateCandidates,
  exists: (p: string) => boolean
): { path: string; source: TemplateSource } {
  const custom = candidates.custom?.trim();
  if (custom) return { path: path.normalize(custom), source: 'custom' };

  const registry = candidates.registry?.trim();
  if (registry) return { path: registry, source: 'registry' };

  const env = candidates.env?.trim();
  if (env) return { path: path.normalize(env), source: 'env' };

  const builtin = candidates.builtin?.trim();
  if (builtin && exists(builtin)) return { path: builtin, source: 'builtin' };

  return { path: '', source: 'none' };
}
