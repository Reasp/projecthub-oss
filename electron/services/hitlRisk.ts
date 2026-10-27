import { isInsideProject } from './pathGuard.js';
import type { HitlConfirmMethod, HitlRequest, HitlRisk } from './hitlTypes.js';
import { hitlRiskReasonText, type HitlRiskCode, type HitlRiskReasonKey } from '../../src/lib/hitlRiskReason.js';
import { hitlRequestTextEn } from '../../src/i18n/hitlRequestText.js';

/**
 * Классы риска HITL (TASK-140.4, [[decision-112]], decision-79 п. 5): чистые функции без Electron.
 *
 * - `classifyRisk` — класс запроса по инструменту, команде и пути. Считает хост, клиенту класс не доверяется.
 * - `isConfirmationSufficient` — хватает ли способа подтверждения для одобрения запроса этого класса.
 *
 * Неизвестный инструмент — `high`: новый инструмент сначала попадает в строгий класс, а не в мягкий.
 */

export interface RiskAssessment {
  risk: HitlRisk;
  /** Почему такой класс — код причины: окно и телефон берут текст из словаря на своём языке (TASK-202.11). */
  code: HitlRiskCode;
  params?: Record<string, string>;
  /** Английский текст причины — для журнала, аудита и старых клиентов. */
  reason: string;
}

function r(risk: HitlRisk, code: HitlRiskCode, params?: Record<string, string>): RiskAssessment {
  const reason = hitlRiskReasonText({ code, params }, undefined, hitlRequestTextEn.risks) ?? code;
  return params ? { risk, code, params, reason } : { risk, code, reason };
}

/** Код причины для `HitlRequest.riskReasonKey`. */
export function riskReasonKey(assessed: RiskAssessment): HitlRiskReasonKey {
  return assessed.params ? { code: assessed.code, params: { ...assessed.params } } : { code: assessed.code };
}

const RANK: Record<HitlRisk, number> = { low: 0, moderate: 1, high: 2 };

export function maxRisk(a: HitlRisk, b: HitlRisk): HitlRisk {
  return RANK[a] >= RANK[b] ? a : b;
}

export function isHitlRisk(value: unknown): value is HitlRisk {
  return value === 'low' || value === 'moderate' || value === 'high';
}

/** Файлы с секретами: `.env*`, ключи, хранилища паролей и учётные данные облаков. */
const SECRET_PATH_RE = /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|[^\\/]*\.(pem|key|p12|pfx|keystore|jks|kdbx))$|[\\/]\.(ssh|aws|gnupg|kube|docker)[\\/]/i;

export function isSecretPath(filePath: string): boolean {
  return Boolean(filePath) && SECRET_PATH_RE.test(filePath.trim());
}

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'read_file', 'read', 'Glob', 'Grep', 'LS', 'list_files', 'search_files']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'write_to_file', 'edit_file', 'apply_patch']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'run_command', 'bash', 'shell']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'spawn_subagent', 'dispatch_agent']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'web_fetch', 'web_search', 'fetch_url']);
/** Служебные инструменты движка без побочных эффектов. */
const HARMLESS_TOOLS = new Set(['TodoWrite', 'TodoRead', 'ExitPlanMode', 'AskUserQuestion', 'ask_question']);

/**
 * Инструменты и действия самого ProjectHub (встроенный MCP `mcp__projecthub__*` и сервисы, которые просят решения):
 * их класс известен заранее, а не выводится правилом «неизвестный — high».
 */
const PROJECTHUB_TOOLS: Record<string, RiskAssessment> = {
  ci_status: r('low', 'ciStatus'),
  ci_failed_log: r('low', 'ciLog'),
  memory_search: r('low', 'memorySearch'),
  doc_list: r('low', 'docsRead'),
  doc_view: r('low', 'docsRead'),
  docs_search: r('low', 'docsSearch'),
  task_list: r('low', 'tasksRead'),
  task_view: r('low', 'tasksRead'),
  projecthub_notify: r('low', 'phoneInbox'),
  tracker_sync_preview: r('low', 'trackerPreview'),
  tracker_sync_status: r('low', 'trackerStatus'),
  ci_rerun: r('moderate', 'ciRerun'),
  memory_write: r('moderate', 'memoryWrite'),
  memory_delete: r('moderate', 'memoryDelete'),
  doc_create: r('moderate', 'docCreate'),
  doc_update: r('moderate', 'docUpdate'),
  // Ветки документации (decision-151): правки в ветке не видны другим, пока их не примут.
  doc_branch_list: r('low', 'docBranchesRead'),
  doc_branch_diff: r('low', 'docBranchesRead'),
  doc_branch_open: r('low', 'docBranchOwn'),
  doc_branch_resolve: r('low', 'docBranchResolve'),
  doc_branch_propose: r('low', 'docBranchPropose'),
  doc_branch_close: r('low', 'docBranchClose'),
  doc_branch_merge: r('moderate', 'docBranchMerge'),
  task_create: r('moderate', 'taskCreate'),
  task_update: r('moderate', 'taskUpdate'),
  task_approve: r('moderate', 'taskApprove'),
  // Захват задачи на origin (decision-152, decision-153): push служебного ref.
  task_claim: r('moderate', 'taskClaim'),
  task_release: r('moderate', 'taskRelease'),
  tracker_sync_run: r('moderate', 'trackerWrite'),
  'gh pr comment': r('moderate', 'prComment'),
  sync_base_branch: r('moderate', 'syncBaseBranch'),
  merge: r('high', 'mergeSecurity'),
  'git commit': r('high', 'commitSecrets')
};

interface CommandRule {
  re: RegExp;
  code: HitlRiskCode;
}

/** Опасные команды: удаление, отправка наружу, сеть, права, публикация, выполнение произвольного кода. */
const HIGH_COMMANDS: CommandRule[] = [
  { re: /^git\s+push\b/, code: 'gitPush' },
  { re: /^git\s+(reset\s+.*--hard|clean\s+-\w*f|branch\s+-\w*D|checkout\s+--\s|restore\b|stash\s+(drop|clear)|filter-branch|update-ref\s+-d|reflog\s+expire)/, code: 'gitDestructive' },
  { re: /^git\s+config\s+--(global|system)\b/, code: 'gitGlobalConfig' },
  { re: /^(rm|rmdir|del|erase|rd|unlink|shred|Remove-Item|ri)\b/i, code: 'deleteFiles' },
  { re: /^(format|mkfs\S*|dd|diskpart|shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, code: 'systemOperation' },
  { re: /^(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b/i, code: 'network' },
  { re: /^(sudo|su|doas|runas|chmod|chown|chgrp|icacls|takeown|setx|reg)\b/i, code: 'permissions' },
  { re: /^(npm|pnpm|yarn|cargo|twine|gem|dotnet\s+nuget)\s+publish\b/i, code: 'publishPackage' },
  { re: /^(docker|podman|kubectl|helm|terraform|aws|az|gcloud|vercel|netlify|fly|heroku)\b/i, code: 'infrastructure' },
  { re: /^gh\s+(?!(pr|issue|run|repo|release)\s+(view|list|status|diff|checks)\b)/i, code: 'ghWrite' },
  { re: /^(node|deno|bun|python\d*|py|ruby|perl|php)\s+(-e|-c|--eval|-p)\b/i, code: 'inlineCode' },
  { re: /^(bash|sh|zsh|cmd|powershell|pwsh)(\.exe)?\s+(-c|\/c|-Command|-EncodedCommand|-e)\b/i, code: 'nestedShell' },
  { re: /^(eval|exec|source|\.)\s/, code: 'inlineCode' },
  { re: /^(printenv|env|set|Get-ChildItem\s+env:|gci\s+env:)\s*$/i, code: 'readEnv' }
];

/** Безопасные команды только на чтение и проверки проекта. */
const LOW_COMMANDS: RegExp[] = [
  /^(ls|dir|pwd|cd|echo|cat|type|head|tail|less|more|wc|stat|file|tree|which|where|whoami|date|true)\b/i,
  /^(grep|rg|egrep|fgrep|findstr|Select-String|sls|ag|ack|Get-Content|gc|Get-ChildItem|gci|Test-Path)\b/i,
  /^find\b(?!.*\s-(delete|exec|execdir|ok)\b)/,
  /^git\s+(status|diff|log|show|blame|branch(?!\s+-\w*[dDmM])|remote\s+-v|rev-parse|ls-files|describe|shortlog|grep|tag\s*$)\b/,
  /^(npm|pnpm|yarn)\s+(test|t|run\s+(test|lint|typecheck|check|format:check)[\w:-]*|ls|list|outdated|why|view)\b/i,
  /^npx\s+(vitest|jest|tsc\s+.*--noEmit|eslint|prettier\s+--check|playwright\s+test)\b/i,
  /^(pytest|cargo\s+(test|check|clippy)|go\s+(test|vet)|mvn\s+test|gradle\s+test|dotnet\s+test|ruff|mypy|flake8)\b/i,
  /^(node|python\d*|npm|git|java|go|cargo|rustc|dotnet)\s+(-v|--version|version)\b/i,
  /^gh\s+(pr|issue|run|repo|release)\s+(view|list|status|diff|checks)\b/i
];

/** Разбиение на простые команды по `&&`, `||`, `;`, `|` и переводу строки. Кавычки не разбираются — грубо, но в строгую сторону. */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().replace(/^\(+|\)+$/g, '').trim())
    .filter(Boolean);
}

/** Класс одной простой команды. */
function classifySimpleCommand(segment: string): RiskAssessment {
  // `VAR=value cmd` и `env VAR=value cmd` — смотрим на саму команду.
  const cmd = segment.replace(/^(env\s+)?([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
  for (const rule of HIGH_COMMANDS) if (rule.re.test(cmd)) return r('high', rule.code);
  const words = cmd.split(/\s+/);
  if (words.some((w) => isSecretPath(w.replace(/^['"]|['"]$/g, '')))) return r('high', 'secretFile');
  if (/\$\(|`/.test(cmd)) return r('high', 'commandSubstitution');
  if (/(^|[^<>&\d])>{1,2}\s*(?!\/dev\/null\b|nul\b|\$null\b)\S/i.test(cmd)) return r('moderate', 'fileRedirect');
  if (LOW_COMMANDS.some((re) => re.test(cmd))) return r('low', 'readOnly');
  return r('moderate', 'changesTree');
}

/** Класс команды оболочки: самый строгий из её частей. Пустая команда — `high`, неизвестно что выполнится. */
export function classifyCommand(command: string): RiskAssessment {
  const parts = splitCommand(command || '');
  if (parts.length === 0) return r('high', 'noCommand');
  let worst: RiskAssessment = r('low', 'readOnly');
  for (const part of parts) {
    const r = classifySimpleCommand(part);
    if (RANK[r.risk] > RANK[worst.risk]) worst = r;
  }
  return worst;
}

export interface RiskInput {
  type?: HitlRequest['type'];
  tool?: string;
  command?: string;
  filePath?: string;
  projectPath?: string;
}

function classifyPath(filePath: string, projectPath: string | undefined, write: boolean): RiskAssessment {
  if (isSecretPath(filePath)) return r('high', 'secretFile');
  if (filePath && projectPath && !isInsideProject(projectPath, filePath)) {
    return write ? r('high', 'writeOutside') : r('moderate', 'readOutside');
  }
  return write ? r('moderate', 'writeInProject') : r('low', 'readInProject');
}

/**
 * Класс риска запроса HITL. Приоритет: управление компьютером → тип и инструмент → неизвестный инструмент (`high`).
 */
export function classifyRisk(input: RiskInput): RiskAssessment {
  const tool = (input.tool || '').trim();
  const filePath = input.filePath || '';
  if (input.type === 'computer_action' || tool.startsWith('computer_') || tool.startsWith('mcp__projecthub-computer')) {
    return r('high', 'computer');
  }
  if (input.type === 'question' || tool === 'AskUserQuestion' || tool === 'ask_question') return r('low', 'question');
  const own = PROJECTHUB_TOOLS[tool.replace(/^mcp__projecthub__/, '')];
  if (own) return { ...own, ...(own.params ? { params: { ...own.params } } : {}) };

  if (COMMAND_TOOLS.has(tool) || (!tool && input.type === 'command')) return classifyCommand(input.command || '');
  if (WRITE_TOOLS.has(tool) || (!tool && input.type === 'file_write')) return classifyPath(filePath, input.projectPath, true);
  if (READ_TOOLS.has(tool)) return classifyPath(filePath, input.projectPath, false);
  if (SUBAGENT_TOOLS.has(tool) || (!tool && input.type === 'subagent_dispatch')) return r('moderate', 'subagent');
  if (NETWORK_TOOLS.has(tool)) return r('high', 'network');
  if (HARMLESS_TOOLS.has(tool)) return r('low', 'harmless');
  // Браузер Playwright MCP: действия внутри изолированного браузера идут без карточки; к человеку попадает выход за него.
  if (tool.startsWith('browser_') || tool.startsWith('mcp__playwright__')) return r('high', 'browserEscape');
  return tool ? r('high', 'unknownTool', { tool }) : r('high', 'unknownAction');
}

/** Класс запроса HITL: строже из того, что посчитал хост, и того, что указал вызывающий сервис. */
export function riskOfRequest(request: Pick<HitlRequest, 'type' | 'tool' | 'command' | 'filePath' | 'projectPath' | 'diff' | 'risk'>): RiskAssessment {
  const assessed = classifyRisk({
    type: request.type,
    tool: request.tool,
    command: request.command,
    filePath: request.filePath || request.diff?.filePath,
    projectPath: request.projectPath
  });
  if (isHitlRisk(request.risk) && RANK[request.risk] > RANK[assessed.risk]) return { ...assessed, risk: request.risk };
  return assessed;
}

/**
 * Каким способом можно одобрить запрос класса (decision-112 п. 3). Отклонить можно всегда и откуда угодно.
 *
 * - `notification` — кнопка в уведомлении на заблокированном телефоне: только `low`.
 * - `unlocked` — действие уведомления после разблокировки, `app` — кнопка в приложении, `chat` — кнопка в мессенджере
 *   (телефон разблокирован, но присутствие владельца не доказано): `low` и `moderate`.
 * - `biometric` — подпись ключом устройства, который требует биометрию на каждое использование, проверенная хостом: любой.
 */
export function isConfirmationSufficient(risk: HitlRisk, method: HitlConfirmMethod, verified: boolean): boolean {
  if (method === 'biometric') return verified;
  if (risk === 'high') return false;
  if (risk === 'moderate') return method === 'unlocked' || method === 'app' || method === 'chat';
  return true;
}

export function parseConfirmMethod(value: unknown): HitlConfirmMethod | null {
  return value === 'notification' || value === 'unlocked' || value === 'app' || value === 'biometric' || value === 'chat' ? value : null;
}
