import { existsSync } from 'node:fs';
import { projectRegistry } from './projectRegistry';
import { getBuiltinTemplateDir } from './appPaths';
import { pickTemplatePath, type TemplateSource } from './templateSource';

export type { TemplateSource } from './templateSource';

export interface TemplateAvailability {
  available: boolean;
  /** Путь, который будет использован (пустая строка, если источник не определён). */
  path: string;
  /** Откуда взят путь: явный аргумент, реестр, переменная окружения, встроенный шаблон. */
  source: TemplateSource;
}

/**
 * Разрешение пути к встроенному шаблону (TASK-43, decision-78). `process.cwd()` не используется:
 * в упакованном приложении он произволен. Приоритет: явный путь → настройка реестра
 * (`settings.templatePath`) → `PROJECT_TEMPLATE_PATH` → встроенный шаблон (`resources/template`,
 * в dev-режиме `template/` репозитория). Создание и инициализация проектов — `projectInitService.ts`.
 */
export async function resolveTemplatePath(customSource?: string): Promise<{ path: string; source: TemplateSource }> {
  return pickTemplatePath(
    {
      custom: customSource,
      registry: await projectRegistry.getTemplatePath(),
      env: process.env.PROJECT_TEMPLATE_PATH,
      builtin: getBuiltinTemplateDir()
    },
    existsSync
  );
}

export async function checkTemplateAvailable(customSource?: string): Promise<TemplateAvailability> {
  const resolved = await resolveTemplatePath(customSource);
  const available = Boolean(resolved.path) && existsSync(resolved.path);
  return { available, path: resolved.path, source: resolved.source };
}
