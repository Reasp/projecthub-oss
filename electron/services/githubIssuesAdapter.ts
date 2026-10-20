import type { RemoteStatus, RemoteTask, TrackerTarget, TrackerTargetGroup } from './trackerTypes.js';
import {
  arr,
  callTrackerJson,
  obj,
  parseTime,
  text,
  trimBase,
  TrackerHttpError,
  type TrackerAdapter,
  type TrackerCallOptions,
  type TrackerHttp,
  type TrackerLinkContext
} from './trackerAdapter.js';

/**
 * Адаптер GitHub Issues, REST API v3 (TASK-129, decision-106). Цель — репозиторий, id задачи — `owner/repo#N`.
 * Статусов у GitHub два: `open` и `closed`. PR в списке issues отбрасываются: ими занимается PR-интеграция.
 */

const PER_PAGE = 100;
const MAX_ISSUE_PAGES = 20;
const MAX_REPO_PAGES = 5;
const ID_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const LINK_RE = /^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;

export const GITHUB_STATUSES: RemoteStatus[] = [
  { name: 'open', type: 'open' },
  { name: 'closed', type: 'closed' }
];

/** Issue GitHub → общий вид; PR (`pull_request` в ответе) — `null`. */
export function parseGithubIssue(json: unknown): RemoteTask | null {
  const i = obj(json);
  if (i.pull_request) return null;
  const number = Number(i.number);
  const url = text(i.html_url);
  const repo = /\/([^/]+)\/([^/]+)\/issues\/\d+$/.exec(url) ?? /\/repos\/([^/]+)\/([^/]+)\/issues\/\d+$/.exec(text(i.url));
  if (!Number.isInteger(number) || number <= 0 || !repo) return null;
  const state = text(i.state) === 'closed' ? 'closed' : 'open';
  return {
    id: `${repo[1]}/${repo[2]}#${number}`,
    title: text(i.title),
    description: text(i.body),
    status: state,
    statusType: state,
    updatedAt: parseTime(i.updated_at),
    url
  };
}

function splitId(id: string): { repo: string; number: string } {
  const m = ID_RE.exec(id);
  if (!m) throw new TrackerHttpError(0, 'invalid_id', `Неверный id задачи GitHub: ${id}`);
  return { repo: `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`, number: m[3] };
}

function repoPath(target: TrackerTarget): string {
  return target.id.split('/').map(encodeURIComponent).join('/');
}

const describe = (json: unknown) => ({ code: '', message: text(obj(json).message) });

/** Есть ли следующая страница: заголовок `Link` с `rel="next"`; без заголовка — по полноте страницы. */
export function hasNextPage(link: string | null, count: number): boolean {
  if (link !== null) return /<[^>]+>;\s*rel="next"/.test(link);
  return count >= PER_PAGE;
}

export function createGithubIssuesAdapter(options: TrackerCallOptions = {}): TrackerAdapter {
  const call = (http: TrackerHttp, path: string, init?: RequestInit, onHeaders?: (h: Headers) => void) =>
    callTrackerJson(http, path, { ...init, headers: { Accept: 'application/vnd.github+json', ...(init?.headers ?? {}) } }, { ...options, label: 'GitHub', describe, onHeaders });

  const getTask = async (http: TrackerHttp, id: string): Promise<RemoteTask | null> => {
    const { repo, number } = splitId(id);
    try {
      return parseGithubIssue(await call(http, `/repos/${repo}/issues/${number}`));
    } catch (err) {
      if (err instanceof TrackerHttpError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  };

  const patch = async (http: TrackerHttp, path: string, body: Record<string, unknown>): Promise<RemoteTask> => {
    const parsed = parseGithubIssue(await call(http, path, { method: 'PATCH', body: JSON.stringify(body) }));
    if (!parsed) throw new TrackerHttpError(0, 'invalid_response', 'GitHub вернул issue без номера');
    return parsed;
  };

  return {
    id: 'github-issues',
    label: 'GitHub Issues',
    serviceId: 'github',

    async listTargets(http) {
      const byOwner = new Map<string, TrackerTarget[]>();
      for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
        let link: string | null = null;
        const repos = arr(
          await call(http, `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, undefined, (h) => (link = h.get('link')))
        );
        for (const r of repos.map(obj)) {
          if (r.has_issues === false || r.archived === true) continue;
          const full = text(r.full_name);
          const [owner, name] = full.split('/');
          if (!owner || !name) continue;
          if (!byOwner.has(owner)) byOwner.set(owner, []);
          byOwner.get(owner)!.push({ id: full, name });
        }
        if (!hasNextPage(link, repos.length)) break;
      }
      const groups: TrackerTargetGroup[] = [...byOwner.entries()].map(([owner, targets]) => ({ id: owner, name: owner, targets }));
      return groups;
    },

    async getStatuses() {
      return GITHUB_STATUSES.map((s) => ({ ...s }));
    },

    async listTasks(http, target) {
      const out: RemoteTask[] = [];
      for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
        let link: string | null = null;
        const items = arr(
          await call(http, `/repos/${repoPath(target)}/issues?state=all&per_page=${PER_PAGE}&page=${page}&sort=updated&direction=desc`, undefined, (h) => (link = h.get('link')))
        );
        for (const item of items) {
          const parsed = parseGithubIssue(item);
          if (parsed) out.push(parsed);
        }
        if (!hasNextPage(link, items.length)) break;
      }
      return out;
    },

    getTask,

    async createTask(http, target, task) {
      // Подзадач у REST-модели issues нет: родитель не переносится (decision-106 п. 4).
      const created = parseGithubIssue(
        await call(http, `/repos/${repoPath(target)}/issues`, { method: 'POST', body: JSON.stringify({ title: task.title, body: task.description }) })
      );
      if (!created) throw new TrackerHttpError(0, 'invalid_response', 'GitHub вернул issue без номера');
      if (task.status === 'closed') {
        const { repo, number } = splitId(created.id);
        return patch(http, `/repos/${repo}/issues/${number}`, { state: 'closed' });
      }
      return created;
    },

    async updateTask(http, id, fields) {
      const { repo, number } = splitId(id);
      const body: Record<string, unknown> = {};
      if (fields.title !== undefined) body.title = fields.title;
      if (fields.description !== undefined) body.body = fields.description;
      if (fields.status !== undefined) {
        if (fields.status !== 'open' && fields.status !== 'closed') throw new TrackerHttpError(0, 'unknown_status', `У GitHub нет статуса «${fields.status}»`);
        body.state = fields.status;
      }
      return patch(http, `/repos/${repo}/issues/${number}`, body);
    },

    linkFor: (id: string, ctx?: TrackerLinkContext) => {
      const m = ID_RE.exec(id);
      if (!m) return ctx?.url ?? id;
      return `${trimBase(ctx?.webBase || 'https://github.com')}/${m[1]}/${m[2]}/issues/${m[3]}`;
    },

    parseLink: (reference: string, ctx?: TrackerLinkContext) => {
      const m = LINK_RE.exec(reference.trim());
      if (!m) return null;
      // Ссылки Gitea выглядят так же: принимаются только ссылки хоста подключения.
      if (trimBase(m[1]).toLowerCase() !== trimBase(ctx?.webBase || 'https://github.com').toLowerCase()) return null;
      return `${m[2]}/${m[3]}#${m[4]}`;
    }
  };
}
