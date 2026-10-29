/**
 * Офлайн-пакет моделей закрытого контура (TASK-147.2, [[decision-186]] п. 4). Каталог `offline-models/` с манифестом
 * `offline-models.json` собирает `scripts/offline/pack-models.mjs` на машине с сетью из её `<userData>/models`. На машине
 * без сети ProjectHub при первом обращении к кэшу моделей досеивает из пакета недостающие файлы в `<userData>/models`:
 * эмбеддинги поиска, Whisper, модели распознавания и голоса sherpa-onnx находят их там же, где нашли бы скачанные.
 *
 * Разбор манифеста и план копирования — чистые функции; копирование проверяет SHA-256 и пишет через временный файл.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OFFLINE_MODELS_DIR = 'offline-models';
export const OFFLINE_MODELS_MANIFEST = 'offline-models.json';
/** Переменная окружения с путём к пакету, если он лежит не рядом с приложением. */
export const OFFLINE_MODELS_ENV = 'PROJECTHUB_OFFLINE_MODELS';
/**
 * Отметка в кэше: этот пакет (SHA-256 манифеста) уже досеян без ошибок. С ней досев не повторяется на каждом запуске и не
 * возвращает модели, которые человек удалил сам; новый пакет — новый хэш, досев идёт снова.
 */
export const OFFLINE_MODELS_APPLIED = '.offline-models-applied';

export interface OfflineModelFile {
  /** Путь внутри пакета и кэша, через `/`. */
  path: string;
  size: number;
  sha256: string;
}

export interface OfflineModelsManifest {
  format: 1;
  files: OfflineModelFile[];
}

/** Безопасный относительный путь: без `..`, абсолютных путей, дисков и служебных файлов загрузки (`.имя`). */
export function isSafeModelPath(p: string): boolean {
  if (!p || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.'));
}

/** Манифест пакета; неверный формат — `null`, файлы с опасным путём или без хэша отбрасываются. */
export function parseOfflineManifest(raw: unknown): OfflineModelsManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (v.format !== 1 || !Array.isArray(v.files)) return null;
  const files: OfflineModelFile[] = [];
  for (const f of v.files) {
    if (!f || typeof f !== 'object') continue;
    const { path: p, size, sha256 } = f as Record<string, unknown>;
    if (typeof p !== 'string' || !isSafeModelPath(p)) continue;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) continue;
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) continue;
    files.push({ path: p, size, sha256: sha256.toLowerCase() });
  }
  return { format: 1, files };
}

/** Что скопировать: файла нет в кэше или его размер другой (оборванная загрузка). Совпавшие по размеру не трогаются. */
export function planModelSeed(manifest: OfflineModelsManifest, existingSizes: ReadonlyMap<string, number>): OfflineModelFile[] {
  return manifest.files.filter((f) => existingSizes.get(f.path) !== f.size);
}

/**
 * Где искать пакет: путь из `PROJECTHUB_OFFLINE_MODELS`, затем `offline-models/` рядом с ресурсами приложения (его кладёт
 * установщик контура), затем в `<userData>`. Берётся первый каталог с манифестом.
 */
export function offlinePackageCandidates(opts: { env?: string; resourcesPath?: string; userDataDir: string }): string[] {
  const out: string[] = [];
  if (opts.env?.trim()) out.push(path.resolve(opts.env.trim()));
  if (opts.resourcesPath) out.push(path.join(opts.resourcesPath, OFFLINE_MODELS_DIR));
  out.push(path.join(opts.userDataDir, OFFLINE_MODELS_DIR));
  return out;
}

export function findOfflinePackage(candidates: readonly string[], exists: (p: string) => boolean = existsSync): string | null {
  return candidates.find((dir) => exists(path.join(dir, OFFLINE_MODELS_MANIFEST))) ?? null;
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

export interface SeedResult {
  copied: number;
  failed: Array<{ path: string; reason: string }>;
  /** Пакет с этим манифестом уже досеян раньше — файлы не проверялись. */
  alreadyApplied?: boolean;
}

/**
 * Досев кэша моделей из пакета. Копия идёт во временный файл рядом, проверяется SHA-256 и только потом переименовывается:
 * битый или подменённый файл в кэш не попадёт, а прерванное копирование не оставит половину модели под настоящим именем.
 */
export async function seedModelsFromPackage(packageDir: string, targetDir: string): Promise<SeedResult> {
  const manifestBytes = await fs.readFile(path.join(packageDir, OFFLINE_MODELS_MANIFEST));
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  const marker = path.join(targetDir, OFFLINE_MODELS_APPLIED);
  if ((await fs.readFile(marker, 'utf8').catch(() => '')).trim() === digest) return { copied: 0, failed: [], alreadyApplied: true };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    // ниже — «invalid manifest»
  }
  const manifest = parseOfflineManifest(parsed);
  if (!manifest) return { copied: 0, failed: [{ path: OFFLINE_MODELS_MANIFEST, reason: 'invalid manifest' }] };
  const sizes = new Map<string, number>();
  await Promise.all(
    manifest.files.map(async (f) => {
      const st = await fs.stat(path.join(targetDir, ...f.path.split('/'))).catch(() => null);
      if (st?.isFile()) sizes.set(f.path, st.size);
    })
  );
  const result: SeedResult = { copied: 0, failed: [] };
  for (const f of planModelSeed(manifest, sizes)) {
    const from = path.join(packageDir, ...f.path.split('/'));
    const to = path.join(targetDir, ...f.path.split('/'));
    const tmp = `${to}.offline-${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, tmp);
      const actual = await sha256File(tmp);
      if (actual !== f.sha256) throw new Error(`sha256 mismatch (${actual.slice(0, 12)})`);
      await fs.rename(tmp, to);
      result.copied++;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      result.failed.push({ path: f.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  // Отметка — только после досева без ошибок: битый файл пакета будет повторён, когда администратор заменит пакет.
  if (result.failed.length === 0) await fs.writeFile(marker, digest, 'utf8').catch(() => undefined);
  return result;
}
