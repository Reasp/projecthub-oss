import React from 'react';
import { ListPlus, Paperclip, Send, Trash2, X } from '../common/icons';
import { useTranslation } from '../../i18n/useTranslation';
import type { QueuedStudioMessage } from '../../lib/studioMessageQueue';

/**
 * Очередь сообщений вкладки над полем ввода (TASK-273): что уйдёт после текущего ответа. Каждое можно убрать,
 * очередь — очистить; после остановки или ошибки очередь ждёт, и следующее отправляется кнопкой. Реплики, которые
 * Claude Code уже получил во время хода (TASK-298), помечены «Отправлено»: крестик отзывает их, пока модель не прочла.
 */
export const QueuedMessagesBar: React.FC<{
  queue: QueuedStudioMessage[];
  isStreaming: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
  onSendNext: () => void;
}> = ({ queue, isStreaming, onRemove, onClear, onSendNext }) => {
  const { t } = useTranslation();
  const l = t.aiStudio.queue;
  if (queue.length === 0) return null;
  // Всё уже у Claude Code (TASK-298): ничего не ждёт конца ответа — заголовок об этом, а не об очереди.
  const allSent = isStreaming && queue.every((m) => m.sentDuringTurn);
  return (
    <div className="mx-4 mt-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-2.5 py-2 text-xs" data-testid="studio-queue">
      <div className="flex items-center gap-2">
        <ListPlus className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
        <span className="font-medium text-indigo-200">{(allSent ? l.sentTitle : l.title).replace('{count}', String(queue.length))}</span>
        <span className="text-slate-400 truncate">{allSent ? l.sentHint : isStreaming ? l.hintStreaming : l.hintPaused}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {!isStreaming && (
            <button type="button" onClick={onSendNext} className="ph-btn ph-btn-primary h-6 px-2" data-testid="studio-queue-send-next">
              <Send className="w-3 h-3" />
              <span>{l.sendNext}</span>
            </button>
          )}
          <button type="button" onClick={onClear} className="ph-btn ph-btn-ghost h-6 px-1.5" title={l.clear} aria-label={l.clear} data-testid="studio-queue-clear">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <ol className="mt-1.5 space-y-1">
        {queue.map((m, i) => (
          <li key={m.id} className="flex items-center gap-2 rounded-md bg-ph-hover/60 px-2 py-1" data-testid="studio-queue-item" data-sent={m.sentDuringTurn ? 'true' : undefined}>
            <span className="text-slate-500 tabular-nums shrink-0">{i + 1}.</span>
            {m.sentDuringTurn && (
              // Уже у Claude Code (TASK-298): модель прочтёт после текущего шага, тогда реплика встанет в ленту.
              <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 text-emerald-300 shrink-0" title={l.sentDuringTurnHint}>
                <Send className="w-3 h-3" />
                {l.sentDuringTurn}
              </span>
            )}
            <span className="text-slate-200 truncate flex-1" title={m.text}>{m.text}</span>
            {m.attachmentNames?.length ? (
              <span className="flex items-center gap-1 text-slate-400 shrink-0 max-w-[40%] truncate" title={m.attachmentNames.join(', ')}>
                <Paperclip className="w-3 h-3 shrink-0" />
                {m.attachmentNames.length === 1 ? m.attachmentNames[0] : String(m.attachmentNames.length)}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(m.id)}
              className="text-slate-500 hover:text-red-300 shrink-0"
              title={m.sentDuringTurn ? l.withdraw : l.remove}
              aria-label={m.sentDuringTurn ? l.withdraw : l.remove}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
};
