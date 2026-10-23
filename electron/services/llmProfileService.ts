import fs from 'node:fs/promises';
import path from 'node:path';
import { getStatePath } from './appPaths.js';
import { secretStorageService, type SecretStorageService } from './secretStorageService.js';
import { AppError } from '../../src/lib/appError.js';
import { providerConfigError } from './providerErrors.js';
import {
  buildProfileHeaders,
  chatCompletionsUrl,
  normalizeProfile,
  type LlmCompatFlags,
  type LlmProfile,
  type LlmProfileView
} from './llmProfiles.js';

/**
 * Хранилище профилей OpenAI-совместимых провайдеров (TASK-70.1, [[decision-39]]).
 *
 * Файл `<userData>/llm-profiles.json` лежит рядом с `ai-config.json` (decision-104; до него —
 * `~/.projecthub`). Ключ хранится в `secretStorageService` профиля (`userData`,
 * decision-88 п. 4) и наружу (в renderer) не отдаётся: `listProfiles` возвращает только `hasApiKey`.
 */

interface StoredProfile extends LlmProfile {
  /**
   * Ключ в самом файле — формат до decision-88. Свой ключ при чтении переносится в хранилище
   * секретов, чужой (не расшифровывается этим профилем) остаётся в файле для профиля-владельца.
   */
  apiKey?: string;
}

export function llmProfileSecretKey(id: string): string {
  return `llmProfile.${id}.apiKey`;
}

interface ProfilesFile {
  version: 1;
  profiles: StoredProfile[];
}

export interface SaveLlmProfileInput {
  profile: unknown;
  /** `undefined` — оставить прежний ключ, пустая строка или `null` — удалить, строка — задать. */
  apiKey?: string | null;
}

export interface LlmRequestTarget {
  profile: LlmProfile;
  endpoint: string;
  headers: Record<string, string>;
  compat: LlmCompatFlags;
}

function toView(p: StoredProfile, hasApiKey: boolean): LlmProfileView {
  const { apiKey: _inline, ...rest } = p;
  return { ...rest, hasApiKey };
}

export class LlmProfileService {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePathOverride?: string,
    private readonly secrets: Pick<SecretStorageService, 'tryDecrypt' | 'setSecret' | 'getSecret' | 'deleteSecret' | 'reportUndecryptable'> = secretStorageService
  ) {}

  /** `<userData>/llm-profiles.json` (decision-104): при первом обращении копируется из `~/.projecthub`. */
  private get filePath(): string {
    return this.filePathOverride ?? getStatePath('llm-profiles.json');
  }

  private async readFile(): Promise<ProfilesFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: [] };
      throw err;
    }
    const parsed = JSON.parse(raw) as { profiles?: unknown };
    const profiles: StoredProfile[] = [];
    for (const item of Array.isArray(parsed.profiles) ? parsed.profiles : []) {
      try {
        const profile = normalizeProfile(item);
        const apiKey = (item as { apiKey?: unknown }).apiKey;
        profiles.push(typeof apiKey === 'string' && apiKey ? { ...profile, apiKey } : profile);
      } catch (err) {
        // Один испорченный профиль не должен лишать пользователя остальных.
        console.warn('[LlmProfileService] Пропущен некорректный профиль:', err instanceof Error ? err.message : err);
      }
    }
    return { version: 1, profiles };
  }

  private async writeFile(data: ProfilesFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** Изменения файла выполняются строго по очереди: параллельные сохранения не теряют друг друга. */
  private mutate<T>(fn: (data: ProfilesFile) => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(async () => {
      const data = await this.readFile();
      const result = await fn(data);
      await this.writeFile(data);
      return result;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Перенос ключей из файла в хранилище секретов профиля (decision-88 п. 4). Чужой ключ остаётся
   * в файле и отмечается как проблема: этим профилем им не воспользоваться.
   */
  private async migrateInlineKeys(): Promise<ProfilesFile> {
    const current = await this.readFile();
    const hasOwnInline = current.profiles.some((p) => p.apiKey && this.secrets.tryDecrypt(p.apiKey).ok);
    if (hasOwnInline) {
      return this.mutate(async (data) => {
        for (const p of data.profiles) {
          if (!p.apiKey) continue;
          const result = this.secrets.tryDecrypt(p.apiKey);
          if (!result.ok) continue;
          await this.secrets.setSecret(llmProfileSecretKey(p.id), result.value);
          delete p.apiKey;
        }
        return data;
      });
    }
    for (const p of current.profiles) {
      if (p.apiKey) await this.secrets.reportUndecryptable(llmProfileSecretKey(p.id), p.apiKey, 'llm-profiles');
    }
    return current;
  }

  private async hasKey(id: string): Promise<boolean> {
    return Boolean(await this.secrets.getSecret(llmProfileSecretKey(id)));
  }

  public async listProfiles(): Promise<LlmProfileView[]> {
    const { profiles } = await this.migrateInlineKeys();
    return Promise.all(profiles.map(async (p) => toView(p, await this.hasKey(p.id))));
  }

  public async saveProfile(input: SaveLlmProfileInput): Promise<LlmProfileView> {
    const profile = normalizeProfile(input.profile);
    await this.migrateInlineKeys();
    const secretKey = llmProfileSecretKey(profile.id);
    if (input.apiKey === null || input.apiKey === '') await this.secrets.deleteSecret(secretKey);
    else if (typeof input.apiKey === 'string') await this.secrets.setSecret(secretKey, input.apiKey.trim());
    const stored = await this.mutate((data) => {
      const idx = data.profiles.findIndex((p) => p.id === profile.id);
      // Чужой ключ в файле не трогаем — он принадлежит другому профилю ProjectHub.
      const foreign = idx >= 0 ? data.profiles[idx].apiKey : undefined;
      const next: StoredProfile = foreign ? { ...profile, apiKey: foreign } : profile;
      if (idx >= 0) data.profiles[idx] = next;
      else data.profiles.push(next);
      return next;
    });
    return toView(stored, await this.hasKey(profile.id));
  }

  public async deleteProfile(id: string): Promise<boolean> {
    const removed = await this.mutate((data) => {
      const before = data.profiles.length;
      data.profiles = data.profiles.filter((p) => p.id !== id);
      return data.profiles.length !== before;
    });
    if (removed) await this.secrets.deleteSecret(llmProfileSecretKey(id));
    return removed;
  }

  /** Профиль с расшифрованным ключом — только для main-процесса. */
  public async getProfileWithKey(id: string | undefined): Promise<{ profile: LlmProfile; apiKey?: string }> {
    if (!id) {
      throw providerConfigError(new AppError('llm.profileNotSelected'), 'no_profile');
    }
    const { profiles } = await this.migrateInlineKeys();
    const stored = profiles.find((p) => p.id === id);
    if (!stored) {
      throw providerConfigError(new AppError('llm.profileNotFound', { id }), 'no_profile');
    }
    const { apiKey: _inline, ...profile } = stored;
    const apiKey = await this.secrets.getSecret(llmProfileSecretKey(id));
    return { profile, ...(apiKey ? { apiKey } : {}) };
  }

  /** Адрес Chat Completions, заголовки и флаги для запроса через профиль. */
  public async resolveRequestTarget(id: string | undefined): Promise<LlmRequestTarget> {
    const { profile, apiKey } = await this.getProfileWithKey(id);
    return {
      profile,
      endpoint: chatCompletionsUrl(profile.baseUrl),
      headers: buildProfileHeaders(profile, apiKey),
      compat: profile.compat
    };
  }
}

export const llmProfileService = new LlmProfileService();
