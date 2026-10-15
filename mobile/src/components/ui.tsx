import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useHaptic } from '../app/context';

/**
 * Базовые элементы мобильного клиента на токенах TASK-127. Оверлеи — через `createPortal` в
 * `document.body` и по шкале z-index [[decision-17]]: лист 9999, тост 10000, подтверждение 10001.
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-indigo-500 text-white active:bg-indigo-600',
  secondary: 'bg-ph-raised text-slate-100 active:bg-ph-hover border border-ph-line',
  danger: 'bg-destructive text-white active:opacity-80',
  success: 'bg-emerald-600 text-white active:bg-emerald-700',
  ghost: 'bg-transparent text-slate-300 active:bg-ph-hover'
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  haptic = 'light',
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; haptic?: Parameters<ReturnType<typeof useHaptic>>[0] | null }) {
  const vibrate = useHaptic();
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-transform active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-11 px-4 text-[15px]',
        size === 'lg' && 'h-12 px-5 text-base',
        VARIANT[variant],
        className
      )}
      onClick={(e) => {
        if (haptic) vibrate(haptic);
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={clsx('block w-full rounded-xl border border-ph-line bg-ph-elevated p-3 text-left', onClick && 'active:bg-ph-hover', className)}
    >
      {children}
    </Tag>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'review'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-ph-raised text-slate-300',
    accent: 'bg-indigo-950 text-indigo-300',
    success: 'bg-emerald-950 text-emerald-300',
    warning: 'bg-amber-950 text-amber-300',
    danger: 'bg-red-950 text-red-300',
    review: 'bg-violet-950 text-purple-300'
  } as const;
  return <span className={clsx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>;
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center text-slate-400">
      {icon && <div className="mb-3 text-slate-500">{icon}</div>}
      <div className="text-[15px] font-medium text-slate-200">{title}</div>
      {hint && <div className="mt-1 text-[13px] leading-snug">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center justify-between px-1 first:mt-0">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">{children}</h2>
      {action}
    </div>
  );
}

/**
 * Нижний лист: закрывается крестиком, тапом по фону и жестом вниз за ручку.
 */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const [dragY, setDragY] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDragY(0);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex flex-col justify-end">
      <div className="ph-fade-enter absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="ph-sheet-enter relative flex max-h-[88vh] flex-col rounded-t-2xl border-t border-ph-line bg-ph-panel pb-safe"
        style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }}
      >
        <div
          className="flex touch-none justify-center pb-1 pt-2"
          onPointerDown={(e) => {
            start.current = e.clientY;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => start.current !== null && setDragY(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => {
            if (dragY > 90) onClose();
            else setDragY(0);
            start.current = null;
          }}
        >
          <div className="h-1 w-10 rounded-full bg-slate-600" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</div>
          <button type="button" aria-label="Закрыть" onClick={onClose} className="-mr-2 rounded-full p-2 text-slate-400 active:bg-ph-hover">
            <XIcon size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <div className="border-t border-ph-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** Подтверждение поверх листа (z-[10001]). */
export function Confirm({
  open,
  title,
  body,
  confirmText,
  danger,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center p-6">
      <div className="ph-fade-enter absolute inset-0 bg-black/70" onClick={onCancel} />
      <div role="alertdialog" aria-modal="true" className="relative w-full max-w-sm rounded-2xl border border-ph-line bg-ph-elevated p-5">
        <div className="text-[17px] font-semibold">{title}</div>
        {body && <div className="mt-2 text-[14px] text-slate-300">{body}</div>}
        <div className="mt-5 flex gap-2">
          <Button className="flex-1" onClick={onCancel}>
            Отмена
          </Button>
          <Button className="flex-1" variant={danger ? 'danger' : 'primary'} haptic="medium" onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-transparent', className)} />;
}
