import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../../src/lib/appError.js';
import { getRolesDir, getUserDataDir } from './appPaths.js';
import { projectRegistry } from './projectRegistry.js';
import {
  PROFILE_FORMAT,
  PROFILE_VERSION,
  decryptProfile,
  encryptProfile,
  isCloneableRemote,
  isProfileSectionId,
  mergeValue,
  missingProjects,
  planSection,
  profileFromJson,
  sanitizeProfile,
  stripSecrets,
  type ProfileDocument,
  type ProfileProject,
  type ProfileSection,
  type ProfileSectionId,
  type RolesSectionData,
  type SectionChange
} from './profileFormat.js';

const execFileAsync = promisify(execFile);

/**
 * Перенос профиля ProjectHub между машинами (TASK-224, [[decision-175]]): сбор разделов с диска этой машины, экспорт
 * в файл, предпросмотр импорта и применение. Формат и слияние — `profileFormat.ts`.
 *
 * Слияние при применении идёт поверх файла как он лежит на диске, а не поверх очищенной копии: поля, которых в
 * профиле нет (ключи старых установок, доверие к правилам проектов), остаются нетронутыми.
 */

/** Разделы-файлы `userData`. */
const SECTION_FILES: Partial<Record<ProfileSectionId, string>> = {
  aiConfig: 'ai-config.json',
  modelTiers: 'model-tiers.json',
  llmProfiles: 'llm-profiles.json',
  modelAssignments: 'model-assignments.json',
  agentPricing: 'agent-pricing.json',
  llmModelCatalog: 'llm-model-catalog.json',
  connections: 'connections.json',
  uiLanguage: 'ui-language.json',
  voiceHotkey: 'voice-hotkey.json',
  notifications: 'notifications.json',
  automations: 'automations.json'
};

/** Поля `automations.json`, которые принадлежат машине: доверие к правилам проектов привязано к локальным путям. */
const AUTOMATIONS_LOCAL_FIELDS = ['trust'];

/** Имя файла роли: без каталогов и служебных имён. */
const ROLE_FILE_RE = /^[\w][\w.-]{0,120}\.(md|ya?ml|json)$/i;

const PREVIEW_TTL_MS = 15 * 60_000;

export interface ProfileSectionPreview {
  id: ProfileSectionId;
  change: SectionChange;
  incomingNewer: boolean;
  updatedAt: string;
}

export interface ProfilePreview {
  token: string;
  exportedAt: string;
  appVersion?: string;
  sections: ProfileSectionPreview[];
  /** Проекты профиля, которых нет на этой машине: предлагается клонировать. */
  missingProjects: ProfileProject[];
}

export interface ProfileServiceDeps {
  userDataDir: () => string;
  rolesDir: () => string;
  projects: () => Promise<string[]>;
  remoteOf: (projectPath: string) => Promise<string | null>;
  appVersion: () => string | undefined;
  now: () => number;
}

/** Вызов RPC на сопряжённом хосте федерации (`federationClientService.call` с выбранным hostId). */
export type ProfileHostCall = (method: 'profile_get' | 'profile_preview' | 'profile_apply', params: Record<string, unknown>) => Promise<unknown>;

const SECTION_CHANGES: readonly SectionChange[] = ['new', 'changed', 'same'];

/** Предпросмотр, который вернул хост: только известные разделы и поля, без проектов для клонирования. */
export function parseProfilePreview(value: unknown): ProfilePreview {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ProfilePreview>;
  if (typeof v.token !== 'string' || !v.token) throw new AppError('profile.hostAnswerInvalid');
  const sections: ProfileSectionPreview[] = [];
  for (const s of Array.isArray(v.sections) ? v.sections : []) {
    if (!s || !isProfileSectionId(s.id) || !SECTION_CHANGES.includes(s.change)) continue;
    sections.push({ id: s.id, change: s.change, incomingNewer: s.incomingNewer === true, updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '' });
  }
  return {
    token: v.token,
    exportedAt: typeof v.exportedAt === 'string' ? v.exportedAt : '',
    ...(typeof v.appVersion === 'string' ? { appVersion: v.appVersion } : {}),
    sections,
    missingProjects: []
  };
}

async function readJson(file: string): Promise<{ data: unknown; mtime: Date } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { data: JSON.parse(text), mtime: stat.mtime };
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

function withoutFields(value: unknown, fields: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>) };
  for (const f of fields) delete out[f];
  return out;
}

export class ProfileService {
  private pending = new Map<string, { doc: ProfileDocument; at: number }>();

  constructor(private readonly deps: ProfileServiceDeps) {}

  /** Раздел этой машины как есть на диске (`raw`) и очищенный для профиля (`section`). */
  private async readSection(id: ProfileSectionId): Promise<{ section?: ProfileSection; raw?: unknown }> {
    if (id === 'roles') {
      const dir = this.deps.rolesDir();
      let names: string[];
      try {
        names = (await fs.readdir(dir)).filter((n) => ROLE_FILE_RE.test(n));
      } catch {
        return {};
      }
      const files: Record<string, string> = {};
      let latest = 0;
      for (const name of names.sort()) {
        const file = path.join(dir, name);
        const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
        files[name] = content;
        latest = Math.max(latest, stat.mtimeMs);
      }
      if (names.length === 0) return {};
      const data: RolesSectionData = { files };
      return { section: { updatedAt: new Date(latest).toISOString(), data }, raw: data };
    }
    if (id === 'projects') {
      const projects: ProfileProject[] = [];
      for (const projectPath of await this.deps.projects()) {
        const remote = await this.deps.remoteOf(projectPath).catch(() => null);
        if (remote && isCloneableRemote(remote)) projects.push({ name: path.basename(projectPath), remote });
      }
      if (projects.length === 0) return {};
      return { section: { updatedAt: new Date(this.deps.now()).toISOString(), data: projects }, raw: projects };
    }
    const fileName = SECTION_FILES[id];
    if (!fileName) return {};
    const read = await readJson(path.join(this.deps.userDataDir(), fileName));
    if (!read) return {};
    const portable = id === 'automations' ? withoutFields(read.data, AUTOMATIONS_LOCAL_FIELDS) : read.data;
    return { section: { updatedAt: read.mtime.toISOString(), data: stripSecrets(portable) }, raw: read.data };
  }

  /** Профиль этой машины без секретов. */
  async collect(ids: readonly ProfileSectionId[]): Promise<ProfileDocument> {
    const sections: ProfileDocument['sections'] = {};
    for (const id of ids) {
      const { section } = await this.readSection(id);
      if (section) sections[id] = section;
    }
    const appVersion = this.deps.appVersion();
    return {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      exportedAt: new Date(this.deps.now()).toISOString(),
      ...(appVersion ? { appVersion } : {}),
      sections
    };
  }

  async exportToFile(file: string, password: string, ids: readonly ProfileSectionId[]): Promise<{ sections: ProfileSectionId[] }> {
    const doc = await this.collect(ids);
    await writeAtomic(file, encryptProfile(doc, password));
    return { sections: Object.keys(doc.sections) as ProfileSectionId[] };
  }

  /** Предпросмотр импорта документа: что изменится по разделам. Документ запоминается до `apply` по токену. */
  async preview(doc: ProfileDocument): Promise<ProfilePreview> {
    this.dropExpired();
    const sections: ProfileSectionPreview[] = [];
    let missing: ProfileProject[] = [];
    for (const [id, incoming] of Object.entries(doc.sections)) {
      if (!isProfileSectionId(id) || !incoming) continue;
      if (id === 'projects') {
        const local = await this.readSection('projects');
        const localRemotes = ((local.raw as ProfileProject[] | undefined) ?? []).map((p) => p.remote);
        const list = Array.isArray(incoming.data) ? (incoming.data as ProfileProject[]).filter((p) => p && typeof p.remote === 'string' && isCloneableRemote(p.remote)) : [];
        missing = missingProjects(list.map((p) => ({ name: String(p.name ?? ''), remote: p.remote })), localRemotes);
        continue;
      }
      const { section } = await this.readSection(id);
      const plan = planSection(id, section, incoming);
      sections.push({ id, change: plan.change, incomingNewer: plan.incomingNewer, updatedAt: incoming.updatedAt });
    }
    const token = crypto.randomBytes(16).toString('hex');
    this.pending.set(token, { doc, at: this.deps.now() });
    return {
      token,
      exportedAt: doc.exportedAt,
      ...(doc.appVersion ? { appVersion: doc.appVersion } : {}),
      sections,
      missingProjects: missing
    };
  }

  /** Предпросмотр файла профиля: неверный пароль и битый файл — `AppError`, ничего не меняется. */
  async previewFile(file: string, password: string): Promise<ProfilePreview> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new AppError('profile.fileUnreadable');
    }
    return this.preview(decryptProfile(text, password));
  }

  /** Применяет выбранные разделы запомненного предпросмотра. */
  async apply(token: string, ids: readonly ProfileSectionId[]): Promise<{ applied: ProfileSectionId[] }> {
    this.dropExpired();
    const entry = this.pending.get(token);
    if (!entry) throw new AppError('profile.previewExpired');
    this.pending.delete(token);
    const applied: ProfileSectionId[] = [];
    for (const id of ids) {
      const incoming = entry.doc.sections[id];
      if (!isProfileSectionId(id) || id === 'projects' || !incoming) continue;
      const { section, raw } = await this.readSection(id);
      const plan = planSection(id, section, incoming);
      if (plan.change === 'same') continue;
      if (id === 'roles') {
        const dir = this.deps.rolesDir();
        for (const [name, content] of Object.entries((plan.merged as RolesSectionData).files)) {
          if (!ROLE_FILE_RE.test(name)) continue;
          const current = (raw as RolesSectionData | undefined)?.files[name];
          if (current !== content) await writeAtomic(path.join(dir, name), content);
        }
      } else {
        const fileName = SECTION_FILES[id];
        if (!fileName) continue;
        // Поверх файла как он есть: поля, которых нет в профиле, остаются своими.
        const merged = mergeValue(raw, incoming.data, plan.incomingNewer);
        await writeAtomic(path.join(this.deps.userDataDir(), fileName), `${JSON.stringify(merged, null, 2)}\n`);
      }
      applied.push(id);
    }
    return { applied };
  }

  /** Профиль с домашнего хоста по федерации (TASK-225): документ хоста сливается здесь по тем же правилам, что файл. */
  async previewFromHost(call: ProfileHostCall, ids: readonly ProfileSectionId[]): Promise<ProfilePreview> {
    return this.preview(profileFromJson(await call('profile_get', { sections: ids })));
  }

  /**
   * Отправка профиля этой машины на хост: план слияния считает хост по своему диску, применение — `applyOnHost` по
   * его токену. Список проектов не отправляется: клонировать на хосте отсюда нечем.
   */
  async previewOnHost(call: ProfileHostCall, ids: readonly ProfileSectionId[]): Promise<ProfilePreview> {
    const doc = await this.collect(ids.filter((id) => id !== 'projects'));
    return parseProfilePreview(await call('profile_preview', { profile: sanitizeProfile(doc) }));
  }

  async applyOnHost(call: ProfileHostCall, token: string, ids: readonly ProfileSectionId[]): Promise<{ applied: ProfileSectionId[] }> {
    const res = (await call('profile_apply', { token, sections: ids })) as { applied?: unknown } | null;
    return { applied: Array.isArray(res?.applied) ? res.applied.filter(isProfileSectionId) : [] };
  }

  private dropExpired(): void {
    const now = this.deps.now();
    for (const [token, entry] of this.pending) if (now - entry.at > PREVIEW_TTL_MS) this.pending.delete(token);
  }
}

async function gitRemote(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 10_000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Клонирует проект из профиля в каталог `parentDir` и добавляет его в реестр. */
export async function cloneProfileProject(remote: string, parentDir: string, name: string): Promise<string> {
  if (!isCloneableRemote(remote)) throw new AppError('profile.cloneRemoteInvalid');
  const folder = (name || path.basename(remote).replace(/\.git$/i, '')).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'project';
  const target = path.join(parentDir, folder);
  try {
    await fs.access(target);
    throw new AppError('profile.cloneTargetExists', { path: target });
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
  try {
    await execFileAsync('git', ['clone', '--', remote, target], {
      timeout: 15 * 60_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim().split('\n').pop() || (err instanceof Error ? err.message : String(err));
    throw new AppError('profile.cloneFailed', { detail: detail.slice(0, 300) });
  }
  await projectRegistry.addProject(target);
  return target;
}

let appVersion: string | undefined;

/** Версию приложения задаёт регистрация IPC (`app.getVersion()`): сервис не зависит от Electron. */
export function setProfileAppVersion(version: string): void {
  appVersion = version;
}

export const profileService = new ProfileService({
  userDataDir: getUserDataDir,
  rolesDir: getRolesDir,
  projects: async () => (await projectRegistry.getProjects()).map((p) => p.path),
  remoteOf: gitRemote,
  appVersion: () => appVersion,
  now: Date.now
});
