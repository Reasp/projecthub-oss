import path from 'node:path';
import fs from 'node:fs/promises';
import {
  CI_LOG_TAIL_CHARS,
  CI_LOG_TAIL_LINES,
  CI_RUNS_LIMIT,
  findCiAdapter,
  jenkinsAdapter,
  summarizeRuns,
  tailCiLog,
  type CiAdapter,
  type CiFilter,
  type CiHttp,
  type CiJob,
  type CiProviderId,
  type CiRun,
  type CiRunDetail,
  type CiStatus,
  type CiTarget
} from './ciProviders.js';
import { stateFields, withVersion } from './stateFiles.js';
import type { ConnectionStatus, ConnectionUsage } from './connectionTypes.js';

/**
 * CI/CD проекта (TASK-138.3, decision-109): пайплайны хостинга репозитория (GitHub Actions, GitLab CI — через то же
 * подключение или `gh`, что и PR) и задание Jenkins из настройки проекта. Сеть — только через подключения и `gh`
 * (decision-102 п. 10). Логи перед выдачей маскируются: токены подключений и шаблоны секретов.
 */

/** Как сервис ходит к одному CI проекта. */
export interface CiAccess {
  adapter: CiAdapter;
  target: CiTarget;
  http: CiHttp;
  /** Подключение («GitHub — octo») или `gh`. */
  via: string;
}

export interface CiProviderInfo {
  id: CiProviderId;
  label: string;
  via: string;
}

export interface CiRunsResult {
  ok: boolean;
  runs: CiRun[];
  providers: CiProviderInfo[];
  /** Худший статус последних запусков каждого workflow. */
  summary: CiStatus | null;
  errors: string[];
}

export interface CiJobLog {
  job: CiJob;
  text: string;
  truncated: boolean;
  totalLines: number;
}

export interface JenkinsSetting {
  connectionId: string;
  /** Путь задания: `folder/app`, у multibranch — `app/{branch}`. */
  job: string;
}

export interface CiConnectionInfo {
  id: string;
  serviceId: string;
  label: string;
  baseUrl: string;
  status: ConnectionStatus;
}

export interface CiServiceDeps {
  /** CI хостинга репозитория по тому же пути, что и PR: подключение или `gh`; нет — `null`. */
  hostingAccess(projectPath: string): Promise<CiAccess | null>;
  connections?: {
    list(): Promise<CiConnectionInfo[]>;
    authorizedFetch(connectionId: string, target: string, init?: RequestInit): Promise<Response>;
  };
  /** Файл настроек CI проектов (`<userData>/ci.json`). */
  statePath?: () => string;
  /** Маскировка секретов в логах: токены подключений и шаблоны. */
  mask(text: string): string;
}

export const CI_STATE_VERSION = 1;
/** Сколько упавших заданий отдаётся за раз и сколько строк лога у каждого. */
export const CI_FAILED_JOBS_LIMIT = 3;

interface ProjectCiSettings {
  jenkins?: JenkinsSetting;
  path?: string;
}

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
}

/** Путь задания Jenkins: сегменты без пустых и `..`, плейсхолдер `{branch}` — только целым сегментом. */
export function normalizeJenkinsJob(job: string): string | null {
  const segments = job
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/(^|\/)job\//g, '$1')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || (s.includes('{branch}') && s !== '{branch}'))) return null;
  return segments.join('/');
}

export class CiService {
  private settings: Record<string, ProjectCiSettings> | null = null;

  constructor(private readonly deps: CiServiceDeps) {}

  private async loadSettings(): Promise<Record<string, ProjectCiSettings>> {
    if (this.settings) return this.settings;
    const out: Record<string, ProjectCiSettings> = {};
    const file = this.deps.statePath?.();
    if (file) {
      try {
        const raw = stateFields(JSON.parse(await fs.readFile(file, 'utf-8')), CI_STATE_VERSION).projects;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const j = v && typeof v === 'object' ? ((v as Record<string, unknown>).jenkins as Record<string, unknown> | undefined) : undefined;
            const job = typeof j?.job === 'string' ? normalizeJenkinsJob(j.job) : null;
            if (j && typeof j.connectionId === 'string' && j.connectionId && job) {
              out[k] = { jenkins: { connectionId: j.connectionId, job }, ...(typeof (v as Record<string, unknown>).path === 'string' ? { path: (v as Record<string, string>).path } : {}) };
            }
          }
        }
      } catch {
        // нет файла или он битый — настроек нет
      }
    }
    this.settings = out;
    return out;
  }

  async getJenkins(projectPath: string): Promise<JenkinsSetting | null> {
    return (await this.loadSettings())[pathKey(projectPath)]?.jenkins ?? null;
  }

  /** Задание Jenkins проекта; `null` — убрать. Подключение должно быть подключением Jenkins. */
  async setJenkins(projectPath: string, value: JenkinsSetting | null): Promise<JenkinsSetting | null> {
    const settings = await this.loadSettings();
    const key = pathKey(projectPath);
    if (value) {
      const job = normalizeJenkinsJob(value.job);
      if (!job) throw new Error('Путь задания Jenkins: имена через «/», для multibranch — {branch} отдельным сегментом');
      const connection = (await this.deps.connections?.list())?.find((c) => c.id === value.connectionId);
      if (!connection || connection.serviceId !== 'jenkins') throw new Error('Выберите подключение к Jenkins');
      settings[key] = { jenkins: { connectionId: value.connectionId, job }, path: projectPath };
    } else {
      delete settings[key];
    }
    const file = this.deps.statePath?.();
    if (file) {
      const text = `${JSON.stringify(withVersion(CI_STATE_VERSION, { projects: settings }), null, 2)}\n`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, 'utf-8');
      await fs.rename(tmp, file).catch(async () => {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        await fs.writeFile(file, text, 'utf-8');
      });
    }
    return settings[key]?.jenkins ?? null;
  }

  /** Прочитать настройки заранее: окно «Подключения» спрашивает использования синхронно. */
  async init(): Promise<void> {
    await this.loadSettings();
  }

  /** Использования подключений Jenkins — для окна «Подключения» (decision-102 п. 7). */
  usages(): ConnectionUsage[] {
    return Object.values(this.settings ?? {})
      .filter((s) => s.jenkins)
      .map((s) => ({ connectionId: s.jenkins!.connectionId, label: `CI: ${s.jenkins!.job}` }));
  }

  /** Все CI проекта: хостинг репозитория и Jenkins из настройки. */
  async accesses(projectPath: string): Promise<CiAccess[]> {
    const out: CiAccess[] = [];
    const hosting = await this.deps.hostingAccess(projectPath).catch(() => null);
    if (hosting) out.push(hosting);
    const jenkins = await this.getJenkins(projectPath);
    const connections = this.deps.connections;
    if (jenkins && connections) {
      const connection = (await connections.list().catch(() => [] as CiConnectionInfo[])).find((c) => c.id === jenkins.connectionId);
      if (connection) {
        out.push({
          adapter: jenkinsAdapter,
          target: { path: jenkins.job, webBase: connection.baseUrl, apiBase: connection.baseUrl },
          http: { request: (target, init) => connections.authorizedFetch(connection.id, target, init) },
          via: connection.label
        });
      }
    }
    return out;
  }

  private async accessFor(projectPath: string, provider: string): Promise<CiAccess> {
    const access = (await this.accesses(projectPath)).find((a) => a.adapter.id === provider);
    if (access) return access;
    const label = findCiAdapter(provider)?.label ?? provider;
    throw new Error(`${label} для проекта не настроен: нет подключения к хостингу репозитория или к Jenkins`);
  }

  async providers(projectPath: string): Promise<CiProviderInfo[]> {
    return (await this.accesses(projectPath)).map((a) => ({ id: a.adapter.id, label: a.adapter.label, via: a.via }));
  }

  /** Запуски по ветке или коммиту у всех CI проекта, новые первыми. Ошибка одного CI не прячет другие. */
  async listRuns(projectPath: string, filter: CiFilter = {}): Promise<CiRunsResult> {
    const accesses = await this.accesses(projectPath);
    const providers = accesses.map((a) => ({ id: a.adapter.id, label: a.adapter.label, via: a.via }));
    const runs: CiRun[] = [];
    const errors: string[] = [];
    for (const access of accesses) {
      try {
        runs.push(...(await access.adapter.listRuns(access.http, access.target, { ...filter, limit: filter.limit ?? CI_RUNS_LIMIT })));
      } catch (err) {
        errors.push(`${access.adapter.label}: ${errorText(err)}`);
      }
    }
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return { ok: errors.length < accesses.length || !accesses.length, runs, providers, summary: summarizeRuns(runs), errors };
  }

  async getRun(projectPath: string, provider: string, runId: string): Promise<CiRunDetail> {
    const access = await this.accessFor(projectPath, provider);
    return access.adapter.getRun(access.http, access.target, runId);
  }

  /**
   * Хвост лога заданий запуска с замаскированными секретами: одного задания или упавших (до трёх). Сначала грубый
   * хвост вдвое длиннее (лог бывает в десятки мегабайт), маскировка, затем окончательный хвост: секрет на границе
   * обрезки не уходит наполовину.
   */
  async failedLogs(projectPath: string, provider: string, runId: string, jobId?: string): Promise<CiJobLog[]> {
    const access = await this.accessFor(projectPath, provider);
    const run = await access.adapter.getRun(access.http, access.target, runId);
    const jobs = jobId ? run.jobs.filter((j) => j.id === jobId) : run.jobs.filter((j) => j.status === 'failure').slice(0, CI_FAILED_JOBS_LIMIT);
    if (jobId && !jobs.length) throw new Error(`Задание ${jobId} не найдено в запуске ${runId}`);
    const out: CiJobLog[] = [];
    // У Jenkins без Stage View стадии делят один лог сборки: он читается один раз.
    const cache = new Map<string, string>();
    for (const job of jobs) {
      const logKey = access.adapter.id === 'jenkins' ? runId : job.id;
      let raw = cache.get(logKey);
      if (raw === undefined) {
        raw = await access.adapter.jobLog(access.http, access.target, runId, job.id);
        cache.set(logKey, raw);
      }
      const rough = tailCiLog(raw, CI_LOG_TAIL_LINES * 2, CI_LOG_TAIL_CHARS * 2);
      const tail = tailCiLog(this.deps.mask(rough.text));
      out.push({ job, text: tail.text, truncated: rough.truncated || tail.truncated, totalLines: rough.totalLines });
    }
    return out;
  }

  async retry(projectPath: string, provider: string, runId: string): Promise<void> {
    const access = await this.accessFor(projectPath, provider);
    await access.adapter.retry(access.http, access.target, runId);
  }

  async playJob(projectPath: string, provider: string, jobId: string): Promise<void> {
    const access = await this.accessFor(projectPath, provider);
    if (!access.adapter.playJob) throw new Error(`${access.adapter.label}: запуск ручного задания не поддерживается`);
    await access.adapter.playJob(access.http, access.target, jobId);
  }

  /** Что увидит человек в запросе HITL: CI, репозиторий или задание, подключение. */
  async describeTarget(projectPath: string, provider: string): Promise<string> {
    const access = await this.accessFor(projectPath, provider);
    return `${access.adapter.label}, ${access.target.path}, через «${access.via}»`;
  }
}
