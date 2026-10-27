/**
 * База знаний компании (TASK-223, decision-182): отдельный проект ProjectHub с `backlog/docs` и `backlog/decisions`,
 * который другие проекты подключают в `.projecthub.json` и читают поиском и ссылками `[[kb:doc-N]]`.
 * Чистый модуль без Node и React.
 */

export const KB_REF_PREFIX = 'kb:';

/** Поле `knowledgeBase` в `.projecthub.json` проекта. */
export interface KnowledgeBaseConfig {
  /** Адрес git remote базы знаний — переносимо: на каждой машине ищется зарегистрированный проект с этим origin. */
  remote?: string;
  /** Путь к базе знаний относительно проекта (`../company-kb`) — для монорепозитория и соседних копий. */
  path?: string;
}

export function parseKnowledgeBaseConfig(projectJson: unknown): KnowledgeBaseConfig | null {
  if (!projectJson || typeof projectJson !== 'object') return null;
  const raw = (projectJson as Record<string, unknown>).knowledgeBase;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const remote = typeof r.remote === 'string' && r.remote.trim() ? r.remote.trim() : undefined;
  const p = typeof r.path === 'string' && r.path.trim() ? r.path.trim() : undefined;
  if (!remote && !p) return null;
  return { ...(remote ? { remote } : {}), ...(p ? { path: p } : {}) };
}

/** Адрес git remote без схемы, `.git`, учётных данных и регистра хоста: SSH и HTTPS одного репозитория совпадают. */
export function normalizeGitRemote(remote: string): string {
  const r = remote.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(r);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`;
  try {
    const u = new URL(r);
    return `${u.hostname.toLowerCase()}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return r;
  }
}
