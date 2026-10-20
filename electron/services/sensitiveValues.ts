/**
 * Реестр известных секретных значений (decision-102 п. 8, TASK-138.1).
 *
 * Шаблоны `secretPatterns` ловят типичные форматы ключей, но токен OAuth может выглядеть как угодно.
 * Слой подключений регистрирует здесь каждое значение, которое загрузил или получил от сервиса, а
 * файловый логгер и маскировка аудита HITL вычищают такие значения дословно.
 *
 * Чистый модуль: без Electron и файловой системы.
 */

/** Короткие значения не регистрируются: они дали бы ложные замены в обычном тексте. */
export const MIN_SENSITIVE_LENGTH = 8;
export const SENSITIVE_MASK = '***';

const values = new Map<string, number>();
let ordered: string[] | null = null;

/** Запомнить значение. Повторная регистрация увеличивает счётчик ссылок. */
export function registerSensitiveValue(value: string | null | undefined): void {
  if (!value || value.length < MIN_SENSITIVE_LENGTH) return;
  values.set(value, (values.get(value) ?? 0) + 1);
  ordered = null;
}

/** Забыть значение (подключение удалено, токен заменён). */
export function unregisterSensitiveValue(value: string | null | undefined): void {
  if (!value) return;
  const count = values.get(value);
  if (count === undefined) return;
  if (count <= 1) values.delete(value);
  else values.set(value, count - 1);
  ordered = null;
}

export function sensitiveValueCount(): number {
  return values.size;
}

/** Для тестов. */
export function clearSensitiveValues(): void {
  values.clear();
  ordered = null;
}

/** Заменить все известные значения на `***`. Длинные заменяются первыми: одно может содержать другое. */
export function redactSensitiveValues(text: string): string {
  if (!text || values.size === 0) return text;
  if (!ordered) ordered = [...values.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of ordered) {
    if (out.includes(value)) out = out.split(value).join(SENSITIVE_MASK);
  }
  return out;
}
