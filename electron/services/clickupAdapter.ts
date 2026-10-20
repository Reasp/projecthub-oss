import type { FieldValues, RemoteStatus, RemoteTask, TrackerTarget, TrackerTargetGroup } from './trackerTypes.js';

/**
 * Модель адаптеров трекеров (TASK-128, decision-103 п. 1) и первый адаптер — ClickUp API v2.
 * Сеть адаптер получает функцией `http` поверх подключения (decision-102 п. 7) и токенов не видит.
 */

export type TrackerHttp = (path: string, init?: RequestInit) => Promise<Response>;

export interface NewRemoteTask {
  title: string;
  description: string;
  status?: string;
  parentId?: string;
}

export interface TrackerAdapter {
  id: string;
  label: string;
  /** Сервис слоя подключений (decision-102). */
  serviceId: string;
  listTargets(http: TrackerHttp): Promise<TrackerTargetGroup[]>;
  getStatuses(http: TrackerHttp, target: TrackerTarget): Promise<RemoteStatus[]>;
  listTasks(http: TrackerHttp, target: TrackerTarget): Promise<RemoteTask[]>;
  getTask(http: TrackerHttp, id: string): Promise<RemoteTask | null>;
  createTask(http: TrackerHttp, target: TrackerTarget, task: NewRemoteTask): Promise<RemoteTask>;
  updateTask(http: TrackerHttp, id: string, fields: Partial<FieldValues>): Promise<RemoteTask>;
  /** Ссылка для `references` задачи (decision-103 п. 2). */
  linkFor(id: string): string;
  /** id внешней задачи из ссылки; `null` — ссылка не этого адаптера. */
  parseLink(reference: string): string | null;
}

export class TrackerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'TrackerHttpError';
  }
}

export interface ClickUpAdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Сколько раз повторять ответ 429. */
  maxRetries?: number;
}

const MAX_RATE_WAIT_MS = 60_000;
const PAGE_LIMIT = 100;
const LINK_RE = /^https?:\/\/app\.clickup\.com\/t\/([A-Za-z0-9]+)\/?$/;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** Статусы списка ClickUp по порядку отображения. */
export function parseClickUpStatuses(json: unknown): RemoteStatus[] {
  return arr(obj(json).statuses)
    .map((s) => obj(s))
    .sort((a, b) => Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0))
    .map((s) => ({ name: text(s.status), type: text(s.type) || 'custom' }))
    .filter((s) => s.name);
}

/** Задача ClickUp → общий вид. Описание — Markdown, если ClickUp его отдал (`include_markdown_description`). */
export function parseClickUpTask(json: unknown): RemoteTask | null {
  const t = obj(json);
  const id = text(t.id);
  if (!id) return null;
  const status = obj(t.status);
  const markdown = typeof t.markdown_description === 'string' ? t.markdown_description : null;
  const parent = text(t.parent);
  return {
    id,
    title: text(t.name),
    description: markdown ?? text(t.description),
    status: text(status.status),
    statusType: text(status.type) || 'custom',
    updatedAt: Number(t.date_updated) || 0,
    url: text(t.url) || `https://app.clickup.com/t/${id}`,
    ...(parent ? { parentId: parent } : {})
  };
}

export function createClickUpAdapter(options: ClickUpAdapterOptions = {}): TrackerAdapter {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const maxRetries = options.maxRetries ?? 2;

  /** Запрос с ожиданием `X-RateLimit-Reset` на 429 (decision-103 п. 7) и разбором ошибки ClickUp `{err, ECODE}`. */
  async function call(http: TrackerHttp, path: string, init?: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await http(path, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }
      });
      if (res.status === 429 && attempt < maxRetries) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const wait = Number.isFinite(reset) && reset > 0 ? reset * 1000 - now() : 1000;
        await sleep(Math.min(Math.max(wait, 1000), MAX_RATE_WAIT_MS));
        continue;
      }
      const body = await res.text();
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const o = obj(json);
        const code = text(o.ECODE) || `http_${res.status}`;
        throw new TrackerHttpError(res.status, code, text(o.err) || `ClickUp ответил ${res.status}`);
      }
      return json;
    }
  }

  const getTask = async (http: TrackerHttp, id: string): Promise<RemoteTask | null> => {
    try {
      return parseClickUpTask(await call(http, `/task/${encodeURIComponent(id)}?include_markdown_description=true`));
    } catch (err) {
      if (err instanceof TrackerHttpError && (err.status === 404 || err.code === 'ITEM_013')) return null;
      throw err;
    }
  };

  /** После записи читаем задачу заново: база берёт то, что хранит ClickUp (decision-103 п. 5). */
  const reread = async (http: TrackerHttp, json: unknown): Promise<RemoteTask> => {
    const parsed = parseClickUpTask(json);
    if (!parsed) throw new TrackerHttpError(0, 'invalid_response', 'ClickUp вернул задачу без id');
    return (await getTask(http, parsed.id)) ?? parsed;
  };

  return {
    id: 'clickup',
    label: 'ClickUp',
    serviceId: 'clickup',

    async listTargets(http) {
      const groups: TrackerTargetGroup[] = [];
      for (const team of arr(obj(await call(http, '/team')).teams).map(obj)) {
        const teamName = text(team.name);
        const targets: TrackerTarget[] = [];
        const spaces = arr(obj(await call(http, `/team/${encodeURIComponent(text(team.id))}/space?archived=false`)).spaces).map(obj);
        for (const space of spaces) {
          const spaceId = encodeURIComponent(text(space.id));
          const spaceName = text(space.name);
          const folders = arr(obj(await call(http, `/space/${spaceId}/folder?archived=false`)).folders).map(obj);
          for (const folder of folders) {
            for (const list of arr(folder.lists).map(obj)) {
              targets.push({ id: text(list.id), name: text(list.name), path: `${spaceName} / ${text(folder.name)}` });
            }
          }
          for (const list of arr(obj(await call(http, `/space/${spaceId}/list?archived=false`)).lists).map(obj)) {
            targets.push({ id: text(list.id), name: text(list.name), path: spaceName });
          }
        }
        groups.push({ id: text(team.id), name: teamName, targets: targets.filter((t) => t.id) });
      }
      return groups;
    },

    async getStatuses(http, target) {
      return parseClickUpStatuses(await call(http, `/list/${encodeURIComponent(target.id)}`));
    },

    async listTasks(http, target) {
      const out: RemoteTask[] = [];
      for (let page = 0; page < 1000; page += 1) {
        const json = obj(
          await call(
            http,
            `/list/${encodeURIComponent(target.id)}/task?page=${page}&include_closed=true&subtasks=true&include_markdown_description=true`
          )
        );
        const tasks = arr(json.tasks);
        for (const t of tasks) {
          const parsed = parseClickUpTask(t);
          if (parsed) out.push(parsed);
        }
        // `last_page` надёжнее размера страницы; без него — короткая страница считается последней.
        const last = typeof json.last_page === 'boolean' ? json.last_page : tasks.length < PAGE_LIMIT;
        if (last || tasks.length === 0) break;
      }
      return out;
    },

    getTask,

    async createTask(http, target, task) {
      const body: Record<string, unknown> = { name: task.title, markdown_content: task.description || ' ' };
      if (task.status) body.status = task.status;
      if (task.parentId) body.parent = task.parentId;
      return reread(http, await call(http, `/list/${encodeURIComponent(target.id)}/task`, { method: 'POST', body: JSON.stringify(body) }));
    },

    async updateTask(http, id, fields) {
      const body: Record<string, unknown> = {};
      if (fields.title !== undefined) body.name = fields.title;
      // Пустое описание ClickUp очищает только пробелом.
      if (fields.description !== undefined) {
        if (fields.description.trim()) body.markdown_content = fields.description;
        else body.description = ' ';
      }
      if (fields.status !== undefined) body.status = fields.status;
      return reread(http, await call(http, `/task/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }));
    },

    linkFor: (id) => `https://app.clickup.com/t/${id}`,
    parseLink: (reference) => LINK_RE.exec(reference.trim())?.[1] ?? null
  };
}

export const TRACKER_ADAPTERS: readonly TrackerAdapter[] = [createClickUpAdapter()];

export function findTrackerAdapter(id: string, adapters: readonly TrackerAdapter[] = TRACKER_ADAPTERS): TrackerAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
