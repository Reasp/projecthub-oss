/**
 * Политика заведения задач агентами (TASK-153, decision-89).
 *
 * Задача, которую агент завёл без человека, получает метку `agent-created` и автора в `reporter`
 * (нативное поле Backlog.md). Пока метка стоит, ни автозапуск назначенных задач, ни правила
 * Automations с запуском агента такую задачу не берут; человек подтверждает её в окне ProjectHub,
 * и метка снимается. Так цепочка «агент завёл → агент назначил → автозапуск выполнил → тот завёл
 * следующие» обрывается на первом же шаге.
 *
 * Чистый модуль без Electron: решения проверяются unit-тестами.
 */
import { parseAssignee } from '../../src/utils/assignee.js';
import { AGENT_CREATED_LABEL, isAwaitingApproval, withoutApprovalLabel } from '../../src/utils/agentTask.js';
import type { RolePermissions, TaskCreateMode } from './hitlTypes.js';

export type { TaskCreateMode };
export { AGENT_CREATED_LABEL, isAwaitingApproval, withoutApprovalLabel };

/** Лимиты на задачи, заведённые агентами. */
export const AGENT_TASK_LIMITS = {
  /** На одну сессию агента. */
  perSession: 10,
  /** На проект за последние 24 часа — по файлам задач с автором-агентом, поэтому переживает перезапуск. */
  perProjectPerDay: 30
} as const;

export interface AgentTaskLimits {
  perSession: number;
  perProjectPerDay: number;
}

/** Допустимые значения лимитов в настройке (TASK-155): меньше одного — это уже режим `deny` роли. */
export const AGENT_TASK_LIMIT_BOUNDS = {
  perSession: { min: 1, max: 200 },
  perProjectPerDay: { min: 1, max: 1000 }
} as const;

function clampLimit(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

/** Лимиты из настройки: нечисло — значение по умолчанию, выход за границы — ближайшая граница. */
export function normalizeAgentTaskLimits(raw: unknown): AgentTaskLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    perSession: clampLimit(r.perSession, AGENT_TASK_LIMIT_BOUNDS.perSession, AGENT_TASK_LIMITS.perSession),
    perProjectPerDay: clampLimit(r.perProjectPerDay, AGENT_TASK_LIMIT_BOUNDS.perProjectPerDay, AGENT_TASK_LIMITS.perProjectPerDay)
  };
}

export const TASK_CREATE_MODES: readonly TaskCreateMode[] = ['propose', 'ask', 'deny'];

export function isTaskCreateMode(value: unknown): value is TaskCreateMode {
  return typeof value === 'string' && (TASK_CREATE_MODES as readonly string[]).includes(value);
}

/** Метки с `agent-created` (без дубля). */
export function withApprovalLabel(labels: readonly string[]): string[] {
  return isAwaitingApproval(labels) ? [...labels] : [...labels, AGENT_CREATED_LABEL];
}

/**
 * Агент переписывает метки задачи целиком: снять `agent-created` он не может, метка возвращается.
 * Поставить её сам — может (это только сужает).
 */
export function preserveApprovalLabel(previous: readonly string[], next: readonly string[]): string[] {
  return isAwaitingApproval(previous) ? withApprovalLabel(next) : [...next];
}

/**
 * Автор задачи в `reporter`: `agent:<slug роли>`, без роли — `agent:<источник>` (`agent:terminal`, `agent:external`).
 * У агентов Swarm `role` — отображаемое имя, поэтому slug важнее.
 */
export function agentReporter(ctx: { roleSlug?: string; role?: string; origin?: string }): string {
  const who = (ctx.roleSlug || ctx.role || ctx.origin || 'unknown').trim().replace(/\s+/g, '-');
  return `agent:${who}`;
}

/** Задачу завёл агент (по `reporter`). */
export function isAgentReporter(reporter: unknown): boolean {
  return typeof reporter === 'string' && reporter.trim().toLowerCase().startsWith('agent:');
}

/**
 * Режим заведения задач для вызова. Явное поле роли `permissions.taskCreate` важнее всего.
 * Роль без поля — `ask`: команда агентов ProjectHub заводит задачи через карточку, свободное заведение —
 * право роли «менеджер». Без роли (терминал по токену агента проекта, внешний MCP-клиент) человек
 * сам ведёт сессию — `propose`: задача создаётся, но ждёт подтверждения.
 */
export function resolveTaskCreateMode(ctx: { role?: string; permissions?: RolePermissions }): TaskCreateMode {
  const explicit = ctx.permissions?.taskCreate;
  if (isTaskCreateMode(explicit)) return explicit;
  return ctx.role ? 'ask' : 'propose';
}

export type TaskCreateDecision =
  | { action: 'create-pending' }
  | { action: 'ask' }
  | { action: 'deny'; reason: 'role-deny' | 'session-limit' | 'daily-limit'; message: string };

/** Что делать с `task_create`: создать с меткой, спросить человека или отказать. */
export function decideTaskCreate(input: {
  mode: TaskCreateMode;
  /** Сколько задач эта сессия уже завела. */
  sessionCount: number;
  /** Сколько задач агенты завели в проекте за последние 24 часа. */
  dayCount: number;
  limits?: AgentTaskLimits;
}): TaskCreateDecision {
  const limits = input.limits ?? AGENT_TASK_LIMITS;
  if (input.mode === 'deny') {
    return { action: 'deny', reason: 'role-deny', message: 'Роли запрещено заводить задачи (permissions.taskCreate: deny). Опиши задачу в ответе — человек заведёт её сам.' };
  }
  if (input.sessionCount >= limits.perSession) {
    return {
      action: 'deny',
      reason: 'session-limit',
      message: `Лимит: не больше ${limits.perSession} задач за сессию агента. Перечисли оставшиеся в ответе — человек решит, заводить ли их.`
    };
  }
  if (input.dayCount >= limits.perProjectPerDay) {
    return {
      action: 'deny',
      reason: 'daily-limit',
      message: `Лимит: агенты уже завели ${input.dayCount} задач в проекте за последние 24 часа (не больше ${limits.perProjectPerDay}). Подожди подтверждения человека.`
    };
  }
  return input.mode === 'ask' ? { action: 'ask' } : { action: 'create-pending' };
}

/** Назначения на агентов, которых не было: `agent:<role>[@host]`. */
export function addedAgentAssignees(previous: readonly string[], next: readonly string[]): string[] {
  const before = new Set(previous.map((a) => a.trim().toLowerCase()));
  return next.filter((a) => parseAssignee(a)?.kind === 'agent' && !before.has(a.trim().toLowerCase()));
}

/**
 * Можно ли агенту поменять исполнителя задачи. Назначить агента на подтверждённую задачу может только
 * человек (как делегирование агенту в Linear и назначение Copilot в GitHub): иначе агент взял бы любую
 * задачу человека и отдал её автозапуску. На неподтверждённой задаче — можно: она всё равно ждёт человека.
 */
export function canAgentChangeAssignee(input: { labels: readonly string[]; previous: readonly string[]; next: readonly string[] }): boolean {
  if (isAwaitingApproval(input.labels)) return true;
  return addedAgentAssignees(input.previous, input.next).length === 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `created_date` Backlog.md (`YYYY-MM-DD HH:mm` или `YYYY-MM-DD`) — время UTC, как его пишут сам Backlog.md и
 * `nowBacklogTimestamp`. Невалидное значение — `null`.
 */
export function parseBacklogTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isFinite(at) ? at : null;
}

/**
 * Сколько задач с автором-агентом создано за последние 24 часа (по `reporter` и `created_date`).
 * Скользящее окно, а не календарный день: не зависит от часового пояса и не обнуляется в полночь.
 */
export function countAgentTasksLastDay(tasks: ReadonlyArray<{ reporter?: unknown; created?: unknown }>, now: number): number {
  return tasks.filter((t) => {
    if (!isAgentReporter(t.reporter)) return false;
    const at = parseBacklogTimestamp(t.created);
    return at !== null && at <= now && now - at < DAY_MS;
  }).length;
}

const TASK_DIR_RE = /(^|\/)backlog\/(tasks|drafts)\//i;
const BACKLOG_CLI_CREATE_RE = /\bbacklog(?:\.md)?\s+(?:task|draft)\s+(?:create|promote)\b/i;
const BACKLOG_CLI_EDIT_RE = /\bbacklog(?:\.md)?\s+task\s+edit\b/i;
const BACKLOG_CLI_RISKY_FLAG_RE = /(?:^|\s)(?:-a|--assignee|-l|--label|--labels|--remove-label|--add-label)(?:[\s=]|$)/i;

/**
 * Обход политики в автономном запуске (Automations, автозапуск назначенной задачи): создать задачу или
 * назначить агента мимо `task_create`/`task_update` ProjectHub — через нативный MCP Backlog.md, запись
 * файла задачи или CLI `backlog`. Возвращает причину отказа или `null`. Правка своей задачи (статус,
 * заметки, критерии) не затрагивается; на назначение агента и метки — отказ.
 */
export function autonomousTaskWriteViolation(tool: string, input: Record<string, unknown>): string | null {
  const redirect = 'В автономном запуске задачи заводятся и меняются только инструментами ProjectHub task_create/task_update (decision-89).';
  if (/^mcp__backlog__(task_create|draft_)/i.test(tool)) return redirect;
  if (/^mcp__backlog__task_edit$/i.test(tool) && Object.keys(input).some((k) => /assignee|label/i.test(k))) return redirect;

  const filePath = String(input.file_path || input.filePath || input.path || '').replace(/\\/g, '/');
  if (filePath && TASK_DIR_RE.test(filePath)) {
    if (tool === 'Write' || tool === 'write_file' || tool === 'write_to_file') return redirect;
    if (tool === 'Edit' || tool === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
      const risky = edits.some((e) => {
        const before = String(e.old_string ?? '');
        const after = String(e.new_string ?? '');
        const assignsAgent = /agent:/i.test(after) && !/agent:/i.test(before);
        const dropsLabel = before.toLowerCase().includes(AGENT_CREATED_LABEL) && !after.toLowerCase().includes(AGENT_CREATED_LABEL);
        return assignsAgent || dropsLabel;
      });
      if (risky) return redirect;
    }
  }

  const command = String(input.command || input.cmd || '');
  if (command) {
    if (BACKLOG_CLI_CREATE_RE.test(command)) return redirect;
    if (BACKLOG_CLI_EDIT_RE.test(command) && BACKLOG_CLI_RISKY_FLAG_RE.test(command)) return redirect;
  }
  return null;
}

/** Нормализует `assignee` из аргументов инструмента: строка, список или строка через запятую. */
export function assigneeList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}
