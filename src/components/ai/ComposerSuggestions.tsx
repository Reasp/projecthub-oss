import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ComposerSuggestionItem {
  key: string;
  /** Основная подпись моноширинным: `/команда` или путь. */
  label: string;
  /** Часть подписи, которую выделить (имя файла в пути). */
  strong?: string;
  hint?: string;
  detail?: string;
  badge?: string;
  icon?: React.ReactNode;
}

interface ComposerSuggestionsProps {
  /** Поле ввода, над которым открывается список. */
  anchor: HTMLElement | null;
  heading: string;
  items: ComposerSuggestionItem[];
  active: number;
  /** Строка вместо пунктов: поиск идёт или ничего не нашлось. */
  status?: string;
  note?: string;
  footer: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  testId: string;
}

const MAX_WIDTH = 640;

/**
 * Список автодополнения поля ввода Agents Studio (TASK-300): над полем, порталом в body с `z-[10000]` (decision-17),
 * `role="listbox"` — Esc этого списка не прерывает ход (TASK-299). Фокус остаётся в поле: клавиши обрабатывает поле,
 * мышь выбирает без потери фокуса.
 */
export const ComposerSuggestions: React.FC<ComposerSuggestionsProps> = ({ anchor, heading, items, active, status, note, footer, onPick, onHover, testId }) => {
  const [position, setPosition] = useState<{ bottom: number; left: number; width: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(rect.width, MAX_WIDTH);
      setPosition({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left), width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, items.length, status]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  if (!position) return null;
  return createPortal(
    <div
      role="listbox"
      aria-label={heading}
      style={{ bottom: position.bottom, left: position.left, width: position.width }}
      className="fixed z-[10000] rounded-lg border border-slate-700 bg-ph-elevated shadow-2xl text-xs overflow-hidden flex flex-col max-h-[45vh]"
      data-testid={testId}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] text-slate-500 shrink-0">{heading}</div>
      <div ref={listRef} className="overflow-y-auto px-1 pb-1 min-h-0">
        {items.map((item, i) => (
          <div
            key={item.key}
            role="option"
            aria-selected={i === active}
            data-index={i}
            data-testid="composer-suggestion"
            data-key={item.key}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
            className={`flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer min-w-0 ${i === active ? 'bg-indigo-500/20 text-white' : 'text-slate-300 hover:bg-ph-hover'}`}
          >
            {item.icon && <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-slate-400">{item.icon}</span>}
            <span className="font-mono shrink min-w-0 truncate">
              {item.strong && item.label.endsWith(item.strong) ? (
                <>
                  <span className="text-slate-500">{item.label.slice(0, item.label.length - item.strong.length)}</span>
                  <span>{item.strong}</span>
                </>
              ) : (
                item.label
              )}
            </span>
            {item.hint && <span className="font-mono text-[11px] text-slate-500 shrink-0">{item.hint}</span>}
            {item.detail && (
              <span className="flex-1 min-w-0 truncate text-[11px] text-slate-500" title={item.detail}>
                {item.detail}
              </span>
            )}
            {!item.detail && <span className="flex-1" />}
            {item.badge && <span className="shrink-0 rounded px-1 py-px text-[10px] bg-ph-raised text-slate-400">{item.badge}</span>}
          </div>
        ))}
        {status && <div className="px-2 py-1.5 text-slate-500" data-testid="composer-suggestion-status">{status}</div>}
      </div>
      {note && <div className="px-2.5 py-1 text-[10px] text-amber-300/80 border-t border-slate-800 shrink-0">{note}</div>}
      <div className="px-2.5 py-1 text-[10px] text-slate-500 border-t border-slate-800 shrink-0">{footer}</div>
    </div>,
    document.body
  );
};
