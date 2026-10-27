// Проверка политики проекта `.projecthub/policy.json` для CI (копия правил ProjectHub: src/lib/projectPolicy.ts,
// TASK-148.1, decision-181 там). Политика только сужает права одобрения инструментов любой роли и сессии проекта.
// Совпадение с правилами ProjectHub проверяет его unit-тест.

export const PROJECT_POLICY_FILE = '.projecthub/policy.json';
export const PROJECT_POLICY_VERSION = 1;

const BOOL_KEYS = ['autoApprove', 'allowCommands', 'allowFileWrite', 'allowFileRead', 'allowSubagents'];
const LIST_KEYS = ['writeExcludePatterns', 'readExcludePatterns', 'commandDenyList', 'allowedTools'];
const NUMBER_KEYS = { commandTimeoutSec: [1, 86400], approvalTimeoutMin: [1, 10080] };
const LIST_MAX = 200;

/** Разбор текста политики: `{ ok: true, policy }` или `{ ok: false, errors }` (английские строки для вывода CI). */
export function parseProjectPolicy(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the policy must be a JSON object'] };
  for (const key of Object.keys(raw)) if (key !== 'version' && key !== 'permissions' && key !== '$schema') errors.push(`unknown field "${key}"`);
  if (raw.version !== PROJECT_POLICY_VERSION) errors.push(`"version" must be ${PROJECT_POLICY_VERSION}`);
  const perms = raw.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
    errors.push('"permissions" must be an object');
    return { ok: false, errors };
  }
  const out = {};
  for (const [key, value] of Object.entries(perms)) {
    if (BOOL_KEYS.includes(key)) {
      if (typeof value !== 'boolean') errors.push(`permissions.${key} must be true or false`);
      else out[key] = value;
    } else if (LIST_KEYS.includes(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) errors.push(`permissions.${key} must be a list of non-empty strings`);
      else if (value.length > LIST_MAX) errors.push(`permissions.${key}: no more than ${LIST_MAX} items`);
      else out[key] = [...new Set(value.map((v) => v.trim()))];
    } else if (key in NUMBER_KEYS) {
      const [min, max] = NUMBER_KEYS[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors.push(`permissions.${key} must be an integer from ${min} to ${max}`);
      else out[key] = value;
    } else errors.push(`unknown permission "${key}"`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: { version: PROJECT_POLICY_VERSION, permissions: out } };
}
