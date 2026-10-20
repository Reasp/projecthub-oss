/**
 * Вложения в промпт Agents Studio (TASK-140.6, [[decision-114]] п. 5): чистые помощники без DOM — уменьшение фото,
 * base64 и загрузка частями через RPC `studio_attach`. Файл сохраняется в проект на хосте, агенту уходит его путь.
 */

/** Часть — 512 КБ: в base64 кадр около 700 КБ, хост принимает до 768 КБ данных. */
export const ATTACH_CHUNK_BYTES = 512 * 1024;
/** Тот же предел, что у хоста (`ATTACHMENT_MAX_BYTES`). */
export const ATTACH_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACH_MAX_PER_PROMPT = 10;
/** Длинная сторона фото после уменьшения: агенту больше не нужно, а промпт легче. */
export const IMAGE_MAX_SIDE = 2048;
/** Фото меньше этого размера и стороны уходят как есть. */
export const IMAGE_SHRINK_FROM_BYTES = 1.5 * 1024 * 1024;

export interface PreparedAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Размеры после уменьшения до `max` по длинной стороне; меньшие не увеличиваются. */
export function fitImageSize(width: number, height: number, max = IMAGE_MAX_SIDE): { width: number; height: number } {
  const side = Math.max(width, height);
  if (side <= max || side <= 0) return { width, height };
  const k = max / side;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Перекодировать ли фото в JPEG: большое по байтам или по стороне. GIF и SVG не трогаем. */
export function shouldShrinkImage(mime: string, bytes: number, width: number, height: number): boolean {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mime)) return false;
  return bytes > IMAGE_SHRINK_FROM_BYTES || Math.max(width, height) > IMAGE_MAX_SIDE;
}

/** Имя после перекодирования: `IMG_1.png` → `IMG_1.jpg`. */
export function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name || 'photo'}.jpg`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

export function newUploadId(random: () => number = Math.random): string {
  return `u${Date.now().toString(36)}${Math.floor(random() * 1e9).toString(36)}`;
}

type AttachResult = { done: false; received: number } | { done: true; path: string; size: number };

/**
 * Загрузка частями по порядку; хост пишет файл, только получив его целиком. Возвращает путь в проекте.
 * Ошибка RPC прерывает загрузку — незаконченную хост уберёт сам.
 */
export async function uploadInChunks(
  rpc: (params: Record<string, unknown>) => Promise<AttachResult>,
  file: PreparedAttachment,
  onProgress?: (sent: number, total: number) => void,
  uploadId = newUploadId()
): Promise<string> {
  const size = file.bytes.length;
  if (size === 0) throw new Error('Файл пустой');
  if (size > ATTACH_MAX_BYTES) throw new Error(`Файл больше ${formatBytes(ATTACH_MAX_BYTES)}`);
  for (let offset = 0; offset < size; offset += ATTACH_CHUNK_BYTES) {
    const part = file.bytes.subarray(offset, Math.min(size, offset + ATTACH_CHUNK_BYTES));
    const res = await rpc({ uploadId, name: file.name, size, offset, data: bytesToBase64(part) });
    onProgress?.(offset + part.length, size);
    if (res.done) return res.path;
  }
  throw new Error('Хост не подтвердил приём файла');
}
