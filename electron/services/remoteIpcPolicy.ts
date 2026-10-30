/**
 * Политика туннеля IPC для проекта другого ПК (TASK-280, [[decision-194]]). Окно клиента работает с удалённым проектом
 * теми же экранами, что с локальным; хост исполняет свои обработчики `ipcMain.handle` только для каналов этого списка и
 * только с путями внутри проектов, доступных устройству. Чистый модуль — хост и тесты.
 */

/**
 * Каналы проекта, которые хост исполняет для удалённого окна. Явный список, а не префиксы: новый канал не попадает в
 * туннель сам — сначала решают, проектный ли он. Не входят: голос и озвучка (устройства клиента), аккаунты, ключи и
 * подключения, глобальные настройки хоста, аудит хоста, действия на рабочем столе хоста (открыть в редакторе,
 * проводнике, Obsidian), экспорт в произвольный файл, освобождение порта убийством чужого процесса.
 */
export const TUNNEL_CHANNELS: ReadonlySet<string> = new Set([
  // Проект
  'projects:getDetails',
  'projects:refresh',
  // Задачи и вехи
  'backlog:approveAgentTask',
  'backlog:approveAgentTasksByReporter',
  'backlog:createTask',
  'backlog:deleteTask',
  'backlog:getConfig',
  'backlog:getTaskContent',
  'backlog:getTasks',
  'backlog:saveFullTask',
  'backlog:saveTask',
  'backlog:toggleCriterion',
  'backlog:updateTaskStatus',
  'backlog:watchProject',
  'milestones:create',
  'milestones:delete',
  'milestones:list',
  'milestones:save',
  // Документация
  'docs:branches:close',
  'docs:branches:diff',
  'docs:branches:list',
  'docs:branches:merge',
  'docs:create',
  'docs:indexDocsDir',
  'docs:linkGraph',
  'docs:linkIndex',
  'docs:list',
  'docs:read',
  'docs:save',
  'rag:getStats',
  'rag:search',
  'graph:getCode',
  'graph:getDocs',
  'memory:delete',
  'memory:list',
  'memory:write',
  // Git и worktree
  'git:abortMerge',
  'git:checkout',
  'git:commit',
  'git:conflictFile',
  'git:createBranch',
  'git:deleteBranch',
  'git:discardFileChanges',
  'git:fetchRemote',
  'git:finishMerge',
  'git:getDiffBetween',
  'git:getFileDiff',
  'git:getLog',
  'git:getRepoDetails',
  'git:getStatus',
  'git:mergeBranch',
  'git:mergeState',
  'git:pullRemote',
  'git:pushRemote',
  'git:resolveConflict',
  'git:stageAll',
  'git:stageFile',
  'git:unstageFile',
  'git:unwatch',
  'git:worktree:add',
  'git:worktree:checkoutFiles',
  'git:worktree:cleanOrphaned',
  'git:worktree:dirtyState',
  'git:worktree:findOrphaned',
  'git:worktree:getDiff',
  'git:worktree:list',
  'git:worktree:merge',
  'git:worktree:prune',
  'git:worktree:pullBase',
  'git:worktree:remove',
  'pr:create',
  'pr:forTask',
  'pr:getDiff',
  'pr:getProviderInfo',
  'pr:list',
  'pr:setMergeStatus',
  'prReview:list',
  'prReview:publish',
  'prReview:start',
  // Файлы
  'files:create',
  'files:delete',
  'files:readContent',
  'files:readTree',
  'files:saveContent',
  // Процессы и терминалы
  'process:list',
  'process:listService',
  'process:restart',
  'process:start',
  'process:stop',
  'process:tailLog',
  'actions:getConfig',
  'actions:saveConfig',
  'pty:create',
  'pty:kill',
  'pty:list',
  'pty:resize',
  'pty:write',
  // Agents Studio и агенты
  'aiSessions:delete',
  'aiSessions:import',
  'aiSessions:list',
  'aiSessions:save',
  'ai:abortStream',
  'ai:applyDiff',
  'ai:clearSession',
  'ai:getClaudeAuthStatus',
  'ai:listCliSessions',
  'ai:previewContext',
  'ai:streamChat',
  'ai:taskDraft',
  'agents:launchCheck',
  'claudeBridge:getAllProjectStatuses',
  'claudeBridge:getAvailableModels',
  'claudeBridge:getProjectStatus',
  'claudeBridge:getSubagents',
  'claudeBridge:getUsage',
  'claudeBridge:sendApprovalResponse',
  'hitl:decide',
  'hitl:listPending',
  'swarm:cancelJudge',
  'swarm:compose',
  'swarm:continueAgent',
  'swarm:deleteResult',
  'swarm:discard',
  'swarm:export',
  'swarm:get',
  'swarm:getTimeline',
  'swarm:list',
  'swarm:listResults',
  'swarm:pickWinner',
  'swarm:pruneResults',
  'swarm:readTranscript',
  'swarm:restoreResult',
  'swarm:resume',
  'swarm:rewind',
  'swarm:runAssigned',
  'swarm:runJudge',
  'swarm:startDoneLoop',
  'swarm:startFanOut',
  'swarm:startHandoff',
  'swarm:stop',
  'plan:approve',
  'plan:discard',
  'plan:generate',
  'plan:getForTask',
  'plan:list',
  'plan:models',
  'plan:resolveConflict',
  'plan:skipNode',
  'plan:stop',
  'doneLoop:getConfig',
  'arena:getConfig',
  'roles:copyToProject',
  'roles:delete',
  'roles:list',
  'roles:save',
  'roles:syncApply',
  'roles:syncPlan',
  'skills:copy',
  'skills:list',
  'skills:sourceList',
  'skills:sources',
  'codeIndex:getState',
  'codeIndex:preview',
  'codeIndex:reindex',
  'codeIndex:save',
  'security:createTask',
  'security:getReport',
  'security:runAudit'
]);

/**
 * События main → окно, которые хост пересылает удалённому окну: потоки и изменения проекта. Глобальные события
 * (голос, обновление, подключения) остаются на хосте.
 */
export const TUNNEL_EVENTS: ReadonlySet<string> = new Set([
  'backlog:tasksChanged',
  'git:changed',
  'process:logChunk',
  'process:statusChanged',
  'pty:data',
  'pty:exit',
  'pty:removed',
  'claudeBridge:statusChanged',
  'claudeBridge:subagentUpdated',
  'swarm:event',
  'plan:event',
  'bus:event',
  'prReview:changed',
  'security:reportUpdated'
]);

/** Поток ответа сессии Studio: канал несёт id сессии (`ai:chunk:<id>`). */
const TUNNEL_EVENT_PREFIXES = ['ai:chunk:', 'ai:complete:', 'ai:error:'];

export function isTunnelChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && TUNNEL_CHANNELS.has(channel);
}

export function isTunnelEvent(channel: string): boolean {
  return TUNNEL_EVENTS.has(channel) || TUNNEL_EVENT_PREFIXES.some((p) => channel.startsWith(p));
}

/** Каналы чтения: их вызовы не пишутся в журнал действий, остальные — пишутся (decision-126). */
const READ_SUFFIX_RE =
  /:(get\w*|list\w*|read\w*|tail\w*|search|preview\w*|mergeState|conflictFile|dirtyState|findOrphaned|sourceList|sources|linkGraph|linkIndex|forTask|launchCheck|branches:list|branches:diff|export)$/;

export function isTunnelReadChannel(channel: string): boolean {
  return READ_SUFFIX_RE.test(channel);
}

/** Строка — абсолютный путь (Windows или POSIX), а не текст: без переводов строк, разумной длины. */
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/)[^\r\n\t\0]*$/;

export function looksLikeAbsolutePath(value: string): boolean {
  return value.length <= 1024 && ABS_PATH_RE.test(value);
}

function normalizeForCompare(p: string, caseInsensitive: boolean): string {
  let s = p.replace(/\\/g, '/');
  // `..` не должен выводить путь из корня: такие пути считаются вне любого корня.
  if (/(^|\/)\.\.(\/|$)/.test(s)) return '\0';
  s = s.replace(/\/+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

/** Путь лежит в одном из корней. На Windows сравнение без учёта регистра. */
export function insideRoots(value: string, roots: readonly string[], caseInsensitive = process.platform === 'win32'): boolean {
  const v = normalizeForCompare(value, caseInsensitive);
  if (v === '\0') return false;
  return roots.some((root) => {
    const r = normalizeForCompare(root, caseInsensitive);
    return r !== '\0' && r !== '' && (v === r || v.startsWith(`${r}/`));
  });
}

/**
 * Поля с текстом, а не путями: сообщения и история сессии Studio (вызовы инструментов агента в ней могут называть любые
 * файлы), содержимое файла, ввод терминала, описание задачи. Путь в тексте — не путь, к которому обращается обработчик.
 */
const TEXT_KEYS = new Set(['messages', 'content', 'text', 'prompt', 'message', 'body', 'description', 'title', 'data', 'diff', 'patch', 'newContent', 'notes', 'plan', 'output', 'logs', 'summary']);

/** Позиционные аргументы-содержимое: вставка в терминал или текст файла, целиком похожие на путь. */
const CONTENT_ARGS: Readonly<Record<string, readonly number[]>> = {
  'pty:write': [1],
  'docs:save': [1],
  'backlog:saveTask': [1],
  'git:commit': [1],
  'ai:applyDiff': [2],
  'files:saveContent': [2]
};

/** Все абсолютные пути в значении (рекурсивно, с ограничением глубины), кроме текстовых полей. */
export function absolutePathsIn(value: unknown, depth = 0, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (looksLikeAbsolutePath(value)) out.push(value);
    return out;
  }
  if (depth >= 8 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) absolutePathsIn(v, depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!TEXT_KEYS.has(k)) absolutePathsIn(v, depth + 1, out);
  }
  return out;
}

/** Первый путь аргументов канала вне доступных корней; `null` — все пути в корнях. */
export function pathOutsideRoots(args: unknown[], roots: readonly string[], caseInsensitive?: boolean, channel = ''): string | null {
  const skip = CONTENT_ARGS[channel] ?? [];
  for (let i = 0; i < args.length; i++) {
    if (skip.includes(i)) continue;
    for (const p of absolutePathsIn(args[i])) {
      if (!insideRoots(p, roots, caseInsensitive)) return p;
    }
  }
  return null;
}
