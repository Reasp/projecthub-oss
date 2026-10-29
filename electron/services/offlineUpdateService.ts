/**
 * Обновление файлом (TASK-147.4, [[decision-189]]): проверка манифеста с подписью Ed25519 и установщика рядом с ним,
 * копия установщика во временный каталог с повторной проверкой хэша, запуск копии. Проверка без Electron — её покрывают
 * тесты на настоящих файлах; запуск установщика — в `launchStagedInstaller`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../src/lib/appError.js';
import { verifyUpdateManifest, type UpdateManifest } from './updateRules.mjs';
import type { UpdateTrustedKey } from './updateTrustedKeys.js';

/** Манифест — небольшой JSON; больше — не манифест. */
const MANIFEST_MAX_BYTES = 64 * 1024;

export interface UpdateCheckContext {
  trustedKeys: readonly UpdateTrustedKey[];
  currentVersion: string;
  platform: string;
  arch: string;
}

export interface VerifiedUpdate {
  manifest: UpdateManifest;
  manifestPath: string;
  installerPath: string;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function assertInstallerMatches(file: string, manifest: UpdateManifest): Promise<void> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new AppError('update.fileMissing', { file: manifest.file });
  if (st.size !== manifest.size || (await sha256File(file)) !== manifest.sha256) throw new AppError('update.fileMismatch', { file: manifest.file });
}

/** Сбой файловой системы (занятый файл, нет места, нет прав) — `AppError` с причиной, а не сырой текст Node. */
async function fsStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('update.fileUnreadable', { detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Манифест и установщик рядом с ним: подпись, платформа, версия, размер и SHA-256. Отказ — `AppError` с кодом `update.*`. */
export function inspectUpdateFile(manifestPath: string, ctx: UpdateCheckContext): Promise<VerifiedUpdate> {
  return fsStep(() => inspect(manifestPath, ctx));
}

async function inspect(manifestPath: string, ctx: UpdateCheckContext): Promise<VerifiedUpdate> {
  const st = await fs.stat(manifestPath).catch(() => null);
  if (!st?.isFile() || st.size > MANIFEST_MAX_BYTES) throw new AppError('update.manifestInvalid');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    throw new AppError('update.manifestInvalid');
  }
  const verdict = verifyUpdateManifest(raw, ctx);
  if (!verdict.ok) throw new AppError(verdict.code, verdict.params);
  const installerPath = path.join(path.dirname(manifestPath), verdict.manifest.file);
  await assertInstallerMatches(installerPath, verdict.manifest);
  return { manifest: verdict.manifest, manifestPath, installerPath };
}

/**
 * Копия установщика в `stagingDir` и проверка хэша уже у копии: файл в общей папке могли подменить между проверкой и
 * запуском. Запускать — только возвращённый путь.
 */
export function stageVerifiedInstaller(update: VerifiedUpdate, stagingDir: string): Promise<string> {
  return fsStep(async () => {
    // `stagingDir` — свой каталог этой установки внутри общего `update-staging`. Прошлые копии рядом — по возможности:
    // установщик прошлого обновления может быть ещё запущен.
    const root = path.dirname(stagingDir);
    for (const name of await fs.readdir(root).catch(() => [] as string[])) {
      if (name !== path.basename(stagingDir)) await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(stagingDir, { recursive: true });
    const staged = path.join(stagingDir, update.manifest.file);
    await fs.copyFile(update.installerPath, staged);
    await assertInstallerMatches(staged, update.manifest);
    return staged;
  });
}
