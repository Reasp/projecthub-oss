/**
 * Настройка индексации GitNexus в проекте (decision-131, TASK-176): чтение блока ProjectHub из
 * `.gitnexusignore`, предпросмотр области индексации, запись блока и переиндексация через processManager.
 * Чистая часть — `codeIndexProfiles.ts`, `codeIndexScan.ts`, `gitnexusIgnoreRules.ts`; здесь только диск и процессы.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { detectStacks } from './initStack';
import {
  defaultIndexSettings,
  gitnexusAnalyzeCommand,
  INDEX_GROUPS,
  INDEX_PROFILES,
  normalizeIndexSettings,
  parseGitnexusIgnore,
  profilesForStacks,
  renderIndexBlock,
  upsertIndexBlock,
  type CodeIndexSettings,
  type IndexContext,
  type IndexGroup,
  type IndexLocale,
  type IndexProfile,
  type IndexProfileId
} from './codeIndexProfiles';
import { findMarketplacePlugins, scanIndexScope, type IndexScanResult } from './codeIndexScan';
import type { ManagedProcess } from '../../src/types/electron';
import { processManager } from './processManager';
import { projectGraphService } from './projectGraphService';

export const GITNEXUS_IGNORE_FILE = '.gitnexusignore';
/** Имя процесса переиндексации в processManager: по нему интерфейс ждёт завершения. */
export const GITNEXUS_ANALYZE_PROCESS = 'gitnexus-analyze';

export interface CodeIndexState {
  stacks: Array<{ id: string; label: string }>;
  /** Профили, предложенные по стеку. */
  suggested: IndexProfileId[];
  /** Сохранённые в блоке настройки, а если блока нет — по умолчанию для предложенных профилей. */
  settings: CodeIndexSettings;
  /** Блок ProjectHub уже есть в `.gitnexusignore`. */
  saved: boolean;
  /** Блок открыт, но не закрыт: запись запрещена. */
  broken: boolean;
  context: IndexContext;
  /** Строки пользователя вне блока (без пустых и комментариев). */
  userLines: string[];
  index: { indexedAt: string | null; files: number | null; rulesChanged: boolean } | null;
  catalog: { profiles: readonly IndexProfile[]; groups: readonly IndexGroup[] };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Профили и контекст для каталога: стек по именам корня и найденные плагины маркетплейса. */
export async function detectIndexProfiles(root: string): Promise<{ stacks: Array<{ id: string; label: string }>; suggested: IndexProfileId[]; context: IndexContext }> {
  const names = existsSync(root) ? await fs.readdir(root) : [];
  const stacks = detectStacks(names);
  const suggested = profilesForStacks(stacks.map((stack) => stack.id));
  const context: IndexContext = { marketplacePlugins: suggested.includes('unreal') ? await findMarketplacePlugins(root) : [] };
  return { stacks: stacks.map(({ id, label }) => ({ id, label })), suggested, context };
}

async function mtimeMs(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readIndexMeta(root: string): Promise<CodeIndexState['index']> {
  const metaPath = path.join(root, '.gitnexus', 'meta.json');
  const text = await readText(metaPath);
  if (text === null) return null;
  try {
    const meta = JSON.parse(text) as { indexedAt?: unknown; stats?: { files?: unknown } };
    const indexedAt = typeof meta.indexedAt === 'string' ? meta.indexedAt : null;
    const at = indexedAt ? Date.parse(indexedAt) : NaN;
    const rulesAt = Math.max(await mtimeMs(path.join(root, GITNEXUS_IGNORE_FILE)), await mtimeMs(path.join(root, '.gitignore')));
    return {
      indexedAt,
      files: typeof meta.stats?.files === 'number' ? meta.stats.files : null,
      // Правила новее индекса — полная пересборка (decision-131 п. 9): инкрементальный проход убирает файлы,
      // но оставляет в графе папки исключённых каталогов.
      rulesChanged: Number.isFinite(at) && rulesAt > at
    };
  } catch {
    return { indexedAt: null, files: null, rulesChanged: false };
  }
}

function userPatternLines(userText: string): string[] {
  return userText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export async function getCodeIndexState(root: string): Promise<CodeIndexState> {
  const detected = await detectIndexProfiles(root);
  const parsed = parseGitnexusIgnore(await readText(path.join(root, GITNEXUS_IGNORE_FILE)));
  return {
    stacks: detected.stacks,
    suggested: detected.suggested,
    settings: parsed.settings ?? defaultIndexSettings(detected.suggested),
    saved: parsed.hasBlock,
    broken: parsed.broken,
    context: detected.context,
    userLines: userPatternLines(parsed.userText),
    index: await readIndexMeta(root),
    catalog: { profiles: INDEX_PROFILES, groups: INDEX_GROUPS }
  };
}

function requireSettings(raw: unknown): CodeIndexSettings {
  const settings = normalizeIndexSettings(raw);
  if (!settings) throw new Error('Некорректные настройки индексации');
  return settings;
}

/** Текст `.gitnexusignore` с новым блоком. Бросает `BrokenIndexBlockError`, если блок не закрыт. */
async function nextIgnoreText(root: string, settings: CodeIndexSettings, locale: IndexLocale): Promise<{ existing: string | null; next: string }> {
  const existing = await readText(path.join(root, GITNEXUS_IGNORE_FILE));
  const { context } = await detectIndexProfiles(root);
  return { existing, next: upsertIndexBlock(existing, renderIndexBlock(settings, context, locale)) };
}

export async function previewCodeIndex(root: string, rawSettings: unknown, locale: IndexLocale): Promise<IndexScanResult> {
  const settings = requireSettings(rawSettings);
  const { existing, next } = await nextIgnoreText(root, settings, locale);
  const parsed = parseGitnexusIgnore(existing);
  // GITNEXUS_NO_GITIGNORE отключает чтение .gitignore у самого GitNexus — предпросмотр следует тому же.
  const gitignore = process.env.GITNEXUS_NO_GITIGNORE ? null : await readText(path.join(root, '.gitignore'));
  return scanIndexScope({ root, gitignore, before: existing === null ? null : parsed.userText, after: next });
}

export async function saveCodeIndexSettings(root: string, rawSettings: unknown, locale: IndexLocale): Promise<{ changed: boolean }> {
  const settings = requireSettings(rawSettings);
  const { existing, next } = await nextIgnoreText(root, settings, locale);
  if (existing === next) return { changed: false };
  await fs.writeFile(path.join(root, GITNEXUS_IGNORE_FILE), next, 'utf-8');
  return { changed: true };
}

/**
 * Переиндексация в фоне через processManager: процесс виден на вкладке процессов, дубль по имени не запустится.
 * Правила новее индекса — полная пересборка (`--force`), иначе в графе останутся папки исключённых каталогов.
 * `gitnexus serve` вкладки графа держит базу индекса — гасим его до analyze, вкладка поднимет сервер заново.
 */
export async function reindexCodeGraph(root: string, force: boolean): Promise<ManagedProcess> {
  const full = force || Boolean((await readIndexMeta(root))?.rulesChanged);
  projectGraphService.shutdown();
  return processManager.startProcess(root, gitnexusAnalyzeCommand(full), GITNEXUS_ANALYZE_PROCESS);
}
