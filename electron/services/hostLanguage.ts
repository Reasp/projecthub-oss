import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { app } from 'electron';
import { resolveInitialLanguage } from '../../src/i18n/initialLanguage.js';
import type { Language } from '../../src/i18n/types.js';
import { getUserDataDir } from './appPaths.js';
import { logger } from './logger.js';

/**
 * Язык текстов, которые рисует сам хост (TASK-205, [[decision-161]]): системные уведомления, Telegram, рабочие чаты,
 * меню трея, служебные строки main в ответах Studio. Это язык интерфейса окна: рендерер сообщает его через
 * `notifications:setHostLanguage` при запуске и при смене, main хранит выбор в `<userData>/ui-language.json`. До первого
 * сообщения (окно ещё не открыто, ph-agent без окна) — язык системы, иначе английский.
 *
 * Телефон этот язык не использует: он получает коды и собирает текст на языке устройства.
 */

const FILE = 'ui-language.json';

let current: Language | null = null;
const listeners = new Set<(lang: Language) => void>();

function systemLanguages(): string[] {
  try {
    const own = (app as { getPreferredSystemLanguages?: () => string[] } | undefined)?.getPreferredSystemLanguages?.();
    if (own?.length) return own;
  } catch {
    // Мок `electron` в тестах и shim ph-agent без метода.
  }
  return [process.env.LC_ALL, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale].filter((v): v is string => Boolean(v));
}

/** Файл выбора языка окна. Его читает бот-воркер Telegram, чтобы смена языка доходила без перезапуска (decision-164). */
export function getHostLanguageFile(): string {
  return path.join(getUserDataDir(), FILE);
}

function readStored(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(getHostLanguageFile(), 'utf8')) as { language?: unknown };
    return typeof parsed.language === 'string' ? parsed.language : null;
  } catch {
    return null;
  }
}

async function save(lang: Language): Promise<void> {
  const dir = getUserDataDir();
  const tmp = path.join(dir, `${FILE}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify({ language: lang }), 'utf8');
  await rename(tmp, path.join(dir, FILE));
}

export function getHostLanguage(): Language {
  if (!current) current = resolveInitialLanguage(readStored(), systemLanguages());
  return current;
}

/** Язык интерфейса окна сменился (или пришёл при запуске). Неизвестное значение игнорируется. */
export function setHostLanguage(value: unknown): Language {
  if (value !== 'en' && value !== 'ru') return getHostLanguage();
  const changed = getHostLanguage() !== value;
  current = value;
  if (!changed) return value;
  void save(value).catch((err) =>
    logger.warn(`[hostLanguage] не удалось сохранить язык: ${err instanceof Error ? err.message : String(err)}`)
  );
  for (const listener of listeners) listener(value);
  return value;
}

export function onHostLanguageChange(listener: (lang: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Для тестов: забыть вычисленный язык. */
export function resetHostLanguageForTests(lang: Language | null = null): void {
  current = lang;
  listeners.clear();
}
