import type { PRCreateOptions, PullRequest } from '../../src/types/electron';
import type { PrInfo } from './prSnapshot.js';

/**
 * Pull/merge requests через REST и GraphQL хостингов (TASK-138.2, decision-105): разбор адреса remote,
 * запросы и разбор ответов GitHub, GitLab, Gitea/Forgejo и Bitbucket Cloud. Чистый модуль: сеть адаптер
 * получает функцией `http` поверх подключения (decision-102 п. 7) и токенов не видит.
 */

export type PrHostingId = 'github' | 'gitlab' | 'gitea' | 'bitbucket';
export type PrHttp = (target: string, init?: RequestInit) => Promise<Response>;
export type PrListState = 'all' | 'open' | 'closed' | 'merged';

export const PR_LIST_LIMIT = 30;
const MAX_DIFF_PAGES = 20;

/** Репозиторий на хостинге подключения. */
export interface RepoRef {
  /** Путь на хостинге: `owner/repo`, `group/sub/repo`, `workspace/slug`. */
  path: string;
  /** Адрес веб-интерфейса — база подключения. */
  webBase: string;
  /** Адрес API подключения. */
  apiBase: string;
}

export interface PrHostingAdapter {
  id: PrHostingId;
  label: string;
  /** Сервис слоя подключений (decision-102). */
  serviceId: string;
  list(http: PrHttp, repo: RepoRef, state: PrListState): Promise<PullRequest[]>;
  get(http: PrHttp, repo: RepoRef, number: number): Promise<PullRequest>;
  diff(http: PrHttp, repo: RepoRef, number: number): Promise<string>;
  create(http: PrHttp, repo: RepoRef, options: PRCreateOptions): Promise<PullRequest>;
  /** Комментарий к PR; возвращает его адрес. */
  comment(http: PrHttp, repo: RepoRef, number: number, body: string): Promise<string>;
  /** Refspec для `git fetch origin`, который кладёт голову PR в `localRef`; `null` — голову так не получить. */
  headRefspec(pr: PullRequest, localRef: string): string | null;
}

export class PrHostingError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'PrHostingError';
  }
}

// ─────────────────────────── Адрес remote ───────────────────────────

export interface GitRemote {
  /** Имя хоста без порта, в нижнем регистре: порт SSH не совпадает с портом веб-интерфейса. */
  hostname: string;
  /** Путь репозитория без `.git` и крайних `/`. */
  path: string;
}

/** Хосты SSH через 443, которые указывают на тот же сервис. */
const SSH_HOST_ALIASES: Record<string, string> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
  'altssh.bitbucket.org': 'bitbucket.org'
};

/** Облачные хостинги по имени хоста; self-hosted определяются по подключениям. */
const CLOUD_HOSTINGS: Record<string, PrHostingId> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'codeberg.org': 'gitea'
};

/**
 * Разбор адреса remote: `https://host/owner/repo.git`, `ssh://git@host:2222/owner/repo.git`,
 * `git@host:owner/repo.git`. Локальные пути и адреса без пути репозитория — `null`.
 */
export function parseGitRemote(url: string | undefined | null): GitRemote | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  let hostname: string;
  let repoPath: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(u.protocol)) return null;
    hostname = u.hostname;
    repoPath = decodeURIComponent(u.pathname);
  } else {
    // scp-подобная запись `[user@]host:path`; однобуквенный «хост» — это диск Windows (`C:\repo`).
    const m = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(raw);
    if (!m) return null;
    hostname = m[1];
    repoPath = m[2];
  }
  hostname = hostname.toLowerCase();
  hostname = SSH_HOST_ALIASES[hostname] ?? hostname;
  repoPath = repoPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!hostname || !repoPath.includes('/')) return null;
  return { hostname, path: repoPath };
}

export function cloudHostingOf(hostname: string): PrHostingId | null {
  return CLOUD_HOSTINGS[hostname.toLowerCase()] ?? null;
}

/** Путь репозитория относительно базы подключения: GitLab под `/gitlab` даёт в HTTPS-адресе лишний префикс. */
export function repoPathFor(remote: GitRemote, baseUrl: string): string {
  let basePath: string;
  try {
    basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    return remote.path;
  }
  if (basePath && remote.path.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) return remote.path.slice(basePath.length + 1);
  return remote.path;
}

/** Подключение подходит remote: тот же хост (без порта). */
export function connectionMatchesRemote(baseUrl: string, remote: GitRemote): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (SSH_HOST_ALIASES[host] ?? host) === remote.hostname;
  } catch {
    return false;
  }
}

/** Номер задачи Backlog.md в ветке или заголовке PR: `feat/task-8`, `TASK-8.2`, `task-12`. */
export function taskIdsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^a-z0-9])task-(\d+(?:\.\d+)*)/gi)) out.add(`TASK-${m[1]}`);
  return [...out];
}

export interface PrUrlRef {
  hostname: string;
  /** Путь до части PR; у GitLab под подкаталогом — вместе с ним. */
  repoPath: string;
  number: number;
}

/**
 * Адрес PR в веб-интерфейсе: `/pull/N` GitHub, `/-/merge_requests/N` GitLab, `/pulls/N` Gitea,
 * `/pull-requests/N` Bitbucket. Остальное (задача трекера, файл) — `null`.
 */
export function parsePrUrl(url: string): PrUrlRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = /^\/(.+?)\/(?:pull|pulls|pull-requests|-\/merge_requests)\/(\d+)(?:\/.*)?$/.exec(u.pathname);
  if (!m) return null;
  const number = Number.parseInt(m[2], 10);
  return number > 0 ? { hostname: u.hostname.toLowerCase(), repoPath: m[1], number } : null;
}

/** Ссылка на PR относится к репозиторию remote. */
export function prUrlInRepo(ref: PrUrlRef, remote: GitRemote, repoPath: string): boolean {
  if (ref.hostname !== remote.hostname) return false;
  const a = ref.repoPath.toLowerCase();
  const b = repoPath.toLowerCase();
  return a === b || a.endsWith(`/${b}`);
}

/** Снимок для опроса `prWatcher` (decision-53 п. 1). PR без головы пропускается. */
export function prInfoFrom(pr: PullRequest): PrInfo | null {
  if (!pr.headSha) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headSha: pr.headSha,
    headRef: pr.sourceBranch,
    baseRef: pr.targetBranch,
    draft: pr.draft === true,
    ...(pr.author && pr.author !== 'unknown' ? { author: pr.author } : {})
  };
}

// ─────────────────────────── Общие помощники ───────────────────────────

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

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(text(v), 10);
  return Number.isInteger(n) ? n : 0;
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Сообщение ошибки из тела ответа: `message` GitHub, GitLab и Gitea, `error.message` Bitbucket. */
export function describeHttpError(status: number, body: string): string {
  let detail = '';
  try {
    const j = obj(JSON.parse(body));
    const m = j.message ?? obj(j.error).message ?? j.error ?? j.error_description;
    detail = Array.isArray(m) ? m.map(text).join('; ') : typeof m === 'object' ? JSON.stringify(m) : text(m);
  } catch {
    // тело без JSON в ошибку не идёт: в нём может быть HTML страницы входа
  }
  return clip(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
}

async function call(http: PrHttp, target: string, init?: RequestInit): Promise<Response> {
  const res = await http(target, init);
  if (!res.ok) throw new PrHostingError(res.status, describeHttpError(res.status, await res.text().catch(() => '')));
  return res;
}

async function getJson(http: PrHttp, target: string, init?: RequestInit): Promise<unknown> {
  const body = await (await call(http, target, init)).text();
  return body ? JSON.parse(body) : null;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getText(http: PrHttp, target: string, accept: string): Promise<string> {
  return (await call(http, target, { headers: { Accept: accept } })).text();
}

function enc(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function ownerName(repo: RepoRef): { owner: string; name: string } {
  const at = repo.path.indexOf('/');
  return { owner: repo.path.slice(0, at), name: repo.path.slice(at + 1) };
}

// ─────────────────────────── GitHub ───────────────────────────

const GH_PR_FIELDS = `number title state url isDraft body createdAt updatedAt headRefName headRefOid baseRefName isCrossRepository
  author { login } labels(first: 20) { nodes { name } } comments { totalCount } reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const GH_LIST_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${GH_PR_FIELDS} } }
  }
}`;

const GH_GET_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${GH_PR_FIELDS} } }
}`;

/** GraphQL GitHub: `api.github.com/graphql`, у GitHub Enterprise — `<host>/api/graphql`. */
export function githubGraphqlUrl(apiBase: string): string {
  return /\/api\/v3$/.test(apiBase) ? apiBase.replace(/\/v3$/, '/graphql') : `${apiBase}/graphql`;
}

function githubChecks(state: string): PullRequest['checksStatus'] {
  if (state === 'SUCCESS') return 'SUCCESS';
  if (state === 'FAILURE' || state === 'ERROR') return 'FAILURE';
  if (state === 'PENDING' || state === 'EXPECTED') return 'PENDING';
  return 'NONE';
}

/** Узел `PullRequest` GraphQL GitHub → общий вид. */
export function parseGithubPrNode(node: unknown): PullRequest | null {
  const n = obj(node);
  const number = num(n.number);
  if (number <= 0) return null;
  const state = text(n.state);
  const rollup = text(obj(obj(obj(arr(obj(n.commits).nodes)[0]).commit).statusCheckRollup).state);
  const review = text(n.reviewDecision);
  return {
    id: number,
    number,
    title: text(n.title) || `#${number}`,
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    url: text(n.url),
    author: text(obj(n.author).login) || 'unknown',
    createdAt: text(n.createdAt),
    updatedAt: text(n.updatedAt),
    sourceBranch: text(n.headRefName),
    targetBranch: text(n.baseRefName) || 'main',
    body: text(n.body),
    labels: arr(obj(n.labels).nodes).map((l) => text(obj(l).name)).filter(Boolean),
    checksStatus: githubChecks(rollup),
    provider: 'github',
    commentsCount: num(obj(n.comments).totalCount),
    draft: n.isDraft === true,
    headSha: text(n.headRefOid) || undefined,
    ...(review === 'APPROVED' || review === 'CHANGES_REQUESTED' || review === 'REVIEW_REQUIRED' ? { reviewDecision: review } : {}),
    fromFork: n.isCrossRepository === true
  };
}

/** PR из REST-ответа GitHub (создание): без проверок и решения ревью. */
export function parseGithubRestPr(json: unknown): PullRequest | null {
  const p = obj(json);
  const number = num(p.number);
  if (number <= 0) return null;
  return {
    id: number,
    number,
    title: text(p.title) || `#${number}`,
    state: p.merged_at ? 'MERGED' : text(p.state) === 'closed' ? 'CLOSED' : 'OPEN',
    url: text(p.html_url),
    author: text(obj(p.user).login) || 'unknown',
    createdAt: text(p.created_at),
    updatedAt: text(p.updated_at),
    sourceBranch: text(obj(p.head).ref),
    targetBranch: text(obj(p.base).ref) || 'main',
    body: text(p.body),
    labels: arr(p.labels).map((l) => text(obj(l).name)).filter(Boolean),
    checksStatus: 'NONE',
    provider: 'github',
    draft: p.draft === true,
    headSha: text(obj(p.head).sha) || undefined
  };
}

async function githubGraphql(http: PrHttp, repo: RepoRef, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const json = obj(await getJson(http, githubGraphqlUrl(repo.apiBase), jsonInit('POST', { query, variables })));
  const repository = obj(json.data).repository;
  // Частичный ответ (нет прав на проверки) принимается; без репозитория — ошибка.
  if (!repository) {
    const message = text(obj(arr(json.errors)[0]).message);
    throw new PrHostingError(200, clip(message || 'Репозиторий не найден или нет доступа'));
  }
  return obj(repository);
}

const GH_STATES: Record<PrListState, string[] | null> = { all: null, open: ['OPEN'], closed: ['CLOSED'], merged: ['MERGED'] };

export const githubPrAdapter: PrHostingAdapter = {
  id: 'github',
  label: 'GitHub',
  serviceId: 'github',
  async list(http, repo, state) {
    const r = await githubGraphql(http, repo, GH_LIST_QUERY, { ...ownerName(repo), states: GH_STATES[state], first: PR_LIST_LIMIT });
    return arr(obj(r.pullRequests).nodes).map(parseGithubPrNode).filter((p): p is PullRequest => Boolean(p));
  },
  async get(http, repo, number) {
    const r = await githubGraphql(http, repo, GH_GET_QUERY, { ...ownerName(repo), number });
    const pr = parseGithubPrNode(r.pullRequest);
    if (!pr) throw new PrHostingError(404, `PR #${number} не найден`);
    return pr;
  },
  diff(http, repo, number) {
    return getText(http, `/repos/${enc(repo.path)}/pulls/${number}`, 'application/vnd.github.diff');
  },
  async create(http, repo, options) {
    const base = options.targetBranch || text(obj(await getJson(http, `/repos/${enc(repo.path)}`)).default_branch) || 'main';
    const json = await getJson(
      http,
      `/repos/${enc(repo.path)}/pulls`,
      jsonInit('POST', { title: options.title, body: options.body, head: options.sourceBranch, base, draft: options.draft === true })
    );
    const pr = parseGithubRestPr(json);
    if (!pr) throw new PrHostingError(200, 'GitHub не вернул созданный PR');
    return pr;
  },
  async comment(http, repo, number, body) {
    return text(obj(await getJson(http, `/repos/${enc(repo.path)}/issues/${number}/comments`, jsonInit('POST', { body }))).html_url);
  },
  headRefspec: (pr, localRef) => `+refs/pull/${pr.number}/head:${localRef}`
};

// ─────────────────────────── GitLab ───────────────────────────

function gitlabChecks(status: string): PullRequest['checksStatus'] {
  if (status === 'success') return 'SUCCESS';
  if (status === 'failed') return 'FAILURE';
  if (['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled'].includes(status)) return 'PENDING';
  return 'NONE';
}

/** Merge request GitLab API v4 → общий вид. `head_pipeline` есть только в ответе на один MR. */
export function parseGitlabMr(json: unknown): PullRequest | null {
  const m = obj(json);
  const number = num(m.iid);
  if (number <= 0) return null;
  const state = text(m.state);
  return {
    id: number,
    number,
    title: text(m.title) || `!${number}`,
    // `locked` — MR в процессе слияния.
    state: state === 'merged' ? 'MERGED' : state === 'closed' ? 'CLOSED' : 'OPEN',
    url: text(m.web_url),
    author: text(obj(m.author).username) || 'unknown',
    createdAt: text(m.created_at),
    updatedAt: text(m.updated_at),
    sourceBranch: text(m.source_branch),
    targetBranch: text(m.target_branch) || 'main',
    body: text(m.description),
    labels: arr(m.labels).map((l) => (typeof l === 'string' ? l : text(obj(l).name))).filter(Boolean),
    checksStatus: gitlabChecks(text(obj(m.head_pipeline).status)),
    provider: 'gitlab',
    commentsCount: num(m.user_notes_count),
    draft: m.draft === true || m.work_in_progress === true,
    headSha: text(m.sha) || undefined,
    fromFork: m.source_project_id !== undefined && m.target_project_id !== undefined && m.source_project_id !== m.target_project_id
  };
}

/** Файлы `/merge_requests/:iid/diffs` → единый дифф с заголовками, как у `git diff`. */
export function gitlabDiffsToUnified(items: unknown[]): string {
  return items
    .map((item) => {
      const d = obj(item);
      const oldPath = text(d.old_path);
      const newPath = text(d.new_path) || oldPath;
      const head = [`diff --git a/${oldPath} b/${newPath}`];
      if (d.new_file === true) head.push('new file mode 100644');
      if (d.deleted_file === true) head.push('deleted file mode 100644');
      if (d.renamed_file === true) head.push(`rename from ${oldPath}`, `rename to ${newPath}`);
      head.push(`--- ${d.new_file === true ? '/dev/null' : `a/${oldPath}`}`, `+++ ${d.deleted_file === true ? '/dev/null' : `b/${newPath}`}`);
      const body = text(d.diff);
      return `${head.join('\n')}\n${body}${body.endsWith('\n') || !body ? '' : '\n'}`;
    })
    .join('');
}

const GL_STATES: Record<PrListState, string> = { all: 'all', open: 'opened', closed: 'closed', merged: 'merged' };

function gitlabProject(repo: RepoRef): string {
  return `/projects/${encodeURIComponent(repo.path)}`;
}

export const gitlabPrAdapter: PrHostingAdapter = {
  id: 'gitlab',
  label: 'GitLab',
  serviceId: 'gitlab',
  async list(http, repo, state) {
    const json = await getJson(http, `${gitlabProject(repo)}/merge_requests?state=${GL_STATES[state]}&order_by=updated_at&sort=desc&per_page=${PR_LIST_LIMIT}`);
    return arr(json).map(parseGitlabMr).filter((p): p is PullRequest => Boolean(p));
  },
  async get(http, repo, number) {
    const pr = parseGitlabMr(await getJson(http, `${gitlabProject(repo)}/merge_requests/${number}`));
    if (!pr) throw new PrHostingError(404, `MR !${number} не найден`);
    return pr;
  },
  async diff(http, repo, number) {
    const items: unknown[] = [];
    try {
      for (let page = 1; page <= MAX_DIFF_PAGES; page += 1) {
        const res = await call(http, `${gitlabProject(repo)}/merge_requests/${number}/diffs?per_page=50&page=${page}`);
        items.push(...arr(JSON.parse((await res.text()) || '[]')));
        const next = res.headers.get('x-next-page');
        if (!next) break;
      }
    } catch (err) {
      // `/diffs` появился в GitLab 15.7; у старых — `/changes`.
      if (!(err instanceof PrHostingError) || err.status !== 404 || items.length) throw err;
      const json = obj(await getJson(http, `${gitlabProject(repo)}/merge_requests/${number}/changes`));
      items.push(...arr(json.changes));
    }
    return gitlabDiffsToUnified(items);
  },
  async create(http, repo, options) {
    const target = options.targetBranch || text(obj(await getJson(http, gitlabProject(repo))).default_branch) || 'main';
    const pr = parseGitlabMr(
      await getJson(
        http,
        `${gitlabProject(repo)}/merge_requests`,
        jsonInit('POST', {
          source_branch: options.sourceBranch,
          target_branch: target,
          title: options.draft ? `Draft: ${options.title}` : options.title,
          description: options.body
        })
      )
    );
    if (!pr) throw new PrHostingError(200, 'GitLab не вернул созданный MR');
    return pr;
  },
  async comment(http, repo, number, body) {
    const note = obj(await getJson(http, `${gitlabProject(repo)}/merge_requests/${number}/notes`, jsonInit('POST', { body })));
    const id = text(note.id);
    return `${repo.webBase}/${repo.path}/-/merge_requests/${number}${id ? `#note_${id}` : ''}`;
  },
  headRefspec: (pr, localRef) => `+refs/merge-requests/${pr.number}/head:${localRef}`
};

// ─────────────────────────── Gitea / Forgejo ───────────────────────────

function giteaChecks(state: string): PullRequest['checksStatus'] {
  if (state === 'success' || state === 'warning') return 'SUCCESS';
  if (state === 'failure' || state === 'error') return 'FAILURE';
  if (state === 'pending') return 'PENDING';
  return 'NONE';
}

const WIP_TITLE = /^\s*(?:\[wip\]|wip:|draft:)/i;

/** PR Gitea/Forgejo API v1 → общий вид. */
export function parseGiteaPr(json: unknown): PullRequest | null {
  const p = obj(json);
  const number = num(p.number);
  if (number <= 0) return null;
  const title = text(p.title) || `#${number}`;
  const headRepo = text(obj(obj(p.head).repo).full_name).toLowerCase();
  const baseRepo = text(obj(obj(p.base).repo).full_name).toLowerCase();
  return {
    id: number,
    number,
    title,
    state: p.merged === true ? 'MERGED' : text(p.state) === 'closed' ? 'CLOSED' : 'OPEN',
    url: text(p.html_url),
    author: text(obj(p.user).login) || 'unknown',
    createdAt: text(p.created_at),
    updatedAt: text(p.updated_at),
    sourceBranch: text(obj(p.head).ref),
    targetBranch: text(obj(p.base).ref) || 'main',
    body: text(p.body),
    labels: arr(p.labels).map((l) => text(obj(l).name)).filter(Boolean),
    checksStatus: 'NONE',
    provider: 'gitea',
    commentsCount: num(p.comments),
    draft: p.draft === true || WIP_TITLE.test(title),
    headSha: text(obj(p.head).sha) || undefined,
    fromFork: Boolean(headRepo && baseRepo && headRepo !== baseRepo)
  };
}

export const giteaPrAdapter: PrHostingAdapter = {
  id: 'gitea',
  label: 'Gitea / Forgejo',
  serviceId: 'gitea',
  async list(http, repo, state) {
    const apiState = state === 'open' ? 'open' : state === 'all' ? 'all' : 'closed';
    const json = await getJson(http, `/repos/${enc(repo.path)}/pulls?state=${apiState}&sort=recentupdate&limit=${PR_LIST_LIMIT}`);
    const prs = arr(json).map(parseGiteaPr).filter((p): p is PullRequest => Boolean(p));
    // У Gitea нет фильтра «слит»: слитые и закрытые приходят вместе как `closed`.
    if (state === 'merged') return prs.filter((p) => p.state === 'MERGED');
    if (state === 'closed') return prs.filter((p) => p.state === 'CLOSED');
    return prs;
  },
  async get(http, repo, number) {
    const pr = parseGiteaPr(await getJson(http, `/repos/${enc(repo.path)}/pulls/${number}`));
    if (!pr) throw new PrHostingError(404, `PR #${number} не найден`);
    if (pr.headSha) {
      try {
        const status = obj(await getJson(http, `/repos/${enc(repo.path)}/commits/${encodeURIComponent(pr.headSha)}/status`));
        pr.checksStatus = arr(status.statuses).length ? giteaChecks(text(status.state)) : 'NONE';
      } catch {
        // статусы коммита — дополнение: без них PR всё равно показывается
      }
    }
    return pr;
  },
  diff(http, repo, number) {
    return getText(http, `/repos/${enc(repo.path)}/pulls/${number}.diff`, 'text/plain');
  },
  async create(http, repo, options) {
    const base = options.targetBranch || text(obj(await getJson(http, `/repos/${enc(repo.path)}`)).default_branch) || 'main';
    const pr = parseGiteaPr(
      await getJson(
        http,
        `/repos/${enc(repo.path)}/pulls`,
        jsonInit('POST', { head: options.sourceBranch, base, title: options.draft ? `WIP: ${options.title}` : options.title, body: options.body })
      )
    );
    if (!pr) throw new PrHostingError(200, 'Gitea не вернула созданный PR');
    return pr;
  },
  async comment(http, repo, number, body) {
    return text(obj(await getJson(http, `/repos/${enc(repo.path)}/issues/${number}/comments`, jsonInit('POST', { body }))).html_url);
  },
  headRefspec: (pr, localRef) => `+refs/pull/${pr.number}/head:${localRef}`
};

// ─────────────────────────── Bitbucket Cloud ───────────────────────────

function bitbucketChecks(states: string[]): PullRequest['checksStatus'] {
  if (!states.length) return 'NONE';
  if (states.some((s) => s === 'FAILED' || s === 'STOPPED')) return 'FAILURE';
  if (states.some((s) => s === 'INPROGRESS')) return 'PENDING';
  return 'SUCCESS';
}

/** PR Bitbucket Cloud API 2.0 → общий вид. `source.commit.hash` у Bitbucket короткий (12 символов). */
export function parseBitbucketPr(json: unknown): PullRequest | null {
  const p = obj(json);
  const number = num(p.id);
  if (number <= 0) return null;
  const state = text(p.state);
  const source = obj(p.source);
  const destination = obj(p.destination);
  const sourceRepo = text(obj(source.repository).full_name).toLowerCase();
  const destinationRepo = text(obj(destination.repository).full_name).toLowerCase();
  const author = obj(p.author);
  return {
    id: number,
    number,
    title: text(p.title) || `#${number}`,
    state: state === 'MERGED' ? 'MERGED' : state === 'OPEN' ? 'OPEN' : 'CLOSED',
    url: text(obj(obj(p.links).html).href),
    author: text(author.nickname) || text(author.display_name) || 'unknown',
    createdAt: text(p.created_on),
    updatedAt: text(p.updated_on),
    sourceBranch: text(obj(source.branch).name),
    targetBranch: text(obj(destination.branch).name) || 'main',
    body: text(p.description),
    labels: [],
    checksStatus: 'NONE',
    provider: 'bitbucket',
    commentsCount: num(p.comment_count),
    draft: p.draft === true,
    headSha: text(obj(source.commit).hash) || undefined,
    fromFork: Boolean(sourceRepo && destinationRepo && sourceRepo !== destinationRepo)
  };
}

const BB_STATES: Record<PrListState, string[]> = {
  all: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'],
  open: ['OPEN'],
  closed: ['DECLINED', 'SUPERSEDED'],
  merged: ['MERGED']
};

function bitbucketRepo(repo: RepoRef): string {
  return `/repositories/${enc(repo.path)}`;
}

export const bitbucketPrAdapter: PrHostingAdapter = {
  id: 'bitbucket',
  label: 'Bitbucket Cloud',
  serviceId: 'bitbucket',
  async list(http, repo, state) {
    const states = BB_STATES[state].map((s) => `state=${s}`).join('&');
    const json = obj(await getJson(http, `${bitbucketRepo(repo)}/pullrequests?${states}&sort=-updated_on&pagelen=${PR_LIST_LIMIT}`));
    return arr(json.values).map(parseBitbucketPr).filter((p): p is PullRequest => Boolean(p));
  },
  async get(http, repo, number) {
    const pr = parseBitbucketPr(await getJson(http, `${bitbucketRepo(repo)}/pullrequests/${number}`));
    if (!pr) throw new PrHostingError(404, `PR #${number} не найден`);
    try {
      const statuses = obj(await getJson(http, `${bitbucketRepo(repo)}/pullrequests/${number}/statuses?pagelen=50`));
      pr.checksStatus = bitbucketChecks(arr(statuses.values).map((s) => text(obj(s).state)));
    } catch {
      // статусы сборок — дополнение
    }
    return pr;
  },
  diff(http, repo, number) {
    // Bitbucket отвечает переходом на `/diff/<spec>` того же API: `authorizedFetch` идёт по нему с токеном.
    return getText(http, `${bitbucketRepo(repo)}/pullrequests/${number}/diff`, 'text/plain');
  },
  async create(http, repo, options) {
    const pr = parseBitbucketPr(
      await getJson(
        http,
        `${bitbucketRepo(repo)}/pullrequests`,
        jsonInit('POST', {
          title: options.title,
          description: options.body,
          source: { branch: { name: options.sourceBranch } },
          // Без ветки назначения Bitbucket берёт основную ветку репозитория.
          ...(options.targetBranch ? { destination: { branch: { name: options.targetBranch } } } : {}),
          ...(options.draft ? { draft: true } : {})
        })
      )
    );
    if (!pr) throw new PrHostingError(200, 'Bitbucket не вернул созданный PR');
    return pr;
  },
  async comment(http, repo, number, body) {
    const json = obj(await getJson(http, `${bitbucketRepo(repo)}/pullrequests/${number}/comments`, jsonInit('POST', { content: { raw: body } })));
    return text(obj(obj(json.links).html).href);
  },
  // У Bitbucket нет ссылок `refs/pull/*`: голова PR из того же репозитория — его ветка, из форка не получить.
  headRefspec: (pr, localRef) => (pr.fromFork || !pr.sourceBranch ? null : `+refs/heads/${pr.sourceBranch}:${localRef}`)
};

export const PR_HOSTING_ADAPTERS: readonly PrHostingAdapter[] = [githubPrAdapter, gitlabPrAdapter, giteaPrAdapter, bitbucketPrAdapter];

export function findPrAdapter(id: string): PrHostingAdapter | undefined {
  return PR_HOSTING_ADAPTERS.find((a) => a.id === id || a.serviceId === id);
}
