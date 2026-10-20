import path from 'node:path';
import { getUserDataDir } from './appPaths.js';
import { appEventBus } from './eventBus.js';
import { agentFleetService } from './agentFleetService.js';
import { prService } from './prServiceInstance.js';
import { hitlService } from './hitlService.js';
import { findTaskFile } from './taskFileLookup.js';
import { parseTaskBody } from './backlogTaskFormat.js';
import { appendSessionNoteToTask } from './taskSessionNote.js';
import { apiToolNamesForCategories, claudeToolNamesForCategories } from './roleEngineAdapter.js';
import { logger } from './logger.js';
import { PR_REVIEWS_DIR, PrReviewService } from './prReviewService.js';
import { PrWatcher } from './prWatcher.js';
import { applyPrMerge } from './prMergeTasks.js';
import type { SwarmEventPayload, SwarmSession } from './swarmTypes.js';

/**
 * Ревью PR в приложении (TASK-81, decision-53): сервис ревью и опрос PR с настоящими зависимостями —
 * хостинг PR (подключение или GitHub CLI, decision-105), флот агентов, HITL, задачи Backlog.md, шина событий.
 * Опрос PR также переводит задачи слитых PR по настройке проекта (TASK-138.5).
 */

const log = (level: 'info' | 'warn', message: string) => (level === 'warn' ? logger.warn(message) : logger.info(message));

export const prReviewService = new PrReviewService({
  gh: {
    getPr: (root, n) => prService.getPrForReview(root, n),
    getDiff: (root, n) => prService.getPrDiffStrict(root, n),
    fetchHead: (root, n) => prService.fetchPrHead(root, n),
    comment: (root, n, body) => prService.commentOnPr(root, n, body),
    describeComment: (root, n) => prService.describeCommentTarget(root, n)
  },
  fleet: {
    buildRoleSlot: (root, slug, slotId, overrides) => agentFleetService.buildRoleSlot(root, slug, slotId, overrides),
    startFanOut: (options) => agentFleetService.startFanOut(options),
    getSwarm: (id) => agentFleetService.getSwarm(id),
    onSwarm: (listener: (session: SwarmSession) => void) => {
      const handler = (event: SwarmEventPayload) => {
        if (event.session) listener(event.session);
      };
      agentFleetService.on('swarmEvent', handler);
      return () => agentFleetService.off('swarmEvent', handler);
    }
  },
  findTask: async (root, taskId) => {
    const task = await findTaskFile(root, taskId);
    if (!task) return null;
    const body = parseTaskBody(task.content.replace(/\r\n/g, '\n'));
    return {
      id: typeof task.data.id === 'string' ? task.data.id : taskId,
      title: typeof task.data.title === 'string' ? task.data.title : taskId,
      description: body.description,
      criteria: body.criteria.map((c) => c.text)
    };
  },
  appendTaskNote: async (root, taskId, note) => {
    await appendSessionNoteToTask(root, taskId, note);
  },
  requestApproval: (request, timeoutMs) => hitlService.request(request, { timeoutMs }),
  readOnlyTools: [...new Set([...claudeToolNamesForCategories(['read', 'search']), ...apiToolNamesForCategories(['read', 'search'])])],
  publish: (event) => appEventBus.publish(event),
  stateDir: path.join(getUserDataDir(), PR_REVIEWS_DIR),
  now: () => Date.now(),
  log
});

export const prWatcher = new PrWatcher({
  listOpenPrs: (root) => prService.listOpenPrsForWatch(root),
  getPrState: (root, n) => prService.getPrStateForWatch(root, n),
  onMerged: async (root, pr) => applyPrMerge(root, pr, await prService.getMergeStatus(root)),
  publish: (event) => appEventBus.publish(event),
  stateDir: getUserDataDir(),
  now: () => Date.now(),
  log
});

/** Источник опроса PR: проекты, где слияние переводит задачу (TASK-138.5). */
const MERGE_WATCH_SOURCE = 'mergeStatus';

async function refreshMergeWatch(): Promise<void> {
  prWatcher.setProjects(await prService.mergeStatusProjects(), MERGE_WATCH_SOURCE);
}

/** Запуск при старте приложения: опрос PR проектов с настройкой и следить за её сменой. */
export function initPrMergeWatch(): () => void {
  void refreshMergeWatch().catch((err) => log('warn', `[PrWatcher] Настройки слияния не прочитаны: ${String(err)}`));
  const off = prService.onMergeSettingsChange(() => void refreshMergeWatch().catch(() => undefined));
  return () => {
    off();
    prWatcher.setProjects([], MERGE_WATCH_SOURCE);
  };
}
