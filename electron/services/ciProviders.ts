import { PrHostingError, describeHttpError, type PrHttp, type RepoRef } from './prHosting.js';
import { AppError } from '../../src/lib/appError.js';

/**
 * Адаптеры CI/CD (TASK-138.3, decision-109): GitHub Actions, GitLab CI, Jenkins. Чистый модуль без Electron и
 * файловой системы: сеть — только через переданный `http` подключения или `gh api` (decision-102 п. 10).
 * Формы ответов — по документации REST API GitHub «Workflow runs», «Workflow jobs», GitLab API v4
 * «Pipelines», «Jobs», Jenkins Remote Access API (`/api/json`, `consoleText`, `wfapi/describe`).
 */

export type CiProviderId = 'github-actions' | 'gitlab-ci' | 'jenkins';

export type CiStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'manual';

export interface CiRun {
  id: string;
  provider: CiProviderId;
  /** Workflow GitHub, «Pipeline #N» GitLab, задание Jenkins. */
  name: string;
  number?: number;
  status: CiStatus;
  branch: string;
  sha: string;
  url: string;
  /** push, pull_request, merge_request_event, schedule… */
  event?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CiJob {
  id: string;
  name: string;
  stage?: string;
  status: CiStatus;
  url: string;
  startedAt?: string;
  finishedAt?: string;
  /** Упавший шаг GitHub или причина падения GitLab. */
  failedStep?: string;
}

export interface CiRunDetail extends CiRun {
  jobs: CiJob[];
}

/**
 * Доступ адаптера к сети. `download` — переход GitHub на подписанный адрес лога в хранилище: токен туда не
 * уходит (`authorizedFetch` не идёт на чужой origin), адрес сам содержит временную подпись.
 */
export interface CiHttp {
  request: PrHttp;
  download?: (url: string) => Promise<Response>;
}

/** Что опрашивает адаптер: репозиторий хостинга или задание Jenkins (`path` — путь задания). */
export type CiTarget = RepoRef;

export interface CiFilter {
  branch?: string;
  sha?: string;
  limit?: number;
}

export interface CiAdapter {
  id: CiProviderId;
  label: string;
  /** Сервис слоя подключений (decision-102). */
  serviceId: 'github' | 'gitlab' | 'jenkins';
  listRuns(http: CiHttp, target: CiTarget, filter: CiFilter): Promise<CiRun[]>;
  getRun(http: CiHttp, target: CiTarget, runId: string): Promise<CiRunDetail>;
  /** Полный текст лога задания, без маскировки: маскирует вызывающий. */
  jobLog(http: CiHttp, target: CiTarget, runId: string, jobId: string): Promise<string>;
  /** Перезапуск упавших заданий (GitHub, GitLab) или новая сборка задания (Jenkins). */
  retry(http: CiHttp, target: CiTarget, runId: string): Promise<void>;
  /** Запуск ручного задания (деплой GitLab); нет — адаптер не умеет. */
  playJob?(http: CiHttp, target: CiTarget, jobId: string): Promise<void>;
}

export const CI_RUNS_LIMIT = 20;

// ─────────────────────────── Помощники ───────────────────────────

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

function iso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  const s = text(v);
  return s || undefined;
}

async function call(http: CiHttp, target: string, init?: RequestInit): Promise<Response> {
  const res = await http.request(target, init);
  if (res.status >= 300 && res.status < 400) return res;
  if (!res.ok) throw new PrHostingError(res.status, describeHttpError(res.status, await res.text().catch(() => '')));
  return res;
}

async function getJson(http: CiHttp, target: string): Promise<unknown> {
  const body = await (await call(http, target)).text();
  return body ? JSON.parse(body) : null;
}

const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');

function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
}

const limitOf = (filter: CiFilter) => Math.max(1, Math.min(filter.limit ?? CI_RUNS_LIMIT, 100));

/** Порядок важности статусов для сводки: что показывать, когда у задачи несколько пайплайнов. */
const STATUS_RANK: Record<CiStatus, number> = { failure: 0, running: 1, queued: 2, manual: 3, cancelled: 4, success: 5, skipped: 6 };

/** Сводный статус последних пайплайнов: по одному на имя (workflow), худший из них. */
export function summarizeRuns(runs: CiRun[]): CiStatus | null {
  const latest = new Map<string, CiRun>();
  for (const run of runs) {
    const key = `${run.provider}:${run.name}`;
    const prev = latest.get(key);
    if (!prev || run.updatedAt > prev.updatedAt) latest.set(key, run);
  }
  let worst: CiStatus | null = null;
  for (const run of latest.values()) if (worst === null || STATUS_RANK[run.status] < STATUS_RANK[worst]) worst = run.status;
  return worst;
}

// ─────────────────────────── GitHub Actions ───────────────────────────

/** `status` + `conclusion` запуска или задания GitHub → общий статус. */
export function githubCiStatus(status: string, conclusion: string): CiStatus {
  if (status && status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'action_required':
      return 'manual';
    default:
      return 'skipped';
  }
}

export function parseGithubRun(json: unknown): CiRun | null {
  const r = obj(json);
  const id = text(r.id);
  if (!id) return null;
  return {
    id,
    provider: 'github-actions',
    name: text(r.name) || text(r.display_title) || `Run ${id}`,
    ...(typeof r.run_number === 'number' ? { number: r.run_number } : {}),
    status: githubCiStatus(text(r.status), text(r.conclusion)),
    branch: text(r.head_branch),
    sha: text(r.head_sha),
    url: text(r.html_url),
    ...(text(r.event) ? { event: text(r.event) } : {}),
    createdAt: text(r.created_at),
    updatedAt: text(r.updated_at) || text(r.created_at)
  };
}

export function parseGithubJob(json: unknown): CiJob | null {
  const j = obj(json);
  const id = text(j.id);
  if (!id) return null;
  const failed = arr(j.steps)
    .map(obj)
    .find((s) => ['failure', 'timed_out'].includes(text(s.conclusion)));
  return {
    id,
    name: text(j.name) || id,
    status: githubCiStatus(text(j.status), text(j.conclusion)),
    url: text(j.html_url),
    ...(iso(j.started_at) ? { startedAt: iso(j.started_at) } : {}),
    ...(iso(j.completed_at) ? { finishedAt: iso(j.completed_at) } : {}),
    ...(failed ? { failedStep: text(failed.name) } : {})
  };
}

export const githubActionsAdapter: CiAdapter = {
  id: 'github-actions',
  label: 'GitHub Actions',
  serviceId: 'github',
  async listRuns(http, repo, filter) {
    const json = obj(
      await getJson(http, `/repos/${enc(repo.path)}/actions/runs${query({ branch: filter.branch, head_sha: filter.sha, per_page: limitOf(filter) })}`)
    );
    return arr(json.workflow_runs).map(parseGithubRun).filter((r): r is CiRun => Boolean(r));
  },
  async getRun(http, repo, runId) {
    const run = parseGithubRun(await getJson(http, `/repos/${enc(repo.path)}/actions/runs/${encodeURIComponent(runId)}`));
    if (!run) throw new PrHostingError(404, new AppError('ci.runNotFound', { run: runId }));
    const jobs = obj(await getJson(http, `/repos/${enc(repo.path)}/actions/runs/${encodeURIComponent(runId)}/jobs?filter=latest&per_page=100`));
    return { ...run, jobs: arr(jobs.jobs).map(parseGithubJob).filter((j): j is CiJob => Boolean(j)) };
  },
  async jobLog(http, repo, _runId, jobId) {
    // Ответ — переход на подписанный адрес хранилища (документация «Download job logs for a workflow run»).
    const res = await call(http, `/repos/${enc(repo.path)}/actions/jobs/${encodeURIComponent(jobId)}/logs`);
    if (res.status < 300) return res.text();
    const location = res.headers.get('location');
    if (!location || !http.download) throw new PrHostingError(res.status, new AppError('ci.logNoAddress'));
    const url = new URL(location);
    if (url.protocol !== 'https:') throw new PrHostingError(res.status, new AppError('ci.logNotHttps'));
    const log = await http.download(url.toString());
    if (!log.ok) throw new PrHostingError(log.status, new AppError('ci.logUnavailable', { status: log.status }));
    return log.text();
  },
  async retry(http, repo, runId) {
    await call(http, `/repos/${enc(repo.path)}/actions/runs/${encodeURIComponent(runId)}/rerun-failed-jobs`, { method: 'POST' });
  }
};

// ─────────────────────────── GitLab CI ───────────────────────────

export function gitlabCiStatus(status: string): CiStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'canceling':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'manual':
      return 'manual';
    default:
      return 'queued';
  }
}

export function parseGitlabPipeline(json: unknown): CiRun | null {
  const p = obj(json);
  const id = text(p.id);
  if (!id) return null;
  const iid = typeof p.iid === 'number' ? p.iid : undefined;
  return {
    id,
    provider: 'gitlab-ci',
    // Номер показывается рядом с именем: «Pipeline #12».
    name: 'Pipeline',
    number: iid ?? Number(id),
    status: gitlabCiStatus(text(p.status)),
    branch: text(p.ref),
    sha: text(p.sha),
    url: text(p.web_url),
    ...(text(p.source) ? { event: text(p.source) } : {}),
    createdAt: text(p.created_at),
    updatedAt: text(p.updated_at) || text(p.created_at)
  };
}

export function parseGitlabJob(json: unknown): CiJob | null {
  const j = obj(json);
  const id = text(j.id);
  if (!id) return null;
  return {
    id,
    name: text(j.name) || id,
    ...(text(j.stage) ? { stage: text(j.stage) } : {}),
    status: gitlabCiStatus(text(j.status)),
    url: text(j.web_url),
    ...(iso(j.started_at) ? { startedAt: iso(j.started_at) } : {}),
    ...(iso(j.finished_at) ? { finishedAt: iso(j.finished_at) } : {}),
    ...(text(j.failure_reason) ? { failedStep: text(j.failure_reason) } : {})
  };
}

const gitlabProject = (repo: RepoRef) => `/projects/${encodeURIComponent(repo.path)}`;

export const gitlabCiAdapter: CiAdapter = {
  id: 'gitlab-ci',
  label: 'GitLab CI',
  serviceId: 'gitlab',
  async listRuns(http, repo, filter) {
    const json = await getJson(
      http,
      `${gitlabProject(repo)}/pipelines${query({ ref: filter.branch, sha: filter.sha, per_page: limitOf(filter), order_by: 'updated_at', sort: 'desc' })}`
    );
    return arr(json).map(parseGitlabPipeline).filter((r): r is CiRun => Boolean(r));
  },
  async getRun(http, repo, runId) {
    const run = parseGitlabPipeline(await getJson(http, `${gitlabProject(repo)}/pipelines/${encodeURIComponent(runId)}`));
    if (!run) throw new PrHostingError(404, new AppError('ci.pipelineNotFound', { run: runId }));
    const jobs = await getJson(http, `${gitlabProject(repo)}/pipelines/${encodeURIComponent(runId)}/jobs?per_page=100`);
    return { ...run, jobs: arr(jobs).map(parseGitlabJob).filter((j): j is CiJob => Boolean(j)) };
  },
  async jobLog(http, repo, _runId, jobId) {
    return (await call(http, `${gitlabProject(repo)}/jobs/${encodeURIComponent(jobId)}/trace`, { headers: { Accept: 'text/plain' } })).text();
  },
  async retry(http, repo, runId) {
    await call(http, `${gitlabProject(repo)}/pipelines/${encodeURIComponent(runId)}/retry`, { method: 'POST' });
  },
  async playJob(http, repo, jobId) {
    await call(http, `${gitlabProject(repo)}/jobs/${encodeURIComponent(jobId)}/play`, { method: 'POST' });
  }
};

// ─────────────────────────── Jenkins ───────────────────────────

/**
 * Путь задания Jenkins (`folder/app`, у multibranch — `app/{branch}`) → путь URL `/job/folder/job/app`.
 * Ветка multibranch в имени задания экранирована (`feat%2Fx`), поэтому в URL она кодируется дважды.
 */
export function jenkinsJobUrlPath(jobPath: string, branch?: string): string {
  return jobPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => `/job/${segment === '{branch}' ? encodeURIComponent(encodeURIComponent(branch ?? '')) : encodeURIComponent(segment)}`)
    .join('');
}

export function jenkinsStatus(result: string, building: boolean): CiStatus {
  if (building) return 'running';
  switch (result) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'UNSTABLE':
      return 'failure';
    case 'ABORTED':
      return 'cancelled';
    case 'NOT_BUILT':
      return 'skipped';
    default:
      return 'queued';
  }
}

const JENKINS_BUILD_TREE = 'number,url,result,building,timestamp,duration,displayName,actions[lastBuiltRevision[SHA1,branch[name]]]';

export function parseJenkinsBuild(json: unknown, jobName: string): CiRun | null {
  const b = obj(json);
  if (typeof b.number !== 'number') return null;
  const revision = arr(b.actions).map((a) => obj(obj(a).lastBuiltRevision)).find((r) => text(r.SHA1));
  const branch = text(obj(arr(revision?.branch)[0]).name).replace(/^(?:refs\/remotes\/)?origin\//, '');
  const started = typeof b.timestamp === 'number' ? b.timestamp : 0;
  const duration = typeof b.duration === 'number' ? b.duration : 0;
  return {
    id: String(b.number),
    provider: 'jenkins',
    name: jobName,
    number: b.number,
    status: jenkinsStatus(text(b.result), b.building === true),
    branch,
    sha: text(revision?.SHA1),
    url: text(b.url),
    createdAt: iso(started) ?? '',
    updatedAt: iso(started + duration) ?? iso(started) ?? ''
  };
}

/** Стадия Pipeline Stage View (`wfapi/describe`) → задание. */
function parseJenkinsStage(json: unknown, buildUrl: string, runId: string): CiJob | null {
  const s = obj(json);
  const id = text(s.id);
  if (!id) return null;
  const status = text(s.status);
  const mapped: CiStatus =
    status === 'SUCCESS' ? 'success' : status === 'FAILED' || status === 'UNSTABLE' ? 'failure' : status === 'IN_PROGRESS' ? 'running' : status === 'ABORTED' ? 'cancelled' : status === 'NOT_EXECUTED' ? 'skipped' : 'queued';
  return { id: `${runId}:${id}`, name: text(s.name) || id, status: mapped, url: buildUrl, ...(iso(s.startTimeMillis) ? { startedAt: iso(s.startTimeMillis) } : {}) };
}

export const jenkinsAdapter: CiAdapter = {
  id: 'jenkins',
  label: 'Jenkins',
  serviceId: 'jenkins',
  async listRuns(http, job, filter) {
    const multibranch = job.path.includes('{branch}');
    // Multibranch без ветки: какое из заданий веток смотреть, неизвестно.
    if (multibranch && !filter.branch) return [];
    const base = jenkinsJobUrlPath(job.path, filter.branch);
    const json = obj(await getJson(http, `${base}/api/json?tree=${encodeURIComponent(`builds[${JENKINS_BUILD_TREE}]{0,${limitOf(filter)}}`)}`));
    const name = job.path.replace('{branch}', filter.branch ?? '');
    const runs = arr(json.builds)
      .map((b) => parseJenkinsBuild(b, name))
      .filter((r): r is CiRun => Boolean(r))
      .map((r) => (multibranch ? { ...r, id: jenkinsRunId(r.id, filter.branch, true), branch: r.branch || filter.branch! } : r));
    // Задание не multibranch: ветку и коммит сборки сверяем сами.
    const byBranch = multibranch || !filter.branch ? runs : runs.filter((r) => r.branch === filter.branch);
    return filter.sha ? byBranch.filter((r) => r.sha.startsWith(filter.sha!) || filter.sha!.startsWith(r.sha || '\u0000')) : byBranch;
  },
  async getRun(http, job, runId) {
    const [number, branch] = splitJenkinsRun(runId);
    const base = jenkinsJobUrlPath(job.path, branch);
    const run = parseJenkinsBuild(await getJson(http, `${base}/${number}/api/json?tree=${encodeURIComponent(JENKINS_BUILD_TREE)}`), job.path.replace('{branch}', branch ?? ''));
    if (!run) throw new PrHostingError(404, new AppError('ci.buildNotFound', { number }));
    let jobs: CiJob[] = [];
    try {
      jobs = arr(obj(await getJson(http, `${base}/${number}/wfapi/describe`)).stages)
        .map((s) => parseJenkinsStage(s, run.url, runId))
        .filter((j): j is CiJob => Boolean(j));
    } catch {
      // нет Pipeline Stage View — вся сборка одним заданием
    }
    if (!jobs.length) jobs = [{ id: runId, name: run.name, status: run.status, url: run.url }];
    return { ...run, id: runId, jobs };
  },
  async jobLog(http, job, runId) {
    // Стадии без своего лога в core Jenkins: лог всей сборки.
    const [number, branch] = splitJenkinsRun(runId);
    return (await call(http, `${jenkinsJobUrlPath(job.path, branch)}/${number}/consoleText`, { headers: { Accept: 'text/plain' } })).text();
  },
  async retry(http, job, runId) {
    const [, branch] = splitJenkinsRun(runId);
    const base = jenkinsJobUrlPath(job.path, branch);
    // У задания с параметрами `build` отвечает 400: тогда сборка с параметрами по умолчанию.
    const res = await http.request(`${base}/build`, { method: 'POST' });
    if (res.status === 400) {
      await call(http, `${base}/buildWithParameters`, { method: 'POST' });
      return;
    }
    if (!res.ok && (res.status < 300 || res.status >= 400)) throw new PrHostingError(res.status, describeHttpError(res.status, await res.text().catch(() => '')));
  }
};

/** Id сборки multibranch несёт ветку: `42@feat/x`; у обычного задания — номер. */
export function jenkinsRunId(number: number | string, branch?: string, multibranch = false): string {
  return multibranch && branch ? `${number}@${branch}` : String(number);
}

function splitJenkinsRun(runId: string): [string, string | undefined] {
  const at = runId.indexOf('@');
  const head = at >= 0 ? runId.slice(0, at) : runId;
  return [head.split(':')[0], at >= 0 ? runId.slice(at + 1) : undefined];
}

export const CI_ADAPTERS: readonly CiAdapter[] = [githubActionsAdapter, gitlabCiAdapter, jenkinsAdapter];

export function findCiAdapter(id: string): CiAdapter | undefined {
  return CI_ADAPTERS.find((a) => a.id === id);
}

// ─────────────────────────── Лог для человека и агента ───────────────────────────

export const CI_LOG_TAIL_LINES = 300;
export const CI_LOG_TAIL_CHARS = 60_000;

/**
 * Хвост лога: без ANSI-последовательностей и меток времени GitHub, последние строки. Падение почти всегда в
 * конце лога, а целиком лог может весить десятки мегабайт.
 */
export function tailCiLog(raw: string, maxLines = CI_LOG_TAIL_LINES, maxChars = CI_LOG_TAIL_CHARS): { text: string; truncated: boolean; totalLines: number } {
  const clean = raw
    // eslint-disable-next-line no-control-regex -- ANSI-коды цвета в логах CI
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /gm, '');
  const lines = clean.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let tail = lines.slice(-maxLines);
  let out = tail.join('\n');
  while (out.length > maxChars && tail.length > 1) {
    tail = tail.slice(1);
    out = tail.join('\n');
  }
  const cut = out.length > maxChars;
  if (cut) out = out.slice(-maxChars);
  return { text: out, truncated: cut || tail.length < lines.length, totalLines: lines.length };
}
