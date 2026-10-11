/**
 * Разбор результата `claude -p /usage` (TASK-126). Чистый модуль без Electron и Node API.
 *
 * Непустой stdout успехом не является: профиль без входа отвечает на `/usage` сводкой стоимости
 * сессии («Total cost: $0.0000 …») с кодом 0, а отказ авторизации CLI тоже пишет в stdout.
 * Успех — только вывод, в котором есть хотя бы одна строка лимита.
 */

export type ClaudeUsageCliErrorKind = 'auth' | 'timeout' | 'failed' | 'unrecognized';

export interface ClaudeUsageCliError {
  kind: ClaudeUsageCliErrorKind;
  /** Первая строка ответа CLI, обрезанная до DETAIL_MAX_LENGTH. */
  detail?: string;
}

export interface ClaudeUsageCliResult {
  /** stdout CLI как есть (обрезаны края) — для вкладки «Сырой вывод». */
  text: string;
  error?: ClaudeUsageCliError;
}

const LIMIT_LINE = /Current (?:session|week)[^\r\n:]*:\s*\d+%\s*used/i;
const AUTH_FAILURE =
  /failed to authenticate|oauth session expired|oauth token has expired|not logged in|please run \/login|invalid api key|authentication_error/i;
const DETAIL_MAX_LENGTH = 300;

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return undefined;
  return line.length > DETAIL_MAX_LENGTH ? `${line.slice(0, DETAIL_MAX_LENGTH)}…` : line;
}

/** Ответ `claude auth status` (JSON) говорит, что в профиле нет входа. Не JSON — не знаем, значит `false`. */
export function isLoggedOutAuthStatus(stdout: string): boolean {
  try {
    const status: unknown = JSON.parse(stdout);
    return typeof status === 'object' && status !== null && (status as { loggedIn?: unknown }).loggedIn === false;
  } catch {
    return false;
  }
}

export function interpretUsageCliResult(code: number | null, stdout: string, stderr: string): ClaudeUsageCliResult {
  const text = stdout.trim();
  if (LIMIT_LINE.test(text)) return { text };

  const errText = stderr.trim();
  const combined = [text, errText].filter(Boolean).join('\n');
  const detail = firstLine(combined);

  if (AUTH_FAILURE.test(combined)) return { text, error: { kind: 'auth', detail } };
  if (code !== 0) return { text, error: { kind: 'failed', detail: detail ?? `exit code ${code}` } };
  // Код 0, но лимитов в тексте нет: профиль без подписки или входа, либо формат вывода изменился.
  return { text, error: { kind: 'unrecognized' } };
}
