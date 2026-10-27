/**
 * Причина класса риска HITL кодом (TASK-202.11, [[decision-112]], [[decision-160]]): хост отдаёт код и параметры,
 * окно, телефон и push собирают текст по словарю `hitlRequestText.risks` на своём языке. Английский `riskReason`
 * остаётся запасным текстом для журнала, аудита и старых клиентов.
 *
 * Чистый модуль без React и Electron.
 */

export const HITL_RISK_CODES = [
  'ciStatus',
  'ciLog',
  'memorySearch',
  'docsRead',
  'docsSearch',
  'tasksRead',
  'phoneInbox',
  'trackerPreview',
  'trackerStatus',
  'ciRerun',
  'memoryWrite',
  'memoryDelete',
  'docCreate',
  'docUpdate',
  'docBranchesRead',
  'docBranchOwn',
  'docBranchResolve',
  'docBranchPropose',
  'docBranchClose',
  'docBranchMerge',
  'taskCreate',
  'taskUpdate',
  'taskApprove',
  'taskClaim',
  'taskRelease',
  'trackerWrite',
  'prComment',
  'syncBaseBranch',
  'mergeSecurity',
  'commitSecrets',
  'gitPush',
  'gitDestructive',
  'gitGlobalConfig',
  'deleteFiles',
  'systemOperation',
  'network',
  'permissions',
  'publishPackage',
  'infrastructure',
  'ghWrite',
  'inlineCode',
  'nestedShell',
  'readEnv',
  'secretFile',
  'commandSubstitution',
  'fileRedirect',
  'readOnly',
  'changesTree',
  'noCommand',
  'writeOutside',
  'readOutside',
  'writeInProject',
  'readInProject',
  'computer',
  'question',
  'subagent',
  'harmless',
  'browserEscape',
  'unknownTool',
  'unknownAction'
] as const;

export type HitlRiskCode = (typeof HITL_RISK_CODES)[number];

/** Код причины класса: `params.tool` — у `unknownTool`. */
export interface HitlRiskReasonKey {
  code: HitlRiskCode;
  params?: Record<string, string>;
}

const CODES = new Set<string>(HITL_RISK_CODES);

export function isHitlRiskCode(value: unknown): value is HitlRiskCode {
  return typeof value === 'string' && CODES.has(value);
}

/** Разбор кода из JSON (телефон, старый хост): битый ключ — `undefined`, показывается запасной текст. */
export function parseHitlRiskReasonKey(value: unknown): HitlRiskReasonKey | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { code, params } = value as { code?: unknown; params?: unknown };
  if (!isHitlRiskCode(code)) return undefined;
  if (params === undefined) return { code };
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, v] of Object.entries(params)) {
    if (typeof v !== 'string') return undefined;
    clean[name] = v;
  }
  return { code, params: clean };
}

/** Текст причины по словарю; без кода или с незнакомым кодом — запасной текст хоста. */
export function hitlRiskReasonText(
  key: HitlRiskReasonKey | undefined,
  fallback: string | undefined,
  templates: Record<HitlRiskCode, string>
): string | undefined {
  const template = key ? templates[key.code] : undefined;
  if (template === undefined) return fallback || undefined;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => key?.params?.[name] ?? all);
}
