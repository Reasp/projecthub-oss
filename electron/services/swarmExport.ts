import type { AgentSlotState, SwarmSession } from './swarmTypes.js';
import { addUsage, emptyUsage, formatTokens, formatUsd, type AgentUsage } from './agentCost.js';
import { describeProviderInfo } from './slotProvider.js';
import { describeProviderErrorBrief } from './providerErrors.js';
import { describeChainLink, describeFallbackStop, MAX_MODEL_SWITCHES } from './modelTiers.js';
import type { Language } from '../../src/i18n/types.js';
import { formatAppError, type AppErrorKey } from '../../src/lib/appError.js';
import { hostText } from '../i18n/hostText.js';
import { swarmReportText, type SwarmReportText } from '../i18n/swarmReportText.js';

/**
 * Экспорт swarm-сессии в Markdown-отчёт и JSON (TASK-56, AC #5) — для вложения в задачу
 * Backlog.md или описание PR. Отчёт — на языке хоста (decision-161), английский по умолчанию. Чистый модуль без Electron.
 */

export interface SwarmSessionTotals {
  usage: AgentUsage;
  costUsd?: number;
  /** Стоимость известна хотя бы по одному агенту. */
  costKnown: boolean;
  durationMs: number;
  agentsCompleted: number;
  agentsFailed: number;
}

export function agentUsage(agent: AgentSlotState): AgentUsage | undefined {
  return agent.metrics?.usage;
}

/** Стоимость агента для отчёта: у локальной модели — «$0.00 (local)», а не «—» (decision-42). */
export function formatAgentCost(usage: AgentUsage | undefined, fallbackCostUsd?: number, tx: SwarmReportText = swarmReportText()): string {
  const cost = usage?.costUsd ?? fallbackCostUsd;
  if (typeof cost !== 'number') return '—';
  return usage?.costSource === 'local' ? tx.localCost(formatUsd(cost)) : formatUsd(cost);
}

/** Сводка по сессии: суммарные токены, стоимость и длительность (от старта до завершения). */
export function summarizeSwarmSession(session: SwarmSession): SwarmSessionTotals {
  let usage = emptyUsage();
  let costKnown = false;
  let completed = 0;
  let failed = 0;
  for (const agent of session.agents) {
    const u = agentUsage(agent);
    if (u) {
      usage = addUsage(usage, u);
      if (typeof u.costUsd === 'number') costKnown = true;
    } else if (typeof agent.metrics?.costUsd === 'number') {
      usage = { ...usage, costUsd: (usage.costUsd ?? 0) + agent.metrics.costUsd };
      costKnown = true;
    }
    if (agent.status === 'completed') completed++;
    if (agent.status === 'failed' || agent.status === 'budget_exceeded') failed++;
  }
  const end = session.completedAt ?? Math.max(session.createdAt, ...session.agents.map((a) => a.metrics?.endTime ?? 0));
  return {
    usage,
    costUsd: costKnown ? usage.costUsd ?? 0 : undefined,
    costKnown,
    durationMs: Math.max(0, end - session.createdAt),
    agentsCompleted: completed,
    agentsFailed: failed
  };
}

/**
 * Провайдер и модель агента для отчёта (TASK-70.5): снимок API-движка (профиль, id, «локальная»),
 * а для CLI-движков — движок и модель слота.
 */
export function agentProviderLabel(agent: AgentSlotState): string {
  const info = agent.providerInfo;
  if (info) {
    const model = info.model || agent.metrics?.usage?.model;
    return `${describeProviderInfo(info)}${model ? ` · \`${model}\`` : ''}`;
  }
  const model = agent.metrics?.usage?.model || agent.modelRouting?.current?.model || agent.config.providerConfig?.model;
  return `${agent.config.engine}${model && model !== 'default' ? ` · \`${model}\`` : ''}`;
}

/**
 * Тир и переключения модели агента для отчёта (decision-44 п. 8): запрошенный тир, фактическая модель и
 * причина каждого переключения. Без тира — пусто.
 */
export function modelRoutingLines(agent: AgentSlotState, tx: SwarmReportText = swarmReportText()): string[] {
  const routing = agent.modelRouting;
  if (!routing) return [];
  const lines: string[] = [];
  lines.push(tx.modelTier(routing.requestedTier ?? '—', tx.routingSource[routing.source], routing.current ? describeChainLink(routing.current) : undefined));
  if (routing.note) lines.push(tx.tiersNote(routing.note));
  if (routing.switches.length > 0) {
    lines.push(tx.modelSwitches);
    routing.switches.forEach((sw, i) => {
      const waited = sw.waitedMs ? tx.waited(Math.round(sw.waitedMs / 100) / 10) : '';
      lines.push(`  ${i + 1}. \`${describeChainLink(sw.from)}\` → \`${describeChainLink(sw.to)}\`: \`${sw.message}\`${waited}`);
    });
  }
  if (routing.stopped && routing.stopped !== 'not_switchable') {
    lines.push(tx.chainStopped(describeFallbackStop(routing.stopped, routing.maxSwitches ?? MAX_MODEL_SWITCHES)));
  }
  return lines;
}

function checkpointWhere(tx: SwarmReportText, cp: { kind?: string; turn?: number; run?: number }): string {
  return tx.checkpointPoint(cp.kind, cp.kind === 'turn' ? cp.turn : cp.run);
}

/**
 * Чекпоинты и откаты агента для отчёта (decision-45): сколько снимков, какие откаты и куда. Без
 * чекпоинтов и откатов — пусто.
 */
export function checkpointLines(agent: AgentSlotState, tx: SwarmReportText = swarmReportText()): string[] {
  const lines: string[] = [];
  const cps = agent.checkpoints ?? [];
  if (cps.length > 0) {
    const last = cps[cps.length - 1];
    lines.push(tx.checkpoints(cps.length, last.n, checkpointWhere(tx, last), last.commit.slice(0, 7)));
  }
  for (const rw of agent.rewinds ?? []) {
    const cp = cps.find((c) => c.n === rw.toCheckpoint);
    const where = checkpointWhere(tx, { kind: rw.toKind, turn: rw.toTurn, run: cp?.run });
    lines.push(tx.rewind(fmtDate(rw.at), rw.toCheckpoint, where, rw.removedFiles, rw.preRewindCheckpoint, rw.commitHash?.slice(0, 7)));
  }
  return lines;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function fmtDuration(ms: number | undefined, tx: SwarmReportText): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 60_000) return tx.seconds((ms / 1000).toFixed(1));
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return tx.minSec(minutes, seconds);
}

function fmtDate(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function fence(text: string, lang = ''): string {
  // Если внутри уже есть тройные бэктики — удлиняем ограждение.
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${ticks}`;
}

export interface MarkdownExportOptions {
  /** Максимум символов вывода агента в отчёте. */
  maxOutputChars?: number;
  /** Максимум символов диффа агента в отчёте. */
  maxPatchChars?: number;
  includePatch?: boolean;
  /** Язык отчёта — язык хоста (decision-161); по умолчанию английский. */
  lang?: Language;
}

function clip(text: string, limit: number, tx: SwarmReportText): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n${tx.truncated(text.length - limit)}`;
}

/** Markdown-отчёт по сессии: сводка, таблица агентов, вывод и дифф каждого. */
export function exportSwarmSessionMarkdown(session: SwarmSession, options: MarkdownExportOptions = {}): string {
  const maxOutput = options.maxOutputChars ?? 20_000;
  const maxPatch = options.maxPatchChars ?? 30_000;
  const includePatch = options.includePatch !== false;
  const tx = swarmReportText(options.lang);
  const errors = hostText(options.lang).appErrors;
  // Причина с кодом — на языке отчёта, без кода — как есть (decision-165).
  const keyed = (text: string, key?: AppErrorKey) => (key && formatAppError(key, errors)) || text;
  const status = (value: string) => tx.status[value] ?? value;
  const totals = summarizeSwarmSession(session);
  const modeLabel = session.mode === 'handoff' ? tx.modes.handoff : session.mode === 'done_loop' ? tx.modes.doneLoop : tx.modes.fanOut;
  const lines: string[] = [];

  lines.push(tx.title(session.id));
  lines.push('');
  if (session.taskId) lines.push(`- **${tx.task}:** ${session.taskId}${session.taskTitle ? ` — ${session.taskTitle}` : ''}`);
  lines.push(`- **${tx.project}:** \`${session.projectPath}\``);
  lines.push(`- **${tx.mode}:** ${modeLabel}`);
  lines.push(`- **${tx.baseBranch}:** \`${session.baseBranch}\``);
  lines.push(`- **${tx.statusLabel}:** ${status(session.status)}`);
  lines.push(`- **${tx.created}:** ${fmtDate(session.createdAt)}${session.completedAt ? tx.completed(fmtDate(session.completedAt)) : ''}`);
  lines.push(`- **${tx.duration}:** ${fmtDuration(totals.durationMs, tx)}`);
  lines.push(
    `- **${tx.tokens}:** ${formatTokens(totals.usage.totalTokens)} (${tx.tokensDetail(
      formatTokens(totals.usage.inputTokens),
      formatTokens(totals.usage.outputTokens),
      formatTokens(totals.usage.cacheReadTokens),
      formatTokens(totals.usage.cacheCreationTokens)
    )})`
  );
  lines.push(`- **${tx.cost}:** ${totals.costKnown ? formatUsd(totals.costUsd) : tx.unknown}${session.budgetUsd ? tx.budget(formatUsd(session.budgetUsd)) : ''}`);
  if (session.winnerAgentId) {
    const winner = session.agents.find((a) => a.id === session.winnerAgentId);
    lines.push(`- **${tx.winner}:** ${winner?.config.name ?? session.winnerAgentId}`);
  }
  if (session.error) lines.push(`- **${tx.error}:** ${keyed(session.error, session.errorKey)}`);
  lines.push('');
  lines.push(tx.prompt);
  lines.push('');
  lines.push(fence(session.prompt || '', ''));
  lines.push('');

  lines.push(tx.agents);
  lines.push('');
  lines.push(tx.tableHeader);
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const agent of session.agents) {
    const u = agentUsage(agent);
    const approx = u?.estimated ? '~' : '';
    const tokens = u
      ? `${approx}${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens)} / ${approx}${formatTokens(u.outputTokens)}`
      : agent.metrics.tokensEstimated
        ? `~${formatTokens(agent.metrics.tokensEstimated)}`
        : '—';
    const cost = formatAgentCost(u, agent.metrics.costUsd, tx);
    const diff = agent.diffSummary ? tx.files(agent.diffSummary.filesChanged, agent.diffSummary.insertions, agent.diffSummary.deletions) : '—';
    const commit = agent.commitHash ? `\`${agent.commitHash.slice(0, 7)}\`` : agent.stashHash ? `stash \`${agent.stashHash.slice(0, 7)}\`` : '—';
    const name = `${agent.winner || session.winnerAgentId === agent.id ? '🏆 ' : ''}${agent.config.name}`;
    lines.push(
      `| ${name} | ${agent.config.engine} | ${cell(agentProviderLabel(agent))} | ${agent.config.role ?? '—'} | ${status(agent.status)} | ${fmtDuration(agent.metrics.durationMs, tx)} | ${tokens} | ${cost} | ${diff} | ${commit} |`
    );
  }
  lines.push('');

  if (session.mode === 'handoff' && session.handoffStages?.length) {
    lines.push(tx.stages);
    lines.push('');
    for (const stage of session.handoffStages) {
      lines.push(
        `${stage.stageIndex + 1}. **${stage.role}** — ${status(stage.status)}${stage.durationMs ? ` (${fmtDuration(stage.durationMs, tx)})` : ''}` +
          `${stage.invalidatedAt ? tx.stageCancelled(fmtDate(stage.invalidatedAt)) : ''}${stage.rerunCount ? tx.stageReruns(stage.rerunCount) : ''}`
      );
    }
    lines.push('');
  }

  if (session.mode === 'done_loop' && session.doneLoop) {
    const loop = session.doneLoop;
    lines.push(tx.loopIterations);
    lines.push('');
    if (loop.outcome) lines.push(`${tx.loopOutcome}: **${loop.outcome}**${loop.reason ? ` — ${keyed(loop.reason, loop.reasonKey)}` : ''}`, '');
    for (const it of loop.iterations) {
      const failed = it.checks.filter((c) => c.status === 'failed' || c.status === 'timeout' || c.status === 'error').length;
      const accepted = it.criteria.filter((c) => c.accepted).length;
      lines.push(
        `${it.index}. ${tx.iteration(failed, it.checks.length, accepted, it.criteria.length)}` +
          `${typeof it.costUsd === 'number' ? `, ${formatUsd(it.costUsd)}` : ''}${it.decision ? tx.decision(it.decision) : ''}` +
          `${it.rolledBack ? tx.rolledBack(it.rolledBack === 'partial') : ''}${it.segment ? tx.continuationN(it.segment) : ''}`
      );
    }
    lines.push('');
  }

  // Продолжения после отката (decision-48 п. 4).
  if (session.continuations?.length) {
    lines.push(tx.continuations);
    lines.push('');
    for (const c of session.continuations) {
      const agentName = session.agents.find((a) => a.id === c.agentId)?.config.name ?? c.agentId;
      const what =
        c.mode === 'loop'
          ? tx.loopContinued((c.afterIteration ?? 0) + 1)
          : c.mode === 'handoff'
            ? tx.stagesRestarted((c.stages ?? []).map((i) => i + 1).join(', '))
            : tx.agentContinued;
      lines.push(
        `- ${fmtDate(c.at)}: ${agentName} — ${what}${c.toCheckpoint !== undefined ? tx.afterRewind(c.toCheckpoint) : ''}` +
          `${c.instruction ? tx.clarification(cell(c.instruction.slice(0, 300))) : ''}`
      );
    }
    lines.push('');
  }

  for (const agent of session.agents) {
    lines.push(`## ${agent.config.name}`);
    lines.push('');
    lines.push(tx.provider(agentProviderLabel(agent)));
    if (agent.providerInfo?.profileId) lines.push(tx.profile(agent.providerInfo.profileId, Boolean(agent.providerInfo.local)));
    lines.push(...modelRoutingLines(agent, tx));
    // Имя профиля, не e-mail (decision-87 п. 14).
    if (agent.claudeAccount) {
      const cli = agent.config.engine === 'codex-cli' ? 'Codex CLI' : agent.config.engine === 'gemini-cli' ? 'Gemini CLI' : 'Claude Code';
      lines.push(tx.account(cli, agent.claudeAccount.name, tx.accountSource[agent.claudeAccount.source]));
    }
    if (agent.worktreeBranch) lines.push(tx.branch(agent.worktreeBranch));
    if (agent.worktreePath) lines.push(`- Worktree: \`${agent.worktreePath}\``);
    lines.push(...checkpointLines(agent, tx));
    if (agent.error) lines.push(tx.agentError(keyed(agent.error, agent.errorKey)));
    // Вид ошибки провайдера (decision-43) — по нему решается, помог бы fallback (TASK-79).
    if (agent.providerError) lines.push(tx.errorKind(describeProviderErrorBrief(agent.providerError)));
    if (agent.review?.status === 'failed' && agent.review.providerError) {
      lines.push(tx.reviewerUnavailable(describeProviderErrorBrief(agent.review.providerError)));
    }
    const u = agentUsage(agent);
    if (u) {
      const detail =
        tx.usageDetail(formatTokens(u.inputTokens), formatTokens(u.outputTokens), formatTokens(u.cacheReadTokens), formatTokens(u.cacheCreationTokens)) +
        (u.model ? tx.usageModel(u.model) : '') +
        (typeof u.costUsd === 'number' ? tx.usageCost(formatUsd(u.costUsd), tx.costSource[u.costSource]) : '');
      lines.push(tx.usage(Boolean(u.estimated), detail));
    }
    lines.push('');
    const output = agent.finalOutput || agent.liveOutput;
    if (output) {
      lines.push(tx.output);
      lines.push('');
      lines.push(fence(clip(output, maxOutput, tx), ''));
      lines.push('');
    }
    if (includePatch && agent.diffSummary?.patch) {
      lines.push(tx.diff);
      lines.push('');
      lines.push(fence(clip(agent.diffSummary.patch, maxPatch, tx), 'diff'));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** JSON-экспорт: сессия без хвостов логов/потокового вывода, но с итогами и usage. */
export function exportSwarmSessionJson(session: SwarmSession): string {
  const totals = summarizeSwarmSession(session);
  const payload = {
    exportedAt: new Date().toISOString(),
    format: 'projecthub-swarm-session',
    version: 1,
    totals: {
      usage: totals.usage,
      costUsd: totals.costUsd,
      durationMs: totals.durationMs,
      agentsCompleted: totals.agentsCompleted,
      agentsFailed: totals.agentsFailed
    },
    session: {
      ...session,
      agents: session.agents.map((a) => ({
        ...a,
        logs: undefined,
        liveOutput: undefined,
        liveOutputTruncated: undefined,
        config: a.config.providerConfig
          ? { ...a.config, providerConfig: { ...a.config.providerConfig, apiKey: undefined } }
          : a.config
      }))
    }
  };
  return JSON.stringify(payload, null, 2);
}
