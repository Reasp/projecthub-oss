import React from 'react';
import { Mic } from '../common/icons';
import { useVoiceState } from '../../hooks/useVoiceState';
import { useI18n } from '../../i18n';

export interface VoiceBadgeProps {
  /** Voice command text or phrase to speak, e.g. "задачи", "старт дев" */
  command: string;
  /** Optional secondary command or synonym */
  altCommand?: string;
  /** Positioning mode */
  position?: 'inline' | 'top' | 'bottom' | 'top-right' | 'bottom-right' | 'right';
  /** Visual color theme */
  variant?: 'indigo' | 'emerald' | 'amber' | 'purple' | 'cyan';
  /** Extra CSS classes */
  className?: string;
  /** Force show even if hands-free is inactive (e.g. for preview/help) */
  alwaysShow?: boolean;
}

export const VoiceBadge: React.FC<VoiceBadgeProps> = ({
  command,
  altCommand,
  position = 'inline',
  variant = 'indigo',
  className = '',
  alwaysShow = false
}) => {
  const { isListening } = useVoiceState();
  const { t } = useI18n();

  if (!isListening && !alwaysShow) {
    return null;
  }

  const altText = altCommand ? t.voice.altCommandFormat.replace('{altCommand}', altCommand) : '';
  const tooltip = t.voice.speakHint.replace('{command}', command).replace('{alt}', altText);

  const variantStyles = {
    indigo:
      'bg-indigo-950/90 text-indigo-200 border-indigo-500/60 hover:border-indigo-400',
    emerald:
      'bg-emerald-950/90 text-emerald-200 border-emerald-500/60 hover:border-emerald-400',
    amber:
      'bg-amber-950/90 text-amber-200 border-amber-500/60 hover:border-amber-400',
    purple:
      'bg-ph-raised text-slate-200 border-slate-700 hover:border-slate-700',
    cyan:
      'bg-ph-raised text-slate-200 border-slate-700 hover:border-slate-700'
  };

  const positionStyles = {
    inline: 'relative inline-flex items-center ml-1.5',
    top: 'absolute -top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none whitespace-nowrap',
    bottom: 'absolute -bottom-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none whitespace-nowrap',
    'top-right': 'absolute -top-2 -right-2 z-30 pointer-events-none whitespace-nowrap',
    'bottom-right': 'absolute -bottom-2 -right-1 z-30 pointer-events-none whitespace-nowrap',
    // Справа от элемента вертикальной полосы (Activity Bar), поверх сайдбара
    right: 'absolute left-full top-1/2 -translate-y-1/2 ml-1 z-30 pointer-events-none whitespace-nowrap'
  };

  return (
    <span
      className={`select-none pointer-events-none inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-mono font-semibold shadow-md animate-in fade-in zoom-in-95 duration-150 transition-all ${variantStyles[variant]} ${positionStyles[position]} ${className}`}
      title={tooltip}
    >
      <Mic className="w-2.5 h-2.5 shrink-0 opacity-80" />
      <span className="tracking-tight whitespace-nowrap">
        «{command}»
      </span>
      {altCommand && (
        <span className="hidden 2xl:inline opacity-60 text-[11px]">
          / «{altCommand}»
        </span>
      )}
    </span>
  );
};
