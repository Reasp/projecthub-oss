/**
 * Политика проекта как код (TASK-148.1, decision-181): файл `.projecthub/policy.json` в репозитории проекта сужает
 * права одобрения инструментов любой роли и сессии проекта. Чистый модуль без Node и React; копия правил для CI
 * проекта — `template/scripts/policy-rules.mjs` (их совпадение проверяет unit-тест).
 *
 * Политика только сужает: булевы права `false` запрещают, `true` ничего не открывает; списки исключений и запретов
 * объединяются с настройками; таймауты берутся меньшие; allow-список инструментов пересекается с остальными.
 */

export const PROJECT_POLICY_FILE = '.projecthub/policy.json';
export const PROJECT_POLICY_VERSION = 1;

export interface ProjectPolicyPermissions {
  autoApprove?: boolean;
  allowCommands?: boolean;
  allowFileWrite?: boolean;
  allowFileRead?: boolean;
  allowSubagents?: boolean;
  writeExcludePatterns?: string[];
  readExcludePatterns?: string[];
  commandDenyList?: string[];
  allowedTools?: string[];
  commandTimeoutSec?: number;
  approvalTimeoutMin?: number;
}

export interface ProjectPolicy {
  version: number;
  permissions: ProjectPolicyPermissions;
}

const BOOL_KEYS = ['autoApprove', 'allowCommands', 'allowFileWrite', 'allowFileRead', 'allowSubagents'] as const;
const LIST_KEYS = ['writeExcludePatterns', 'readExcludePatterns', 'commandDenyList', 'allowedTools'] as const;
const NUMBER_KEYS = { commandTimeoutSec: [1, 86_400], approvalTimeoutMin: [1, 10_080] } as const;
const LIST_MAX = 200;

export type PolicyParse = { ok: true; policy: ProjectPolicy } | { ok: false; errors: string[] };

/** Разбор текста файла политики. Ошибки — английские строки для вывода CI и журнала. */
export function parseProjectPolicy(text: string): PolicyParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the policy must be a JSON object'] };
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) if (key !== 'version' && key !== 'permissions' && key !== '$schema') errors.push(`unknown field "${key}"`);
  if (root.version !== PROJECT_POLICY_VERSION) errors.push(`"version" must be ${PROJECT_POLICY_VERSION}`);
  const p = root.permissions;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('"permissions" must be an object');
    return { ok: false, errors };
  }
  const perms = p as Record<string, unknown>;
  const out: ProjectPolicyPermissions = {};
  for (const [key, value] of Object.entries(perms)) {
    if ((BOOL_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') errors.push(`permissions.${key} must be true or false`);
      else (out as Record<string, unknown>)[key] = value;
    } else if ((LIST_KEYS as readonly string[]).includes(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) errors.push(`permissions.${key} must be a list of non-empty strings`);
      else if (value.length > LIST_MAX) errors.push(`permissions.${key}: no more than ${LIST_MAX} items`);
      else (out as Record<string, unknown>)[key] = [...new Set(value.map((v: string) => v.trim()))];
    } else if (key in NUMBER_KEYS) {
      const [min, max] = NUMBER_KEYS[key as keyof typeof NUMBER_KEYS];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors.push(`permissions.${key} must be an integer from ${min} to ${max}`);
      else (out as Record<string, unknown>)[key] = value;
    } else errors.push(`unknown permission "${key}"`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: { version: PROJECT_POLICY_VERSION, permissions: out } };
}

/**
 * Права, когда файл политики есть, но неверен: всё через человека. Ошибка в политике не должна открывать то, что
 * политика закрывала.
 */
export const FAIL_CLOSED_PERMISSIONS: ProjectPolicyPermissions = {
  autoApprove: false,
  allowCommands: false,
  allowFileWrite: false,
  allowFileRead: false,
  allowSubagents: false
};
