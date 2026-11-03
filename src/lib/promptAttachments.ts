/**
 * Вложения в промпт вкладки Agents Studio (TASK-289, decision-210). Файл сохраняется в каталог вложений вкладки
 * (`<каталог вкладки>/.projecthub/attachments/<дата>/`), реплика хранит ссылку на него — путь от корня проекта, а не
 * содержимое: файл вкладки на диске не раздувается картинками, превью и повтор хода читают тот же файл.
 *
 * Модуль без Node и Electron: его используют и окно, и main-процесс.
 */

/** Вложение реплики человека. */
export interface PromptAttachment {
  /** Путь от корня проекта, через `/`: `.projecthub/attachments/2026-11-03/101500-image.png` или в дереве вкладки. */
  path: string;
  /** Имя файла для подписи. */
  name: string;
  /** MIME-тип; пустой, если окно его не узнало. */
  mime: string;
  /** Размер в байтах. */
  size: number;
}

/** Файл целиком — до 15 МБ, как у вложений с телефона. */
export const PROMPT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
/** Вложений в одном промпте. */
export const PROMPT_ATTACHMENT_MAX_COUNT = 10;
/**
 * Картинка блоком `image` — до 3.75 МБ: API принимает до 5 МБ в base64. Больше — уходит путём, CLI прочитает её
 * инструментом Read и уменьшит сам. Окно уменьшает вставленные картинки заранее ({@link PROMPT_IMAGE_MAX_SIDE}).
 */
export const CLI_IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024);
/** Длинная сторона картинки после уменьшения в окне. */
export const PROMPT_IMAGE_MAX_SIDE = 2000;
/** Форматы, которые модель принимает блоком `image`. */
export const CLI_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  log: 'text/plain'
};

/** MIME по расширению — для файлов, у которых браузер тип не определил. */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return EXT_MIME[name.slice(dot + 1).toLowerCase()] ?? '';
}

/** Картинка — для превью в окне (любая `image/*`, кроме SVG: его превью строится как у файла). */
export function isPreviewableImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime);
}

/** Как вложение уходит в ход Claude Code: блоком `image`, блоком `document` (PDF) или путём в тексте промпта. */
export type CliAttachmentForm = 'image' | 'document' | 'path';

export function cliAttachmentForm(a: Pick<PromptAttachment, 'mime' | 'size'>): CliAttachmentForm {
  if (CLI_IMAGE_MIMES.includes(a.mime) && a.size > 0 && a.size <= CLI_IMAGE_MAX_BYTES) return 'image';
  if (a.mime === 'application/pdf' && a.size > 0 && a.size <= PROMPT_ATTACHMENT_MAX_BYTES) return 'document';
  return 'path';
}

/**
 * Путь вложения от корня проекта: файл каталога вложений самого проекта или дерева внутри него. Без `..`, абсолютных
 * путей и обратных слэшей — main-процесс читает файл только по такому пути.
 */
const ATTACHMENT_PATH = /^(?:[^/\\:]+\/)*\.projecthub\/attachments\/\d{4}-\d{2}-\d{2}\/[^/\\:]{1,120}$/;

export function isPromptAttachmentPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000 || !ATTACHMENT_PATH.test(value)) return false;
  return !value.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

/** Вложения реплики из недоверенного источника (файл сессии, запрос окна): только корректные, не больше 10. */
export function sanitizePromptAttachments(value: unknown): PromptAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: PromptAttachment[] = [];
  for (const item of value) {
    if (out.length >= PROMPT_ATTACHMENT_MAX_COUNT) break;
    const a = item as Partial<PromptAttachment> | null;
    if (!a || !isPromptAttachmentPath(a.path) || out.some((o) => o.path === a.path)) continue;
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0;
    out.push({
      path: a.path,
      name: typeof a.name === 'string' && a.name.trim() ? a.name.slice(0, 200) : a.path.split('/').pop()!,
      mime: typeof a.mime === 'string' ? a.mime.slice(0, 100) : '',
      size
    });
  }
  return out;
}

/**
 * Текст промпта с перечнем файлов, которые агент открывает сам: вложения для движков без блоков картинок и файлы,
 * которые не уходят блоком. Пути — от каталога, где работает агент.
 */
export function promptWithFileList(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) return body;
  const list = ['Attached files (open them by path):', ...paths.map((p) => `- ${p}`)].join('\n');
  return body ? `${body}\n\n${list}` : list;
}

/** Размер для подписи: `512 B`, `34 KB`, `2.4 MB`. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
