import type { ProjectToolDeps } from './projectAgentTools';
import { projectRegistry } from './projectRegistry';
import { hitlService } from './hitlService';
import { searchWithKnowledgeBase } from './knowledgeBaseService';
import { editionRegistry } from '../extensions/editionRegistry';
import { appEventBus } from './eventBus';
import { AgentTaskNotifyBatcher } from './agentTaskNotify';
import { agentTaskApproval, agentTaskSettings } from './agentTaskApprovalInstance';

/**
 * Задачи агента, ждущие подтверждения, — в шину пачками: уведомление по матрице каналов (decision-89).
 * Пачка получает билет: кнопка Telegram подтверждает ровно её задачи (TASK-155).
 */
const agentTaskNotifier = new AgentTaskNotifyBatcher((event) => {
  if (event.type !== 'task:agentCreated') {
    appEventBus.publish(event);
    return;
  }
  const ticket = agentTaskApproval.tickets.issue({ projectPath: event.projectPath, reporter: event.reporter, taskIds: event.tasks.map((t) => t.id) });
  appEventBus.publish({ ...event, approvalTicket: ticket.id });
});

/** Боевые зависимости инструментов задач и документов (TASK-136.6): реестр, аудит, поиск по документации, HITL. */
export const projectAgentToolDeps: ProjectToolDeps = {
  async listProjectRoots() {
    return (await projectRegistry.getProjects()).map((p) => p.path);
  },
  recordAutoDecision(info, decision, rule, detail) {
    return hitlService.recordAutoDecision(info, decision, rule, detail);
  },
  async searchDocs(projectRoot, query, limit, memberId) {
    // База знаний компании (TASK-223): участнику команды — только если ему открыт её проект.
    return searchWithKnowledgeBase(projectRoot, query, limit, (kbRoot) => !memberId || editionRegistry.memberCanAccessProject(memberId, kbRoot));
  },
  // Карточка режима `ask` (decision-89): общая очередь HITL, решение и аудит — там же.
  async requestApproval(request) {
    const res = await hitlService.request({ ...request, id: hitlService.newRequestId(), createdAt: Date.now() });
    return Boolean(res?.approved);
  },
  onAgentTaskPending(info) {
    agentTaskNotifier.add(info);
  },
  // Ветки документации (decision-151): окно документации обновляет список, предложение — уведомление человеку.
  onDocBranchChanged(info) {
    appEventBus.publish({ type: 'docs:branchChanged', ...info, at: Date.now() });
  },
  async getAgentTaskLimits() {
    return (await agentTaskSettings.get()).limits;
  }
};
