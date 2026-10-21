import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from '../common/icons';

export interface ComposerMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ComposerMenuProps {
  /** Содержимое кнопки-триггера (иконка и/или подпись). */
  trigger: React.ReactNode;
  title: string;
  /** Заголовок меню над пунктами. */
  heading?: string;
  items: ComposerMenuItem[];
  /** Показать шеврон у триггера — для выбора значения (режим), а не для списка действий. */
  chevron?: boolean;
  disabled?: boolean;
  testId?: string;
}

/**
 * Меню нижней строки поля ввода Agents Studio (TASK-169): открывается вверх от кнопки, порталом в body
 * с z-[10000] (decision-17), закрывается кликом мимо и Escape.
 */
export const ComposerMenu: React.FC<ComposerMenuProps> = ({ trigger, title, heading, items, chevron, disabled, testId }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ bottom: window.innerHeight - rect.top + 6, left: Math.max(8, rect.left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 h-7 px-1.5 rounded-md text-xs transition shrink-0 disabled:opacity-40 ${
          open ? 'bg-ph-hover text-slate-100' : 'text-slate-400 hover:text-slate-100 hover:bg-ph-hover'
        }`}
        data-testid={testId}
      >
        {trigger}
        {chevron && <ChevronDown className="w-3 h-3 text-slate-500" />}
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ bottom: position.bottom, left: position.left }}
            className="fixed z-[10000] min-w-[200px] max-w-[360px] rounded-lg border border-slate-700 bg-ph-elevated shadow-2xl p-1 text-xs"
          >
            {heading && <div className="px-2.5 py-1.5 text-[11px] text-slate-500">{heading}</div>}
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`w-full flex items-start gap-2 px-2.5 py-1.5 rounded-md text-left transition disabled:opacity-40 ${
                  item.checked ? 'bg-indigo-500/15 text-white' : 'text-slate-300 hover:bg-ph-hover'
                }`}
              >
                <span className="w-3.5 h-3.5 mt-px shrink-0 flex items-center justify-center text-slate-400">{item.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{item.label}</span>
                  {item.hint && <span className="block text-[11px] text-slate-500 truncate">{item.hint}</span>}
                </span>
                {item.checked !== undefined && (
                  <Check className={`w-3.5 h-3.5 shrink-0 mt-px ${item.checked ? 'text-indigo-300' : 'opacity-0'}`} />
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};
