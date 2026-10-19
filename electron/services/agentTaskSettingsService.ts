import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAgentTaskLimits, type AgentTaskLimits } from './agentTaskPolicy.js';

/**
 * Настройки задач, заведённых агентами (TASK-155, decision-89 п. 6): лимиты за сессию и за 24 часа на проект.
 *
 * Лежат в `<userData>/agent-tasks.json`, а не в файлах проекта: `.projecthub.json` и `backlog/config.yml`
 * агент может переписать сам и поднять себе лимит.
 */
export const AGENT_TASK_SETTINGS_FILE = 'agent-tasks.json';

export interface AgentTaskSettings {
  limits: AgentTaskLimits;
}

export function normalizeAgentTaskSettings(raw: unknown): AgentTaskSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { limits: normalizeAgentTaskLimits(r.limits) };
}

export class AgentTaskSettingsService {
  private cached: AgentTaskSettings | null = null;

  constructor(private readonly dir: () => string) {}

  private get file(): string {
    return path.join(this.dir(), AGENT_TASK_SETTINGS_FILE);
  }

  public async get(): Promise<AgentTaskSettings> {
    if (this.cached) return this.cached;
    try {
      this.cached = normalizeAgentTaskSettings(JSON.parse(await fs.readFile(this.file, 'utf-8')));
    } catch {
      this.cached = normalizeAgentTaskSettings(null);
    }
    return this.cached;
  }

  public async save(raw: unknown): Promise<AgentTaskSettings> {
    const settings = normalizeAgentTaskSettings(raw);
    const target = this.file;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    await fs.rename(tmp, target);
    this.cached = settings;
    return settings;
  }
}
