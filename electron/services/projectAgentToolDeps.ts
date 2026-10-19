import type { ProjectToolDeps } from './projectAgentTools';
import { projectRegistry } from './projectRegistry';
import { hitlService } from './hitlService';
import { searchProjectDocs } from './ragSearch';
import { appEventBus } from './eventBus';
import { AgentTaskNotifyBatcher } from './agentTaskNotify';

/** Задачи агента, ждущие подтверждения, — в шину пачками: уведомление по матрице каналов (decision-89). */
const agentTaskNotifier = new AgentTaskNotifyBatcher((event) => appEventBus.publish(event));

/** Боевые зависимости инструментов задач и документов (TASK-136.6): реестр, аудит, поиск по документации, HITL. */
export const projectAgentToolDeps: ProjectToolDeps = {
  async listProjectRoots() {
    return (await projectRegistry.getProjects()).map((p) => p.path);
  },
  recordAutoDecision(info, decision, rule, detail) {
    return hitlService.recordAutoDecision(info, decision, rule, detail);
  },
  async searchDocs(projectRoot, query, limit) {
    return searchProjectDocs({ projectPath: projectRoot, query, mode: 'all', limit });
  },
  // Карточка режима `ask` (decision-89): общая очередь HITL, решение и аудит — там же.
  async requestApproval(request) {
    const res = await hitlService.request({ ...request, id: hitlService.newRequestId(), createdAt: Date.now() });
    return Boolean(res?.approved);
  },
  onAgentTaskPending(info) {
    agentTaskNotifier.add(info);
  }
};
