import type { ProjectToolDeps } from './projectAgentTools';
import { projectRegistry } from './projectRegistry';
import { hitlService } from './hitlService';
import { searchProjectDocs } from './ragSearch';

/** Боевые зависимости инструментов задач и документов (TASK-136.6): реестр, аудит, поиск по документации. */
export const projectAgentToolDeps: ProjectToolDeps = {
  async listProjectRoots() {
    return (await projectRegistry.getProjects()).map((p) => p.path);
  },
  recordAutoDecision(info, decision, rule, detail) {
    return hitlService.recordAutoDecision(info, decision, rule, detail);
  },
  async searchDocs(projectRoot, query, limit) {
    return searchProjectDocs({ projectPath: projectRoot, query, mode: 'all', limit });
  }
};
