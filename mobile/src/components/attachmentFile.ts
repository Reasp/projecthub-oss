import { fitImageSize, jpegName, shouldShrinkImage, type PreparedAttachment } from '../protocol/attachments';

/**
 * Файл из выбора системы в байты для загрузки (TASK-140.6). Большое фото перекодируется в JPEG по длинной стороне
 * `IMAGE_MAX_SIDE` средствами WebView (canvas) — своей библиотеки обработки изображений нет.
 */

function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function shrink(file: File, img: HTMLImageElement): Promise<PreparedAttachment | null> {
  const { width, height } = fitImageSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob || blob.size >= file.size) return null;
  return { name: jpegName(file.name), mime: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) };
}

export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  const mime = file.type || 'application/octet-stream';
  const name = file.name || (mime.startsWith('image/') ? 'photo.jpg' : 'file');
  if (mime.startsWith('image/')) {
    const img = await loadImage(file);
    if (img && shouldShrinkImage(mime, file.size, img.naturalWidth, img.naturalHeight)) {
      const small = await shrink(file, img).catch(() => null);
      if (small) return small;
    }
  }
  return { name, mime, bytes: new Uint8Array(await file.arrayBuffer()) };
}
