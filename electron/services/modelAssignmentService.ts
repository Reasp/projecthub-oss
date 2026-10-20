import { promises as fs } from 'fs';
import path from 'path';
import { getUserDataDir } from './appPaths.js';
import { emptyModelAssignments, normalizeModelAssignments, type ModelAssignments } from './modelPurposes.js';
import { stateFields, withVersion } from './stateFiles.js';

export const MODEL_ASSIGNMENTS_FILE = 'model-assignments.json';
/** Версия формата файла (decision-104). */
export const MODEL_ASSIGNMENTS_VERSION = 1;

export interface ModelAssignmentState {
  settings: ModelAssignments;
  filePath: string;
  /** Файл есть, но не прочитан (битый JSON): действуют назначения по каталогу, сохранение перезапишет файл. */
  loadError?: string;
  /** Записи, отброшенные при чтении (неизвестное назначение, пустая цель). */
  problems: string[];
}

/**
 * Назначения моделей `<userData>/model-assignments.json` (TASK-134.1, decision-74): чтение и атомарная
 * запись по очереди. Файла нет или он битый — действуют назначения по каталогу: вызов модели из-за
 * настроек назначений не падает.
 */
export class ModelAssignmentService {
  private state: ModelAssignmentState | null = null;
  private loading: Promise<ModelAssignmentState> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePathOverride?: string) {}

  get filePath(): string {
    return this.filePathOverride ?? path.join(getUserDataDir(), MODEL_ASSIGNMENTS_FILE);
  }

  /** Назначения; файл читается один раз. */
  async getState(): Promise<ModelAssignmentState> {
    if (this.state) return this.state;
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async getSettings(): Promise<ModelAssignments> {
    return (await this.getState()).settings;
  }

  /** Перечитать файл (например, после ручной правки). */
  async reload(): Promise<ModelAssignmentState> {
    this.state = null;
    return this.getState();
  }

  /** Сохраняет назначения целиком (ввод из UI нормализуется) и сразу применяет их. */
  async save(raw: unknown): Promise<ModelAssignmentState> {
    const { settings, problems } = normalizeModelAssignments(raw);
    await this.write(settings);
    this.state = { settings, filePath: this.filePath, problems };
    console.log(`[ModelAssignmentService] Сохранены назначения моделей: ${Object.keys(settings.assignments).length}`);
    return this.state;
  }

  private async load(): Promise<ModelAssignmentState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) console.warn('[ModelAssignmentService] Не удалось прочитать model-assignments.json, действуют назначения по каталогу:', err);
      this.state = {
        settings: emptyModelAssignments(),
        filePath: this.filePath,
        problems: [],
        ...(missing ? {} : { loadError: errorText(err) })
      };
      return this.state;
    }
    try {
      const { settings, problems } = normalizeModelAssignments(stateFields(JSON.parse(raw), MODEL_ASSIGNMENTS_VERSION));
      if (problems.length > 0) console.warn(`[ModelAssignmentService] Пропущены назначения: ${problems.join('; ')}`);
      this.state = { settings, filePath: this.filePath, problems };
    } catch (err) {
      console.warn('[ModelAssignmentService] model-assignments.json не разобран, действуют назначения по каталогу:', err);
      this.state = { settings: emptyModelAssignments(), filePath: this.filePath, problems: [], loadError: errorText(err) };
    }
    return this.state;
  }

  private async write(settings: ModelAssignments): Promise<void> {
    const run = this.writeChain.then(async () => {
      settings.updatedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(withVersion(MODEL_ASSIGNMENTS_VERSION, settings), null, 2), 'utf-8');
      await fs.rename(tmp, this.filePath);
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const modelAssignmentService = new ModelAssignmentService();
