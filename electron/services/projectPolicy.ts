import { FAIL_CLOSED_PERMISSIONS, type ProjectPolicyPermissions } from '../../src/lib/projectPolicy.js';

/**
 * Точка расширения политики проекта (TASK-148.1, decision-181): модуль Enterprise регистрирует, откуда брать файл
 * политики для пути проекта или worktree. Без модуля политики нет, и поведение не меняется.
 */

export interface ResolvedProjectPolicy {
  permissions: ProjectPolicyPermissions;
  /** Версия для аудита: хэш файла, `invalid:<хэш>` для неверного файла. */
  version: string;
}

type Provider = (projectOrWorkDir: string) => ResolvedProjectPolicy | undefined;

let provider: Provider | null = null;

export function setProjectPolicyProvider(next: Provider | null): void {
  provider = next;
}

/** Политика проекта, к которому относится путь; сбой провайдера — всё через человека, а не без политики. */
export function projectPolicyFor(projectOrWorkDir: string | undefined): ResolvedProjectPolicy | undefined {
  if (!provider || !projectOrWorkDir) return undefined;
  try {
    return provider(projectOrWorkDir);
  } catch (err) {
    console.warn('[projectPolicy] provider failed:', err);
    return { permissions: FAIL_CLOSED_PERMISSIONS, version: 'error' };
  }
}
