import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeGitRemote, parseKnowledgeBaseConfig } from '../../src/lib/knowledgeBase.js';
import { projectAccessKey } from '../../src/utils/projectAccess.js';
import type { DocItem, RagSearchResult } from '../../src/types/electron';
import { listProjectDocs, readDocFile } from './docsService.js';
import { projectRegistry } from './projectRegistry.js';
import { searchProjectDocs } from './ragSearch.js';

const execFileAsync = promisify(execFile);

/**
 * База знаний компании для проекта (TASK-223, decision-182): какой зарегистрированный проект подключён как база
 * знаний, поиск по ней вместе с проектом и чтение её документов для ссылок `[[kb:doc-N]]`. База знаний — только
 * проект из реестра: путь из `.projecthub.json` не открывает произвольный каталог.
 */

export interface KnowledgeBaseRef {
  root: string;
  name: string;
}

const REMOTE_TTL_MS = 60_000;
const remoteCache = new Map<string, { at: number; remote: string | null }>();

async function originOf(projectPath: string): Promise<string | null> {
  const key = projectAccessKey(projectPath);
  const cached = remoteCache.get(key);
  if (cached && Date.now() - cached.at < REMOTE_TTL_MS) return cached.remote;
  let remote: string | null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 10_000, windowsHide: true });
    remote = stdout.trim() || null;
  } catch {
    remote = null;
  }
  remoteCache.set(key, { at: Date.now(), remote });
  return remote;
}

export interface KnowledgeBaseDeps {
  readProjectJson: (projectRoot: string) => Promise<unknown>;
  registeredProjects: () => Promise<string[]>;
  originOf: (projectPath: string) => Promise<string | null>;
}

const defaultDeps: KnowledgeBaseDeps = {
  readProjectJson: async (root) => {
    try {
      return JSON.parse(await fs.readFile(path.join(root, '.projecthub.json'), 'utf8'));
    } catch {
      return null;
    }
  },
  registeredProjects: async () => (await projectRegistry.getProjects()).map((p) => p.path),
  originOf
};

/** База знаний проекта или `null`: не подключена, не найдена среди зарегистрированных проектов или это сам проект. */
export async function resolveKnowledgeBase(projectRoot: string, deps: KnowledgeBaseDeps = defaultDeps): Promise<KnowledgeBaseRef | null> {
  const config = parseKnowledgeBaseConfig(await deps.readProjectJson(projectRoot));
  if (!config) return null;
  const self = projectAccessKey(projectRoot);
  const projects = (await deps.registeredProjects()).filter((p) => projectAccessKey(p) !== self);
  if (config.path) {
    const wanted = projectAccessKey(path.resolve(projectRoot, config.path));
    const found = projects.find((p) => projectAccessKey(p) === wanted);
    if (found) return { root: found, name: path.basename(found) };
  }
  if (config.remote) {
    const wanted = normalizeGitRemote(config.remote);
    for (const p of projects) {
      const origin = await deps.originOf(p);
      if (origin && normalizeGitRemote(origin) === wanted) return { root: p, name: path.basename(p) };
    }
  }
  return null;
}

/**
 * Поиск по проекту и его базе знаний: результаты базы знаний — документы и решения, с её `projectName`/`projectPath`,
 * общий порядок — по оценке. `canAccess` закрывает базу знаний участнику без доступа к её проекту.
 */
export async function searchWithKnowledgeBase(
  projectRoot: string,
  query: string,
  limit: number,
  canAccess: (kbRoot: string) => boolean = () => true,
  deps: KnowledgeBaseDeps = defaultDeps
): Promise<RagSearchResult[]> {
  const own = await searchProjectDocs({ projectPath: projectRoot, query, mode: 'all', limit });
  const kb = await resolveKnowledgeBase(projectRoot, deps).catch(() => null);
  if (!kb || !canAccess(kb.root)) return own;
  const fromKb = (await searchProjectDocs({ projectPath: kb.root, query, mode: 'all', limit }).catch(() => [])).filter(
    (r) => r.category === 'doc' || r.category === 'decision'
  );
  return [...own, ...fromKb].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function knowledgeBaseIndex(projectRoot: string): Promise<{ name: string; docs: DocItem[] } | null> {
  const kb = await resolveKnowledgeBase(projectRoot);
  if (!kb) return null;
  return { name: kb.name, docs: await listProjectDocs(kb.root) };
}

/** Документ базы знаний по id для ссылки `[[kb:doc-N]]`; только файлы из списка документов базы знаний. */
export async function readKnowledgeBaseDoc(projectRoot: string, id: string): Promise<{ id: string; title: string; content: string; kbName: string } | null> {
  const kb = await resolveKnowledgeBase(projectRoot);
  if (!kb) return null;
  const doc = (await listProjectDocs(kb.root)).find((d) => d.id.toLowerCase() === id.trim().toLowerCase());
  if (!doc) return null;
  return { id: doc.id, title: doc.title, content: await readDocFile(doc.filePath), kbName: kb.name };
}
