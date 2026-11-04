import path from 'node:path';

/**
 * Подготовка каталога аккаунта Claude Code к интерактивному запуску из ProjectHub (TASK-292, decision-216).
 * Чистый модуль: без файловой системы и Electron — разбор и правка содержимого `<CLAUDE_CONFIG_DIR>/.claude.json`.
 *
 * Claude Code (2.1.317) показывает первичную настройку, пока в конфиге нет `hasCompletedOnboarding: true`, и диалог
 * доверия, пока у папки запуска (или её родителя внутри того же git-репозитория) нет
 * `projects[<путь>].hasTrustDialogAccepted: true`. Ключ `projects` — абсолютный путь, на Windows с прямыми слэшами.
 */

/** Значения записи проекта, которые CLI создаёт сам (`allowedTools`, `mcpServers` и т.д.), — чтобы запись была полной. */
export const CLI_PROJECT_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false
});

export type ClaudeConfigChange = 'onboarding' | `trust:${string}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ключи `projects` для папки так, как их строит CLI: абсолютный путь без завершающего слэша, на Windows `\` → `/`.
 * Буква диска на Windows — в обоих регистрах: CLI берёт путь из `process.cwd()`, а регистр там тот, что передал
 * запускающий процесс.
 */
export function cliProjectKeys(dir: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!dir?.trim()) return [];
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let resolved = impl.resolve(dir.trim());
  if (resolved.length > 1 && /[\\/]$/.test(resolved) && !/^[A-Za-z]:[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
  if (platform !== 'win32') return [resolved];
  const key = resolved.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:/.test(key) ? key[0] : null;
  if (!drive) return [key];
  return [...new Set([key, drive.toUpperCase() + key.slice(1), drive.toLowerCase() + key.slice(1)])];
}

/**
 * Новое содержимое `.claude.json`: первичная настройка пройдена, папки доверены. Остальные поля не трогаются.
 * `null` — содержимое не объект (файл повреждён или чужого формата): такой файл ProjectHub не правит.
 */
export function prepareClaudeConfig(
  config: unknown,
  trustKeys: readonly string[]
): { next: Record<string, unknown>; changes: ClaudeConfigChange[] } | null {
  if (!isPlainObject(config)) return null;
  const changes: ClaudeConfigChange[] = [];
  const next: Record<string, unknown> = { ...config };
  if (next.hasCompletedOnboarding !== true) {
    next.hasCompletedOnboarding = true;
    changes.push('onboarding');
  }
  if (trustKeys.length > 0) {
    const projects: Record<string, unknown> = isPlainObject(next.projects) ? { ...next.projects } : {};
    for (const key of trustKeys) {
      const existing = projects[key];
      if (isPlainObject(existing) && existing.hasTrustDialogAccepted === true) continue;
      projects[key] = { ...CLI_PROJECT_DEFAULTS, ...(isPlainObject(existing) ? existing : {}), hasTrustDialogAccepted: true };
      changes.push(`trust:${key}`);
    }
    if (changes.some((c) => c.startsWith('trust:'))) next.projects = projects;
  }
  return { next, changes };
}
