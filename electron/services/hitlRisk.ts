import { isInsideProject } from './pathGuard.js';
import type { HitlConfirmMethod, HitlRequest, HitlRisk } from './hitlTypes.js';

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
  /** Почему такой класс — коротко, для карточки и телефона. */
  reason: string;
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
  ci_status: { risk: 'low', reason: 'чтение статуса CI' },
  ci_failed_log: { risk: 'low', reason: 'чтение лога CI' },
  memory_search: { risk: 'low', reason: 'поиск в памяти проекта' },
  doc_list: { risk: 'low', reason: 'чтение документов' },
  doc_view: { risk: 'low', reason: 'чтение документов' },
  docs_search: { risk: 'low', reason: 'поиск в документации' },
  task_list: { risk: 'low', reason: 'чтение задач' },
  task_view: { risk: 'low', reason: 'чтение задач' },
  projecthub_notify: { risk: 'low', reason: 'сообщение человеку во «Входящие» телефона' },
  tracker_sync_preview: { risk: 'low', reason: 'предпросмотр синхронизации трекера' },
  tracker_sync_status: { risk: 'low', reason: 'статус синхронизации трекера' },
  ci_rerun: { risk: 'moderate', reason: 'перезапуск CI' },
  memory_write: { risk: 'moderate', reason: 'запись в память проекта' },
  memory_delete: { risk: 'moderate', reason: 'удаление факта памяти' },
  doc_create: { risk: 'moderate', reason: 'новый документ' },
  doc_update: { risk: 'moderate', reason: 'правка документа' },
  // Ветки документации (decision-151): правки в ветке не видны другим, пока их не примут.
  doc_branch_list: { risk: 'low', reason: 'чтение веток документации' },
  doc_branch_diff: { risk: 'low', reason: 'чтение веток документации' },
  doc_branch_open: { risk: 'low', reason: 'своя ветка документации' },
  doc_branch_resolve: { risk: 'low', reason: 'слияние основной в свою ветку документации' },
  doc_branch_propose: { risk: 'low', reason: 'предложение слить ветку документации' },
  doc_branch_close: { risk: 'low', reason: 'закрытие своей ветки документации' },
  doc_branch_merge: { risk: 'moderate', reason: 'принятие ветки документации в основную' },
  task_create: { risk: 'moderate', reason: 'новая задача' },
  task_update: { risk: 'moderate', reason: 'правка задачи' },
  task_approve: { risk: 'moderate', reason: 'подтверждение задач агента' },
  // Захват задачи на origin (decision-152, decision-153): push служебного ref.
  task_claim: { risk: 'moderate', reason: 'захват задачи на origin' },
  task_release: { risk: 'moderate', reason: 'снятие захвата задачи на origin' },
  tracker_sync_run: { risk: 'moderate', reason: 'запись в трекер' },
  'gh pr comment': { risk: 'moderate', reason: 'комментарий в PR' },
  sync_base_branch: { risk: 'moderate', reason: 'слияние основной ветки в свой worktree' },
  merge: { risk: 'high', reason: 'слияние в основную ветку с находками безопасности' },
  'git commit': { risk: 'high', reason: 'коммит с похожими на секреты строками' }
};

interface CommandRule {
  re: RegExp;
  reason: string;
}

/** Опасные команды: удаление, отправка наружу, сеть, права, публикация, выполнение произвольного кода. */
const HIGH_COMMANDS: CommandRule[] = [
  { re: /^git\s+push\b/, reason: 'git push — отправка в удалённый репозиторий' },
  { re: /^git\s+(reset\s+.*--hard|clean\s+-\w*f|branch\s+-\w*D|checkout\s+--\s|restore\b|stash\s+(drop|clear)|filter-branch|update-ref\s+-d|reflog\s+expire)/, reason: 'git — изменения будут потеряны' },
  { re: /^git\s+config\s+--(global|system)\b/, reason: 'глобальные настройки git' },
  { re: /^(rm|rmdir|del|erase|rd|unlink|shred|Remove-Item|ri)\b/i, reason: 'удаление файлов' },
  { re: /^(format|mkfs\S*|dd|diskpart|shutdown|reboot|Stop-Computer|Restart-Computer)\b/i, reason: 'системная операция' },
  { re: /^(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b/i, reason: 'сетевой запрос' },
  { re: /^(sudo|su|doas|runas|chmod|chown|chgrp|icacls|takeown|setx|reg)\b/i, reason: 'права и системные настройки' },
  { re: /^(npm|pnpm|yarn|cargo|twine|gem|dotnet\s+nuget)\s+publish\b/i, reason: 'публикация пакета' },
  { re: /^(docker|podman|kubectl|helm|terraform|aws|az|gcloud|vercel|netlify|fly|heroku)\b/i, reason: 'инфраструктура и облако' },
  { re: /^gh\s+(?!(pr|issue|run|repo|release)\s+(view|list|status|diff|checks)\b)/i, reason: 'gh — запись в GitHub' },
  { re: /^(node|deno|bun|python\d*|py|ruby|perl|php)\s+(-e|-c|--eval|-p)\b/i, reason: 'выполнение кода из строки' },
  { re: /^(bash|sh|zsh|cmd|powershell|pwsh)(\.exe)?\s+(-c|\/c|-Command|-EncodedCommand|-e)\b/i, reason: 'вложенная оболочка' },
  { re: /^(eval|exec|source|\.)\s/, reason: 'выполнение кода из строки' },
  { re: /^(printenv|env|set|Get-ChildItem\s+env:|gci\s+env:)\s*$/i, reason: 'чтение переменных окружения' }
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
  for (const rule of HIGH_COMMANDS) if (rule.re.test(cmd)) return { risk: 'high', reason: rule.reason };
  const words = cmd.split(/\s+/);
  if (words.some((w) => isSecretPath(w.replace(/^['"]|['"]$/g, '')))) return { risk: 'high', reason: 'файл с секретами' };
  if (/\$\(|`/.test(cmd)) return { risk: 'high', reason: 'подстановка команды' };
  if (/(^|[^<>&\d])>{1,2}\s*(?!\/dev\/null\b|nul\b|\$null\b)\S/i.test(cmd)) return { risk: 'moderate', reason: 'запись в файл' };
  if (LOW_COMMANDS.some((re) => re.test(cmd))) return { risk: 'low', reason: 'чтение или проверка' };
  return { risk: 'moderate', reason: 'команда меняет рабочее дерево' };
}

/** Класс команды оболочки: самый строгий из её частей. Пустая команда — `high`, неизвестно что выполнится. */
export function classifyCommand(command: string): RiskAssessment {
  const parts = splitCommand(command || '');
  if (parts.length === 0) return { risk: 'high', reason: 'команда не указана' };
  let worst: RiskAssessment = { risk: 'low', reason: 'чтение или проверка' };
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
  if (isSecretPath(filePath)) return { risk: 'high', reason: 'файл с секретами' };
  if (filePath && projectPath && !isInsideProject(projectPath, filePath)) {
    return write ? { risk: 'high', reason: 'запись вне проекта' } : { risk: 'moderate', reason: 'чтение вне проекта' };
  }
  return write ? { risk: 'moderate', reason: 'запись в проекте' } : { risk: 'low', reason: 'чтение в проекте' };
}

/**
 * Класс риска запроса HITL. Приоритет: управление компьютером → тип и инструмент → неизвестный инструмент (`high`).
 */
export function classifyRisk(input: RiskInput): RiskAssessment {
  const tool = (input.tool || '').trim();
  const filePath = input.filePath || '';
  if (input.type === 'computer_action' || tool.startsWith('computer_') || tool.startsWith('mcp__projecthub-computer')) {
    return { risk: 'high', reason: 'управление компьютером' };
  }
  if (input.type === 'question' || tool === 'AskUserQuestion' || tool === 'ask_question') return { risk: 'low', reason: 'вопрос агента' };
  const own = PROJECTHUB_TOOLS[tool.replace(/^mcp__projecthub__/, '')];
  if (own) return { ...own };

  if (COMMAND_TOOLS.has(tool) || (!tool && input.type === 'command')) return classifyCommand(input.command || '');
  if (WRITE_TOOLS.has(tool) || (!tool && input.type === 'file_write')) return classifyPath(filePath, input.projectPath, true);
  if (READ_TOOLS.has(tool)) return classifyPath(filePath, input.projectPath, false);
  if (SUBAGENT_TOOLS.has(tool) || (!tool && input.type === 'subagent_dispatch')) return { risk: 'moderate', reason: 'запуск субагента' };
  if (NETWORK_TOOLS.has(tool)) return { risk: 'high', reason: 'сетевой запрос' };
  if (HARMLESS_TOOLS.has(tool)) return { risk: 'low', reason: 'служебный инструмент' };
  // Браузер Playwright MCP: действия внутри изолированного браузера идут без карточки; к человеку попадает выход за него.
  if (tool.startsWith('browser_') || tool.startsWith('mcp__playwright__')) return { risk: 'high', reason: 'выход за изолированный браузер' };
  return { risk: 'high', reason: tool ? `неизвестный инструмент ${tool}` : 'неизвестное действие' };
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
  if (isHitlRisk(request.risk) && RANK[request.risk] > RANK[assessed.risk]) return { risk: request.risk, reason: assessed.reason };
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

/** Подпись класса для людей. */
export const RISK_LABEL: Record<HitlRisk, string> = { low: 'низкий риск', moderate: 'средний риск', high: 'высокий риск' };
