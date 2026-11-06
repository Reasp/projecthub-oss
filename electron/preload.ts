import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  collectIds,
  prefixHostPaths,
  projectRootFor,
  routeByKnownIds,
  stripRemoteArgs,
  type StrippedArgs
} from '../src/lib/remoteProjectPath';

/** Полезная нагрузка события pty:removed — автоудаление завершившейся сессии (TASK-50). */
type PtyRemovedPayload = { sessionId: string; title: string; reason: 'ttl' };
import type {
  AsrDownloadProgress,
  StudioRemoteRequestPayload,
  ArenaSettings,
  ProviderErrorInfo,
  CheckDefinition,
  IElectronAPI,
  ConnectionView,
  ConnectionFlowView,
  ScanOptions,
  BacklogTask,
  TaskCriterion,
  ManagedProcess,
  McpServerStatus,
  ComputerOverlayState,
  ComputerUseSettings,
  ComputerUseStatus,
  NotificationAction,
  NotificationDelivery,
  NotificationSettings,
  NotificationSeverity,
  PlanEventPayload,
  PushToTalkEvent,
  PushToTalkSettings,
  PushToTalkStatus,
  RagSearchOptions,
  StartProcessOptions,
  VoiceClassifyRequest,
  VoiceComputerTaskRequest,
  VoiceDictateRequest,
  VoiceOverlayAction,
  VoiceOverlayPayload,
  TtsChunkPayload,
  TtsDonePayload,
  TtsDownloadProgress,
  TtsErrorPayload,
  TtsSpeakRequest,
  QwenInstallProgressInfo,
  MemoryDraftInput,
  AutomationRuleInput,
  SecuritySettings,
  AutomationsSettings,
  PrReviewStartOptions,
  SecretIssuesState,
  SwarmEventPayload,
  ProjectAgentStatus,
  SubagentInfo,
  AIMessage,
  AppBusEvent,
  UpdaterStatus,
  McpRemoteAction
} from '../src/types/electron';

/**
 * Событие main → окно: тип данных задаёт объявление `IElectronAPI`, IPC его не проверяет — данные приходят от main
 * ProjectHub, а не от страницы (TASK-250).
 */
function relay<T>(callback: (data: T) => void): (event: IpcRendererEvent, data: unknown) => void {
  return (_event, data) => callback(data as T);
}

/**
 * Проект другого ПК в окне как локальный (TASK-280, [[decision-194]]). Его путь — `phr://<hostId>/<путь на хосте>`:
 * вызов с таким путём или с id объекта, полученного от хоста (сессия терминала, процесс, запрос HITL), исполняет хост
 * своим обработчиком канала. Пути ответа и событий хоста получают префикс обратно — экраны не отличают удалённый
 * проект от локального.
 */
interface RemoteRoute {
  hostId: string;
  projectPath: string;
}
const remoteRoots = new Map<string, Set<string>>();
const idRoutes = new Map<string, RemoteRoute>();
const ID_ROUTES_MAX = 20_000;

function hostRoots(hostId: string): string[] {
  return [...(remoteRoots.get(hostId) ?? [])];
}

function rememberIds(value: unknown, route: RemoteRoute): void {
  for (const id of collectIds(value)) {
    idRoutes.delete(id);
    idRoutes.set(id, route);
  }
  for (const id of idRoutes.keys()) {
    if (idRoutes.size <= ID_ROUTES_MAX) break;
    idRoutes.delete(id);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- тип ответа задаёт объявление IElectronAPI, как у ipcRenderer.invoke
function invoke(channel: string, ...args: unknown[]): Promise<any> {
  if (remoteRoots.size === 0) return ipcRenderer.invoke(channel, ...args);
  let stripped: StrippedArgs;
  try {
    stripped = stripRemoteArgs(args);
  } catch {
    return Promise.reject(new Error('One call refers to projects of different computers'));
  }
  const route: RemoteRoute | null = stripped.hostId
    ? { hostId: stripped.hostId, projectPath: projectRootFor(stripped.roots[0] ?? '', hostRoots(stripped.hostId)) }
    : routeByKnownIds(args, idRoutes);
  if (!route) return ipcRenderer.invoke(channel, ...args);
  const target = route;
  rememberIds(stripped.args, target);
  return ipcRenderer.invoke('remote:ipcInvoke', target.hostId, target.projectPath, channel, stripped.args).then((result: unknown) => {
    rememberIds(result, target);
    return prefixHostPaths(result, target.hostId, hostRoots(target.hostId));
  });
}

// События хоста для его проектов, открытых в этом окне: тем же каналом, что локальные, с путями `phr://`.
ipcRenderer.on('federation:event', (_event, payload: { hostId?: unknown; event?: unknown; data?: unknown }) => {
  if (payload?.event !== 'ipc:event' || typeof payload.hostId !== 'string') return;
  const roots = hostRoots(payload.hostId);
  if (roots.length === 0) return;
  const data = payload.data as { channel?: unknown; args?: unknown } | undefined;
  if (typeof data?.channel !== 'string' || !Array.isArray(data.args)) return;
  rememberIds(data.args, { hostId: payload.hostId, projectPath: roots[0] });
  const mapped = prefixHostPaths(data.args, payload.hostId, roots) as unknown[];
  ipcRenderer.emit(data.channel, { sender: ipcRenderer }, ...mapped);
});

const api: IElectronAPI = {
  // Projects & Registry
  listProjects: () => invoke('projects:list'),
  scanProjects: (options?: ScanOptions) => invoke('projects:scan', options),
  addProject: (folderPath: string) => invoke('projects:add', folderPath),
  removeProject: (projectPath: string) => invoke('projects:remove', projectPath),
  refreshProject: (projectPath: string) => invoke('projects:refresh', projectPath),
  toggleFavorite: (projectPath: string) => invoke('projects:toggleFavorite', projectPath),
  getScanRoots: () => invoke('projects:getScanRoots'),
  setScanRoots: (roots: string[]) => invoke('projects:setScanRoots', roots),
  getProjectDetails: (projectPath: string) => invoke('projects:getDetails', projectPath),
  setProjectVoiceAlias: (projectPath: string, alias: string) =>
    invoke('projects:setVoiceAlias', { projectPath, alias }),

  // Documentation & ADR Decisions
  listDocs: (projectPath: string) => invoke('docs:list', projectPath),
  getDocLinkIndex: (projectPath: string) => invoke('docs:linkIndex', projectPath),
  getDocLinkGraph: (projectPath: string) => invoke('docs:linkGraph', projectPath),
  openDocsInObsidian: (projectPath: string) => invoke('docs:openInObsidian', projectPath),
  readDoc: (filePath: string) => invoke('docs:read', filePath),
  saveDoc: (filePath: string, content: string) => invoke('docs:save', filePath, content),
  createDoc: (projectPath: string, params: unknown) => invoke('docs:create', projectPath, params),
  listDocBranches: (projectPath: string) => invoke('docs:branches:list', projectPath),
  diffDocBranch: (projectPath: string, branchId: string) => invoke('docs:branches:diff', projectPath, branchId),
  mergeDocBranch: (projectPath: string, branchId: string, options?: unknown) => invoke('docs:branches:merge', projectPath, branchId, options),
  closeDocBranch: (projectPath: string, branchId: string) => invoke('docs:branches:close', projectPath, branchId),

  // Project Template Wizard
  checkTemplateAvailable: (customSource?: string) =>
    invoke('template:checkAvailable', customSource),
  setTemplatePath: (templatePath: string | null) => invoke('template:setPath', templatePath),

  // Инициализация проекта и каталог шаблонов (TASK-136, decision-78)
  initSelectFolder: () => invoke('init:selectFolder'),
  initPreview: (request) => invoke('init:preview', request),
  initApply: (request) => invoke('init:apply', request),
  initFoundationStatus: (projectPath: string) => invoke('init:foundationStatus', projectPath),
  initTemplateStatus: (projectPath: string, locale: string) => invoke('init:templateStatus', projectPath, locale),
  onInitProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('init:progress', handler);
    return () => {
      ipcRenderer.removeListener('init:progress', handler);
    };
  },
  templatesList: (locale: string) => invoke('templates:list', locale),
  templatesAddFolder: () => invoke('templates:addFolder'),
  templatesAddZip: () => invoke('templates:addZip'),
  templatesAddGit: (url: string) => invoke('templates:addGit', url),
  templatesUpdate: (id: string) => invoke('templates:update', id),
  templatesDuplicate: (id: string, name?: string) => invoke('templates:duplicate', id, name),
  templatesRemove: (id: string) => invoke('templates:remove', id),
  templatesSetTrusted: (id: string, trusted: boolean) => invoke('templates:setTrusted', id, trusted),
  templatesOpenFolder: (id: string) => invoke('templates:openFolder', id),
  templatesPreviewSaveProject: (projectPath, options) => invoke('templates:previewSaveProject', projectPath, options),
  templatesSaveProject: (projectPath, options) => invoke('templates:saveProject', projectPath, options),

  // Background Processes & Terminal
  startProcess: (projectPath: string, command: string, name: string, options?: StartProcessOptions) =>
    invoke('process:start', projectPath, command, name, options),
  stopProcess: (processId: string) =>
    invoke('process:stop', processId),
  restartProcess: (processId: string) =>
    invoke('process:restart', processId),
  listPortOwners: (port: number) =>
    invoke('process:listPortOwners', port),
  releasePort: (port: number) =>
    invoke('process:releasePort', port),
  listProcesses: (projectPath: string) =>
    invoke('process:list', projectPath),
  tailProcessLog: (projectPath: string, processName: string, lines?: number) =>
    invoke('process:tailLog', projectPath, processName, lines),
  onProcessLogChunk: (callback: (data: { processId: string; text: string }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('process:logChunk', handler);
    return () => {
      ipcRenderer.removeListener('process:logChunk', handler);
    };
  },
  onProcessStatusChanged: (callback: (process: ManagedProcess) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('process:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('process:statusChanged', handler);
    };
  },

  // Action Runner & Script Config (.projecthub.json)
  getActionConfig: (projectPath: string) =>
    invoke('actions:getConfig', projectPath),
  saveActionConfig: (projectPath: string, config: unknown) =>
    invoke('actions:saveConfig', projectPath, config),

  // Vector RAG & Knowledge Search
  searchDocs: (options: RagSearchOptions) =>
    invoke('rag:search', options),
  getRagStats: (projectPath: string) =>
    invoke('rag:getStats', projectPath),

  // System Dialogs & Launchers
  selectDirectory: () => invoke('dialog:selectDirectory'),
  openInExplorer: (targetPath: string) => invoke('system:openInExplorer', targetPath),
  openInCode: (targetPath: string) => invoke('system:openInCode', targetPath),
  openTerminal: (targetPath: string) => invoke('system:openTerminal', targetPath),

  // Backlog Tasks & Real-time Watcher
  getTasks: (projectPath: string) => invoke('backlog:getTasks', projectPath),
  getBacklogConfig: (projectPath: string) => invoke('backlog:getConfig', projectPath),
  getTaskContent: (filePath: string) => invoke('backlog:getTaskContent', filePath),
  updateTaskStatus: (filePath: string, newStatus: string) => invoke('backlog:updateTaskStatus', filePath, newStatus),
  approveAgentTask: (filePath: string) => invoke('backlog:approveAgentTask', filePath),
  approveAgentTasksByReporter: (projectPath: string, reporter: string) =>
    invoke('backlog:approveAgentTasksByReporter', projectPath, reporter),
  saveTask: (filePath: string, content: string) => invoke('backlog:saveTask', filePath, content),
  saveFullTask: (
    filePath: string,
    data: {
      title: string;
      status: BacklogTask['status'];
      labels: string[];
      milestone?: string;
      assignee?: string[];
      description: string;
      criteria?: TaskCriterion[];
    }
  ) => invoke('backlog:saveFullTask', filePath, data),
  toggleCriterion: (filePath: string, index: number, completed: boolean) =>
    invoke('backlog:toggleCriterion', filePath, index, completed),
  createTask: (projectPath: string, task: { title: string; description: string; labels: string[]; type?: string; priority?: string; milestone?: string }) =>
    invoke('backlog:createTask', projectPath, task),
  deleteTask: (filePath: string) => invoke('backlog:deleteTask', filePath),
  watchProjectTasks: (projectPath: string) => invoke('backlog:watchProject', projectPath),
  onTasksChanged: (callback: (data: { projectPath: string; event: string; filePath: string }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('backlog:tasksChanged', handler);
    return () => {
      ipcRenderer.removeListener('backlog:tasksChanged', handler);
    };
  },

  // Milestones & Roadmap
  listMilestones: (projectPath: string) => invoke('milestones:list', projectPath),
  createMilestone: (projectPath: string, params: unknown) => invoke('milestones:create', projectPath, params),
  saveMilestone: (filePath: string, params: unknown) => invoke('milestones:save', filePath, params),
  deleteMilestone: (filePath: string) => invoke('milestones:delete', filePath),

  // Реестр ролей агентов (decision-9, TASK-60)
  listRoles: (projectPath?: string) => invoke('roles:list', projectPath),
  getAgentTaskSettings: () => invoke('agentTasks:getSettings'),
  saveAgentTaskSettings: (settings: unknown) => invoke('agentTasks:saveSettings', settings),
  saveRole: (scope: 'global' | 'project', role: unknown, projectPath?: string) =>
    invoke('roles:save', scope, role, projectPath),
  deleteRole: (scope: 'global' | 'project', slug: string, projectPath?: string) =>
    invoke('roles:delete', scope, slug, projectPath),
  copyRoleToProject: (slug: string, projectPath: string) => invoke('roles:copyToProject', slug, projectPath),
  // Экспорт ролей в нативные субагенты и хуки терминала (TASK-77, decision-54)
  planRoleSync: (projectPath: string, options: unknown) => invoke('roles:syncPlan', projectPath, options),
  applyRoleSync: (projectPath: string, options: unknown, choices: unknown) => invoke('roles:syncApply', projectPath, options, choices),
  getTerminalHookSettings: () => invoke('terminalHooks:getSettings'),
  saveTerminalHookSettings: (settings: unknown) => invoke('terminalHooks:saveSettings', settings),
  getTerminalHookConnection: () => invoke('terminalHooks:getConnection'),
  regenerateTerminalHookToken: () => invoke('terminalHooks:regenerateToken'),
  // Менеджер скиллов проекта (TASK-105, decision-61)
  listProjectSkills: (projectPath: string) => invoke('skills:list', projectPath),
  listSkillSources: (projectPath: string) => invoke('skills:sources', projectPath),
  listSourceSkills: (projectPath: string, source: unknown) => invoke('skills:sourceList', projectPath, source),
  copySkill: (projectPath: string, request: unknown) => invoke('skills:copy', projectPath, request),

  // Git
  getGitLog: (projectPath: string, maxCount?: number) => invoke('git:getLog', projectPath, maxCount),
  getGitStatus: (projectPath: string) => invoke('git:getStatus', projectPath),

  // Git Advanced
  getGitRepoDetails: (projectPath: string) => invoke('git:getRepoDetails', projectPath),
  unwatchGit: (projectPath: string) => invoke('git:unwatch', projectPath),
  checkoutBranch: (projectPath: string, branchName: string, createNew?: boolean) =>
    invoke('git:checkout', projectPath, branchName, createNew),
  createBranch: (projectPath: string, branchName: string) =>
    invoke('git:createBranch', projectPath, branchName),
  deleteBranch: (projectPath: string, branchName: string, force?: boolean) =>
    invoke('git:deleteBranch', projectPath, branchName, force),
  mergeBranch: (projectPath: string, branchName: string, options?: { renumber?: boolean }) =>
    invoke('git:mergeBranch', projectPath, branchName, options),
  fetchRemote: (projectPath: string) =>
    invoke('git:fetchRemote', projectPath),
  pullRemote: (projectPath: string) =>
    invoke('git:pullRemote', projectPath),
  getMergeState: (projectPath: string) =>
    invoke('git:mergeState', projectPath),
  getConflictFile: (projectPath: string, filePath: string) =>
    invoke('git:conflictFile', projectPath, filePath),
  resolveConflict: (projectPath: string, filePath: string, resolution: unknown) =>
    invoke('git:resolveConflict', projectPath, filePath, resolution),
  finishMerge: (projectPath: string) =>
    invoke('git:finishMerge', projectPath),
  abortMerge: (projectPath: string) =>
    invoke('git:abortMerge', projectPath),
  pushRemote: (projectPath: string) =>
    invoke('git:pushRemote', projectPath),
  discardFileChanges: (projectPath: string, filePath: string) =>
    invoke('git:discardFileChanges', projectPath, filePath),
  getDiffBetween: (projectPath: string, targetA: string, targetB?: string, filePath?: string) =>
    invoke('git:getDiffBetween', projectPath, targetA, targetB, filePath),
  stageFile: (projectPath: string, filePath: string) =>
    invoke('git:stageFile', projectPath, filePath),
  unstageFile: (projectPath: string, filePath: string) =>
    invoke('git:unstageFile', projectPath, filePath),
  stageAll: (projectPath: string) =>
    invoke('git:stageAll', projectPath),
  commitChanges: (projectPath: string, message: string, stageAll?: boolean, acknowledgeSecrets?: string) =>
    invoke('git:commit', projectPath, message, stageAll, acknowledgeSecrets),
  getFileDiff: (projectPath: string, filePath: string, staged?: boolean) =>
    invoke('git:getFileDiff', projectPath, filePath, staged),
  onGitChanged: (callback: (data: { projectPath: string }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('git:changed', handler);
    return () => {
      ipcRenderer.removeListener('git:changed', handler);
    };
  },

  // Git Worktrees (TASK-53)
  listWorktrees: (projectPath: string) =>
    invoke('git:worktree:list', projectPath),
  addWorktree: (projectPath: string, options: unknown) =>
    invoke('git:worktree:add', projectPath, options),
  removeWorktree: (projectPath: string, worktreePath: string, force?: boolean) =>
    invoke('git:worktree:remove', projectPath, worktreePath, force),
  pruneWorktrees: (projectPath: string) =>
    invoke('git:worktree:prune', projectPath),
  getWorktreeDiff: (projectPath: string, worktreeBranch: string, baseBranch: string, worktreePath?: string) =>
    invoke('git:worktree:getDiff', projectPath, worktreeBranch, baseBranch, worktreePath),
  getWorktreeDirtyState: (projectPath: string, worktreePath: string) =>
    invoke('git:worktree:dirtyState', projectPath, worktreePath),
  mergeWorktree: (projectPath: string, worktreeBranch: string, targetBranch: string, options?: { renumber?: boolean; pendingChanges?: 'refuse' | 'commit'; commitMessage?: string }) =>
    invoke('git:worktree:merge', projectPath, worktreeBranch, targetBranch, options),
  pullBaseIntoWorktree: (projectPath: string, worktreePath: string, targetBranch: string) =>
    invoke('git:worktree:pullBase', projectPath, worktreePath, targetBranch),
  checkoutWorktreeFiles: (projectPath: string, branch: string, filePaths: string[]) =>
    invoke('git:worktree:checkoutFiles', projectPath, branch, filePaths),
  findOrphanedWorktrees: (projectPath: string, activeTaskIds: string[] = [], activeSwarmIds: string[] = []) =>
    invoke('git:worktree:findOrphaned', projectPath, activeTaskIds, activeSwarmIds),
  cleanOrphanedWorktrees: (projectPath: string, worktreePaths: string[], branches: string[]) =>
    invoke('git:worktree:cleanOrphaned', projectPath, worktreePaths, branches),

  // Pull & Merge Requests
  getPRProviderInfo: (projectPath: string) => invoke('pr:getProviderInfo', projectPath),
  listPullRequests: (projectPath: string, state?: 'all' | 'open' | 'closed' | 'merged') =>
    invoke('pr:list', projectPath, state),
  createPullRequest: (projectPath: string, options: unknown) =>
    invoke('pr:create', projectPath, options),
  // Ревью PR (TASK-81, decision-53)
  listPrReviews: (projectPath: string, prNumber?: number) => invoke('prReview:list', projectPath, prNumber),
  startPrReview: (projectPath: string, prNumber: number, options: PrReviewStartOptions) =>
    invoke('prReview:start', projectPath, prNumber, options),
  publishPrReview: (projectPath: string, reviewId: string) => invoke('prReview:publish', projectPath, reviewId),
  onPrReviewChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('prReview:changed', handler);
    return () => {
      ipcRenderer.removeListener('prReview:changed', handler);
    };
  },
  getPRDiff: (projectPath: string, prNumber: number) =>
    invoke('pr:getDiff', projectPath, prNumber),
  setPRConnection: (projectPath: string, connectionId: string | null) =>
    invoke('pr:setConnection', projectPath, connectionId),
  importPRCliLogin: (projectPath: string) => invoke('pr:importCliLogin', projectPath),
  setPRMergeStatus: (projectPath: string, status: string | null) => invoke('pr:setMergeStatus', projectPath, status),
  getTaskPullRequests: (projectPath: string, taskId: string) => invoke('pr:forTask', projectPath, taskId),

  // Interactive PTY Terminals (Claude Code & Multi-tab Shell)
  createPtySession: (options: unknown) => invoke('pty:create', options),
  writePty: (sessionId: string, data: string) => invoke('pty:write', sessionId, data),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    invoke('pty:resize', sessionId, cols, rows),
  killPty: (sessionId: string) => invoke('pty:kill', sessionId),
  listPtySessions: () => invoke('pty:list'),
  getPtyOutput: (sessionId: string) => invoke('pty:getOutput', sessionId),
  onPtyData: (callback: (data: { sessionId: string; data: string; end?: number }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('pty:data', handler);
    return () => {
      ipcRenderer.removeListener('pty:data', handler);
    };
  },
  onPtyExit: (callback: (data: { sessionId: string; exitCode: number }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('pty:exit', handler);
    return () => {
      ipcRenderer.removeListener('pty:exit', handler);
    };
  },
  // Завершившаяся сессия удалена по TTL — рендерер убирает вкладку (TASK-50)
  onPtyRemoved: (callback: (data: PtyRemovedPayload) => void) => {
    const handler = (_event: unknown, data: PtyRemovedPayload) => callback(data);
    ipcRenderer.on('pty:removed', handler);
    return () => {
      ipcRenderer.removeListener('pty:removed', handler);
    };
  },

  // Agents Studio & Claude Bridge Engine
  getAIConfig: () => invoke('ai:getConfig'),
  saveAIConfig: (config: unknown) => invoke('ai:saveConfig', config),
  // Профили OpenAI-совместимых провайдеров (TASK-70.1, TASK-70.2)
  getLlmProviderPresets: () => invoke('llmProfiles:presets'),
  listLlmProfiles: () => invoke('llmProfiles:list'),
  saveLlmProfile: (profile: unknown, apiKey?: string | null) => invoke('llmProfiles:save', { profile, apiKey }),
  deleteLlmProfile: (id: string) => invoke('llmProfiles:delete', id),
  listLlmProfileModels: (id: string, refresh?: boolean) => invoke('llmProfiles:listModels', id, refresh),
  importLegacyLlmProfile: (provider: string) => invoke('llmProfiles:importLegacy', provider),
  getAgentPricing: () => invoke('pricing:get'),
  saveAgentPricing: (overrides: unknown) => invoke('pricing:save', overrides),
  fetchOpenRouterPrices: () => invoke('pricing:fetchOpenRouter'),
  getModelTiers: () => invoke('modelTiers:get'),
  saveModelTiers: (settings: unknown) => invoke('modelTiers:save', settings),
  seedModelTiers: (draft?: unknown) => invoke('modelTiers:seed', draft),
  getModelAssignments: () => invoke('modelAssignments:get'),
  saveModelAssignments: (settings: unknown) => invoke('modelAssignments:save', settings),
  previewModelAssignments: (draft?: unknown) => invoke('modelAssignments:preview', draft),
  generateTaskDraft: (request: unknown) => invoke('ai:taskDraft', request),
  getClaudeAuthStatus: (query?: { projectPath?: string; accountId?: string; force?: boolean }) =>
    invoke('ai:getClaudeAuthStatus', query),
  claudeLogout: (query?: { projectPath?: string; accountId?: string }) => invoke('ai:claudeLogout', query),
  listCliSessions: (query: { projectPath: string; cwd?: string; claudeAccountId?: string }) => invoke('ai:listCliSessions', query),
  readCliSession: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; cliSessionId: string }) => invoke('ai:readCliSession', query),
  // Разговор вкладки занят фоновой сессией CLI (TASK-301)
  stopCliBackgroundSession: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; cliSessionId: string }) =>
    invoke('ai:stopCliBackgroundSession', query),
  studioEngines: (query?: { projectPath?: string; force?: boolean }) => invoke('ai:studioEngines', query),
  // `/rewind` в Agents Studio (TASK-284)
  cliRewindPoints: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; cliSessionId: string }) => invoke('ai:cliRewindPoints', query),
  cliRewindPreview: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; cliSessionId: string; promptUuid: string }) =>
    invoke('ai:cliRewindPreview', query),
  cliRewindFiles: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; cliSessionId: string; promptUuid: string }) =>
    invoke('ai:cliRewindFiles', query),
  // `/add-dir` в Agents Studio (TASK-285)
  checkAddDir: (query: { projectPath: string; cwd?: string; dir: string }) => invoke('ai:checkAddDir', query),
  // `/memory` в Agents Studio (TASK-286)
  cliMemoryDialog: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; addDirs?: string[] }) => invoke('ai:cliMemoryDialog', query),
  readCliMemoryFile: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; file: string }) => invoke('ai:readCliMemoryFile', query),
  saveCliMemoryFile: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; file: string; content: string }) =>
    invoke('ai:saveCliMemoryFile', query),
  openCliMemoryFolder: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; dir: string }) => invoke('ai:openCliMemoryFolder', query),
  cliStatus: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; addDirs?: string[]; cliSessionId?: string }) => invoke('ai:cliStatus', query),
  cliCommands: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; addDirs?: string[] }) => invoke('ai:cliCommands', query),
  searchFiles: (query: { projectPath: string; cwd?: string; query: string; limit?: number }) => invoke('ai:searchFiles', query),
  exportConversation: (query: { projectPath: string; markdown: string; fileName: string; cwd?: string; claudeAccountId?: string; addDirs?: string[]; cliSessionId?: string }) =>
    invoke('ai:exportConversation', query),
  saveStudioAttachment: (query: { projectPath: string; cwd?: string; name: string; mime: string; data: string }) => invoke('ai:saveAttachment', query),
  studioAttachmentPreview: (query: { projectPath: string; path: string; mime?: string }) => invoke('ai:attachmentPreview', query),
  openStudioAttachment: (query: { projectPath: string; path: string }) => invoke('ai:openAttachment', query),
  cliRenameSession: (query: { projectPath: string; cwd?: string; claudeAccountId?: string; addDirs?: string[]; cliSessionId: string; name: string }) =>
    invoke('ai:cliRenameSession', query),
  // Профили аккаунтов Claude Code (TASK-152, decision-87)
  claudeAccounts: {
    overview: () => invoke('claudeAccounts:overview'),
    statuses: (force?: boolean) => invoke('claudeAccounts:statuses', force),
    status: (id: string, force?: boolean) => invoke('claudeAccounts:status', id, force),
    create: (name: string, engine?: string) => invoke('claudeAccounts:create', name, engine),
    connectExternal: (input: { name: string; source: 'dialog' | 'processEnv'; engine?: string }) => invoke('claudeAccounts:connectExternal', input),
    rename: (id: string, name: string) => invoke('claudeAccounts:rename', id, name),
    remove: (id: string) => invoke('claudeAccounts:remove', id),
    logout: (id: string) => invoke('claudeAccounts:logout', id),
    forProject: (projectPath: string) => invoke('claudeAccounts:forProject', projectPath),
    setProject: (projectPath: string, accountId: string | null) => invoke('claudeAccounts:setProject', projectPath, accountId),
    projectEngines: (projectPath: string) => invoke('claudeAccounts:projectEngines', projectPath),
    setProjectEngine: (projectPath: string, engine: string, accountId: string | null) =>
      invoke('claudeAccounts:setProjectEngine', projectPath, engine, accountId),
    setRole: (roleSlug: string, accountId: string | null) => invoke('claudeAccounts:setRole', roleSlug, accountId)
  },
  // Синхронизация задач с внешним трекером (TASK-128, decision-103)
  trackerSync: {
    status: (projectPath: string) => invoke('trackerSync:status', projectPath),
    save: (projectPath: string, patch: unknown) => invoke('trackerSync:save', projectPath, patch),
    targets: (projectPath: string) => invoke('trackerSync:targets', projectPath),
    describeTarget: (projectPath: string) => invoke('trackerSync:describeTarget', projectPath),
    preview: (projectPath: string) => invoke('trackerSync:preview', projectPath),
    run: (projectPath: string) => invoke('trackerSync:run', projectPath)
  },
  // Рабочие чаты (TASK-138.4, decision-110)
  chat: {
    list: () => invoke('chat:list'),
    save: (subscription: unknown) => invoke('chat:save', subscription),
    remove: (id: string) => invoke('chat:remove', id),
    targets: (kind: string, connectionId: string) => invoke('chat:targets', kind, connectionId),
    test: (id: string) => invoke('chat:test', id)
  },
  // CI/CD (TASK-138.3, decision-109)
  ci: {
    providers: (projectPath: string) => invoke('ci:providers', projectPath),
    runs: (projectPath: string, filter?: unknown) => invoke('ci:runs', projectPath, filter),
    run: (projectPath: string, provider: string, runId: string) => invoke('ci:run', projectPath, provider, runId),
    logs: (projectPath: string, provider: string, runId: string, jobId?: string) => invoke('ci:logs', projectPath, provider, runId, jobId),
    retry: (projectPath: string, provider: string, runId: string, jobId?: string) => invoke('ci:retry', projectPath, provider, runId, jobId),
    getJenkins: (projectPath: string) => invoke('ci:getJenkins', projectPath),
    setJenkins: (projectPath: string, value: unknown) => invoke('ci:setJenkins', projectPath, value)
  },
  // Подключения к внешним сервисам (TASK-138.1, decision-102)
  connections: {
    services: () => invoke('connections:services'),
    list: () => invoke('connections:list'),
    addToken: (input: unknown, reconnectId?: string) => invoke('connections:addToken', input, reconnectId),
    startOAuth: (input: unknown, reconnectId?: string) => invoke('connections:startOAuth', input, reconnectId),
    getFlow: (flowId: string) => invoke('connections:getFlow', flowId),
    cancelFlow: (flowId: string) => invoke('connections:cancelFlow', flowId),
    openFlowPage: (flowId: string) => invoke('connections:openFlowPage', flowId),
    check: (id: string) => invoke('connections:check', id),
    rename: (id: string, label: string) => invoke('connections:rename', id, label),
    remove: (id: string) => invoke('connections:remove', id),
    onChanged: (callback: (list: ConnectionView[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, list: ConnectionView[]) => callback(list);
      ipcRenderer.on('connections:changed', handler);
      return () => {
        ipcRenderer.removeListener('connections:changed', handler);
      };
    },
    onFlowChanged: (callback: (flow: ConnectionFlowView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, flow: ConnectionFlowView) => callback(flow);
      ipcRenderer.on('connections:flowChanged', handler);
      return () => {
        ipcRenderer.removeListener('connections:flowChanged', handler);
      };
    }
  },
  streamAIChat: (request: unknown) => invoke('ai:streamChat', request),
  previewAgentContext: (projectPath: string, taskId: string, contextParts?: unknown) =>
    invoke('ai:previewContext', projectPath, taskId, contextParts),
  abortAIStream: (sessionId: string) => invoke('ai:abortStream', sessionId),
  cliBackgroundTaskOutput: (sessionId: string, taskId: string) => invoke('ai:cliBackgroundTaskOutput', { sessionId, taskId }),
  stopCliBackgroundTask: (sessionId: string, taskId: string) => invoke('ai:stopCliBackgroundTask', { sessionId, taskId }),
  cliSendDuringTurn: (sessionId: string, message: { id: string; text: string; attachments?: unknown[] }) => invoke('ai:cliSendDuringTurn', { sessionId, message }),
  cliCancelDuringTurn: (sessionId: string, messageId: string) => invoke('ai:cliCancelDuringTurn', { sessionId, messageId }),
  clearAISession: (sessionId: string) => invoke('ai:clearSession', sessionId),
  applyAIDiff: (projectPath: string, relativePath: string, newContent: string) =>
    invoke('ai:applyDiff', projectPath, relativePath, newContent),
  // История диалогов Agents Studio в файлах (TASK-35)
  listAISessions: (projectPath: string) => invoke('aiSessions:list', projectPath),
  saveAISession: (projectPath: string, session: unknown) => invoke('aiSessions:save', projectPath, session),
  deleteAISession: (projectPath: string, sessionId: string) =>
    invoke('aiSessions:delete', projectPath, sessionId),
  importAISessions: (sessionsByProject: unknown) => invoke('aiSessions:import', sessionsByProject),
  // Agents Studio с телефона (TASK-140.10): запросы хоста к стору и ответы на них
  onStudioRemoteRequest: (callback: (req: StudioRemoteRequestPayload) => void) => {
    const handler = (_event: IpcRendererEvent, req: StudioRemoteRequestPayload) => callback(req);
    ipcRenderer.on('aiStudio:remoteRequest', handler);
    return () => {
      ipcRenderer.removeListener('aiStudio:remoteRequest', handler);
    };
  },
  replyStudioRemote: (requestId: string, reply: { ok: boolean; sessionId?: string; error?: string }) =>
    invoke('aiStudio:remoteReply', requestId, reply),

  // Claude Bridge Approvals & Statuses
  getAllProjectStatuses: () => invoke('claudeBridge:getAllProjectStatuses'),
  getProjectAgentStatus: (projectPath: string) => invoke('claudeBridge:getProjectStatus', projectPath),
  sendApprovalResponse: (requestId: string, response: { approved: boolean; text?: string }) =>
    invoke('claudeBridge:sendApprovalResponse', requestId, response),
  getSubagents: (projectPath: string) => invoke('claudeBridge:getSubagents', projectPath),
  getAvailableModels: () => invoke('claudeBridge:getAvailableModels'),
  getClaudeUsage: (forceRefresh?: boolean, query?: { accountId?: string; projectPath?: string }) =>
    invoke('claudeBridge:getUsage', forceRefresh, query),

  // Multi-Agent Swarm & Fleet Orchestration (TASK-54)
  startSwarmFanOut: (options: unknown) => invoke('swarm:startFanOut', options),
  startSwarmHandoff: (options: unknown) => invoke('swarm:startHandoff', options),
  // Цикл «до готовности» (TASK-75)
  startSwarmDoneLoop: (options: unknown) => invoke('swarm:startDoneLoop', options),
  getDoneLoopConfig: (projectPath: string) => invoke('doneLoop:getConfig', projectPath),
  // Планировщик подзадач (TASK-80, decision-49)
  generatePlan: (options: unknown) => invoke('plan:generate', options),
  listPlans: (projectPath?: string) => invoke('plan:list', projectPath),
  getPlanForTask: (projectPath: string, taskId: string) => invoke('plan:getForTask', projectPath, taskId),
  getPlanModels: (projectPath: string) => invoke('plan:models', projectPath),
  approvePlan: (planId: string) => invoke('plan:approve', planId),
  stopPlan: (planId: string) => invoke('plan:stop', planId),
  skipPlanNode: (planId: string, taskId: string, skipped: boolean) =>
    invoke('plan:skipNode', planId, taskId, skipped),
  resolvePlanConflict: (planId: string, taskId: string, action: 'retry' | 'skip' | 'stop' | 'renumber') =>
    invoke('plan:resolveConflict', planId, taskId, action),
  discardPlan: (planId: string) => invoke('plan:discard', planId),
  onPlanEvent: (callback: (event: PlanEventPayload) => void) => {
    const handler = (_event: unknown, data: PlanEventPayload) => callback(data);
    ipcRenderer.on('plan:event', handler);
    return () => {
      ipcRenderer.removeListener('plan:event', handler);
    };
  },
  // Запуск агента, назначенного на задачу через assignee (decision-9, TASK-60)
  runAssignedAgent: (options: { projectPath: string; taskId: string; taskTitle?: string; prompt: string; roleSlug: string; hostId?: string }) =>
    invoke('swarm:runAssigned', options),
  stopSwarm: (swarmId: string) => invoke('swarm:stop', swarmId),
  pickSwarmWinner: (swarmId: string, winnerAgentId: string, mergeIntoBase?: boolean) =>
    invoke('swarm:pickWinner', swarmId, winnerAgentId, mergeIntoBase),
  getSwarm: (swarmId: string) => invoke('swarm:get', swarmId),
  // Автосудья арены (TASK-61)
  runSwarmJudge: (swarmId: string, options?: { rerunChecks?: boolean; skipReview?: boolean }) =>
    invoke('swarm:runJudge', swarmId, options),
  cancelSwarmJudge: (swarmId: string) => invoke('swarm:cancelJudge', swarmId),
  composeSwarmResult: (swarmId: string, selections: Array<{ agentId: string; files: string[] }>) =>
    invoke('swarm:compose', swarmId, selections),
  getArenaConfig: (projectPath: string) => invoke('arena:getConfig', projectPath),
  readVisualArtifact: (relPath: string) => invoke('visual:readArtifact', relPath),
  revealVisualArtifact: (relPath: string) => invoke('visual:revealArtifact', relPath),
  saveArenaConfig: (projectPath: string, patch: { checks?: CheckDefinition[]; arena?: ArenaSettings }) =>
    invoke('arena:saveConfig', projectPath, patch),
  listSwarms: (projectPath?: string) => invoke('swarm:list', projectPath),
  resumeSwarm: (swarmId: string) => invoke('swarm:resume', swarmId),
  discardSwarm: (swarmId: string, cleanupWorktrees?: boolean) =>
    invoke('swarm:discard', swarmId, cleanupWorktrees),
  listAgentResults: (projectPath: string) => invoke('swarm:listResults', projectPath),
  restoreAgentResult: (projectPath: string, ref: string) => invoke('swarm:restoreResult', projectPath, ref),
  deleteAgentResult: (projectPath: string, ref: string) => invoke('swarm:deleteResult', projectPath, ref),
  pruneAgentResults: (projectPath: string) => invoke('swarm:pruneResults', projectPath),
  getSwarmTranscript: (swarmId: string, agentId: string) =>
    invoke('swarm:readTranscript', swarmId, agentId),
  exportSwarm: (swarmId: string, format: 'markdown' | 'json') => invoke('swarm:export', swarmId, format),
  exportSwarmToFile: (swarmId: string, format: 'markdown' | 'json') =>
    invoke('swarm:exportToFile', swarmId, format),
  // Таймлайн, откат, продолжение агента и трасса JSONL (TASK-72, decision-45)
  getAgentTimeline: (swarmId: string, agentId: string) => invoke('swarm:getTimeline', swarmId, agentId),
  rewindAgent: (swarmId: string, agentId: string, checkpoint: number) =>
    invoke('swarm:rewind', swarmId, agentId, checkpoint),
  continueAgent: (swarmId: string, agentId: string, instruction?: string) =>
    invoke('swarm:continueAgent', swarmId, agentId, instruction),
  exportAgentTrace: (swarmId: string, agentId?: string) => invoke('swarm:exportTrace', swarmId, agentId),
  onSwarmEvent: (callback: (event: SwarmEventPayload) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('swarm:event', handler);
    return () => {
      ipcRenderer.removeListener('swarm:event', handler);
    };
  },

  onProjectAgentStatusChanged: (callback: (status: ProjectAgentStatus) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('claudeBridge:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('claudeBridge:statusChanged', handler);
    };
  },
  onSubagentUpdated: (callback: (subagent: SubagentInfo) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('claudeBridge:subagentUpdated', handler);
    return () => {
      ipcRenderer.removeListener('claudeBridge:subagentUpdated', handler);
    };
  },

  onAIChunk: (sessionId: string, callback: Parameters<IElectronAPI['onAIChunk']>[1]) => {
    const channel = `ai:chunk:${sessionId}`;
    const handler = relay(callback);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  // Подсказка следующего промпта Claude Code (TASK-294): приходит после конца хода, поэтому общим каналом, а не потоком хода.
  onAIPromptSuggestion: (callback: Parameters<IElectronAPI['onAIPromptSuggestion']>[0]) => {
    const handler = relay(callback);
    ipcRenderer.on('ai:promptSuggestion', handler);
    return () => {
      ipcRenderer.removeListener('ai:promptSuggestion', handler);
    };
  },
  onAIComplete: (sessionId: string, callback: (message: AIMessage) => void) => {
    const channel = `ai:complete:${sessionId}`;
    const handler = relay(callback);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  onAIError: (sessionId: string, callback: (error: string, info?: ProviderErrorInfo) => void) => {
    const channel = `ai:error:${sessionId}`;
    // Второй аргумент — снимок ошибки провайдера (decision-43), может отсутствовать.
    const handler = (_event: IpcRendererEvent, data: unknown, info?: ProviderErrorInfo) => callback(String(data), info);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },

  // File Explorer & Helpers
  readDirectoryTree: (projectPath: string, subDir?: string, maxDepth?: number) =>
    invoke('files:readTree', projectPath, subDir, maxDepth),
  readFileContent: (projectPath: string, relativePath: string) =>
    invoke('files:readContent', projectPath, relativePath),
  saveFileContent: (projectPath: string, relativePath: string, content: string) =>
    invoke('files:saveContent', projectPath, relativePath, content),
  createFileOrFolder: (projectPath: string, relativePath: string, isDirectory = false) =>
    invoke('files:create', projectPath, relativePath, isDirectory),
  deleteFileOrFolder: (projectPath: string, relativePath: string) =>
    invoke('files:delete', projectPath, relativePath),

  // Local Whisper STT Engine
  // Float32Array уходит через IPC как есть (structured clone сохраняет TypedArray) — без Array.from
  // language: 'auto' — язык определяется по речи, fallbackLanguage — при неуверенности (TASK-117)
  transcribeLocalWhisper: (
    audioData: number[] | Float32Array,
    language?: 'ru' | 'en' | 'auto',
    fallbackLanguage?: 'ru' | 'en'
  ) =>
    invoke('voice:transcribeLocal', {
      audioData: audioData instanceof Float32Array ? audioData : Float32Array.from(audioData),
      language,
      fallbackLanguage
    }),
  getLocalWhisperStatus: () => invoke('voice:getLocalWhisperStatus'),
  // Ленивый прогрев модели: вызывается при первом включении hands-free или из настроек
  warmupLocalWhisper: () => invoke('voice:warmupLocalWhisper'),
  // Шумодав и Silero VAD перед распознаванием (TASK-164.2): фраза 16 кГц туда и обратно без копий в массив
  prepareSpeech: (samples: Float32Array, options: { gate: boolean; denoise: 'off' | 'gtcrn' | 'dpdfnet' }) =>
    invoke('voice:prepareSpeech', { samples, gate: options.gate, denoise: options.denoise }),
  getSpeechPrepStatus: () => invoke('voice:getSpeechPrepStatus'),
  // Локальная модель sherpa (GigaAM, TASK-164.4): подготовка и распознавание одним вызовом
  recognizeSherpa: (
    samples: Float32Array,
    options: { gate: boolean; denoise: 'off' | 'gtcrn' | 'dpdfnet'; modelId: string }
  ) => invoke('voice:recognizeSherpa', { samples, ...options }),
  listAsrModels: () => invoke('asr:listModels'),
  downloadAsrModel: (modelId: string) => invoke('asr:downloadModel', modelId),
  cancelAsrDownload: (modelId: string) => invoke('asr:cancelDownload', modelId),
  deleteAsrModel: (modelId: string) => invoke('asr:deleteModel', modelId),
  onAsrDownloadProgress: (callback: (progress: AsrDownloadProgress) => void) => {
    const handler = (_event: IpcRendererEvent, progress: AsrDownloadProgress) => callback(progress);
    ipcRenderer.on('asr:downloadProgress', handler);
    return () => {
      ipcRenderer.removeListener('asr:downloadProgress', handler);
    };
  },

  // Глобальный push-to-talk и LLM-классификатор свободных команд (TASK-83)
  getPushToTalkStatus: () => invoke('voice:getPushToTalkStatus'),
  savePushToTalkSettings: (patch: Partial<PushToTalkSettings>) =>
    invoke('voice:savePushToTalkSettings', patch),
  requestPushToTalkPermission: () => invoke('voice:requestPushToTalkPermission'),
  classifyVoiceCommand: (request: VoiceClassifyRequest) => invoke('voice:classifyCommand', request),
  // Голос → компьютер и системная диктовка: HITL и allowlist применяет прокси в main (TASK-82)
  runVoiceComputerTask: (request: VoiceComputerTaskRequest) => invoke('voice:runComputerTask', request),
  dictateVoiceText: (request: VoiceDictateRequest) => invoke('voice:dictateText', request),
  // Горячая клавиша живёт в main, поэтому работает и при свёрнутом окне: старт/стоп приходят событием
  onPushToTalk: (callback: (event: PushToTalkEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: PushToTalkEvent) => callback(payload);
    ipcRenderer.on('voice:push-to-talk', handler);
    return () => {
      ipcRenderer.removeListener('voice:push-to-talk', handler);
    };
  },
  onPushToTalkStatus: (callback: (status: PushToTalkStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: PushToTalkStatus) => callback(status);
    ipcRenderer.on('voice:push-to-talk-status', handler);
    return () => {
      ipcRenderer.removeListener('voice:push-to-talk-status', handler);
    };
  },

  // Automations (TASK-74, decision-52): правила, подтверждение проектных, журнал, запуск сейчас
  listAutomations: () => invoke('automations:list'),
  saveAutomationRule: (rule: AutomationRuleInput) => invoke('automations:saveRule', rule),
  deleteAutomationRule: (id: string) => invoke('automations:deleteRule', id),
  setAutomationEnabled: (key: string, enabled: boolean, hash?: string) => invoke('automations:setEnabled', key, enabled, hash),
  runAutomationNow: (key: string) => invoke('automations:runNow', key),
  resumeAutomation: (key: string) => invoke('automations:resume', key),
  getAutomationLog: (limit?: number) => invoke('automations:getLog', limit),
  updateAutomationSettings: (patch: Partial<AutomationsSettings>) => invoke('automations:updateSettings', patch),
  onAutomationsChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('automations:changed', handler);
    return () => {
      ipcRenderer.removeListener('automations:changed', handler);
    };
  },

  // Security Health (TASK-73, decision-56): аудит зависимостей, задача из находки, настройки
  getSecurityReport: (projectPath: string) => invoke('security:getReport', projectPath),
  runSecurityAudit: (projectPath: string) => invoke('security:runAudit', projectPath),
  createSecurityTask: (projectPath: string, ecosystem: string, pkg: string) => invoke('security:createTask', projectPath, ecosystem, pkg),
  getSecuritySettings: () => invoke('security:getSettings'),
  saveSecuritySettings: (patch: Partial<SecuritySettings>) => invoke('security:saveSettings', patch),
  onSecurityReportUpdated: (callback: (projectPath: string) => void) => {
    const handler = (_event: IpcRendererEvent, projectPath: string) => callback(projectPath);
    ipcRenderer.on('security:reportUpdated', handler);
    return () => {
      ipcRenderer.removeListener('security:reportUpdated', handler);
    };
  },

  // Графы кода и документации (TASK-167, decision-118)
  getCodeGraph: (projectPath: string, force?: boolean) => invoke('graph:getCode', projectPath, force === true),
  getDocsGraph: (projectPath: string) => invoke('graph:getDocs', projectPath),

  // Настройка индексации GitNexus и переиндексация (TASK-176, decision-131)
  codeIndexState: (projectPath: string) => invoke('codeIndex:getState', projectPath),
  codeIndexPreview: (projectPath: string, settings: unknown, locale: string) => invoke('codeIndex:preview', projectPath, settings, locale),
  codeIndexSave: (projectPath: string, settings: unknown, locale: string) => invoke('codeIndex:save', projectPath, settings, locale),
  codeIndexReindex: (projectPath: string, force: boolean) => invoke('codeIndex:reindex', projectPath, force === true),
  indexDocsDir: (projectPath: string) => invoke('docs:indexDocsDir', projectPath),

  // Память проекта (TASK-76): факты backlog/memory — список, правка человеком, удаление
  listMemory: (projectPath: string) => invoke('memory:list', projectPath),
  writeMemory: (projectPath: string, draft: MemoryDraftInput, replace?: string) =>
    invoke('memory:write', projectPath, draft, replace),
  deleteMemory: (projectPath: string, id: string) => invoke('memory:delete', projectPath, id),

  // Локальный TTS на голосах Piper (TASK-69): генерация в воркере main, воспроизведение в рендерере
  getTtsStatus: () => invoke('tts:getStatus'),
  listTtsVoices: () => invoke('tts:listVoices'),
  downloadTtsVoice: (voiceId: string) => invoke('tts:downloadVoice', voiceId),
  cancelTtsVoiceDownload: (voiceId: string) => invoke('tts:cancelDownload', voiceId),
  deleteTtsVoice: (voiceId: string) => invoke('tts:deleteVoice', voiceId),
  importTtsVoice: () => invoke('tts:importVoice'),
  warmupTts: (voiceId: string, opts?: { auto?: boolean }) => invoke('tts:warmup', voiceId, opts),
  speakTts: (req: TtsSpeakRequest) => invoke('tts:speak', req),
  cancelTts: (jobId: string) => invoke('tts:cancel', jobId),
  cancelAllTts: () => invoke('tts:cancelAll'),
  // PCM приходит чанками по мере готовности: Float32Array переживает structured clone как есть
  onTtsChunk: (callback: (chunk: TtsChunkPayload) => void) => {
    const handler = (_event: IpcRendererEvent, chunk: TtsChunkPayload) => callback(chunk);
    ipcRenderer.on('tts:chunk', handler);
    return () => {
      ipcRenderer.removeListener('tts:chunk', handler);
    };
  },
  onTtsDone: (callback: (info: TtsDonePayload) => void) => {
    const handler = (_event: IpcRendererEvent, info: TtsDonePayload) => callback(info);
    ipcRenderer.on('tts:done', handler);
    return () => {
      ipcRenderer.removeListener('tts:done', handler);
    };
  },
  onTtsError: (callback: (info: TtsErrorPayload) => void) => {
    const handler = (_event: IpcRendererEvent, info: TtsErrorPayload) => callback(info);
    ipcRenderer.on('tts:error', handler);
    return () => {
      ipcRenderer.removeListener('tts:error', handler);
    };
  },
  onTtsDownloadProgress: (callback: (progress: TtsDownloadProgress) => void) => {
    const handler = (_event: IpcRendererEvent, progress: TtsDownloadProgress) => callback(progress);
    ipcRenderer.on('tts:downloadProgress', handler);
    return () => {
      ipcRenderer.removeListener('tts:downloadProgress', handler);
    };
  },

  // Второй движок озвучки: Qwen3-TTS в сайдкаре Python (TASK-104, decision-64)
  getQwenTtsStatus: () => invoke('tts:qwen:getStatus'),
  listQwenTtsVoices: () => invoke('tts:qwen:listVoices'),
  installQwenTts: (req: { models: string[]; hfEndpoint?: string }) => invoke('tts:qwen:install', req),
  cancelQwenTtsInstall: () => invoke('tts:qwen:cancelInstall'),
  unloadQwenTts: () => invoke('tts:qwen:unload'),
  setQwenTtsKeepLoaded: (keep: boolean) => invoke('tts:qwen:setKeepLoaded', keep),
  saveQwenTtsVoice: (input: { label: string; instruct: string; seed: number }) =>
    invoke('tts:qwen:saveVoice', input),
  deleteQwenTtsVoice: (voiceId: string) => invoke('tts:qwen:deleteVoice', voiceId),
  onQwenTtsInstallProgress: (callback: (progress: QwenInstallProgressInfo) => void) => {
    const handler = (_event: IpcRendererEvent, progress: QwenInstallProgressInfo) => callback(progress);
    ipcRenderer.on('tts:qwen:installProgress', handler);
    return () => {
      ipcRenderer.removeListener('tts:qwen:installProgress', handler);
    };
  },

  // System
  getPlatform: () => invoke('system:getPlatform'),

  // SafeStorage & Secret Encryption
  isEncryptionAvailable: () => invoke('secrets:isEncryptionAvailable'),
  encryptSecret: (text: string) => invoke('secrets:encrypt', text),
  decryptSecret: (cipherText: string) => invoke('secrets:decrypt', cipherText),
  saveEncryptedSecret: (key: string, value: string) => invoke('secrets:setSecret', { key, value }),
  getEncryptedSecret: (key: string) => invoke('secrets:getSecret', key),
  deleteEncryptedSecret: (key: string) => invoke('secrets:deleteSecret', key),
  getSecretIssues: () => invoke('secrets:getIssues'),
  acknowledgeSecretIssues: () => invoke('secrets:acknowledgeIssues'),
  showSecretBackup: () => invoke('secrets:showBackup'),
  getSecretBackupPreview: () => invoke('secrets:getBackupPreview'),
  restoreSecretsFromBackup: (ids: string[]) => invoke('secrets:restoreFromBackup', ids),
  deleteSecretBackupEntries: (ids: string[]) => invoke('secrets:deleteFromBackup', ids),
  onSecretIssuesChanged: (callback: (state: SecretIssuesState) => void) => {
    const handler = (_event: IpcRendererEvent, state: SecretIssuesState) => callback(state);
    ipcRenderer.on('secrets:issuesChanged', handler);
    return () => {
      ipcRenderer.removeListener('secrets:issuesChanged', handler);
    };
  },

  // Внешние ссылки: только через системный браузер (main проверяет схему)
  openExternal: (url: string) => invoke('shell:openExternal', url),

  // Remote MCP Server (External Agent Control)
  getMcpStatus: () => invoke('mcp:getStatus'),
  toggleMcpServer: (enable: boolean) => invoke('mcp:toggleServer', enable),
  regenerateMcpToken: () => invoke('mcp:regenerateToken'),
  setMcpAppState: (state: { activeProject?: { name: string; path: string } | null; activeTab?: string }) => invoke('mcp:setAppState', state),
  onMcpStatusChanged: (callback: (status: McpServerStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: McpServerStatus) => callback(status);
    ipcRenderer.on('mcp:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('mcp:statusChanged', handler);
    };
  },
  onRemoteAction: (callback: (action: McpRemoteAction) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('mcp:remoteAction', handler);
    return () => {
      ipcRenderer.removeListener('mcp:remoteAction', handler);
    };
  },

  // Управление компьютером через MCP-прокси: настройки, kill-switch, диагностика (TASK-82)
  getComputerUseStatus: () => invoke('computerUse:getStatus'),
  getComputerUseSettings: () => invoke('computerUse:getSettings'),
  saveComputerUseSettings: (patch: Partial<ComputerUseSettings>) => invoke('computerUse:saveSettings', patch),
  engageComputerKillSwitch: (reason?: 'overlay' | 'manual') => invoke('computerUse:engageKillSwitch', reason),
  releaseComputerKillSwitch: () => invoke('computerUse:releaseKillSwitch'),
  startComputerUseRuntime: () => invoke('computerUse:startRuntime'),
  runComputerUseDiagnostics: () => invoke('computerUse:diagnostics'),
  takeComputerTestScreenshot: () => invoke('computerUse:testScreenshot'),
  onComputerUseStatusChanged: (callback: (status: ComputerUseStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: ComputerUseStatus) => callback(status);
    ipcRenderer.on('computerUse:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('computerUse:statusChanged', handler);
    };
  },
  onComputerOverlayState: (callback: (state: ComputerOverlayState) => void) => {
    const handler = (_event: IpcRendererEvent, state: ComputerOverlayState) => callback(state);
    ipcRenderer.on('computerUse:overlay', handler);
    return () => {
      ipcRenderer.removeListener('computerUse:overlay', handler);
    };
  },

  // System Voice Overlay
  syncVoiceOverlay: (state: VoiceOverlayPayload) => ipcRenderer.send('voice:overlay-sync', state),
  onVoiceOverlayUpdate: (callback: (state: VoiceOverlayPayload) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('voice:overlay-update', handler);
    return () => {
      ipcRenderer.removeListener('voice:overlay-update', handler);
    };
  },
  sendVoiceOverlayAction: (action: VoiceOverlayAction) =>
    ipcRenderer.send('voice:overlay-action', action),
  // Карточку результата push-to-talk закрыли в main: крестиком, кликом мимо или Esc (TASK-115).
  onVoiceResultCardDismissed: (callback: (event: { id: number }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { id: number }) => callback(payload);
    ipcRenderer.on('voice:result-card-dismissed', handler);
    return () => {
      ipcRenderer.removeListener('voice:result-card-dismissed', handler);
    };
  },
  onVoiceExternalControl: (callback: (action: 'toggle-pause' | 'stop') => void) => {
    const handler = relay(callback);
    ipcRenderer.on('voice:external-control', handler);
    return () => {
      ipcRenderer.removeListener('voice:external-control', handler);
    };
  },

  // Remote Control (TASK-51)
  getRemoteStatus: () => invoke('remote:getStatus'),
  toggleRemoteControl: (enable?: boolean) => invoke('remote:toggle', enable),
  updateRemoteConfig: (config: unknown) => invoke('remote:updateConfig', config),
  regenerateRemoteToken: () => invoke('remote:regenerateToken'),
  disconnectRemoteDevice: (deviceId: string) => invoke('remote:disconnectDevice', deviceId),
  approveRemoteDevice: (deviceId: string) => invoke('remote:approveDevice', deviceId),
  setRemoteDeviceRights: (deviceId: string, rights: 'readOnly' | 'hitl' | 'full') =>
    invoke('remote:setDeviceRights', deviceId, rights),
  setRemoteDeviceProjectRights: (deviceId: string, rights: unknown) => invoke('remote:setDeviceProjectRights', deviceId, rights),
  revokeRemoteDevice: (deviceId: string) => invoke('remote:revokeDevice', deviceId),
  testTelegramNotification: (text?: string) => invoke('remote:testTelegramNotification', text),
  startRemoteTunnel: () => invoke('remote:startTunnel'),
  stopRemoteTunnel: () => invoke('remote:stopTunnel'),
  onRemoteControlStatusChanged: (callback: (status: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('remote:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('remote:statusChanged', handler);
    };
  },
  onRemoteHitlDecisionMade: (callback: (data: { requestId: string; sessionId: string; approved: boolean; byDevice: string }) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('remote:hitlDecisionMade', handler);
    return () => {
      ipcRenderer.removeListener('remote:hitlDecisionMade', handler);
    };
  },

  // Федерация компьютеров, hub-режим (TASK-66)
  listFederationPeers: () => invoke('federation:listPeers'),
  addFederationPeer: (options: {
    hostId: string;
    machineName?: string;
    transport: 'lan' | 'relay';
    address: string;
    secretKey?: string;
    hostKey?: string;
    pin?: string;
    autoConnect?: boolean;
  }) => invoke('federation:addPeer', options),
  removeFederationPeer: (hostId: string) => invoke('federation:removePeer', hostId),
  connectFederationPeer: (hostId: string) => invoke('federation:connectPeer', hostId),
  disconnectFederationPeer: (hostId: string) => invoke('federation:disconnectPeer', hostId),
  federationCall: (hostId: string, method: string, params?: Record<string, unknown>) =>
    invoke('federation:call', hostId, method, params),
  getFederationHosts: () => invoke('federation:getHosts'),
  /** Ссылки `projecthub://` (decision-143 п. 4): забрать очередь и подписаться на сигнал о новых. */
  takeDeepLinks: (): Promise<string[]> => invoke('deeplink:take'),
  onDeepLinkAvailable: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('deeplink:available', handler);
    return () => {
      ipcRenderer.removeListener('deeplink:available', handler);
    };
  },
  /** Окна проектов (TASK-295): вынести проект в окно, вернуть его вкладкой, границы своего окна. */
  openProjectWindow: (projectPath: string, at?: { x: number; y: number } | null) => invoke('projectWindow:open', projectPath, at ?? null),
  reattachProjectWindow: () => invoke('projectWindow:reattach'),
  getWindowDropContext: () => invoke('projectWindow:getDropContext'),
  closeProjectWindow: (projectPath: string) => invoke('projectWindow:close', projectPath),
  onProjectWindowClosed: (callback: (info: { projectPath: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { projectPath: string }) => callback(info);
    ipcRenderer.on('projectWindow:closed', handler);
    return () => {
      ipcRenderer.removeListener('projectWindow:closed', handler);
    };
  },
  // Дерево флота (TASK-174): сводка этого ПК и событие её изменения
  getLocalOverview: () => invoke('fleet:getLocalOverview'),
  onLocalOverviewChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('overview:changed', handler);
    return () => {
      ipcRenderer.removeListener('overview:changed', handler);
    };
  },
  onFederationPeersChanged: (callback: (peers: unknown[]) => void) => {
    const handler = (_event: unknown, peers: unknown[]) => callback(peers);
    ipcRenderer.on('federation:peersChanged', handler);
    return () => {
      ipcRenderer.removeListener('federation:peersChanged', handler);
    };
  },
  onFederationEvent: (
    callback: (payload: { hostId: string; machineName: string; event: string; data: unknown }) => void
  ) => {
    const handler = (_event: unknown, payload: { hostId: string; machineName: string; event: string; data: unknown }) =>
      callback(payload);
    ipcRenderer.on('federation:event', handler);
    return () => {
      ipcRenderer.removeListener('federation:event', handler);
    };
  },
  // Проект другого ПК, открытый в окне (TASK-280): по его корню вызовы и события получают маршрут и префикс.
  registerRemoteProject: (hostId: string, hostPath: string) => {
    if (typeof hostId !== 'string' || typeof hostPath !== 'string' || !hostId || !hostPath) return;
    const roots = remoteRoots.get(hostId) ?? new Set<string>();
    roots.add(hostPath);
    remoteRoots.set(hostId, roots);
  },
  unregisterRemoteProject: (hostId: string, hostPath: string) => {
    const roots = remoteRoots.get(hostId);
    if (!roots) return;
    roots.delete(hostPath);
    if (roots.size === 0) remoteRoots.delete(hostId);
  },

  // Единый HITL-контур (TASK-57)
  listPendingApprovals: (filter?: { projectPath?: string; sessionId?: string }) => invoke('hitl:listPending', filter),
  decideApproval: (requestId: string, response: { approved: boolean; text?: string }) =>
    invoke('hitl:decide', requestId, response),
  listHitlAudit: (query?: unknown) => invoke('hitl:listAudit', query),
  listHitlAuditMonths: () => invoke('hitl:auditMonths'),
  getHitlInfo: () => invoke('hitl:auditInfo'),
  exportHitlAudit: (query?: unknown, format?: 'jsonl' | 'json' | 'csv') => invoke('hitl:exportAudit', query, format),
  // Перенос профиля (TASK-224, decision-175)
  profileExport: (password: string, sections?: string[]) => invoke('profile:export', password, sections),
  profileChooseFile: () => invoke('profile:chooseFile'),
  profilePreview: (filePath: string, password: string) => invoke('profile:preview', filePath, password),
  profileApply: (token: string, sections: string[]) => invoke('profile:apply', token, sections),
  profileCloneProject: (remote: string, name: string) => invoke('profile:cloneProject', remote, name),
  profilePreviewFromHost: (hostId: string, sections: string[]) => invoke('profile:previewFromHost', hostId, sections),
  profilePreviewOnHost: (hostId: string, sections: string[]) => invoke('profile:previewOnHost', hostId, sections),
  profileApplyOnHost: (hostId: string, token: string, sections: string[]) => invoke('profile:applyOnHost', hostId, token, sections),
  profileRelaunch: () => invoke('profile:relaunch'),
  // База знаний компании (TASK-223)
  knowledgeBaseIndex: (projectPath: string) => invoke('kb:index', projectPath),
  knowledgeBaseRead: (projectPath: string, id: string) => invoke('kb:read', projectPath, id),
  onBusEvent: (callback: (event: AppBusEvent) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('bus:event', handler);
    return () => {
      ipcRenderer.removeListener('bus:event', handler);
    };
  },

  // Уведомления: трей, ОС, звук, Telegram (TASK-63)
  getNotificationSettings: () => invoke('notifications:getSettings'),
  updateNotificationSettings: (patch: Partial<NotificationSettings>) =>
    invoke('notifications:updateSettings', patch),
  testNotification: () => invoke('notifications:test'),
  setHostLanguage: (language: 'en' | 'ru') => invoke('notifications:setHostLanguage', language),
  notificationNavigate: (action: NotificationAction) => invoke('notifications:navigate', action),
  startTelegramBot: () => invoke('notifications:startBot'),
  stopTelegramBot: () => invoke('notifications:stopBot'),
  listServiceProcesses: () => invoke('process:listService'),
  onNotificationDelivered: (callback: (delivery: NotificationDelivery) => void) => {
    const handler = (_event: unknown, data: NotificationDelivery) => callback(data);
    ipcRenderer.on('notify:delivered', handler);
    return () => {
      ipcRenderer.removeListener('notify:delivered', handler);
    };
  },
  onNotificationSound: (callback: (data: { severity: NotificationSeverity; volume: number }) => void) => {
    const handler = (_event: unknown, data: { severity: NotificationSeverity; volume: number }) => callback(data);
    ipcRenderer.on('notify:sound', handler);
    return () => {
      ipcRenderer.removeListener('notify:sound', handler);
    };
  },
  onNotificationNavigate: (callback: (action: NotificationAction) => void) => {
    const handler = (_event: unknown, data: NotificationAction) => callback(data);
    ipcRenderer.on('notify:navigate', handler);
    return () => {
      ipcRenderer.removeListener('notify:navigate', handler);
    };
  },

  // Диагностика и автообновление (TASK-58)
  getDiagnosticsInfo: () => invoke('diagnostics:getInfo'),
  collectDiagnosticsArchive: () => invoke('diagnostics:collectArchive'),
  getUpdaterStatus: () => invoke('updater:getStatus'),
  checkForUpdates: () => invoke('updater:check'),
  installUpdateNow: () => invoke('updater:installNow'),
  pickUpdateFile: () => invoke('updater:pickFile'),
  installUpdateFile: () => invoke('updater:installFile'),
  onUpdaterStatusChanged: (callback: (status: UpdaterStatus) => void) => {
    const handler = relay(callback);
    ipcRenderer.on('updater:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('updater:statusChanged', handler);
    };
  },

  // Редакция сборки и платные модули (TASK-151, decision-123 п. 4): ограничения запуска агента и каналы `ee:*`
  getEditionInfo: () => invoke('edition:info'),
  checkAgentLaunch: (ctx: unknown) => invoke('agents:launchCheck', ctx),
  editionInvoke: (channel: string, ...args: unknown[]) => {
    if (typeof channel !== 'string' || !channel.startsWith('ee:')) return Promise.reject(new Error('A paid module channel must start with ee:'));
    return ipcRenderer.invoke(channel, ...args);
  }
};

contextBridge.exposeInMainWorld('api', api);






