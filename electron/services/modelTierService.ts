import { promises as fs } from 'fs';
import path from 'path';
import { getUserDataDir } from './appPaths.js';
import { llmProfileService } from './llmProfileService.js';
import { llmModelCatalogService } from './llmModelCatalogService.js';
import { aiAgentService } from './aiAgentService.js';
import { claudeBridgeService } from './claudeBridgeService.js';
import { mainEngineOf } from './modelTarget.js';
import {
  emptyModelTierSettings,
  normalizeModelTierSettings,
  seedModelTiers,
  type ModelTierSettings,
  type TierSeedInput
} from './modelTiers.js';
import { stateFields, withVersion } from './stateFiles.js';
import type { AppErrorKey } from '../../src/lib/appError.js';

export const MODEL_TIERS_FILE = 'model-tiers.json';
/** Версия формата файла (decision-104). */
export const MODEL_TIERS_VERSION = 1;

export interface ModelTierState {
  settings: ModelTierSettings;
  filePath: string;
  /** Файл есть, но не прочитан (битый JSON): тиры пусты, сохранение перезапишет файл. */
  loadError?: string;
  /** Записи, отброшенные при чтении (неизвестный движок, пустая модель, повтор), — английский текст. */
  problems: string[];
  /** Те же записи кодом (decision-165), по порядку `problems`. */
  problemKeys?: AppErrorKey[];
}

export interface ModelTierSeedResult extends ModelTierState {
  /** Сколько звеньев добавлено заполнением. */
  added: number;
}

/**
 * Что настроено у пользователя — для первичного заполнения тиров (decision-44 п. 3). Без сети: профили,
 * кэш их каталогов, модель Agents Studio и ответ `claude --version`.
 */
export async function collectTierSeedInput(): Promise<TierSeedInput> {
  const [profiles, catalogs, aiStudio, cli] = await Promise.all([
    llmProfileService.listProfiles().catch(() => []),
    llmModelCatalogService.cachedModels().catch(() => ({})),
    aiAgentService.getConfig().catch(() => undefined),
    claudeBridgeService.ensureClaudeCliAvailable().catch(() => ({ available: false }))
  ]);
  return {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, local: p.local })),
    catalogs,
    ...(aiStudio
      ? { aiStudio: { provider: aiStudio.provider, profileId: aiStudio.profileId, model: aiStudio.model, engine: mainEngineOf(aiStudio) } }
      : {}),
    claudeCli: cli.available === true
  };
}

/**
 * Таблица тиров моделей `<userData>/model-tiers.json` (TASK-79, decision-44): чтение, атомарная запись по
 * очереди, первичное заполнение при отсутствии файла и по кнопке. Битый файл не ломает запуск агентов:
 * тиры считаются пустыми, и слот работает как без тира.
 */
export class ModelTierService {
  private state: ModelTierState | null = null;
  private loading: Promise<ModelTierState> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePathOverride?: string,
    private readonly seedSource: () => Promise<TierSeedInput> = collectTierSeedInput
  ) {}

  get filePath(): string {
    return this.filePathOverride ?? path.join(getUserDataDir(), MODEL_TIERS_FILE);
  }

  /** Таблица; файл читается один раз, при его отсутствии — заполняется из настроенного и сохраняется. */
  async getState(): Promise<ModelTierState> {
    if (this.state) return this.state;
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async getSettings(): Promise<ModelTierSettings> {
    return (await this.getState()).settings;
  }

  /** Перечитать файл (например, после ручной правки). */
  async reload(): Promise<ModelTierState> {
    this.state = null;
    return this.getState();
  }

  /** Сохраняет таблицу целиком (ввод из UI нормализуется) и сразу применяет её. */
  async save(raw: unknown): Promise<ModelTierState> {
    const { settings, problems, problemKeys } = normalizeModelTierSettings(raw);
    await this.write(settings);
    this.state = { settings, filePath: this.filePath, problems, problemKeys };
    console.log(`[ModelTierService] Сохранены тиры моделей: ${countEntries(settings)} звеньев`);
    return this.state;
  }

  /**
   * «Заполнить из настроенного»: добавляет недостающие звенья к текущей таблице, ручные записи не трогает.
   * Ничего не сохраняет — результат попадает в черновик UI и сохраняется общей кнопкой.
   */
  async seed(base?: unknown): Promise<ModelTierSeedResult> {
    const current = base === undefined ? (await this.getState()).settings : normalizeModelTierSettings(base).settings;
    const { settings, added } = seedModelTiers(await this.seedSource(), current);
    return { settings, added, filePath: this.filePath, problems: [] };
  }

  private async load(): Promise<ModelTierState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[ModelTierService] Не удалось прочитать model-tiers.json, тиры пусты:', err);
        this.state = { settings: emptyModelTierSettings(), filePath: this.filePath, problems: [], loadError: errorText(err) };
        return this.state;
      }
      return this.firstRun();
    }
    try {
      const { settings, problems, problemKeys } = normalizeModelTierSettings(stateFields(JSON.parse(raw), MODEL_TIERS_VERSION));
      if (problems.length > 0) console.warn(`[ModelTierService] Skipped tier entries: ${problems.join('; ')}`);
      this.state = { settings, filePath: this.filePath, problems, problemKeys };
    } catch (err) {
      console.warn('[ModelTierService] model-tiers.json не разобран, тиры пусты:', err);
      this.state = { settings: emptyModelTierSettings(), filePath: this.filePath, problems: [], loadError: errorText(err) };
    }
    return this.state;
  }

  /** Файла нет: заполнение из настроенного и запись, чтобы следующий запуск не угадывал заново. */
  private async firstRun(): Promise<ModelTierState> {
    let settings = emptyModelTierSettings();
    try {
      const seeded = seedModelTiers(await this.seedSource(), settings);
      settings = seeded.settings;
      console.log(`[ModelTierService] Тиры заполнены из настроенного: ${seeded.added} звеньев`);
    } catch (err) {
      console.warn('[ModelTierService] Заполнение тиров не удалось, тиры пусты:', err);
    }
    try {
      await this.write(settings);
    } catch (err) {
      console.warn('[ModelTierService] Не удалось сохранить model-tiers.json:', err);
    }
    this.state = { settings, filePath: this.filePath, problems: [] };
    return this.state;
  }

  private async write(settings: ModelTierSettings): Promise<void> {
    const run = this.writeChain.then(async () => {
      settings.updatedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(withVersion(MODEL_TIERS_VERSION, settings), null, 2), 'utf-8');
      await fs.rename(tmp, this.filePath);
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }
}

function countEntries(settings: ModelTierSettings): number {
  return settings.tiers.cheap.length + settings.tiers.balanced.length + settings.tiers.frontier.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const modelTierService = new ModelTierService();
