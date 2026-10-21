import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { PaperPlaneRightIcon } from '@phosphor-icons/react';
import { useT } from '../i18n/react';
import { Button } from './ui';
import { editorPanelHeight, expandsFields, fitFieldValue } from './fieldEditorModel';

/**
 * Редактор полей ввода на полэкрана (TASK-177, [[decision-132]]). На сенсорном экране тап по полю открывает
 * многострочный редактор в верхней половине экрана, нижнюю занимает клавиатура. Голосовой набор — микрофоном
 * клавиатуры. «Готово» и тап по фону переносят текст в поле, «Отмена» оставляет поле как было.
 */

export interface FieldEditorOptions {
  value: string;
  onChange: (value: string) => void;
  /** Заголовок редактора — подпись поля. Без него — подсказка поля. */
  title?: string;
  placeholder?: string;
  /** Поле многострочное: перевод строки сохраняется. Однострочному Enter в редакторе — «Готово». */
  multiline?: boolean;
  maxLength?: number;
  /** Действие формы прямо из редактора (Studio — «Отправить»): получает итоговое значение поля. */
  onSubmit?: (value: string) => void;
  submitLabel?: string;
}

interface EditorRequest extends FieldEditorOptions {
  seq: number;
}

let request: EditorRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function setRequest(next: EditorRequest | null): void {
  request = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Свойства для `<input>` или `<textarea>`: на сенсорном экране поле только для чтения (своя клавиатура не всплывает),
 * фокус открывает редактор. На ПК — обычное поле.
 */
export function fieldProps(opts: FieldEditorOptions) {
  const expand = expandsFields(typeof window !== 'undefined' ? window.matchMedia?.bind(window) : undefined);
  return {
    value: opts.value,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => opts.onChange(e.target.value),
    placeholder: opts.placeholder,
    maxLength: opts.maxLength,
    readOnly: expand || undefined,
    'data-field-editor': expand ? '' : undefined,
    onFocus: expand
      ? (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          e.currentTarget.blur();
          setRequest({ ...opts, seq: ++seq });
        }
      : undefined
  };
}

/** Один редактор на приложение: монтируется в корне, открывается из `fieldProps`. */
export function FieldEditorHost() {
  const current = useSyncExternalStore(subscribe, () => request, () => null);
  const close = useCallback(() => setRequest(null), []);
  if (!current) return null;
  return <FieldEditor key={current.seq} request={current} onClose={close} />;
}

/** Тап, открывший редактор, дошлёт `click` уже в редактор — его не считать нажатием кнопки или фона. */
const GHOST_CLICK_MS = 400;

function viewportBox() {
  const vv = window.visualViewport;
  return { top: vv?.offsetTop ?? 0, height: vv?.height ?? window.innerHeight };
}

function FieldEditor({ request: req, onClose }: { request: EditorRequest; onClose: () => void }) {
  const tr = useT();
  const multiline = req.multiline ?? false;
  const [draft, setDraft] = useState(req.value);
  const [view, setView] = useState(viewportBox);
  const screenHeight = useRef(Math.max(window.innerHeight, view.height));
  const openedAt = useRef(Date.now());
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setView(viewportBox());
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = () => {
    const value = fitFieldValue(draft, { multiline, maxLength: req.maxLength });
    req.onChange(value);
    onClose();
    return value;
  };

  const submit = () => req.onSubmit?.(apply());

  const swallowGhostClick = (e: MouseEvent) => {
    if (Date.now() - openedAt.current < GHOST_CLICK_MS) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const title = req.title ?? req.placeholder;
  return createPortal(
    <div className="fixed inset-x-0 z-[9999]" style={{ top: view.top, height: view.height }} onClickCapture={swallowGhostClick}>
      <div className="ph-fade-enter absolute inset-0 bg-black/60" onClick={apply} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="field-editor"
        className="ph-fade-enter relative flex flex-col overflow-hidden rounded-b-2xl border-b border-ph-line bg-ph-panel pt-[env(safe-area-inset-top)] shadow-lg shadow-black/40"
        style={{ height: editorPanelHeight(screenHeight.current, view.height) }}
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          <button type="button" data-testid="field-editor-cancel" onClick={onClose} className="rounded-lg px-2 py-2 text-[15px] text-slate-300 active:bg-ph-hover">
            {tr.common.cancel}
          </button>
          <div className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">{title}</div>
          <button
            type="button"
            data-testid="field-editor-done"
            onClick={apply}
            className="rounded-lg px-2 py-2 text-[15px] font-semibold text-indigo-300 active:bg-ph-hover disabled:opacity-40"
          >
            {tr.common.done}
          </button>
        </div>
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (!multiline && e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
          placeholder={req.placeholder}
          maxLength={req.maxLength}
          enterKeyHint={multiline ? 'enter' : 'done'}
          data-testid="field-editor-text"
          className="min-h-0 flex-1 resize-none border-y border-ph-line bg-ph-raised px-4 py-3 text-[16px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500"
        />
        {(req.maxLength !== undefined || req.onSubmit) && (
          <div className="flex min-h-[48px] items-center gap-2 px-4 py-1.5">
            <div className="min-w-0 flex-1 truncate text-[12px] text-slate-500">{req.maxLength !== undefined ? `${draft.length}/${req.maxLength}` : ''}</div>
            {req.onSubmit && (
              <Button variant="primary" size="sm" haptic="medium" disabled={!draft.trim()} onClick={submit} data-testid="field-editor-submit">
                <PaperPlaneRightIcon size={16} weight="fill" /> {req.submitLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
