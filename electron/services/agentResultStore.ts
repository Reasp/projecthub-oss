/**
 * Сохранённые результаты агентов проекта (TASK-238, [[decision-188]]): список ref `refs/projecthub/results/`, восстановление
 * в ветку и очистка по сроку или лимиту. Что делать — решают чистые функции `agentResultRefs.ts`, здесь только git и журнал.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { AppError } from '../../src/lib/appError.js';
import { appendRemoteAudit } from './remoteActionAudit.js';
import { AGENT_COMMITTER } from '../extensions/editionRegistry.js';
import {
  AGENT_RESULT_REF_PREFIX,
  RESULT_REF_FORMAT,
  expiredResultRefs,
  isStashSnapshot,
  parseResultRefs,
  reflogSavedAt,
  restoreBranchName,
  withSavedAt,
  type AgentResultRefEntry,
  type ResultRetention
} from './agentResultRefs.js';

/**
 * Результаты в репозитории проекта, новые сверху. Время сохранения — из reflog ref (его пишет `preserveAgentResult`),
 * для ref, сохранённых до reflog, — время файла ref; упакованный ref без reflog остаётся с датой коммита.
 */
export async function listAgentResults(projectPath: string): Promise<AgentResultRefEntry[]> {
  const git = simpleGit(projectPath);
  const entries = parseResultRefs(await git.raw(['for-each-ref', `--format=${RESULT_REF_FORMAT}`, AGENT_RESULT_REF_PREFIX]));
  if (entries.length === 0) return entries;
  const common = path.resolve(projectPath, (await git.raw(['rev-parse', '--git-common-dir'])).trim());
  const saved = new Map<string, number>();
  await Promise.all(
    entries.map(async (e) => {
      const fromLog = await fs.readFile(path.join(common, 'logs', e.ref), 'utf8').then(reflogSavedAt, () => null);
      const at = fromLog ?? (await fs.stat(path.join(common, e.ref)).then((s) => s.mtimeMs, () => null));
      if (at) saved.set(e.ref, at);
    })
  );
  return withSavedAt(entries, saved);
}

async function findEntry(projectPath: string, ref: string): Promise<AgentResultRefEntry> {
  const entry = (await listAgentResults(projectPath)).find((e) => e.ref === ref);
  if (!entry) throw new AppError('swarm.resultNotFound', { ref });
  return entry;
}

/**
 * Ветка из сохранённого результата. Коммит агента — ветка на нём; снимок `stash create` — обычный коммит с деревом
 * снимка поверх его HEAD, чтобы в истории не было служебного коммита индекса. Текущая ветка и рабочее дерево не меняются.
 */
export async function restoreAgentResult(projectPath: string, ref: string): Promise<{ branch: string; sha: string }> {
  const entry = await findEntry(projectPath, ref);
  const git = simpleGit(projectPath);
  // Полные имена: `refname:short` сокращает ветку до `heads/…`, если есть тег с тем же именем.
  const branches = (await git.raw(['for-each-ref', '--format=%(refname)', 'refs/heads/']))
    .split(/\r?\n/)
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length));
  const branch = restoreBranchName(entry, new Set(branches));
  const parents = (await git.raw(['rev-list', '--parents', '-n', '1', entry.sha])).trim().split(/\s+/).slice(1);
  const secondSubject = parents.length >= 2 ? (await git.raw(['log', '-1', '--format=%s', parents[1]])).trim() : '';
  let sha = entry.sha;
  if (isStashSnapshot(parents, secondSubject)) {
    const message = `Restore result of agent ${entry.agentId} (session ${entry.sessionId})`;
    // Технический автор, как у авто-коммита агента (decision-8 п. 1): без него commit-tree падает на машине без user.name.
    const who = ['-c', `user.name=${AGENT_COMMITTER.name}`, '-c', `user.email=${AGENT_COMMITTER.email}`];
    sha = (await git.raw([...who, 'commit-tree', `${entry.sha}^{tree}`, '-p', parents[0], '-m', message])).trim();
  }
  await git.raw(['branch', branch, sha]);
  void appendRemoteAudit({
    ts: Date.now(),
    method: 'restore_agent_result',
    ok: true,
    deviceId: 'local',
    actor: 'window',
    projectPath,
    target: { ref: entry.ref, branch }
  });
  return { branch, sha };
}

/** Удаление одного результата по просьбе человека. */
export async function deleteAgentResult(projectPath: string, ref: string): Promise<void> {
  const entry = await findEntry(projectPath, ref);
  await simpleGit(projectPath).raw(['update-ref', '-d', entry.ref, entry.sha]);
  void appendRemoteAudit({ ts: Date.now(), method: 'delete_agent_result', ok: true, deviceId: 'local', actor: 'window', projectPath, target: { ref: entry.ref } });
}

/**
 * Очистка по сроку и лимиту. `update-ref -d <ref> <sha>` удаляет ref, только если он не сменился с момента чтения.
 * Каждый удалённый ref — строка журнала действий: какой результат, какой коммит и почему.
 */
export async function pruneAgentResults(
  projectPath: string,
  retention: ResultRetention,
  liveSessionParts: ReadonlySet<string>,
  now = Date.now()
): Promise<AgentResultRefEntry[]> {
  const expired = expiredResultRefs(await listAgentResults(projectPath), retention, now, liveSessionParts);
  const git = simpleGit(projectPath);
  const removed: AgentResultRefEntry[] = [];
  for (const entry of expired) {
    try {
      await git.raw(['update-ref', '-d', entry.ref, entry.sha]);
      removed.push(entry);
      void appendRemoteAudit({
        ts: now,
        method: 'prune_agent_result',
        ok: true,
        deviceId: 'local',
        actor: 'window',
        projectPath,
        target: { ref: entry.ref, sha: entry.sha.slice(0, 12), reason: `maxAgeDays=${retention.maxAgeDays} maxCount=${retention.maxCount}` }
      });
    } catch (err) {
      console.warn(`[AgentResultStore] Failed to delete ${entry.ref}:`, err);
    }
  }
  return removed;
}
