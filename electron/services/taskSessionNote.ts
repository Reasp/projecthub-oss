/**
 * Заметка хода (TASK-76, decision-51 п. 8): по завершении сессии агента, привязанной к задаче,
 * harness дописывает в `## Implementation Notes` задачи основного дерева одну короткую запись —
 * исход, агенты, итерации, стоимость, ветка и коммит, итог агента. Одна запись на сессию: у цикла
 * «до готовности» она не задваивается с `Final Summary`, а при провале остаётся единственным следом
 * попытки. Пишет harness, а не агент — заметка есть у любого движка и любой модели.
 *
 * `formatSessionNote` — чистая функция; `appendSessionNoteToTask` — запись в файл задачи.
 */
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { applyImplementationNote, normalizeFrontmatter, nowBacklogTimestamp, withUpdatedDate } from './backlogTaskFormat.js';
import { findTaskFile } from './taskFileLookup.js';
import { redactSecrets } from './hitlAudit.js';
import type { SwarmMode } from './swarmTypes.js';
import type { Language } from '../../src/i18n/types.js';
import { formatAppError, type AppErrorKey } from '../../src/lib/appError.js';
import { hostText } from '../i18n/hostText.js';

/** Сколько символов итога агента попадает в заметку. */
export const NOTE_SUMMARY_MAX = 600;

export type SessionNoteStatus = 'completed' | 'failed' | 'stopped';

export interface SessionNoteAgent {
  name: string;
  role?: string;
  engine: string;
  model?: string;
  status: string;
  branch?: string;
  commitHash?: string;
  costUsd?: number;
}

export interface SessionNoteInput {
  at: Date;
  mode: SwarmMode;
  status: SessionNoteStatus;
  error?: string;
  /** Код причины: заметка собирает её на языке хоста (decision-165). */
  errorKey?: AppErrorKey;
  totalCostUsd?: number;
  agents: SessionNoteAgent[];
  /** Число итераций цикла «до готовности»; для остальных режимов — нет. */
  iterations?: number;
  /** Итог: `summary` отчёта цикла или финальное сообщение агента. */
  summary?: string;
  /** Номер продолжения после отката (decision-48), 0 — исходный запуск. */
  continuation?: number;
  /** Язык хоста (decision-161): файл задачи читает человек. По умолчанию английский. */
  lang?: Language;
}

const usd = (v: number) => `$${v.toFixed(v < 0.01 ? 4 : 2)}`;

/**
 * Исход сессии для заметки. Сессия арены или конвейера получает `completed`, даже если ни один агент не
 * справился, — в заметке это провал: иначе «успех» стоял бы рядом с упавшим агентом.
 */
export function resolveNoteStatus(sessionStatus: SessionNoteStatus, agentStatuses: readonly string[]): SessionNoteStatus {
  if (sessionStatus !== 'completed' || agentStatuses.length === 0) return sessionStatus;
  return agentStatuses.some((s) => s === 'completed') ? 'completed' : 'failed';
}

/** Текст одной строкой: переводы строк и заголовки Markdown не должны ломать секцию задачи. */
function oneLine(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Итог агента: одна строка, без секретов, не длиннее лимита; у длинного берётся конец — там вывод. */
export function noteSummary(text: string | undefined, max = NOTE_SUMMARY_MAX): string {
  if (!text) return '';
  const flat = redactSecrets(oneLine(text));
  return flat.length > max ? `…${flat.slice(flat.length - max).trimStart()}` : flat;
}

export function formatSessionNote(input: SessionNoteInput): string {
  const host = hostText(input.lang);
  const tx = host.sessionNote;
  const head: string[] = [tx.modes[input.mode] ?? input.mode, tx.statuses[input.status]];
  if (typeof input.iterations === 'number') head.push(tx.iterations(input.iterations));
  if (typeof input.totalCostUsd === 'number') head.push(usd(input.totalCostUsd));
  if (input.continuation) head.push(tx.continuation(input.continuation));

  const lines = [tx.header(nowBacklogTimestamp(input.at), head.join(', '))];
  if (input.status !== 'completed' && input.error) {
    const reason = (input.errorKey && formatAppError(input.errorKey, host.appErrors)) || input.error;
    lines.push(tx.reason(noteSummary(reason, 300)));
  }
  for (const a of input.agents) {
    const who = [a.role, a.engine, a.model].filter(Boolean).join(', ');
    const parts = [`- ${oneLine(a.name)} (${who}): ${a.status}`];
    if (a.branch) parts.push(tx.branch(a.branch));
    if (a.commitHash) parts.push(tx.commit(a.commitHash.slice(0, 7)));
    if (typeof a.costUsd === 'number' && input.agents.length > 1) parts.push(usd(a.costUsd));
    lines.push(parts.join(', '));
  }
  const summary = noteSummary(input.summary);
  if (summary) lines.push(tx.summary(summary));
  return lines.join('\n');
}

const locks = new Map<string, Promise<unknown>>();

/** Сериализует чтение-правку-запись одного файла: две сессии одной задачи не затрут заметки друг друга. */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = filePath.toLowerCase();
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Дописывает заметку в файл задачи основного дерева проекта. Нет файла задачи — false; окончания
 * строк файла сохраняются, `updated_date` обновляется как у правок из GUI.
 *
 * Гонки с циклом «до готовности» нет по порядку событий: `Final Summary` он пишет до перевода сессии в
 * конечный статус, а отмену итога при откате (decision-48) — только по действию человека над уже
 * завершённой сессией.
 */
export async function appendSessionNoteToTask(projectPath: string, taskId: string, note: string): Promise<boolean> {
  return updateTaskFile(projectPath, taskId, (data, content) => ({ data, content: applyImplementationNote(content, note) }));
}

/**
 * Правка файла задачи основного дерева: frontmatter и тело под блокировкой файла, `updated_date` — как у правок из
 * GUI, запись атомарно. Нет файла задачи — false. Общий путь заметки хода и проверки задачи с телефона (TASK-140.5).
 */
export async function updateTaskFile(
  projectPath: string,
  taskId: string,
  mutate: (data: Record<string, unknown>, content: string) => { data: Record<string, unknown>; content: string }
): Promise<boolean> {
  const task = await findTaskFile(projectPath, taskId);
  if (!task) return false;
  return withFileLock(task.filePath, async () => {
    const raw = await fs.readFile(task.filePath, 'utf-8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const parsed = matter(raw.replace(/\r\n/g, '\n'), {});
    const next = mutate({ ...parsed.data }, parsed.content);
    const text = matter.stringify(next.content, normalizeFrontmatter(withUpdatedDate(next.data)));
    // Атомарно: writeFile сначала обнуляет файл, и вотчер Backlog, UI или тест прочли бы пустую задачу
    const tmp = `${task.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, eol === '\n' ? text : text.replace(/\n/g, eol), 'utf-8');
    try {
      await fs.rename(tmp, task.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return true;
  });
}
