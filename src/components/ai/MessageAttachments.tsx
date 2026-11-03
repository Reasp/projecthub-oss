import React, { useEffect, useState } from 'react';
import { File, ImageOff } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import { formatAttachmentSize, isPreviewableImage, type PromptAttachment } from '../../lib/promptAttachments';

/**
 * Вложения реплики человека в ленте Agents Studio (TASK-289): картинки — превью, прочие файлы — плашкой с именем.
 * Щелчок открывает файл системной программой (картинку, PDF, текст) или показывает его в папке.
 */

/** Превью уже показанных картинок: лента перерисовывается часто, файл читается один раз. */
const previewCache = new Map<string, string | null>();
const PREVIEW_CACHE_MAX = 60;

function cacheKey(projectPath: string, path: string): string {
  return `${projectPath}\n${path}`;
}

const AttachmentThumb: React.FC<{ projectPath: string; attachment: PromptAttachment; onOpen: () => void }> = ({ projectPath, attachment, onOpen }) => {
  const { t } = useTranslation();
  const key = cacheKey(projectPath, attachment.path);
  const [url, setUrl] = useState<string | null | undefined>(previewCache.get(key));
  useEffect(() => {
    if (previewCache.has(key)) {
      setUrl(previewCache.get(key));
      return;
    }
    let alive = true;
    window.api
      ?.studioAttachmentPreview({ projectPath, path: attachment.path, mime: attachment.mime })
      .catch(() => null)
      .then((dataUrl) => {
        if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value as string);
        previewCache.set(key, dataUrl ?? null);
        if (alive) setUrl(dataUrl ?? null);
      });
    return () => {
      alive = false;
    };
  }, [key, projectPath, attachment.path, attachment.mime]);
  const title = t.aiStudio.input.attachOpen.replace('{name}', attachment.name);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      aria-label={title}
      className="block rounded-lg overflow-hidden border border-indigo-300/30 bg-black/20 hover:border-indigo-200 transition"
      data-testid="message-attachment-image"
    >
      {url ? (
        <img src={url} alt={attachment.name} className="max-h-40 max-w-[16rem] object-contain" />
      ) : (
        <span className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-indigo-100">
          <ImageOff className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[12rem]">{attachment.name}</span>
        </span>
      )}
    </button>
  );
};

export const MessageAttachments: React.FC<{ projectPath: string; attachments: PromptAttachment[] }> = ({ projectPath, attachments }) => {
  const { t } = useTranslation();
  if (attachments.length === 0) return null;
  const open = (a: PromptAttachment) => void window.api?.openStudioAttachment({ projectPath, path: a.path }).catch(() => false);
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="message-attachments">
      {attachments.map((a) =>
        isPreviewableImage(a.mime) ? (
          <AttachmentThumb key={a.path} projectPath={projectPath} attachment={a} onOpen={() => open(a)} />
        ) : (
          <button
            key={a.path}
            type="button"
            onClick={() => open(a)}
            title={t.aiStudio.input.attachOpen.replace('{name}', a.name)}
            className="flex items-center gap-1.5 rounded-lg border border-indigo-300/30 bg-indigo-500/10 px-2.5 py-1.5 text-[11px] text-indigo-100 hover:border-indigo-200 transition"
            data-testid="message-attachment-file"
          >
            <File className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate max-w-[14rem]">{a.name}</span>
            {a.size > 0 && <span className="text-indigo-300/70 shrink-0">{formatAttachmentSize(a.size)}</span>}
          </button>
        )
      )}
    </div>
  );
};
