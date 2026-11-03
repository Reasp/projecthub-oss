import { CLI_IMAGE_MAX_BYTES, PROMPT_IMAGE_MAX_SIDE, mimeFromName } from './promptAttachments';

/**
 * Подготовка файла-вложения в окне (TASK-289, decision-210): большие снимки экрана уменьшаются до
 * {@link PROMPT_IMAGE_MAX_SIDE} по длинной стороне и до {@link CLI_IMAGE_MAX_BYTES}, чтобы уйти в ход блоком `image`.
 * GIF не трогается (анимация), прочие файлы уходят как есть.
 */

/** Размер после уменьшения: длинная сторона не больше `maxSide`, пропорции сохраняются. */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxSide || long <= 0) return { width, height };
  const k = maxSide / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Имя с другим расширением: `shot.png` → `shot.jpg`. */
export function withExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

export interface AttachmentPayload {
  name: string;
  mime: string;
  /** Содержимое в base64. */
  data: string;
  size: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Уменьшенная картинка или `null`, если уменьшать не нужно или не вышло (тогда уходит исходный файл). */
async function shrinkImage(file: Blob, name: string, mime: string): Promise<{ blob: Blob; name: string; mime: string } | null> {
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(mime)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const target = scaledSize(bitmap.width, bitmap.height, PROMPT_IMAGE_MAX_SIDE);
  const needsResize = target.width !== bitmap.width || target.height !== bitmap.height;
  if (!needsResize && file.size <= CLI_IMAGE_MAX_BYTES && mime !== 'image/bmp') {
    bitmap.close();
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();
  // Снимок экрана лучше читается в PNG; если PNG всё ещё велик — JPEG.
  if (mime !== 'image/jpeg') {
    const png = await canvasBlob(canvas, 'image/png');
    if (png && png.size <= CLI_IMAGE_MAX_BYTES) return { blob: png, name: withExtension(name, 'png'), mime: 'image/png' };
  }
  for (const quality of [0.9, 0.8, 0.65]) {
    const jpeg = await canvasBlob(canvas, 'image/jpeg', quality);
    if (jpeg && jpeg.size <= CLI_IMAGE_MAX_BYTES) return { blob: jpeg, name: withExtension(name, 'jpg'), mime: 'image/jpeg' };
  }
  return null;
}

/** Файл из буфера обмена, перетаскивания или выбора — в данные для сохранения вложения. */
export async function attachmentPayload(file: File): Promise<AttachmentPayload> {
  const name = file.name || 'file';
  const mime = file.type || mimeFromName(name);
  const shrunk = await shrinkImage(file, name, mime);
  const blob = shrunk?.blob ?? file;
  return { name: shrunk?.name ?? name, mime: shrunk?.mime ?? mime, data: await blobToBase64(blob), size: blob.size };
}
