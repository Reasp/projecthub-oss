import type { RemoteStatus, RemoteTask, TrackerTarget } from './trackerTypes.js';
import { AppError } from '../../src/lib/appError.js';
import {
  arr,
  MAX_RATE_WAIT_MS,
  obj,
  parseTime,
  rateLimitWaitMs,
  text,
  TrackerHttpError,
  type TrackerAdapter,
  type TrackerCallOptions,
  type TrackerHttp,
  type TrackerLinkContext
} from './trackerAdapter.js';

/**
 * Адаптер Linear, GraphQL API (TASK-129, decision-106). Цель — команда (team), статусы — её workflow states,
 * id задачи — идентификатор (`ENG-12`): Linear принимает его в `issue(id:)` наравне с UUID.
 */

const PAGE = 100;
const MAX_PAGES = 50;
const LINK_RE = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/?#]*)?\/?$/;

const ISSUE_FIELDS = 'id identifier title description url updatedAt parent { identifier } state { id name type } team { id }';

/** Тип состояния Linear → тип статуса синка: `completed` — `done`, `canceled` — `closed`, начальные — `open`. */
export function linearStatusType(type: string): string {
  if (type === 'completed') return 'done';
  if (type === 'canceled') return 'closed';
  if (type === 'backlog' || type === 'unstarted' || type === 'triage') return 'open';
  return 'custom';
}

export function parseLinearIssue(json: unknown): RemoteTask | null {
  const i = obj(json);
  const id = text(i.identifier);
  if (!id) return null;
  const state = obj(i.state);
  const parent = text(obj(i.parent).identifier);
  return {
    id,
    title: text(i.title),
    description: text(i.description),
    status: text(state.name),
    statusType: linearStatusType(text(state.type)),
    updatedAt: parseTime(i.updatedAt),
    url: text(i.url),
    ...(parent ? { parentId: parent } : {})
  };
}

export function createLinearAdapter(options: TrackerCallOptions = {}): TrackerAdapter {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? 2;

  /** GraphQL-запрос. Лимит Linear — 429 или ошибка `RATELIMITED`; ждём сброса, но не дольше минуты. */
  async function gql(http: TrackerHttp, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await http('/graphql', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      const body = await res.text();
      let json: Record<string, unknown>;
      try {
        json = obj(body ? JSON.parse(body) : null);
      } catch {
        json = {};
      }
      const first = obj(arr(json.errors)[0]);
      const code = text(obj(first.extensions).code);
      const limited = rateLimitWaitMs(res, now()) !== null || code === 'RATELIMITED';
      if (limited && attempt < maxRetries) {
        const reset = Number(res.headers.get('x-ratelimit-requests-reset'));
        const wait = Number.isFinite(reset) && reset > 0 ? reset - now() : (rateLimitWaitMs(res, now()) ?? 1000);
        await sleep(Math.min(Math.max(wait, 1000), MAX_RATE_WAIT_MS));
        continue;
      }
      if (!res.ok || (arr(json.errors).length && !json.data)) {
        throw new TrackerHttpError(res.status, code || `http_${res.status}`, text(first.message) || new AppError('tracker.httpStatus', { service: 'Linear', status: res.status }));
      }
      return obj(json.data);
    }
  }

  /** Состояния команды: id по имени нужен для смены статуса. */
  async function teamStates(http: TrackerHttp, teamId: string): Promise<Array<{ id: string; name: string; type: string; position: number }>> {
    const data = await gql(http, 'query($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }', { id: teamId });
    return arr(obj(obj(data.team).states).nodes)
      .map(obj)
      .map((s) => ({ id: text(s.id), name: text(s.name), type: text(s.type), position: Number(s.position) || 0 }))
      .filter((s) => s.id && s.name)
      .sort((a, b) => a.position - b.position);
  }

  async function stateId(http: TrackerHttp, teamId: string, status: string): Promise<string> {
    const found = (await teamStates(http, teamId)).find((s) => s.name.toLowerCase() === status.toLowerCase());
    if (!found) throw new TrackerHttpError(0, 'unknown_status', new AppError('tracker.linearUnknownStatus', { status }));
    return found.id;
  }

  async function rawIssue(http: TrackerHttp, id: string): Promise<Record<string, unknown> | null> {
    try {
      const issue = (await gql(http, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id })).issue;
      return issue ? obj(issue) : null;
    } catch (err) {
      if (err instanceof TrackerHttpError && /not found/i.test(err.message)) return null;
      throw err;
    }
  }

  const getTask = async (http: TrackerHttp, id: string) => {
    const raw = await rawIssue(http, id);
    return raw ? parseLinearIssue(raw) : null;
  };

  const mutated = (data: Record<string, unknown>, key: string): RemoteTask => {
    const payload = obj(data[key]);
    const parsed = payload.success === false ? null : parseLinearIssue(payload.issue);
    if (!parsed) throw new TrackerHttpError(0, 'invalid_response', new AppError('tracker.noTask', { service: 'Linear' }));
    return parsed;
  };

  return {
    id: 'linear',
    label: 'Linear',
    serviceId: 'linear',

    async listTargets(http) {
      const data = await gql(http, 'query { organization { name } teams(first: 100) { nodes { id key name } } }');
      const targets: TrackerTarget[] = arr(obj(data.teams).nodes)
        .map(obj)
        .map((t) => ({ id: text(t.id), name: `${text(t.key)} · ${text(t.name)}` }))
        .filter((t) => t.id);
      return [{ id: 'linear', name: text(obj(data.organization).name) || 'Linear', targets }];
    },

    async getStatuses(http, target): Promise<RemoteStatus[]> {
      return (await teamStates(http, target.id)).map((s) => ({ name: s.name, type: linearStatusType(s.type) }));
    },

    async listTasks(http, target) {
      const out: RemoteTask[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data = await gql(
          http,
          `query($id: String!, $after: String) { team(id: $id) { issues(first: ${PAGE}, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
          { id: target.id, after }
        );
        const issues = obj(obj(data.team).issues);
        for (const node of arr(issues.nodes)) {
          const parsed = parseLinearIssue(node);
          if (parsed) out.push(parsed);
        }
        const info = obj(issues.pageInfo);
        if (info.hasNextPage !== true || !text(info.endCursor)) break;
        after = text(info.endCursor);
      }
      return out;
    },

    getTask,

    async createTask(http, target, task) {
      const input: Record<string, unknown> = { teamId: target.id, title: task.title, description: task.description };
      if (task.status) input.stateId = await stateId(http, target.id, task.status);
      if (task.parentId) {
        const parent = await rawIssue(http, task.parentId);
        if (parent) input.parentId = text(parent.id);
      }
      return mutated(await gql(http, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { input }), 'issueCreate');
    },

    async updateTask(http, id, fields) {
      const input: Record<string, unknown> = {};
      if (fields.title !== undefined) input.title = fields.title;
      if (fields.description !== undefined) input.description = fields.description;
      if (fields.status !== undefined) {
        const raw = await rawIssue(http, id);
        if (!raw) throw new TrackerHttpError(404, 'not_found', new AppError('tracker.taskNotFoundIn', { service: 'Linear', id }));
        input.stateId = await stateId(http, text(obj(raw.team).id), fields.status);
      }
      return mutated(
        await gql(http, `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { id, input }),
        'issueUpdate'
      );
    },

    // Рабочее пространство есть только в адресе задачи от Linear: без него ссылка не строится.
    linkFor: (id: string, ctx?: TrackerLinkContext) => {
      const m = ctx?.url ? LINK_RE.exec(ctx.url) : null;
      return m ? `https://linear.app/${m[1]}/issue/${id}` : (ctx?.url ?? `https://linear.app/issue/${id}`);
    },

    parseLink: (reference: string) => {
      const m = LINK_RE.exec(reference.trim());
      return m ? m[2].toUpperCase() : null;
    }
  };
}
