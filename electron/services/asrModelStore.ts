/**
 * Локальные модели распознавания речи на sherpa-onnx (TASK-164.4): пока одна — GigaAM v3 с
 * пунктуацией для русского. Загрузка по образцу голосов Piper (`ttsVoiceStore`): архив `.tar.bz2`
 * из релиза sherpa-onnx, проверка sha256, распаковка внутри процесса (decision-32), перенос на место
 * из временного каталога — недокачанная модель никогда не видна как установленная.
 */
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureModelsCacheDir } from './appPaths';
import { AppError } from '../../src/lib/appError';
import { extractTarBz2 } from './archiveExtract';
import { sha256File } from './fileHash';
import { parseContentLength, resolveTotalBytes } from './ttsDownloadProgress';

export type AsrModelId = 'gigaam-v3-ru';

export interface AsrModelDefinition {
  id: AsrModelId;
  label: string;
  language: 'ru';
  url: string;
  sha256: string;
  archiveBytes: number;
  /** Корневой каталог внутри архива. */
  archiveRoot: string;
  /** Файлы, без которых модель не грузится. */
  files: { model: string; tokens: string };
}

/**
 * GigaAM v3 CTC с пунктуацией (Sber, MIT): на стенде TASK-164.1 ошибается в 3–4 раза реже whisper-base
 * при задержке 0.17 с против 0.8 с на фразу. CTC, а не RNN-T: на стенде точнее и легче.
 */
export const ASR_MODELS: Record<AsrModelId, AsrModelDefinition> = {
  'gigaam-v3-ru': {
    id: 'gigaam-v3-ru',
    label: 'GigaAM v3 (русский, с пунктуацией)',
    language: 'ru',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16.tar.bz2',
    sha256: '20e41e160efa6f2460a7ef6554cdbbb9e8fffb2b92e6bc708e9406bd8b9256ea',
    archiveBytes: 163_282_594,
    archiveRoot: 'sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16',
    files: { model: 'model.int8.onnx', tokens: 'tokens.txt' }
  }
};

export interface InstalledAsrModel {
  id: AsrModelId;
  modelPath: string;
  tokensPath: string;
}

export interface AsrModelStatus {
  id: AsrModelId;
  label: string;
  installed: boolean;
  downloading: boolean;
  archiveBytes: number;
}

export interface AsrDownloadProgress {
  modelId: AsrModelId;
  phase: 'download' | 'verify' | 'extract' | 'done';
  receivedBytes: number;
  totalBytes: number;
}

const activeDownloads = new Map<AsrModelId, AbortController>();

export function isAsrModelId(value: unknown): value is AsrModelId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ASR_MODELS, value);
}

async function asrRoot(): Promise<string> {
  const root = path.join(await ensureModelsCacheDir(), 'asr');
  await fs.mkdir(root, { recursive: true });
  return root;
}

export async function getInstalledAsrModel(id: AsrModelId): Promise<InstalledAsrModel | null> {
  const def = ASR_MODELS[id];
  const dir = path.join(await asrRoot(), id);
  const modelPath = path.join(dir, def.files.model);
  const tokensPath = path.join(dir, def.files.tokens);
  return existsSync(modelPath) && existsSync(tokensPath) ? { id, modelPath, tokensPath } : null;
}

export async function listAsrModels(): Promise<AsrModelStatus[]> {
  const out: AsrModelStatus[] = [];
  for (const def of Object.values(ASR_MODELS)) {
    out.push({
      id: def.id,
      label: def.label,
      installed: Boolean(await getInstalledAsrModel(def.id)),
      downloading: activeDownloads.has(def.id),
      archiveBytes: def.archiveBytes
    });
  }
  return out;
}

export function cancelAsrDownload(id: AsrModelId): boolean {
  const controller = activeDownloads.get(id);
  if (!controller) return false;
  controller.abort();
  activeDownloads.delete(id);
  return true;
}

/** Скачивает модель, проверяет sha256, распаковывает и переносит на место. */
export async function downloadAsrModel(
  id: AsrModelId,
  onProgress?: (progress: AsrDownloadProgress) => void
): Promise<InstalledAsrModel> {
  const def = ASR_MODELS[id];
  if (activeDownloads.has(id)) throw new AppError('models.downloadInProgress', { id });

  const root = await asrRoot();
  const targetDir = path.join(root, id);
  const tmpArchive = path.join(root, `.${id}.download`);
  const stagingDir = path.join(root, `.${id}.staging`);
  const controller = new AbortController();
  activeDownloads.set(id, controller);

  try {
    const response = await fetch(def.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new AppError('models.downloadHttp', { status: response.status });
    const contentLength = parseContentLength(response.headers.get('content-length'));
    let received = 0;
    const report = (phase: AsrDownloadProgress['phase']) =>
      onProgress?.({ modelId: id, phase, receivedBytes: received, totalBytes: resolveTotalBytes(contentLength, received, phase) });

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      report('download');
    });
    await pipeline(source, createWriteStream(tmpArchive));

    report('verify');
    const actual = await sha256File(tmpArchive);
    if (actual !== def.sha256) throw new AppError('models.checksumMismatch', { id });

    report('extract');
    await fs.rm(stagingDir, { recursive: true, force: true });
    await extractTarBz2(tmpArchive, stagingDir);
    const unpacked = path.join(stagingDir, def.archiveRoot);
    for (const file of Object.values(def.files)) {
      if (!existsSync(path.join(unpacked, file))) throw new AppError('models.archiveIncomplete', { file });
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(unpacked, targetDir).catch(async () => {
      await fs.cp(unpacked, targetDir, { recursive: true });
    });
    // Примеры звука и скрипты экспорта из архива приложению не нужны
    await fs.rm(path.join(targetDir, 'test_wavs'), { recursive: true, force: true }).catch(() => {});

    report('done');
    console.log(`[AsrModelStore] ${id} installed`);
    return { id, modelPath: path.join(targetDir, def.files.model), tokensPath: path.join(targetDir, def.files.tokens) };
  } finally {
    activeDownloads.delete(id);
    await fs.rm(tmpArchive, { force: true }).catch(() => {});
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function deleteAsrModel(id: AsrModelId): Promise<boolean> {
  const dir = path.join(await asrRoot(), id);
  if (!existsSync(dir)) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
