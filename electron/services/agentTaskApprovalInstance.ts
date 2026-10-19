import { AgentTaskApprovalService } from './agentTaskApprovalService';
import { AgentTaskSettingsService } from './agentTaskSettingsService';
import { getUserDataDir } from './appPaths';
import { hitlService } from './hitlService';
import { projectRegistry } from './projectRegistry';

/** Лимиты задач агентов (TASK-155): `<userData>/agent-tasks.json`. */
export const agentTaskSettings = new AgentTaskSettingsService(() => getUserDataDir());

/** Боевой экземпляр подтверждения задач агента (TASK-155): аудит HITL и реестр проектов. */
export const agentTaskApproval = new AgentTaskApprovalService({
  recordHumanDecision: (info, decision, source, rule, detail) => hitlService.recordHumanDecision(info, decision, source, rule, detail),
  listProjectRoots: async () => (await projectRegistry.getProjects()).map((p) => p.path)
});
