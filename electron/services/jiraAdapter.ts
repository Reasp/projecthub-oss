import type { RemoteStatus, RemoteTask, TrackerTarget } from './trackerTypes.js';
import { AppError } from '../../src/lib/appError.js';
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
 * Адаптер Jira, REST API v2 (TASK-129, decision-106): Jira Cloud и Server/Data Center одним кодом.
 * Цель — проект (ключ), id задачи — ключ (`PROJ-12`). Статус меняется переходом (transition), а не полем.
 * Описание v2 — строка в разметке Jira (wiki markup): переносится как текст, без перевода в Markdown.
 */

const PAGE = 100;
const MAX_TASKS = 5000;
const FIELDS = 'summary,description,status,updated,parent';
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const LINK_RE = /^(https?:\/\/.+?)\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/;

/** Категория статуса Jira → тип статуса синка. */
export function jiraStatusType(categoryKey: string): string {
  if (categoryKey === 'done') return 'done';
  if (categoryKey === 'new') return 'open';
  return 'custom';
}

/** База сайта из `self` задачи: `https://acme.atlassian.net/rest/api/2/issue/10001` → `https://acme.atlassian.net`. */
function siteOf(self: string): string {
  const at = self.indexOf('/rest/api/');
  return at > 0 ? self.slice(0, at) : '';
}

export function parseJiraIssue(json: unknown): RemoteTask | null {
  const i = obj(json);
  const key = text(i.key);
  if (!KEY_RE.test(key)) return null;
  const f = obj(i.fields);
  const status = obj(f.status);
  const parent = text(obj(f.parent).key);
  const site = siteOf(text(i.self));
  return {
    id: key,
    title: text(f.summary),
    // В v3 описание — документ ADF (объект); строкой оно приходит только из v2.
    description: typeof f.description === 'string' ? f.description : '',
    status: text(status.name),
    statusType: jiraStatusType(text(obj(status.statusCategory).key)),
    updatedAt: parseTime(f.updated),
    url: site ? `${site}/browse/${key}` : '',
    ...(parent ? { parentId: parent } : {})
  };
}

/** Сообщение Jira: `errorMessages` и `errors` по полям. */
function describe(json: unknown): { code?: string; message?: string } {
  const o = obj(json);
  const messages = [...arr(o.errorMessages).map(text), ...Object.entries(obj(o.errors)).map(([k, v]) => `${k}: ${text(v)}`)].filter(Boolean);
  return { message: messages.join('; ') || text(o.message) };
}

export function createJiraAdapter(options: TrackerCallOptions = {}): TrackerAdapter {
  const call = (http: TrackerHttp, path: string, init?: RequestInit) => callTrackerJson(http, path, init, { ...options, label: 'Jira', describe });

  const getTask = async (http: TrackerHttp, id: string): Promise<RemoteTask | null> => {
    try {
      return parseJiraIssue(await call(http, `/rest/api/2/issue/${encodeURIComponent(id)}?fields=${FIELDS}`));
    } catch (err) {
      if (err instanceof TrackerHttpError && err.status === 404) return null;
      throw err;
    }
  };

  /** Сменить статус переходом, ведущим в него. Нет такого перехода из текущего статуса — ошибка с объяснением. */
  async function transition(http: TrackerHttp, key: string, status: string): Promise<void> {
    const json = obj(await call(http, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`));
    const all = arr(json.transitions).map(obj);
    const found = all.find((t) => text(obj(t.to).name).toLowerCase() === status.toLowerCase());
    if (!found) {
      throw new TrackerHttpError(0, 'no_transition', new AppError('tracker.jiraNoTransition', { key, status }));
    }
    await call(http, `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: text(found.id) } }) });
  }

  /** Тип задачи для создания: подзадача — тип с `subtask`, иначе «Task», иначе первый обычный. */
  async function issueTypeFor(http: TrackerHttp, projectKey: string, subtask: boolean): Promise<string> {
    const types = arr(obj(await call(http, `/rest/api/2/project/${encodeURIComponent(projectKey)}`)).issueTypes).map(obj);
    const pool = types.filter((t) => (t.subtask === true) === subtask);
    const chosen = (subtask ? pool[0] : (pool.find((t) => /^(task|задача)$/i.test(text(t.name))) ?? pool[0])) ?? undefined;
    if (!chosen) throw new TrackerHttpError(0, 'no_issue_type', new AppError(subtask ? 'tracker.jiraNoSubtaskType' : 'tracker.jiraNoTaskType', { project: projectKey }));
    return text(chosen.id);
  }

  /** Поиск задач проекта: новый `/search/jql` (Cloud), на Server/DC — прежний `/search`. */
  async function search(http: TrackerHttp, jql: string): Promise<unknown[]> {
    const q = encodeURIComponent(jql);
    const out: unknown[] = [];
    try {
      let token = '';
      while (out.length < MAX_TASKS) {
        const json = obj(await call(http, `/rest/api/2/search/jql?jql=${q}&fields=${FIELDS}&maxResults=${PAGE}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`));
        out.push(...arr(json.issues));
        token = text(json.nextPageToken);
        if (!token || json.isLast === true) break;
      }
      return out;
    } catch (err) {
      if (!(err instanceof TrackerHttpError) || (err.status !== 404 && err.status !== 405) || out.length) throw err;
    }
    // Сервер может урезать `maxResults`: следующая страница начинается после полученных задач.
    while (out.length < MAX_TASKS) {
      const json = obj(await call(http, `/rest/api/2/search?jql=${q}&fields=${FIELDS}&maxResults=${PAGE}&startAt=${out.length}`));
      const issues = arr(json.issues);
      out.push(...issues);
      const total = Number(json.total);
      if (!issues.length || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }

  return {
    id: 'jira',
    label: 'Jira',
    serviceId: 'jira',

    async listTargets(http) {
      let projects: Record<string, unknown>[] = [];
      try {
        for (let startAt = 0; startAt < 1000; startAt += 50) {
          const json = obj(await call(http, `/rest/api/2/project/search?maxResults=50&startAt=${startAt}`));
          const values = arr(json.values).map(obj);
          projects.push(...values);
          if (json.isLast !== false || !values.length) break;
        }
      } catch (err) {
        // Server/DC: постраничного поиска проектов нет, список целиком.
        if (!(err instanceof TrackerHttpError) || err.status !== 404) throw err;
        projects = arr(await call(http, '/rest/api/2/project')).map(obj);
      }
      const targets: TrackerTarget[] = projects
        .map((p) => ({ id: text(p.key), name: `${text(p.key)} · ${text(p.name)}` }))
        .filter((t) => t.id);
      return [{ id: 'jira', name: 'Jira', targets }];
    },

    async getStatuses(http, target): Promise<RemoteStatus[]> {
      const byType = arr(await call(http, `/rest/api/2/project/${encodeURIComponent(target.id)}/statuses`)).map(obj);
      const seen = new Map<string, RemoteStatus>();
      for (const issueType of byType) {
        for (const s of arr(issueType.statuses).map(obj)) {
          const name = text(s.name);
          if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, type: jiraStatusType(text(obj(s.statusCategory).key)) });
        }
      }
      // Порядок: новые, в работе, завершённые — как колонки доски.
      const rank = (t: string) => (t === 'open' ? 0 : t === 'custom' ? 1 : 2);
      return [...seen.values()].sort((a, b) => rank(a.type) - rank(b.type));
    },

    async listTasks(http, target) {
      const issues = await search(http, `project = "${target.id.replace(/"/g, '')}" ORDER BY updated DESC`);
      return issues.map(parseJiraIssue).filter((t): t is RemoteTask => Boolean(t));
    },

    getTask,

    async createTask(http, target, task) {
      const fields: Record<string, unknown> = {
        project: { key: target.id },
        summary: task.title,
        description: task.description,
        issuetype: { id: await issueTypeFor(http, target.id, Boolean(task.parentId)) }
      };
      if (task.parentId) fields.parent = { key: task.parentId };
      const created = obj(await call(http, '/rest/api/2/issue', { method: 'POST', body: JSON.stringify({ fields }) }));
      const key = text(created.key);
      if (!key) throw new TrackerHttpError(0, 'invalid_response', new AppError('tracker.jiraNoKey'));
      let fresh = await getTask(http, key);
      if (task.status && fresh && fresh.status.toLowerCase() !== task.status.toLowerCase()) {
        await transition(http, key, task.status);
        fresh = await getTask(http, key);
      }
      if (!fresh) throw new TrackerHttpError(0, 'invalid_response', new AppError('tracker.jiraCreatedMissing', { key }));
      return fresh;
    },

    async updateTask(http, id, fields) {
      const update: Record<string, unknown> = {};
      if (fields.title !== undefined) update.summary = fields.title;
      if (fields.description !== undefined) update.description = fields.description;
      if (Object.keys(update).length) {
        await call(http, `/rest/api/2/issue/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ fields: update }) });
      }
      if (fields.status !== undefined) await transition(http, id, fields.status);
      const fresh = await getTask(http, id);
      if (!fresh) throw new TrackerHttpError(404, 'not_found', new AppError('tracker.taskNotFoundIn', { service: 'Jira', id }));
      return fresh;
    },

    linkFor: (id: string, ctx?: TrackerLinkContext) => (ctx?.webBase ? `${trimBase(ctx.webBase)}/browse/${id}` : (ctx?.url ?? id)),

    parseLink: (reference: string, ctx?: TrackerLinkContext) => {
      const m = LINK_RE.exec(reference.trim());
      if (!m || !ctx?.webBase) return null;
      return trimBase(m[1]).toLowerCase() === trimBase(ctx.webBase).toLowerCase() ? m[2] : null;
    }
  };
}
